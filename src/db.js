/**
 * db.js
 * Postgres connection + schema + query helpers.
 * Tables: users, audits (linked by user_id)
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('⚠  DATABASE_URL not set — database features disabled.');
}

const pool = connectionString ? new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
}) : null;

// ── Schema setup ──────────────────────────────────────────────────────────────
async function initSchema() {
  if (!pool) return;

  /* Step 1: ensure users table exists FIRST (audits references it) */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT,
      business_type TEXT,
      region TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  /* Step 2: ensure audits table exists (no foreign key constraints in CREATE) */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      email TEXT,
      score INTEGER,
      report_json JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      unlocked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_audits_email ON audits(email);
    CREATE INDEX IF NOT EXISTS idx_audits_created_at ON audits(created_at DESC);
  `);

  /* Step 3: add every optional column one-by-one. IF NOT EXISTS makes these safe to re-run. */
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS overrides JSONB DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS raw_data JSONB`);
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS last_analyzed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS user_id TEXT`);

  /* Step 4: add indexes that depend on the new columns */
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audits_user ON audits(user_id)`);

  /* Step 5: add the foreign key constraint ONLY if it does not already exist */
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'audits_user_id_fkey'
          AND table_name = 'audits'
      ) THEN
        ALTER TABLE audits
          ADD CONSTRAINT audits_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  console.log('✓ Database schema ready');
}

// ═════════════════════════════════════════════════════════════════════════════
// USERS
// ═════════════════════════════════════════════════════════════════════════════

async function createUser({ id, email, passwordHash, companyName, businessType, region }) {
  if (!pool) throw new Error('Database not configured');

  try {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, company_name, business_type, region)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email.toLowerCase().trim(), passwordHash, companyName, businessType, region]
    );
    return { id, email, companyName, businessType, region };
  } catch (err) {
    if (err.code === '23505') {
      throw new Error('An account with this email already exists');
    }
    throw err;
  }
}

async function getUserByEmail(email) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, company_name, business_type, region, created_at
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, email, company_name, business_type, region, created_at
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function recordLogin(userId) {
  if (!pool) return;
  await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
}

// ═════════════════════════════════════════════════════════════════════════════
// AUDITS
// ═════════════════════════════════════════════════════════════════════════════

async function saveAudit({ id, userId, url, report, rawData }) {
  if (!pool) throw new Error('Database not configured');

  const score = report?.hero?.score || null;

  await pool.query(
    `INSERT INTO audits (id, user_id, url, score, report_json, raw_data, last_analyzed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [id, userId || null, url, score, report, rawData || null]
  );

  return { id, url, score };
}

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

async function getAudit(id) {
  if (!pool) throw new Error('Database not configured');
  const { rows } = await pool.query(
    `SELECT id, user_id, url, email, score, report_json, raw_data, overrides,
            created_at, last_analyzed_at, unlocked_at
     FROM audits WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getAuditMeta(id) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, url, email, score, created_at, last_analyzed_at, unlocked_at,
            (raw_data IS NOT NULL) AS has_raw_data
     FROM audits WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// List all audits for a user — newest first
async function listAuditsForUser(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, url, score, created_at, last_analyzed_at
     FROM audits
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function unlockAudit(id, email) {
  if (!pool) throw new Error('Database not configured');
  await pool.query(
    `UPDATE audits SET email = $1, unlocked_at = NOW() WHERE id = $2`,
    [email.toLowerCase().trim(), id]
  );
}

// Link an existing anonymous audit to a user (when they sign up after running an audit)
async function claimAudit(auditId, userId) {
  if (!pool) throw new Error('Database not configured');
  await pool.query(
    `UPDATE audits SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
    [userId, auditId]
  );
}

async function setImageOverride(auditId, imageSrc, decision) {
  if (!pool) throw new Error('Database not configured');
  const validDecisions = ['accepted', 'rejected', null];
  if (!validDecisions.includes(decision)) throw new Error('Invalid decision');

  const { rows } = await pool.query(`SELECT overrides FROM audits WHERE id = $1`, [auditId]);
  if (rows.length === 0) throw new Error('Audit not found');

  const current = rows[0].overrides || {};
  if (decision === null) delete current[imageSrc];
  else current[imageSrc] = decision;

  await pool.query(
    `UPDATE audits SET overrides = $1::jsonb WHERE id = $2`,
    [JSON.stringify(current), auditId]
  );
  return current;
}

module.exports = {
  initSchema,
  // users
  createUser,
  getUserByEmail,
  getUserById,
  recordLogin,
  // audits
  saveAudit,
  updateAnalysis,
  getAudit,
  getAuditMeta,
  listAuditsForUser,
  unlockAudit,
  claimAudit,
  setImageOverride,
  isEnabled: () => !!pool,
};
