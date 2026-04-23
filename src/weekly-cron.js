/**
 * weekly-cron.js
 * Runs every Monday morning. For every user who opted in to weekly emails:
 *   1. Find their most-recent audit with raw_data
 *   2. Re-run the AI analysis against that stored data (cheap — no re-crawl)
 *   3. Compare new score to previous — compose a changeSummary
 *   4. Send them an email
 *   5. Record a snapshot for Phase 2 (score history)
 *   6. Mark user as emailed-this-week
 *
 * Usage:
 *   node src/weekly-cron.js           # process all due users
 *   node src/weekly-cron.js --dry-run # process but don't email or persist
 *   node src/weekly-cron.js --user=<userId>  # just process one user (for testing)
 */

const db = require('./db');
const email = require('./email');
const scorer = require('./scorer-ai');

const DRY_RUN = process.argv.includes('--dry-run');
const SPECIFIC_USER = (process.argv.find(a => a.startsWith('--user=')) || '').replace('--user=', '');
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://builderaudit.co.uk';

function log(...args) { console.log('[weekly-cron]', ...args); }

/* Build a human-readable "what changed" summary from delta between old and new analysis */
function buildChangeSummary(oldReport, newReport) {
  const parts = [];

  const oldIssues = new Set((oldReport?.trust_breakpoints || []).map(b => b.title || '').filter(Boolean));
  const newIssues = new Set((newReport?.trust_breakpoints || []).map(b => b.title || '').filter(Boolean));

  const resolved = [...oldIssues].filter(x => !newIssues.has(x));
  const appeared = [...newIssues].filter(x => !oldIssues.has(x));

  if (resolved.length > 0) {
    parts.push(`${resolved.length} issue${resolved.length > 1 ? 's' : ''} no longer flagged: ${resolved.slice(0, 2).join('; ')}${resolved.length > 2 ? '…' : ''}`);
  }
  if (appeared.length > 0) {
    parts.push(`${appeared.length} new issue${appeared.length > 1 ? 's' : ''} detected: ${appeared.slice(0, 2).join('; ')}${appeared.length > 2 ? '…' : ''}`);
  }

  if (parts.length === 0) {
    const newCount = newIssues.size;
    return `${newCount} issue${newCount === 1 ? '' : 's'} tracked. Run a fresh audit to catch changes on your live site.`;
  }
  return parts.join('. ') + '.';
}

async function processUser(user) {
  log(`Processing user ${user.id} (${user.email})`);

  /* Find their primary audit */
  const audit = await db.getPrimaryAuditForUser(user.id);
  if (!audit) {
    log(`  → no audits with raw_data, skipping`);
    return { skipped: 'no-audit' };
  }

  log(`  → primary audit: ${audit.id} (current score ${audit.score})`);

  /* Get previous score — from the last snapshot if present, else the audit.score itself */
  const lastSnapshot = await db.getLatestSnapshot(audit.id);
  const previousScore = lastSnapshot?.score != null ? lastSnapshot.score : (audit.score || 0);

  /* Re-analyse using stored raw data */
  const rawData = audit.raw_data;
  if (!rawData || !rawData.pages) {
    log(`  → audit has no raw data, skipping`);
    return { skipped: 'no-raw-data' };
  }

  const userContext = {
    businessType: user.business_type,
    region: user.region,
    companyName: user.company_name,
  };

  log(`  → running AI re-analysis...`);
  let newReport;
  try {
    newReport = await scorer.scoreWebsite(
      rawData.pages,
      audit.url,
      rawData.imageVerification || null,
      audit.overrides || {},
      userContext,
      audit.audience || 'builder'
    );
  } catch (err) {
    log(`  ✗ re-analysis failed: ${err.message}`);
    return { error: err.message };
  }

  const newScore = newReport?.hero?.score || 0;
  const changeSummary = buildChangeSummary(audit.report_json, newReport);
  log(`  → new score: ${newScore} (was ${previousScore}, delta ${newScore - previousScore > 0 ? '+' : ''}${newScore - previousScore})`);
  log(`  → summary: ${changeSummary}`);

  if (DRY_RUN) {
    log(`  → DRY RUN — skipping save + email`);
    return { dryRun: true, newScore, previousScore, changeSummary };
  }

  /* Persist the new analysis */
  await db.updateAnalysis(audit.id, newReport);

  /* Create a snapshot for score history */
  await db.createSnapshot({
    auditId: audit.id,
    score: newScore,
    summary: { delta: newScore - previousScore, changeSummary, source: 'weekly_cron' },
  });

  /* Send the email */
  const emailResult = await email.sendWeeklyCheckIn({
    user: {
      email: user.email,
      companyName: user.company_name,
      businessType: user.business_type,
      region: user.region,
    },
    audit: { id: audit.id, url: audit.url },
    previousScore,
    newScore,
    changeSummary,
    appBaseUrl: APP_BASE_URL,
  });

  if (emailResult.success) {
    await db.markWeeklyEmailSent(user.id);
    log(`  ✓ email sent to ${user.email}`);
  } else {
    log(`  ✗ email failed: ${emailResult.error || 'unknown'}`);
  }

  return { success: true, newScore, previousScore, emailSent: emailResult.success };
}

async function main() {
  log(`=== Weekly cron starting at ${new Date().toISOString()} ===`);
  log(`DRY_RUN=${DRY_RUN} SPECIFIC_USER=${SPECIFIC_USER || '(all)'}`);

  if (!db.isEnabled()) {
    log('✗ Database not configured, aborting');
    process.exit(1);
  }
  if (!email.isEnabled() && !DRY_RUN) {
    log('✗ Email not configured, aborting (use --dry-run to test without emails)');
    process.exit(1);
  }

  /* Ensure schema is in place before we query new columns */
  await db.initSchema();

  let users;
  if (SPECIFIC_USER) {
    const u = await db.getUserById(SPECIFIC_USER);
    users = u ? [u] : [];
  } else {
    users = await db.getUsersDueForWeeklyEmail();
  }

  log(`Found ${users.length} user(s) to process`);

  const results = { success: 0, skipped: 0, errored: 0 };

  for (const user of users) {
    try {
      const r = await processUser(user);
      if (r.success || r.dryRun) results.success++;
      else if (r.error) results.errored++;
      else results.skipped++;
    } catch (err) {
      log(`✗ Unhandled error for user ${user.id}: ${err.message}`);
      results.errored++;
    }
  }

  log(`=== Done. Success: ${results.success} | Skipped: ${results.skipped} | Errored: ${results.errored} ===`);
  process.exit(0);
}

main().catch(err => {
  console.error('[weekly-cron] Fatal error:', err);
  process.exit(1);
});
