export const meta = {
  name: 'doh-codereview-windows',
  description: 'doh codeReview: walk one target window by window, several at once, then the cross-file pass',
  whenToUse: 'Only when the doh:codeReview skill hands over this script with a target.workflow args object.',
  phases: [
    { title: 'Windows', detail: 'one doh:codereview-walker per window of files, several side by side' },
    { title: 'Cross-file', detail: 'one fresh doh:codereview-walker over the whole target' },
  ],
}

// The walk of one codeReview target (skills/codeReview/SKILL.md Step 3, Windows) as one
// background run: the conversation that started it hears from it once, instead of once per
// window - measured on a 115-file review (2026-10-27), 62 hand-backs cost the dispatching
// conversation 26.3M cache-read tokens, as much as all the walkers together.
//
// args (review-context.cjs `target.workflow.args`):
//   dir      the target's work folder, where every brief is (`window<NN>.md`, `cross-file.brief.md`)
//   lanes    how many windows are walked at once - their parts are independent files
//   windows  [["<first>-<last>", "<model or ''>", "<effort or ''>"], ...] in file order
//   cross    { model, effort } of the cross-file pass's agent
// Returns { windows: [{ window, files, ok, reply }], failed: [window numbers], cross: reply line or null }.

const pad = (n) => String(n).padStart(2, '0')
const dir = String(args.dir || '').replace(/[\\/]+$/, '')
const windows = (args.windows || []).map((w, k) => ({
  number: k + 1,
  files: String(w[0]),
  model: w[1] || '',
  effort: w[2] || '',
  brief: `${dir}/window${pad(k + 1)}.md`,
}))
const lastLine = (reply) => String(reply || '').trim().split('\n').pop().trim()
const spawnOptions = (setting, label, phaseTitle) => ({
  label,
  phase: phaseTitle,
  agentType: 'doh:codereview-walker',
  ...(setting.model ? { model: setting.model } : {}),
  ...(setting.effort ? { effort: setting.effort } : {}),
})

// One window. A walker that stopped is started once more: it skips every part already on disk.
async function walk(w) {
  let line = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const label = `window ${w.number}/${windows.length}: files ${w.files}${attempt > 1 ? ' (again)' : ''}`
    line = lastLine(await agent(`Read ${w.brief} and follow it.`, spawnOptions(w, label, 'Windows')))
    if (line.startsWith('WINDOW DONE')) return { window: w.number, files: w.files, ok: true, reply: line }
  }
  return { window: w.number, files: w.files, ok: false, reply: line || 'no reply' }
}

phase('Windows')
const results = []
let next = 0
// Each lane takes the next window as soon as its walker is done.
const lane = async () => {
  while (next < windows.length) {
    const w = windows[next++]
    results[w.number - 1] = await walk(w)
  }
}
const lanes = Math.max(1, Math.min(Number(args.lanes) || 1, windows.length))
log(`${windows.length} window(s), ${lanes} at a time`)
await parallel(Array.from({ length: lanes }, () => lane))

const failed = windows.filter((w) => !results[w.number - 1] || !results[w.number - 1].ok).map((w) => w.number)
let cross = null
if (failed.length === 0) {
  phase('Cross-file')
  cross = lastLine(await agent(`Read ${dir}/cross-file.brief.md and follow it.`, spawnOptions(args.cross || {}, 'cross-file pass', 'Cross-file')))
} else {
  log(`window(s) ${failed.join(', ')} not done: the cross-file pass waits for the conversation that walks them`)
}
return { windows: results, failed, cross }
