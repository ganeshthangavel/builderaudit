/**
 * db.js
 * Postgres connection + schema + query helpers for audits.
 * Auto-creates the audits table on first run.
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('⚠  DATABASE_URL not set — database features disabled. Add DATABASE_URL in Railway to enable saved reports.');
}

const pool = connectionString ? new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
}) : null;

// ── Schema setup ──────────────────────────────────────────────────────────────
async function initSchema() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      email TEXT,
      score INTEGER,
      report_json JSONB NOT NULL,
      raw_data JSONB,
      overrides JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_analyzed_at TIMESTAMPTZ,
      unlocked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_audits_email ON audits(email);
    CREATE INDEX IF NOT EXISTS idx_audits_created_at ON audits(created_at DESC);

    ALTER TABLE audits ADD COLUMN IF NOT EXISTS overrides JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE audits ADD COLUMN IF NOT EXISTS raw_data JSONB;
    ALTER TABLE audits ADD COLUMN IF NOT EXISTS last_analyzed_at TIMESTAMPTZ;
  `);

  console.log('✓ Database schema ready');
}

// ── Save a new audit ──────────────────────────────────────────────────────────
async function saveAudit({ id, url, report, rawData }) {
  if (!pool) throw new Error('Database not configured');

  const score = report?.hero?.score || null;

  await pool.query(
    `INSERT INTO audits (id, url, score, report_json, raw_data, last_analyzed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [id, url, score, report, rawData || null]
  );

  return { id, url, score };
}

// ── Update existing audit with new analysis (same raw data, new AI output) ───
async function updateAnalysis(id, report) {
  if (!pool) throw new Error('Database not configured');

  const score = report?.hero?.score || null;

  await pool.query(
    `UPDATE audits
     SET report_json = $1, score = $2, last_analyzed_at = NOW()
     WHERE id = $3`,
    [report, score, id]
  );

  return { id, score };
}

// ── Get audit by id ───────────────────────────────────────────────────────────
async function getAudit(id) {
  if (!pool) throw new Error('Database not configured');

  const { rows } = await pool.query(
    `SELECT id, url, email, score, report_json, raw_data, overrides, created_at, last_analyzed_at, unlocked_at
     FROM audits WHERE id = $1`,
    [id]
  );

  return rows[0] || null;
}

// ── Unlock audit with email ───────────────────────────────────────────────────
async function unlockAudit(id, email) {
  if (!pool) throw new Error('Database not configured');

  await pool.query(
    `UPDATE audits
     SET email = $1, unlocked_at = NOW()
     WHERE id = $2`,
    [email.toLowerCase().trim(), id]
  );
}

// ── Get meta only (no full report JSON) — for existence check ────────────────
async function getAuditMeta(id) {
  if (!pool) return null;

  const { rows } = await pool.query(
    `SELECT id, url, email, score, created_at, last_analyzed_at, unlocked_at,
            (raw_data IS NOT NULL) AS has_raw_data
     FROM audits WHERE id = $1`,
    [id]
  );

  return rows[0] || null;
}

/* Save or clear an override for a specific flagged image.
 * overrides format: { "image_src_url": "accepted" | "rejected" }
 */
async function setImageOverride(auditId, imageSrc, decision) {
  if (!pool) throw new Error('Database not configured');
  const validDecisions = ['accepted', 'rejected', null];
  if (!validDecisions.includes(decision)) throw new Error('Invalid decision');

  const { rows } = await pool.query(
    `SELECT overrides FROM audits WHERE id = $1`,
    [auditId]
  );
  if (rows.length === 0) throw new Error('Audit not found');

  const current = rows[0].overrides || {};

  if (decision === null) {
    delete current[imageSrc];
  } else {
    current[imageSrc] = decision;
  }

  await pool.query(
    `UPDATE audits SET overrides = $1::jsonb WHERE id = $2`,
    [JSON.stringify(current), auditId]
  );

  return current;
}

module.exports = {
  initSchema,
  saveAudit,
  updateAnalysis,
  getAudit,
  getAuditMeta,
  unlockAudit,
  setImageOverride,
  isEnabled: () => !!pool,
};
