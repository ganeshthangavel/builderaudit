/**
 * config.js
 *
 * Snapshots all relevant environment variables at module load time.
 *
 * Why this exists: Railway's Runtime V2 beta (RAILWAY_BETA_ENABLE_RUNTIME_V2=1)
 * strips user-defined environment variables from process.env *between* module
 * load and HTTP request handling. They are present at boot; they are gone at
 * request time.
 *
 * This module is loaded BEFORE the broken behaviour kicks in (i.e. at startup,
 * before any HTTP listener is established). It captures the values into a
 * frozen object that we then export, so all later code uses these snapshots
 * instead of reading process.env directly.
 *
 * Once Railway disables Runtime V2 for your service, you can revert to direct
 * process.env reads — but until then, ALL code that needs an env var should
 * import it from here.
 */

const config = Object.freeze({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
  DATABASE_URL: process.env.DATABASE_URL || null,
  JWT_SECRET: process.env.JWT_SECRET || null,
  SERPAPI_KEY: process.env.SERPAPI_KEY || null,
  RESEND_API_KEY: process.env.RESEND_API_KEY || null,
  ENQUIRY_TO_EMAIL: process.env.ENQUIRY_TO_EMAIL || null,
  FROM_EMAIL: process.env.FROM_EMAIL || null,
  APP_BASE_URL: process.env.APP_BASE_URL || null,
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || '3000',
});

/* Boot-time logging — helps diagnose Railway env var issues. */
console.log('[config] Snapshotted env at boot:');
console.log('  DATABASE_URL:    ' + (config.DATABASE_URL ? `present (length ${config.DATABASE_URL.length})` : '✗ MISSING'));
console.log('  ANTHROPIC_API_KEY: ' + (config.ANTHROPIC_API_KEY ? `present (length ${config.ANTHROPIC_API_KEY.length})` : '✗ MISSING'));
console.log('  JWT_SECRET:      ' + (config.JWT_SECRET ? 'present' : '✗ MISSING'));
console.log('  SERPAPI_KEY:     ' + (config.SERPAPI_KEY ? 'present' : '✗ MISSING'));
console.log('  RESEND_API_KEY:  ' + (config.RESEND_API_KEY ? 'present' : '✗ MISSING'));
console.log('  ENQUIRY_TO_EMAIL: ' + (config.ENQUIRY_TO_EMAIL || '(default)'));
console.log('  FROM_EMAIL:      ' + (config.FROM_EMAIL || '(default)'));

module.exports = config;
