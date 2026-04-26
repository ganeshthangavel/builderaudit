/**
 * db.js
 * Postgres connection + schema + query helpers.
 * Tables: users, audits (linked by user_id)
 *
 * IMPORTANT: pool is initialised lazily via getPool() because Railway injects
 * env var references AFTER module load. Reading process.env.DATABASE_URL at
 * module load returns undefined; reading it at first use returns the resolved
 * connection string. See: Railway Agent diagnosis, Apr 2026.
 */

const { Pool } = require('pg');

let _pool = null;
let _initLogged = false;

function getPool() {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    if (!_initLogged) {
      console.warn('⚠  DATABASE_URL not set — database features disabled.');
      _initLogged = true;
    }
    return null;
  }

  _pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  if (!_initLogged) {
    console.log('✓ Postgres pool initialised (DATABASE_URL length: ' + connectionString.length + ')');
    _initLogged = true;
  }

  /* Kick off schema migration once the pool exists. This handles the Railway
     case where DATABASE_URL is injected after module load — the startup
     initSchema() call no-op'd, so we trigger migration on first real DB use.
     Don't await here; just fire-and-forget so callers don't hang. */
  ensureSchema();

  return _pool;
}

/* Ensure the schema has been migrated. Runs once per process. Triggered
   automatically on first DB access via the helpers below — so we self-heal
   the case where Railway hadn't injected DATABASE_URL yet at module load
   and the startup initSchema() call silently no-op'd. */
let _schemaPromise = null;
function ensureSchema() {
  if (_schemaPromise) return _schemaPromise;
  if (!getPool()) return Promise.resolve(); /* no DB anyway */
  _schemaPromise = initSchema().catch(err => {
    console.error('Lazy schema init failed:', err.message);
    _schemaPromise = null; /* allow retry on next call */
  });
  return _schemaPromise;
}

// ── Schema setup ──────────────────────────────────────────────────────────────
async function initSchema() {
  if (!getPool()) return;

  /* Each migration step is wrapped independently. If one fails, the others still run.
     This prevents a single quirk (e.g. a pre-existing constraint with a different name)
     from leaving the DB partially migrated — which is what caused the 500 errors. */
  async function step(label, sql) {
    try {
      await getPool().query(sql);
      // console.log('✓ migration:', label);
    } catch (err) {
      console.warn('⚠ migration skipped [' + label + ']:', err.message);
    }
  }

  /* Step 1: users table (referenced by audits FK) */
  await step('create users table', `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT,
      business_type TEXT,
      region TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    )
  `);
  await step('index users.email', `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

  /* Step 2: audits table (no FK at create time — we add it later defensively) */
  await step('create audits table', `
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      email TEXT,
      score INTEGER,
      report_json JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      unlocked_at TIMESTAMPTZ
    )
  `);
  await step('index audits.email',      `CREATE INDEX IF NOT EXISTS idx_audits_email ON audits(email)`);
  await step('index audits.created_at', `CREATE INDEX IF NOT EXISTS idx_audits_created_at ON audits(created_at DESC)`);

  /* Step 3: add every optional column individually. One failure cannot block another. */
  await step('audits.overrides',         `ALTER TABLE audits ADD COLUMN IF NOT EXISTS overrides JSONB DEFAULT '{}'::jsonb`);
  await step('audits.raw_data',          `ALTER TABLE audits ADD COLUMN IF NOT EXISTS raw_data JSONB`);
  await step('audits.last_analyzed_at',  `ALTER TABLE audits ADD COLUMN IF NOT EXISTS last_analyzed_at TIMESTAMPTZ`);
  await step('audits.user_id',           `ALTER TABLE audits ADD COLUMN IF NOT EXISTS user_id TEXT`);
  await step('audits.audience',          `ALTER TABLE audits ADD COLUMN IF NOT EXISTS audience TEXT DEFAULT 'builder'`);

  /* User preferences for retention emails */
  await step('users.weekly_email_opt_in',  `ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_email_opt_in BOOLEAN DEFAULT FALSE`);
  await step('users.last_weekly_email_at', `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_weekly_email_at TIMESTAMPTZ`);

  /* Step 4: indexes on new columns */
  await step('index audits.user_id', `CREATE INDEX IF NOT EXISTS idx_audits_user ON audits(user_id)`);

  /* Step 5: FK constraint — wrapped in DO $$ to be idempotent + failure-tolerant */
  await step('audits FK to users', `
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
  await step('create audit_snapshots table', `
    CREATE TABLE IF NOT EXISTS audit_snapshots (
      id SERIAL PRIMARY KEY,
      audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
      score INTEGER,
      summary JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await step('index audit_snapshots', `CREATE INDEX IF NOT EXISTS idx_snapshots_audit ON audit_snapshots(audit_id, created_at DESC)`);

  /* Step 6: enquiries table */
  await step('create enquiries table', `
    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      audit_id TEXT REFERENCES audits(id) ON DELETE SET NULL,
      service TEXT NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    )
  `);
  await step('index enquiries.user',       `CREATE INDEX IF NOT EXISTS idx_enquiries_user ON enquiries(user_id)`);
  await step('index enquiries.audit',      `CREATE INDEX IF NOT EXISTS idx_enquiries_audit ON enquiries(audit_id)`);
  await step('index enquiries.created_at', `CREATE INDEX IF NOT EXISTS idx_enquiries_created_at ON enquiries(created_at DESC)`);

  console.log('✓ Database schema ready');
}

// ═════════════════════════════════════════════════════════════════════════════
// ENQUIRIES
// ═════════════════════════════════════════════════════════════════════════════

async function createEnquiry({ id, userId, auditId, service, notes }) {
  if (!getPool()) throw new Error('Database not configured');

  await getPool().query(
    `INSERT INTO enquiries (id, user_id, audit_id, service, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, auditId || null, service, notes || null]
  );
  return { id };
}

