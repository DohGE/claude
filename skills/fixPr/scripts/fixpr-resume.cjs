#!/usr/bin/env node
'use strict';

// Where a fixPr run whose orchestrator died stands, per target, and the one thing to do next.
//
// On 2026-11-18 the orchestrator of a seven-part run was killed (exit 137) in the middle of its
// landings. Everything a run needs to go on was on disk - the run file (pr-comments.cjs, with what
// fixpr-launch.cjs, restack.cjs and fixpr-after.cjs kept on each target) and each agent's
// `<reportPath>.result.json` - but no script read it back: the next session re-created a worktree
// by hand, pushed with a hand-copied lease (which skipped the `keep-base` check: the bottom part
// then conflicted with its base on GitHub), and wrote a one-off script to close the threads six
// landed parts had left open after a 401. This reads the same files plus git, and names, per
// target, the step and its exact command:
//
//   spawn          no result file (the agent was stopped), or an agent that ended in error with
//                  uncommitted work in its worktree: launch again (fixpr-launch.cjs --resume=yes
//                  takes the worktree as it is) and spawn the fix agent.
//   land           a held part whose parent has landed (restack.cjs land), or the commit of a
//                  `keep-base` bottom never pushed (land --keep-base=yes: it moves onto its base
//                  only when it no longer merges, and pushes with the lease). The worktree is made
//                  again first when it is gone (worktree.cjs --resume=yes).
//   push           a commit made and never pushed that no worktree or local branch holds any more
//                  (restack.cjs push --commit, with the lease pinned to where origin stood when the
//                  run began once the commit rewrote it). Wherever a worktree can hold the commit, it
//                  goes through `land` instead - see landOrPush.
//   landing-agent  a landing that stopped in the middle of its conflict agent's rebase.
//   after          the landing happened, fixpr-after.cjs did not run (threads, checks, worktree).
//   resolve        landed and pushed, threads left open (a 401): fixpr-after.cjs --resolve-only.
//   cascade        pushed with open parts above it the run does not name, still on the old commit.
//   wait           a held part whose parent has not landed yet - a stack lands bottom-up.
//   manual         nothing a script can do (a commit gone from the repository, a refused worktree).
//   done           nothing left.
//
// Run it, do every action once, and run it again until each target is `done`, `wait`s on a part
// still in the hands of an agent, or is `manual`.
//
// Usage: node fixpr-resume.cjs [--run=<fixpr-run-*.json>] [--project=<path>] [--push=yes|no]
//        [--reply=yes|no] [--keep-worktree=yes|no] [--language=<name>] [--worktrees=yes|no]
// --run defaults to the newest run file of the project (<project>/.claude/doh, else the skill's
// reports folder). --push and --language default to what the launch kept; --worktrees=no makes
// no worktree (the actions are only named).
// Prints one JSON object: { runPath, actions: [{ branch, action, reason, command?, note?,
// worktree?, briefVars? }], counts, warnings, errors }.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript } = require('./fixpr-launch.cjs');

const skillDir = path.resolve(__dirname, '..');
const scriptOf = (name) => path.join(__dirname, name);

