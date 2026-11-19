'use strict';

// One write of the run file (fixpr-run-*.json) at a time.
//
// Several scripts keep what they did on a target of the same run file, and since Step 3 launches
// every target in the background they can do it at the same moment: fixpr-launch.cjs keeps `launch`,
// restack.cjs `landingResult` and `pushResult`, fixpr-after.cjs `outcome`. Each one reads the file,
// changes its own target and writes the whole file back, so two of them a moment apart would drop
// whichever wrote first - and fixpr-resume.cjs plans a stopped run from exactly these fields. The
// read-change-write runs under a lock folder next to the file (mkdir is atomic on every platform
// the plugin runs on). A lock older than `staleMs` is a crashed script's; a wait past `waitMs` goes
// on unlocked rather than lose the write.

const fs = require('node:fs');

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `mutate(data)` changes the parsed run file in place; what it returns is returned.
function updateRunFile(file, mutate, { waitMs = 30000, staleMs = 60000, wait = sleepMs } = {}) {
  const lock = `${file}.lock`;
  const start = Date.now();
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(lock);
      held = true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') break;
      let st = null;
      try {
        st = fs.statSync(lock);
      } catch {
        continue; // released in the meantime
      }
      if (Date.now() - st.mtimeMs > staleMs) {
        try { fs.rmdirSync(lock); } catch { /* taken over by another script */ }
        continue;
      }
      if (Date.now() - start > waitMs) break;
      wait(50);
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = mutate(data);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
    return value;
  } finally {
    if (held) {
      try { fs.rmdirSync(lock); } catch { /* already gone */ }
    }
  }
}

module.exports = { updateRunFile };