async function listEnquiriesForUser(userId) {
  if (!getPool()) return [];
  const { rows } = await getPool().query(
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
  if (!getPool()) throw new Error('Database not configured');

  try {
    await getPool().query(
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
  if (!getPool()) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT id, email, password_hash, company_name, business_type, region, created_at,
              weekly_email_opt_in, last_weekly_email_at
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703') {
      console.warn('getUserByEmail fallback: retention columns missing');
      const { rows } = await getPool().query(
        `SELECT id, email, password_hash, company_name, business_type, region, created_at
         FROM users WHERE email = $1`,
        [email.toLowerCase().trim()]
      );
      return rows[0] || null;
    }
    throw err;
  }
}

async function getUserById(id) {
  if (!getPool()) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT id, email, company_name, business_type, region, created_at,
              weekly_email_opt_in, last_weekly_email_at
       FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703') {
      console.warn('getUserById fallback: retention columns missing');
      const { rows } = await getPool().query(
        `SELECT id, email, company_name, business_type, region, created_at
         FROM users WHERE id = $1`,
        [id]
      );
      return rows[0] || null;
    }
    throw err;
  }
}

async function recordLogin(userId) {
  if (!getPool()) return;
  await getPool().query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
}

// ═════════════════════════════════════════════════════════════════════════════
// AUDITS
// ═════════════════════════════════════════════════════════════════════════════

async function saveAudit({ id, userId, url, report, rawData, audience }) {
  if (!getPool()) throw new Error('Database not configured');

  const score = report?.hero?.score || null;

  try {
    await getPool().query(
      `INSERT INTO audits (id, user_id, url, score, report_json, raw_data, audience, last_analyzed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [id, userId || null, url, score, report, rawData || null, audience || 'builder']
    );
  } catch (err) {
    /* If a new column is missing in the DB (e.g. audience, raw_data, or last_analyzed_at),
       fall back to the minimum viable INSERT so the audit is at least saved. */
    if (err.code === '42703' /* undefined_column */) {
      console.warn('saveAudit fallback — new column missing, inserting minimal row:', err.message);
      await getPool().query(
        `INSERT INTO audits (id, user_id, url, score, report_json)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, userId || null, url, score, report]
      );
    } else {
      throw err;
    }
  }

  return { id, url, score };
}

async function updateAnalysis(id, report) {
  if (!getPool()) throw new Error('Database not configured');
  const score = report?.hero?.score || null;
  await getPool().query(
    `UPDATE audits
     SET report_json = $1, score = $2, last_analyzed_at = NOW()
     WHERE id = $3`,
    [report, score, id]
  );
  return { id, score };
}