function parseArgs(argv) {
  const args = { run: '', project: process.cwd(), push: '', reply: '', keepWorktree: '', language: '', worktrees: 'yes' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    const value = m[2].trim();
    if (m[1] === 'run') args.run = value;
    else if (m[1] === 'project') args.project = value;
    else if (m[1] === 'push') args.push = value;
    else if (m[1] === 'reply') args.reply = value;
    else if (m[1] === 'keep-worktree') args.keepWorktree = value;
    else if (m[1] === 'language') args.language = value;
    else if (m[1] === 'worktrees') args.worktrees = value;
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --run, --project, --push, --reply, --keep-worktree, --language, --worktrees).`);
  for (const [flag, value] of [['push', args.push], ['reply', args.reply], ['keep-worktree', args.keepWorktree], ['worktrees', args.worktrees]]) {
    if (value && !['yes', 'no'].includes(value)) throw new Error(`--${flag} takes yes or no.`);
  }
  return args;
}

// The newest run file: the collector names them fixpr-run-<date>-<hh>-<mm>.json, so the name
// sorts by start; two of one minute go by the time they were last written.
function newestRun(project) {
  const dirs = [path.join(path.resolve(project), '.claude', 'doh'), path.join(skillDir, 'reports')];
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^fixpr-run-.*\.json$/.test(f)).map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)) || fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    return files[files.length - 1];
  }
  return null;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function gitIn(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: res.status === 0, out: String(res.stdout || '').trim() };
}

// What the plan asks git, as one seam: the tests hand in a repository of their own.
function gitFacts(project, git = gitIn) {
  const isDir = (dir) => Boolean(dir) && fs.existsSync(dir) && git(dir, ['rev-parse', '--git-dir']).ok;
  return {
    fetch: (branches) => git(project, ['fetch', '--quiet', 'origin', ...branches]).ok,
    tip: (branch) => git(project, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out || null,
    hasCommit: (sha) => Boolean(sha) && git(project, ['cat-file', '-e', `${sha}^{commit}`]).ok,
    // `sha` is in what origin has of `branch`.
    onOrigin: (sha, branch) => Boolean(sha) && git(project, ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${branch}`]).ok,
    // origin's `branch` is an ancestor of `sha`: a plain push takes it, no lease needed.
    fastForward: (branch, sha) => git(project, ['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, sha]).ok,
    sits: (parent, child) => git(project, ['merge-base', '--is-ancestor', `refs/remotes/origin/${parent}`, `refs/remotes/origin/${child}`]).ok,
    worktree: (dir) => isDir(dir),
    // The commit a worktree, or the local branch a worktree is made again from, stands on.
    head: (dir) => (isDir(dir) ? git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).out || null : null),
    localHead: (branch) => [branch, `doh-fixpr/${branch}`].map((b) => git(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).out).find(Boolean) || null,
    dirty: (dir) => isDir(dir) && git(dir, ['status', '--porcelain', '--untracked-files=no']).out !== '',
    ahead: (dir, branch) => (isDir(dir) ? Number(git(dir, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]).out) || 0 : 0),
    inRebase: (dir) => {
      if (!isDir(dir)) return false;
      const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']).out;
      return Boolean(gitDir) && (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply')));
    },
  };
}

// `node "<script>" --name="value" …`, the form SKILL.md documents.
function command(script, flags) {
  return [`node "${scriptOf(script)}"`, ...flags.filter(Boolean).map(([name, value]) => (value === true ? `--${name}` : `--${name}="${value}"`))].join(' ');
}

const short = (sha) => (sha ? String(sha).slice(0, 12) : '');

