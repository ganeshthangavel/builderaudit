#!/usr/bin/env node
/**
 * audit.js  — CLI tool
 * Usage: node audit.js https://example-builder.co.uk
 * Outputs a full JSON report to ./reports/<domain>-<timestamp>.json
 *   and prints a human-readable summary to the console.
 */

const fs = require('fs');
const path = require('path');
const { crawlWebsite } = require('./src/crawler');
const { scoreWebsite, DIMENSIONS } = require('./src/scorer');

const url = process.argv[2];
if (!url) {
  console.error('Usage: node audit.js <url>');
  process.exit(1);
}

const SEVERITY_ORDER = { critical: 0, warning: 1, good: 2 };
const BAR = (score) => {
  const filled = Math.round(score / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled) + `  ${score}/100`;
};

(async () => {
  try {
    const pages = await crawlWebsite(url);
    if (!pages.length) throw new Error('No pages crawled — check the URL');

    const report = await scoreWebsite(pages, url);

    // ── Console summary ───────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  SITE AUDIT REPORT`);
    console.log(`  ${url}`);
    console.log('═'.repeat(60));
    console.log(`\n  OVERALL SCORE: ${report.overallScore}/100`);
    console.log(`  ${BAR(report.overallScore)}`);
    console.log(`\n  ${report.summary}\n`);
    console.log('─'.repeat(60));
    console.log('  CATEGORY BREAKDOWN\n');

    for (const [key, cfg] of Object.entries(DIMENSIONS)) {
      const score = report.scores[key];
      const emoji = score >= 70 ? '✅' : score >= 45 ? '⚠️ ' : '❌';
      console.log(`  ${emoji} ${cfg.label.padEnd(22)} ${BAR(score)}`);
    }

    console.log('\n' + '─'.repeat(60));
    console.log('  PRIORITY ISSUES\n');

    const sorted = [...report.issues].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );

    for (const issue of sorted) {
      const icon = issue.severity === 'critical' ? '🔴' :
                   issue.severity === 'warning'  ? '🟡' : '🟢';
      console.log(`  ${icon} ${issue.title}`);
      console.log(`     ${issue.detail}`);
      console.log(`     Fix: ${issue.fix}\n`);
    }

    if (report.positives?.length) {
      console.log('─'.repeat(60));
      console.log('  WHAT\'S WORKING\n');
      report.positives.forEach(p => console.log(`  ✓ ${p}`));
      console.log('');
    }

    console.log('─'.repeat(60));
    console.log(`  Competitor gap: ${report.competitorGap}`);
    console.log('═'.repeat(60) + '\n');

    // ── Save full JSON report ─────────────────────────────────────────────
    const reportsDir = path.join(__dirname, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    const domain = new URL(url).hostname.replace(/\./g, '_');
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const outPath = path.join(reportsDir, `${domain}-${timestamp}.json`);

    fs.writeFileSync(outPath, JSON.stringify({ url, scannedAt: new Date().toISOString(), ...report }, null, 2));
    console.log(`  📄 Full report saved: ${outPath}\n`);

  } catch (err) {
    console.error('\n❌ Audit failed:', err.message);
    process.exit(1);
  }
})();
