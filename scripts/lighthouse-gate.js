'use strict';
// Grades a site-audit --json report: accessibility, best practices and SEO at
// 100 on phone and desktop for every page named, and no other finding on any
// page in the report. An exception belongs in site-audit.json, which
// site-audit reads before it reports. Its "check by eye" lines are not findings
// to site-audit either, so they are printed and do not fail the job.
// The scores are read from the report rather than from its findings, so a
// renamed finding kind cannot turn this into a check that always passes, and a
// page or a form with no scores at all fails.
//
// Usage: node scripts/lighthouse-gate.js <report.json> <page url>...
const { readFileSync } = require('node:fs');

const FLOORS = { accessibility: 100, 'best-practices': 100, seo: 100 };
const FORMS = ['mobile', 'desktop'];
const SCORES = 'lighthouse scores';
const NOTE = 'check by eye';

/**
 * @param {any} report site-audit's --json output
 * @param {string[]} pages the page URLs that must carry scores
 * @returns {{ failures: string[], notes: string[] }}
 */
function grade(report, pages) {
  const failures = [];
  const notes = [];
  const byUrl = (report && report.pages) || {};
  for (const url of pages) {
    const page = byUrl[url];
    if (!page) {
      failures.push(`${url}: not in the report`);
      continue;
    }
    for (const form of FORMS) {
      const result = page.lighthouse && page.lighthouse[form];
      if (!result || !result.scores) {
        failures.push(`${url}: no Lighthouse result on ${form}`);
        continue;
      }
      for (const [category, floor] of Object.entries(FLOORS)) {
        const score = result.scores[category];
        if (typeof score !== 'number') failures.push(`${url}: no ${category} score on ${form}`);
        else if (score < floor) {
          const why = (result.failed || []).filter((/** @type {string} */ f) => f.startsWith(`${category}: `))
            .map((/** @type {string} */ f) => f.slice(category.length + 2));
          failures.push(`${url}: ${category} ${score} on ${form}, needs ${floor}${why.length ? `: ${why.join('; ')}` : ''}`);
        }
      }
    }
  }
  for (const [url, page] of Object.entries(byUrl)) {
    for (const f of (/** @type {any} */ (page)).findings || []) {
      if (f.kind === SCORES) continue;
      if (f.kind === NOTE) notes.push(`${url}: ${f.detail}`);
      // A run that failed outright is already a missing score above, but its
      // message says why.
      else if (f.kind === 'lighthouse') failures.push(`${url}: ${f.detail}`);
      else failures.push(`${url}: ${f.kind}: ${f.detail}`);
    }
  }
  return { failures: [...new Set(failures)], notes };
}

function main() {
  const [path, ...pages] = process.argv.slice(2);
  if (!path || !pages.length) {
    console.error('usage: node scripts/lighthouse-gate.js <report.json> <page url>...');
    process.exit(2);
  }
  const { failures, notes } = grade(JSON.parse(readFileSync(path, 'utf8')), pages);
  if (notes.length) {
    console.log(`To check by eye (${notes.length}):`);
    for (const n of notes) console.log(`  ${n}`);
  }
  if (failures.length) {
    console.log(`Site audit failed (${failures.length}):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log(`Lighthouse at 100 for accessibility, best practices and SEO on ${pages.length} pages, phone and desktop, and no other findings.`);
}

if (require.main === module) main();
module.exports = { grade };
