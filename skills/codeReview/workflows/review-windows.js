export const meta = {
  name: 'doh-codereview-windows',
  description: 'doh codeReview: walk the windows of every target of a run from one pool of lanes, each target\'s cross-file pass right after its own windows',
  whenToUse: 'Only when the doh:codeReview skill hands over this script with a workflow args object.',
  phases: [
    { title: 'Windows', detail: 'one doh:codereview-walker per window of files, several side by side' },
    { title: 'Cross-file', detail: 'one fresh doh:codereview-walker per target, once its windows are done' },
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
//   targets  [{ dir, windows, cross }] - one per target with windows:
//     dir      the target's work folder, where every brief is (`window<NN>.md`, `cross-file.brief.md`)
//     windows  [["<first>-<last>", "<model or ''>", "<effort or ''>"], ...] in file order
//     cross    { model, effort } of the cross-file pass's agent
// The one-target form of 0.26 (`{ dir, lanes, windows, cross }`) still runs.
// Returns { targets: [{ dir, windows: [{ window, files, ok, reply }], failed: [window numbers], cross: reply line or null }] },
// or, for the one-target form, that target's { windows, failed, cross }.

const pad = (n) => String(n).padStart(2, '0')
const lastLine = (reply) => String(reply || '').trim().split('\n').pop().trim()
const spawnOptions = (setting, label, phaseTitle) => ({
  label,
  phase: phaseTitle,
  agentType: 'doh:codereview-walker',
  ...(setting.model ? { model: setting.model } : {}),
  ...(setting.effort ? { effort: setting.effort } : {}),
})

const single = !Array.isArray(args.targets)
const targets = (single ? [{ dir: args.dir, windows: args.windows, cross: args.cross }] : args.targets).map((t) => {
  const dir = String(t.dir || '').replace(/[\\/]+$/, '')
  // `<run>/<branch>/raport.work`: the branch folder names the target in a label.
  const name = single ? '' : `${dir.split('/').slice(-2, -1)[0] || dir}: `
  const windows = (t.windows || []).map((w, k) => ({
    number: k + 1,
    files: String(w[0]),
    model: w[1] || '',
    effort: w[2] || '',
    brief: `${dir}/window${pad(k + 1)}.md`,
  }))
  return { dir, name, windows, cross: t.cross || {}, results: [], left: windows.length, failed: [], reply: null }
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
  target.reply = lastLine(await agent(`Read ${target.dir}/cross-file.brief.md and follow it.`, spawnOptions(target.cross, `${target.name}cross-file pass`, 'Cross-file')))
}

phase('Windows')
const jobs = targets.flatMap((target) => target.windows.map((w) => ({ target, w })))
let next = 0
// Each lane takes the next window, of whichever target, as soon as its walker is done.
const lane = async () => {
  while (next < jobs.length) {
    const { target, w } = jobs[next++]
    target.results[w.number - 1] = await walk(target, w)
    target.left--
    if (target.left === 0) await crossOf(target)
  }
}
const lanes = Math.max(1, Math.min(Number(args.lanes) || 1, jobs.length))
log(`${jobs.length} window(s) of ${targets.length} target(s), ${lanes} at a time`)
await parallel(Array.from({ length: lanes }, () => lane))

const report = (t) => ({ windows: t.results, failed: t.failed, cross: t.reply })
return single ? report(targets[0]) : { targets: targets.map((t) => ({ dir: t.dir, ...report(t) })) }
