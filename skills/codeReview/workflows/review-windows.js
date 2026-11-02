export const meta = {
  name: 'doh-codereview-windows',
  description: 'doh codeReview: walk the windows of every target of a run from one pool of lanes, each target\'s cross-file pass right after its own windows',
  whenToUse: 'Only when the doh:codeReview skill hands over this script; the copy in the run folder carries its args.',
  phases: [
    { title: 'Windows', detail: 'one doh:codereview-walker per window of files, several side by side' },
    { title: 'Gaps', detail: 'one light walker per target closes the items left open for a readable outside file' },
    { title: 'Cross-file', detail: 'one fresh doh:codereview-cross per target, once its windows are done' },
  ],
}

// The walk of a codeReview run (skills/codeReview/SKILL.md Step 3, Windows) as one background
// run: the conversation that started it hears from it once, instead of once per window - measured
// on a 115-file review (2026-10-27), 62 hand-backs cost the dispatching conversation 26.3M
// cache-read tokens, as much as all the walkers together. One run for every target of the review:
// one approval, one notification, and one pool of lanes - two runs side by side doubled the
// agents at work, and their searches stalled each other for minutes (2026-10-27, 4 targets).
//
// args (review-context.cjs `workflow.args`):
//   lanes    how many walkers work at once, over all targets - their parts are independent files
//   targets  [{ dir, windows, cross, gaps }] - one per target with windows:
//     dir      the target's work folder, where every brief is (`window<NN>.md`, `cross-file.brief.md`, `gaps.brief.md`)
//     windows  [["<first>-<last>", "<model or ''>", "<effort or ''>", ["<target>:<window>", ...]], ...] in file
//              order; the fourth entry, when there is one, names the windows (of `targets`, both counted
//              from 1) that walk the files this window carries verdicts from - a later part of a
//              stack waits for them, so their parts are on disk when its bundles are read
//     cross    { model, effort } of the cross-file pass's agent
//     gaps     { model, effort } of the agent that closes the items left open for a readable outside
//              file before the cross-file pass; absent, there is no such step
// The one-target form of 0.26 (`{ dir, lanes, windows, cross }`) still runs.
// Returns { targets: [{ dir, windows: [{ window, files, ok, reply }], failed: [window numbers], cross: reply line or null }] },
// or, for the one-target form, that target's { windows, failed, cross }.
// The run folder's copy carries its args on the next line (review-context.cjs runWorkflow), so the
// call names only `scriptPath`; `args` passed to the call win over them.
const baked = null
const input = (typeof args === 'object' && args && (Array.isArray(args.targets) || Array.isArray(args.windows))) ? args : (baked || {})

const pad = (n) => String(n).padStart(2, '0')
const lastLine = (reply) => String(reply || '').trim().split('\n').pop().trim()
// A window goes to a walker, whose system prompt holds the walk; the cross-file pass to its own
// agent, whose prompt holds only the pass - not the 70 kB walk it never makes.
const agentTypes = { Windows: 'doh:codereview-walker', Gaps: 'doh:codereview-walker', 'Cross-file': 'doh:codereview-cross' }
const spawnOptions = (setting, label, phaseTitle) => ({
  label,
  phase: phaseTitle,
  agentType: agentTypes[phaseTitle],
  ...(setting.model ? { model: setting.model } : {}),
  ...(setting.effort ? { effort: setting.effort } : {}),
})

const single = !Array.isArray(input.targets)
const targets = (single ? [{ dir: input.dir, windows: input.windows, cross: input.cross }] : input.targets).map((t) => {
  const dir = String(t.dir || '').replace(/[\\/]+$/, '')
  // `<run>/<branch>/raport.work`: the branch folder names the target in a label.
  const name = single ? '' : `${dir.split('/').slice(-2, -1)[0] || dir}: `
  const windows = (t.windows || []).map((w, k) => ({
    number: k + 1,
    files: String(w[0]),
    model: w[1] || '',
    effort: w[2] || '',
    after: Array.isArray(w[3]) ? w[3].map(String) : [],
    brief: `${dir}/window${pad(k + 1)}.md`,
  }))
  return { dir, name, windows, cross: t.cross || {}, gaps: t.gaps || null, results: [], left: windows.length, failed: [], reply: null, gapsReply: null }
})

// One window. A walker that stopped is started once more: it skips every part already on disk.
async function walk(target, w) {
  let line = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const label = `${target.name}window ${w.number}/${target.windows.length}: files ${w.files}${attempt > 1 ? ' (again)' : ''}`
    line = lastLine(await agent(`Read ${w.brief} and follow it.`, spawnOptions(w, label, 'Windows')))
    if (line.startsWith('WINDOW DONE')) return { window: w.number, files: w.files, ok: true, reply: line }
  }
  return { window: w.number, files: w.files, ok: false, reply: line || 'no reply' }
}

// A target's cross-file pass, in the lane that finished its last window - while other targets'
// windows are still walked. A window that is not done holds it back: the conversation walks it.
async function crossOf(target) {
  target.failed = target.windows.filter((w) => !target.results[w.number - 1] || !target.results[w.number - 1].ok).map((w) => w.number)
  if (target.failed.length > 0) {
    log(`${target.name}window(s) ${target.failed.join(', ')} not done: the cross-file pass waits for the conversation that walks them`)
    return
  }
  // The items the walk left open for a file outside the review that the revision holds: a light
  // walker reads those files once and settles what they settle. It replies at once when none are.
  if (target.gaps) {
    target.gapsReply = lastLine(await agent(`Read ${target.dir}/gaps.brief.md and follow it.`, spawnOptions(target.gaps, `${target.name}open items`, 'Gaps')))
  }
  target.reply = lastLine(await agent(`Read ${target.dir}/cross-file.brief.md and follow it.`, spawnOptions(target.cross, `${target.name}cross-file pass`, 'Cross-file')))
}

phase('Windows')
const jobs = targets.flatMap((target, t) => target.windows.map((w) => ({ target, w, key: `${t + 1}:${w.number}`, state: 'pending' })))
const known = new Set(jobs.map((job) => job.key))
const finished = new Set()
const waiting = []
const wakeAll = () => {
  while (waiting.length > 0) waiting.shift()()
}
// A window whose files carry verdicts from an earlier part of the stack waits for the windows that
// walk those files; one naming no window of this run waits for nothing.
const ready = (job) => job.w.after.every((key) => finished.has(key) || !known.has(key))
// Each lane takes the first window, of whichever target, that is free to start, as soon as its
// walker is done; with none free it waits for the next window to finish.
const lane = async () => {
  for (;;) {
    const job = jobs.find((j) => j.state === 'pending' && ready(j))
    if (!job) {
      if (!jobs.some((j) => j.state === 'pending')) return
      await new Promise((resolve) => waiting.push(resolve))
      continue
    }
    job.state = 'running'
    job.target.results[job.w.number - 1] = await walk(job.target, job.w)
    job.state = 'done'
    finished.add(job.key)
    wakeAll()
    job.target.left--
    if (job.target.left === 0) await crossOf(job.target)
  }
}
const lanes = Math.max(1, Math.min(Number(input.lanes) || 1, jobs.length))
log(`${jobs.length} window(s) of ${targets.length} target(s), ${lanes} at a time`)
await parallel(Array.from({ length: lanes }, () => lane))

const report = (t) => ({ windows: t.results, failed: t.failed, ...(t.gaps ? { gaps: t.gapsReply } : {}), cross: t.reply })
return single ? report(targets[0]) : { targets: targets.map((t) => ({ dir: t.dir, ...report(t) })) }
