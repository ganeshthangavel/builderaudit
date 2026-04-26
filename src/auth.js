/**
 * auth.js
 * Password hashing (bcrypt) + session tokens (JWT) + auth middleware.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

const JWT_SECRET = config.JWT_SECRET || config.ANTHROPIC_API_KEY || 'dev-fallback-secret-please-set-JWT_SECRET';
const SESSION_COOKIE = 'ba_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

if (!config.JWT_SECRET) {
  console.warn('⚠  JWT_SECRET not set in env — using fallback. Set JWT_SECRET in Railway for production.');
}

async function hashPassword(plain) {
  if (!plain || plain.length < 8) throw new Error('Password must be at least 8 characters');
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

function issueSession(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function readSession(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setSessionCookie(res, userId) {
  const token = issueSession(userId);
  res.cookie(SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { sameSite: 'lax', secure: true });
}

// Middleware: attaches req.user if a valid session cookie is present
async function attachUser(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return next();
  const payload = readSession(token);
  if (!payload) return next();
  try {
    const user = await db.getUserById(payload.uid);
    if (user) req.user = user;
  } catch (err) {
    console.warn('attachUser failed:', err.message);
  }
  next();
}

// Middleware: requires the user to be logged in, else 401 JSON response
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  issueSession,
  readSession,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
};