async function getAudit(id) {
  if (!getPool()) throw new Error('Database not configured');
  try {
    const { rows } = await getPool().query(
      `SELECT id, user_id, url, email, score, report_json, raw_data, overrides, audience,
              created_at, last_analyzed_at, unlocked_at
       FROM audits WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  } catch (err) {
    /* If a new column (e.g. audience) is missing from the DB, fall back to legacy columns
       so we don't return 500s to users with old databases. Logs the problem for ops. */
    if (err.code === '42703' /* undefined_column */) {
      console.warn('getAudit fallback: column missing, retrying without new columns —', err.message);
      const { rows } = await getPool().query(
        `SELECT id, user_id, url, email, score, report_json, raw_data, overrides,
                created_at, last_analyzed_at, unlocked_at
         FROM audits WHERE id = $1`,
        [id]
      );
      if (rows[0]) rows[0].audience = 'builder'; /* default for old audits */
      return rows[0] || null;
    }
    throw err;
  }
}

async function getAuditMeta(id) {
  if (!getPool()) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT id, user_id, url, email, score, audience, created_at, last_analyzed_at, unlocked_at,
              (raw_data IS NOT NULL) AS has_raw_data
       FROM audits WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703' /* undefined_column */) {
      console.warn('getAuditMeta fallback: column missing —', err.message);
      const { rows } = await getPool().query(
        `SELECT id, user_id, url, email, score, created_at, last_analyzed_at, unlocked_at,
                (raw_data IS NOT NULL) AS has_raw_data
         FROM audits WHERE id = $1`,
        [id]
      );
      if (rows[0]) rows[0].audience = 'builder';
      return rows[0] || null;
    }
    throw err;
  }
}

// List all audits for a user — newest first
async function listAuditsForUser(userId) {
  if (!getPool()) return [];
  const { rows } = await getPool().query(
    `SELECT id, url, score, created_at, last_analyzed_at
     FROM audits
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function unlockAudit(id, email) {
  if (!getPool()) throw new Error('Database not configured');
  await getPool().query(
    `UPDATE audits SET email = $1, unlocked_at = NOW() WHERE id = $2`,
    [email.toLowerCase().trim(), id]
  );
}

// Link an existing anonymous audit to a user (when they sign up after running an audit)
async function claimAudit(auditId, userId) {
  if (!getPool()) throw new Error('Database not configured');
  await getPool().query(
    `UPDATE audits SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
    [userId, auditId]
  );
}

async function setImageOverride(auditId, imageSrc, decision) {
  if (!getPool()) throw new Error('Database not configured');
  const validDecisions = ['accepted', 'rejected', null];
  if (!validDecisions.includes(decision)) throw new Error('Invalid decision');

  const { rows } = await getPool().query(`SELECT overrides FROM audits WHERE id = $1`, [auditId]);
  if (rows.length === 0) throw new Error('Audit not found');

  const current = rows[0].overrides || {};
  if (decision === null) delete current[imageSrc];
  else current[imageSrc] = decision;

  await getPool().query(
    `UPDATE audits SET overrides = $1::jsonb WHERE id = $2`,
    [JSON.stringify(current), auditId]
  );
  return current;
}

// ═════════════════════════════════════════════════════════════════════════════
// USER PREFERENCES (weekly email opt-in, etc.)
// ═════════════════════════════════════════════════════════════════════════════

async function updateUserSettings(userId, settings) {
  if (!getPool()) throw new Error('Database not configured');
  var fields = [];
  var values = [];
  var idx = 1;
  if (typeof settings.weeklyEmailOptIn === 'boolean') {
    fields.push(`weekly_email_opt_in = $${idx++}`);
    values.push(settings.weeklyEmailOptIn);
  }
  if (fields.length === 0) return;
  values.push(userId);
  await getPool().query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function markWeeklyEmailSent(userId) {
  if (!getPool()) return;
  await getPool().query(`UPDATE users SET last_weekly_email_at = NOW() WHERE id = $1`, [userId]);
}

// ═════════════════════════════════════════════════════════════════════════════
// AUDIT SNAPSHOTS (score history)
// ═════════════════════════════════════════════════════════════════════════════

async function createSnapshot({ auditId, score, summary }) {
  if (!getPool()) return;
  await getPool().query(
    `INSERT INTO audit_snapshots (audit_id, score, summary) VALUES ($1, $2, $3)`,
    [auditId, score, summary || null]
  );
}

async function getLatestSnapshot(auditId) {
  if (!getPool()) return null;
  const { rows } = await getPool().query(
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
  if (!getPool()) return [];
  const { rows } = await getPool().query(
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
  if (!getPool()) return [];
  const { rows } = await getPool().query(
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
  if (!getPool()) return null;
  const { rows } = await getPool().query(
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
  isEnabled: () => !!getPool(),
  pool: () => getPool(),
};
