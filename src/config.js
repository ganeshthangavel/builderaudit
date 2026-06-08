/**
 * config.js
 *
 * Snapshots all relevant environment variables at module load time and
 * EXPORTS the snapshot immediately, before any logging or side effects.
 *
 * This ordering matters: if anything in the boot logs throws or any other
 * module is imported mid-load, exporting first ensures consumers get the
 * real snapshot rather than `{}`.
 *
 * Originally added to work around Railway Runtime V2 env-stripping; still
 * useful as a single source of truth for env vars across the codebase.
 */

const config = Object.freeze({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
  DATABASE_URL: process.env.DATABASE_URL || null,
  JWT_SECRET: process.env.JWT_SECRET || null,
  SERPAPI_KEY: process.env.SERPAPI_KEY || null,
  SCRAPFLY_API_KEY: process.env.SCRAPFLY_API_KEY || null,
  RESEND_API_KEY: process.env.RESEND_API_KEY || null,
  ENQUIRY_TO_EMAIL: process.env.ENQUIRY_TO_EMAIL || null,
  FROM_EMAIL: process.env.FROM_EMAIL || null,
  APP_BASE_URL: process.env.APP_BASE_URL || null,
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || '3000',
});

/* EXPORT FIRST — before any logging or potential side effects.
   This way any consumer who imports us gets the real object, even if
   something downstream throws. */
module.exports = config;

/* Boot-time logging — helpful for diagnosing env var configuration.
   Wrapped in try/catch so a logging error can never break exports. */
try {
  console.log('[config] Snapshotted env at boot:');
  console.log('  DATABASE_URL:    ' + (config.DATABASE_URL ? `present (length ${config.DATABASE_URL.length})` : '✗ MISSING'));
  console.log('  ANTHROPIC_API_KEY: ' + (config.ANTHROPIC_API_KEY ? `present (length ${config.ANTHROPIC_API_KEY.length})` : '✗ MISSING'));
  console.log('  JWT_SECRET:      ' + (config.JWT_SECRET ? 'present' : '✗ MISSING'));
  console.log('  SERPAPI_KEY:     ' + (config.SERPAPI_KEY ? 'present' : '✗ MISSING'));
  console.log('  SCRAPFLY_API_KEY: ' + (config.SCRAPFLY_API_KEY ? 'present' : '✗ MISSING (crawler will refuse to run)'));
  console.log('  RESEND_API_KEY:  ' + (config.RESEND_API_KEY ? 'present' : '✗ MISSING'));
  console.log('  ENQUIRY_TO_EMAIL: ' + (config.ENQUIRY_TO_EMAIL || '(default)'));
  console.log('  FROM_EMAIL:      ' + (config.FROM_EMAIL || '(default)'));
} catch (err) {
  console.error('[config] Logging error (ignored):', err.message);
}