function plan(runPath, options = {}, deps = {}) {
  const data = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const targets = data.targets || [];
  const project = data.project || path.dirname(runPath);
  const facts = deps.facts || gitFacts(project);
  const addWorktree = deps.addWorktree || ((branch) => runScript(scriptOf('worktree.cjs'), ['--action=add', `--branch=${branch}`, `--project=${project}`, '--resume=yes']));
  const out = { runPath, actions: [], counts: {}, warnings: [], errors: [] };
  const names = [...new Set(targets.flatMap((t) => [t.branch, t.stack && t.stack.parent, t.pr && t.pr.base, ...((t.stack && t.stack.above) || [])].filter(Boolean)))];
  if (!facts.fetch(names)) out.warnings.push('Could not fetch every branch of the run; compared the refs the repository already has.');
  // The stopped run lost the main checkout's node_modules (a removal, fixpr-after.cjs), or a launch
  // found it broken: no landing and no launch until the user has installed it there again - the
  // same health check worktree.cjs links by.
  if (targets.some((t) => (t.outcome && t.outcome.mainModulesLost) || (t.launch && t.launch.mainBroken))) {
    const health = (deps.mainModules || (() => require('./worktree.cjs').mainModulesHealth(project)))();
    if (!health.ok) out.errors.push(`${health.reason}: run \`${health.command}\` in ${project} first, then --resume again. No launch or landing goes on before that.`);
  }
  const byBranch = new Map(targets.map((t) => [t.branch, t]));
  const pushOf = (t) => options.push || (t.launch && t.launch.push) || 'yes';
  const languageOf = (t) => options.language || (t.launch && t.launch.language) || 'English';

  // Landed, as far as the parts above it go: its outcome kept, and its commit on origin (or a run
  // that pushes nothing). A part that did not land, or was never launched, leaves origin/<branch>
  // where it was - its children move onto that.
  const landed = (t) => {
    if (!t) return true;
    if (t.launch && (t.launch.errors || []).length && !readJson(`${t.reportPath}.result.json`)) return true;
    const o = t.outcome;
    if (!o) return false;
    return !o.committed || o.pushed || pushOf(t) === 'no' || facts.onOrigin(o.commit, t.branch);
  };

  for (const t of targets) {
    const action = decide(t);
    out.actions.push({ branch: t.branch, ...action });
    out.counts[action.action] = (out.counts[action.action] || 0) + 1;
  }
  return out;

  function decide(t) {
    const result = readJson(`${t.reportPath}.result.json`);
    const o = t.outcome || null;
    const landing = t.landingResult || null;
    const pushed = t.pushResult || null;
    const push = pushOf(t);
    const reply = options.reply || (o && o.reply) || 'yes';
    const keep = options.keepWorktree === 'yes';
    const hasWorktree = facts.worktree(t.worktree);
    const run = ['run', runPath];
    const branchFlag = ['branch', t.branch];
    const afterCmd = (commit, isPushed, extra = []) => command('fixpr-after.cjs', [run, branchFlag, ['land-next', 'no'], ['push', push], commit ? ['commit', commit] : null, commit ? ['pushed', isPushed ? 'yes' : 'no'] : null, reply === 'no' ? ['reply', 'no'] : null, keep ? ['keep-worktree', 'yes'] : null, ...extra]);

    // The worktree a landing works in, made again when it is gone.
    const needWorktree = () => {
      if (hasWorktree) return { ok: true };
      if (options.worktrees === 'no') return { ok: true, note: `worktree ${t.worktree} is gone: make it with worktree.cjs --action=add --resume=yes before the landing` };
      const made = addWorktree(t.branch) || {};
      if ((made.errors || []).length || !made.worktree || made.mainBroken) {
        return { ok: false, reason: `the worktree could not be made again: ${((made.errors || [])[0]) || (made.mainBroken ? 'the main checkout has no complete node_modules' : 'worktree.cjs made none')}` };
      }
      return { ok: true, worktree: made.worktree, warnings: made.warnings || [] };
    };
    const withWorktree = (action) => {
      const wt = needWorktree();
      if (!wt.ok) return { action: 'manual', reason: wt.reason };
      if (wt.worktree) out.warnings.push(...wt.warnings.map((w) => `${t.branch}: ${w}`));
      return { ...action, ...(wt.worktree ? { worktree: wt.worktree } : {}), ...(wt.note ? { note: wt.note } : {}) };
    };
    // A commit landed, never pushed: through restack.cjs push, from the project when the worktree
    // is gone, with the lease once the commit no longer builds on what origin has.
    const pushAction = (commit, why) => {
      if (!facts.hasCommit(commit)) return { action: 'manual', reason: `commit ${short(commit)} is no longer in the repository; ${why}` };
      const lease = facts.fastForward(t.branch, commit) ? null : t.remoteTipAtStart || (landing && landing.lease) || null;
      if (!lease && !facts.fastForward(t.branch, commit)) return { action: 'manual', reason: `${short(commit)} rewrote ${t.branch} and the run file holds no lease (remoteTipAtStart) to push it with` };
      return { action: 'push', reason: why, commit, ...(lease ? { lease } : {}), command: command('restack.cjs', [['action', 'push'], run, branchFlag, ['commit', commit], lease ? ['lease', lease] : null]) };
    };
    const landAction = (why, extra = []) => withWorktree({
      action: 'land', reason: why,
      command: command('restack.cjs', [['action', 'land'], run, branchFlag, ['push', push], ['summary', 'yes'], ...extra]),
    });
    // A commit made and never pushed goes out through `land`: it checks the commit against its base
    // (or parent) again, moves it when the base moved since, runs the gate on a move, and pushes
    // with the lease. The hand push of 2026-11-18 skipped exactly that and conflicted on GitHub.
    // `land` works on the HEAD of the worktree, so it applies only where the worktree - or the local
    // branch worktree.cjs --resume=yes makes it again from - stands on that commit. A commit nothing
    // checks out any more (a landing's commit whose branch moved on, a worktree reset since) can
    // only be pushed as it is: restack.cjs push --commit, the one case left for a bare push.
    const landOrPush = (commit, why, extra = []) => {
      if (!facts.hasCommit(commit)) return { action: 'manual', reason: `commit ${short(commit)} is no longer in the repository; ${why}` };
      const at = hasWorktree ? facts.head(t.worktree) : facts.localHead(t.branch);
      if (at && at !== commit) return pushAction(commit, `${why}; ${hasWorktree ? 'its worktree' : 'its local branch'} stands on ${short(at)}, not on it, so land (which moves HEAD) cannot carry it`);
      if (!at) return pushAction(commit, `${why}; no worktree or local branch holds it, so land (which moves HEAD) cannot carry it`);
      return landAction(why, extra);
    };
    // A landing that stopped at a conflict, or at a red gate its agent was to adapt to.
    const resumeLanding = (parent) => {
      const remote = facts.tip(t.branch);
      if (remote && remote !== t.remoteTipAtStart && parent && facts.sits(parent, t.branch)) {
        return { action: 'after', reason: `its landing agent pushed ${short(remote)} onto ${parent} before the run stopped`, command: afterCmd(remote, true) };
      }
      if (hasWorktree && facts.inRebase(t.worktree) && landing.briefVars) {
        const prompt = t.promptPath ? t.promptPath.replace(/\.md$/i, '-restack.md') : '';
        return {
          action: 'landing-agent', reason: `its landing agent was stopped in the middle of the rebase (${landing.status})`, briefVars: landing.briefVars,
          command: command('../../../scripts/render-agent-prompt.cjs', [['template', path.join(skillDir, 'references', 'restack-agent.md')], ['out', prompt], ['vars', landing.briefVars], ['set', `PR_NUMBER=${t.pr.number}`], ['set', `PR_URL=${t.pr.url}`], ['set', `LANGUAGE=${languageOf(t)}`]]),
        };
      }
      return null;
    };

    // 1. The fix agent.
    if (!result) {
      const notes = [];
      if (hasWorktree && facts.ahead(t.worktree, t.branch) > 0) notes.push(`its worktree already holds ${facts.ahead(t.worktree, t.branch)} commit(s) the stopped agent made`);
      if (hasWorktree && facts.dirty(t.worktree)) notes.push('its worktree holds the stopped agent\'s uncommitted changes');
      const refused = t.launch && (t.launch.errors || []).length ? ` (the last launch was refused: ${t.launch.errors[0]})` : '';
      return {
        action: 'spawn', reason: `no result file: its fix agent never ended${refused}`,
        command: command('fixpr-launch.cjs', [run, branchFlag, ['push', push], ['language', languageOf(t)], ['resume', 'yes']]),
        ...(notes.length ? { note: `An earlier agent of this run was stopped; ${notes.join(', and ')}. Check that work against the comments and build on it: one commit for the run, never --amend.` } : {}),
      };
    }
    if (result.type !== 'result') {
      if (o) return { action: 'done', reason: 'its agent ended in error; the outcome is kept and the worktree left for the user' };
      if (hasWorktree && facts.dirty(t.worktree)) {
        return {
          action: 'spawn', reason: 'its agent ended in error with uncommitted work in the worktree',
          command: command('fixpr-launch.cjs', [run, branchFlag, ['push', push], ['language', languageOf(t)], ['resume', 'yes']]),
          note: `The previous agent ended in error: ${String(result.report || '').slice(0, 300)}. Its uncommitted changes are in the worktree: go on from them.`,
        };
      }
      return { action: 'after', reason: 'its agent ended in error; fixpr-after.cjs did not record it', command: command('fixpr-after.cjs', [run, branchFlag, ['keep-worktree', 'yes']]) };
    }

    // 2. The landing, before fixpr-after.cjs ran.
    if (!o) {
      if (pushed && pushed.pushed && facts.onOrigin(pushed.commit, t.branch)) {
        return { action: 'after', reason: `${short(pushed.commit)} was pushed; fixpr-after.cjs did not run`, command: afterCmd(pushed.commit, true) };
      }
      if (t.landing === 'hold') {
        const parent = t.stack && t.stack.parent;
        const parentTarget = byBranch.get(parent);
        if (!(t.stack && t.stack.parentOutsideRun) && parentTarget && !landed(parentTarget)) return { action: 'wait', reason: `${parent} has not landed yet: a held part lands after it` };
        // `noop`: the part already sat on its parent and origin had it - landed, nothing moved.
        if (landing && (landing.status === 'landed' || landing.status === 'noop')) {
          const onOrigin = landing.pushed || landing.status === 'noop' || facts.onOrigin(landing.commit, t.branch);
          if (!onOrigin && push === 'yes' && landing.commit) return landOrPush(landing.commit, `its landing moved it to ${short(landing.commit)} and the push did not happen`);
          return { action: 'after', reason: `its landing ended (${short(landing.commit)}); fixpr-after.cjs did not run`, command: afterCmd(landing.commit, onOrigin) };
        }
        if (landing && landing.status === 'push-rejected' && landing.commit) return landOrPush(landing.commit, `its landing's push was refused (${(landing.errors || [])[0] || 'push-rejected'})`);
        if (landing && (landing.status === 'conflict' || (landing.status === 'gate-red' && landing.briefVars))) {
          const resumed = resumeLanding(parent);
          if (resumed) return resumed;
          return landAction(`its landing stopped at ${landing.status === 'conflict' ? 'a conflict' : 'a red gate after the move'}; it runs again and hands its agent the brief`, result.committed ? [['pending-steps', 'build']] : []);
        }
        if (landing && landing.status === 'gate-red') return { action: 'after', reason: 'its landing ended with a red gate; recorded like an agent error, the worktree kept', command: command('fixpr-after.cjs', [run, branchFlag, ['keep-worktree', 'yes']]) };
        return landAction(landing ? `its landing ended ${landing.status}${(landing.errors || [])[0] ? `: ${landing.errors[0]}` : ''}; it runs again` : `${parent || 'its parent'} has landed; it moves onto it`, result.committed ? [['pending-steps', 'build']] : []);
      }
      if (!result.committed) return { action: 'after', reason: 'its agent committed nothing; fixpr-after.cjs did not run', command: afterCmd(null) };
      const commit = (landing && landing.commit) || result.commit;
      if (!facts.hasCommit(commit)) return { action: 'manual', reason: `commit ${short(commit)} is no longer in the repository` };
      if (result.pushed && !landing) return { action: 'after', reason: 'its agent pushed; fixpr-after.cjs did not run', command: afterCmd(null) };
      if (facts.onOrigin(commit, t.branch)) return { action: 'after', reason: `${short(commit)} is on origin; fixpr-after.cjs did not run`, command: afterCmd(commit, true) };
      if (push === 'no') return { action: 'after', reason: 'committed, and the run pushes nothing (--no-push)', command: afterCmd(null) };
      if (landing && (landing.status === 'conflict' || (landing.status === 'gate-red' && landing.briefVars))) {
        const resumed = resumeLanding(t.pr && t.pr.base);
        if (resumed) return resumed;
      }
      if (landing && landing.status === 'push-rejected' && landing.commit) return landOrPush(landing.commit, `its landing's push was refused (${(landing.errors || [])[0] || 'push-rejected'})`, t.landing === 'keep-base' ? [['keep-base', 'yes']] : []);
      if (t.landing === 'keep-base') return landOrPush(commit, `${short(commit)} was committed and never pushed: it moves onto ${t.pr.base} only if it no longer merges, and pushes with the lease`, [['keep-base', 'yes']]);
      return landOrPush(commit, `${short(commit)} was committed${result.rebased ? ' and rebased' : ''} and never pushed: land checks it against ${t.pr.base} again and pushes with the lease`);
    }

    // 3. After fixpr-after.cjs: a push still owed, threads left open, parts above left behind.
    const ids = (result.fixedThreadIds || []).length;
    const resolveCmd = command('fixpr-after.cjs', [run, branchFlag, ['resolve-only', 'yes'], reply === 'no' ? ['reply', 'no'] : null]);
    const isPushed = o.pushed || (o.commit && facts.onOrigin(o.commit, t.branch));
    if (o.committed && !isPushed && push === 'yes' && o.commit) {
      if (t.landing === 'keep-base') return landOrPush(o.commit, `${short(o.commit)} was never pushed: it moves onto ${t.pr.base} only if it no longer merges, and pushes with the lease`, [['keep-base', 'yes']]);
      return landOrPush(o.commit, `${short(o.commit)} was never pushed: land checks it against ${(t.stack && t.stack.parent) || t.pr.base} again and pushes with the lease`);
    }
    if (o.committed && isPushed && !o.pushed) {
      return { action: 'resolve', reason: `${short(o.commit)} is on origin now: the threads it fixed are closed and the outcome marked pushed`, command: resolveCmd };
    }
    const r = o.resolve || {};
    const open = (r.failed || []).length + (reply === 'no' ? 0 : (r.replyFailed || []).length) + (r.errors || []).length;
    if (!t.local && ids > 0 && isPushed && open > 0) {
      return { action: 'resolve', reason: `${(r.failed || []).length} thread(s) not resolved, ${(r.replyFailed || []).length} reply(ies) not posted${(r.errors || []).length ? `: ${r.errors[0]}` : ''}`, command: resolveCmd };
    }
    const above = (t.stack && t.stack.above) || [];
    if (isPushed && o.committed && above.length > 0 && !facts.sits(t.branch, above[0])) {
      const checksDir = t.checksDir ? path.join(t.checksDir, 'cascade') : path.join(project, '.claude', 'doh', 'restack-checks');
      return {
        action: 'cascade', reason: `${above[0]}, open above it and not in the run, does not sit on it yet`,
        command: command('restack.cjs', [['action', 'cascade'], ['project', project], ['stack', [t.branch, ...above].join(';')], ['from', t.branch], ['from-old-tip', t.remoteTipAtStart || ''], ['checks-dir', checksDir], ['push', push]]),
      };
    }
    return { action: 'done', reason: o.keptWorktree ? `landed; the worktree ${o.keptWorktree.path} was kept (${o.keptWorktree.reason})` : 'landed' };
  }
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    const runPath = args.run || newestRun(args.project);
    if (!runPath) throw new Error(`No fixpr-run-*.json under ${path.join(path.resolve(args.project), '.claude', 'doh')}: give --run.`);
    result = plan(path.resolve(runPath), args);
  } catch (err) {
    result = { actions: [], warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, plan, newestRun, gitFacts, command };

if (require.main === module) main();
