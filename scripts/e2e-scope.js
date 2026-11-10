'use strict';
// Whether the browser-test job has anything to test. Merges here are
// fast-forwards, so a push to main is a commit its pull request already ran
// the suite on, and nothing the app serves or the tests load is Markdown.
// Every doubt runs the suite: a tag, a range git cannot read, a forge that
// does not answer.
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

/**
 * @param {{ event: string, ref: string, changed: string[] | null, prState: string | null }} s
 *   changed: the files the run covers, null when unreadable; prState: this
 *   job's last result on the commit's pull request, null when there is none
 * @returns {{ run: boolean, why: string }}
 */
function decide({ event, ref, changed, prState }) {
  if (ref.startsWith('refs/tags/')) return { run: true, why: 'a tag runs everything' };
  if (event === 'push' && prState === 'success') {
    return { run: false, why: 'this commit passed the browser tests on its pull request' };
  }
  if (changed === null) return { run: true, why: 'the changed files could not be read' };
  if (changed.length === 0) return { run: true, why: 'the range holds no changed files' };
  if (changed.every(f => f.endsWith('.md'))) {
    return { run: false, why: 'only Markdown changed' };
  }
  return { run: true, why: `${changed.length} changed files, not all Markdown` };
}

/** @param {NodeJS.ProcessEnv} env @returns {string[] | null} */
function changedFiles(env) {
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  try {
    let from;
    if (env.EVENT_NAME === 'pull_request') from = git('merge-base', `origin/${env.BASE_REF}`, 'HEAD');
    else if (env.EVENT_NAME === 'push' && env.BEFORE && !/^0+$/.test(env.BEFORE)) from = env.BEFORE;
    else return null;
    const out = git('diff', '--name-only', from, 'HEAD');
    return out ? out.split('\n') : [];
  } catch {
    return null;
  }
}

/** @param {NodeJS.ProcessEnv} env @returns {Promise<string | null>} */
async function prState(env) {
  if (env.EVENT_NAME !== 'push') return null;
  const context = `${env.GITHUB_WORKFLOW} / ${env.GITHUB_JOB} (pull_request)`;
  const url = `${env.GITHUB_SERVER_URL}/api/v1/repos/${env.GITHUB_REPOSITORY}/commits/${env.GITHUB_SHA}/status`;
  try {
    const res = await fetch(url, { headers: { Authorization: `token ${env.TOKEN}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The combined status holds the latest result per context.
    const hit = ((await res.json()).statuses || []).find((/** @type {any} */ s) => s.context === context);
    console.log(`'${context}': ${hit ? hit.status : 'none'}`);
    return hit ? hit.status : null;
  } catch (err) {
    console.log(`::warning::could not read the pull request's result for '${context}': ${err}`);
    return null;
  }
}

async function main() {
  const env = process.env;
  const { run, why } = decide({
    event: env.EVENT_NAME || '',
    ref: env.GITHUB_REF || '',
    changed: changedFiles(env),
    prState: await prState(env),
  });
  console.log(`${run ? 'Running' : 'Skipping'} the browser tests: ${why}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${run}\n`);
}

if (require.main === module) main();
module.exports = { decide };
