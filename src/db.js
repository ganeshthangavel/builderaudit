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
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS audience TEXT DEFAULT 'builder'`);

  /* User preferences for retention emails */
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_email_opt_in BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_weekly_email_at TIMESTAMPTZ`);

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

  /* Step 6a: audit_snapshots table — for score history + delta detection */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_snapshots (
      id SERIAL PRIMARY KEY,
      audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
      score INTEGER,
      summary JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_audit ON audit_snapshots(audit_id, created_at DESC);
  `);

  /* Step 6: enquiries table — services the user has requested help with */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      audit_id TEXT REFERENCES audits(id) ON DELETE SET NULL,
      service TEXT NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_enquiries_user ON enquiries(user_id);
    CREATE INDEX IF NOT EXISTS idx_enquiries_audit ON enquiries(audit_id);
    CREATE INDEX IF NOT EXISTS idx_enquiries_created_at ON enquiries(created_at DESC);
  `);

  console.log('✓ Database schema ready');
}

// ═════════════════════════════════════════════════════════════════════════════
// ENQUIRIES
// ═════════════════════════════════════════════════════════════════════════════

async function createEnquiry({ id, userId, auditId, service, notes }) {
  if (!pool) throw new Error('Database not configured');

  await pool.query(
    `INSERT INTO enquiries (id, user_id, audit_id, service, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, auditId || null, service, notes || null]
  );
  return { id };
}

async function listEnquiriesForUser(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, audit_id, service, notes, status, created_at, responded_at
     FROM enquiries
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
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
    `SELECT id, email, password_hash, company_name, business_type, region, created_at,
            weekly_email_opt_in, last_weekly_email_at
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, email, company_name, business_type, region, created_at,
            weekly_email_opt_in, last_weekly_email_at
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

async function saveAudit({ id, userId, url, report, rawData, audience }) {
  if (!pool) throw new Error('Database not configured');

  const score = report?.hero?.score || null;

  await pool.query(
    `INSERT INTO audits (id, user_id, url, score, report_json, raw_data, audience, last_analyzed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [id, userId || null, url, score, report, rawData || null, audience || 'builder']
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
    `SELECT id, user_id, url, email, score, report_json, raw_data, overrides, audience,
            created_at, last_analyzed_at, unlocked_at
     FROM audits WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getAuditMeta(id) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, url, email, score, audience, created_at, last_analyzed_at, unlocked_at,
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

// ═════════════════════════════════════════════════════════════════════════════
// USER PREFERENCES (weekly email opt-in, etc.)
// ═════════════════════════════════════════════════════════════════════════════

async function updateUserSettings(userId, settings) {
  if (!pool) throw new Error('Database not configured');
  var fields = [];
  var values = [];
  var idx = 1;
  if (typeof settings.weeklyEmailOptIn === 'boolean') {
    fields.push(`weekly_email_opt_in = $${idx++}`);
    values.push(settings.weeklyEmailOptIn);
  }
  if (fields.length === 0) return;
  values.push(userId);
  await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function markWeeklyEmailSent(userId) {
  if (!pool) return;
  await pool.query(`UPDATE users SET last_weekly_email_at = NOW() WHERE id = $1`, [userId]);
}

// ═════════════════════════════════════════════════════════════════════════════
// AUDIT SNAPSHOTS (score history)
// ═════════════════════════════════════════════════════════════════════════════

async function createSnapshot({ auditId, score, summary }) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO audit_snapshots (audit_id, score, summary) VALUES ($1, $2, $3)`,
    [auditId, score, summary || null]
  );
}

async function getLatestSnapshot(auditId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, audit_id, score, summary, created_at
     FROM audit_snapshots
     WHERE audit_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [auditId]
  );
  return rows[0] || null;
}

async function listSnapshots(auditId, limit) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, audit_id, score, summary, created_at
     FROM audit_snapshots
     WHERE audit_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [auditId, limit || 20]
  );
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// BATCH: fetch users due for weekly email
// ═════════════════════════════════════════════════════════════════════════════

/* Returns users who:
   - have weekly_email_opt_in = true
   - have at least one saved audit with raw_data (so we can re-analyse)
   - have not received a weekly email in the last 6 days (to avoid duplicates on manual runs)
*/
async function getUsersDueForWeeklyEmail() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.email, u.company_name, u.business_type, u.region, u.last_weekly_email_at
     FROM users u
     WHERE u.weekly_email_opt_in = TRUE
       AND EXISTS (
         SELECT 1 FROM audits a
         WHERE a.user_id = u.id AND a.raw_data IS NOT NULL
       )
       AND (u.last_weekly_email_at IS NULL
            OR u.last_weekly_email_at < NOW() - INTERVAL '6 days')
     ORDER BY u.id`
  );
  return rows;
}

/* For a given user, returns their most-recent audit that has raw_data */
async function getPrimaryAuditForUser(userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, url, score, report_json, raw_data, overrides, audience,
            created_at, last_analyzed_at
     FROM audits
     WHERE user_id = $1 AND raw_data IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

module.exports = {
  initSchema,
  // users
  createUser,
  getUserByEmail,
  getUserById,
  recordLogin,
  updateUserSettings,
  markWeeklyEmailSent,
  // audits
  saveAudit,
  updateAnalysis,
  getAudit,
  getAuditMeta,
  listAuditsForUser,
  unlockAudit,
  claimAudit,
  setImageOverride,
  // snapshots (score history)
  createSnapshot,
  getLatestSnapshot,
  listSnapshots,
  // weekly email batch helpers
  getUsersDueForWeeklyEmail,
  getPrimaryAuditForUser,
  // enquiries
  createEnquiry,
  listEnquiriesForUser,
  isEnabled: () => !!pool,
};
