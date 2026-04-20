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
      overrides JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      unlocked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_audits_email ON audits(email);
    CREATE INDEX IF NOT EXISTS idx_audits_created_at ON audits(created_at DESC);

    ALTER TABLE audits ADD COLUMN IF NOT EXISTS overrides JSONB DEFAULT '{}'::jsonb;
  `);

  console.log('✓ Database schema ready');
}

// ── Save a new audit ──────────────────────────────────────────────────────────
async function saveAudit({ id, url, report }) {
  if (!pool) throw new Error('Database not configured');

  const score = report?.hero?.score || null;

  await pool.query(
    `INSERT INTO audits (id, url, score, report_json)
     VALUES ($1, $2, $3, $4)`,
    [id, url, score, report]
  );

  return { id, url, score };
}

// ── Get audit by id ───────────────────────────────────────────────────────────
async function getAudit(id) {
  if (!pool) throw new Error('Database not configured');

  const { rows } = await pool.query(
    `SELECT id, url, email, score, report_json, created_at, unlocked_at
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
    `SELECT id, url, email, score, created_at, unlocked_at
     FROM audits WHERE id = $1`,
    [id]
  );

  return rows[0] || null;
}

/* Save or clear an override for a specific flagged image.
 * overrides format: { "image_src_url": "accepted" | "rejected" }
 * "accepted" = user says the flag is valid
 * "rejected" = user says "this is actually mine, don't penalise"
 */
async function setImageOverride(auditId, imageSrc, decision) {
  if (!pool) throw new Error('Database not configured');
  const validDecisions = ['accepted', 'rejected', null];
  if (!validDecisions.includes(decision)) throw new Error('Invalid decision');

  /* Read, modify, write back — safest for arbitrary keys (URLs contain slashes, special chars) */
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
  getAudit,
  getAuditMeta,
  unlockAudit,
  setImageOverride,
  isEnabled: () => !!pool,
};
