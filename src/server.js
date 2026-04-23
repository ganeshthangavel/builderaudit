const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const https = require('https');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const { customAlphabet } = require('nanoid');
const db = require('./db');
const auth = require('./auth');
const email = require('./email');
const { scoreWebsite } = require('./scorer-ai');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

const app = express();
app.use(cors({ credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.attachUser);

const PUBLIC = path.join(__dirname, '../public');

/* ── Anthropic client with explicit key + startup diagnostics ──
   The SDK auto-reads ANTHROPIC_API_KEY, but being explicit gives us
   a clear error if the env var is missing rather than a cryptic SDK error. */
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('✗ ANTHROPIC_API_KEY is not set — audits WILL fail.');
  console.error('  Check Railway → Variables → ANTHROPIC_API_KEY and redeploy.');
} else {
  const trimmed = ANTHROPIC_KEY.trim();
  if (trimmed !== ANTHROPIC_KEY) {
    console.warn('⚠ ANTHROPIC_API_KEY has leading/trailing whitespace — trimming. Consider fixing it in Railway.');
  }
  if (!trimmed.startsWith('sk-ant-')) {
    console.warn('⚠ ANTHROPIC_API_KEY does not start with "sk-ant-" — likely malformed or wrong value.');
  }
  console.log('✓ ANTHROPIC_API_KEY present (' + trimmed.slice(0, 10) + '…' + trimmed.slice(-4) + ', length ' + trimmed.length + ')');
}
const client = new Anthropic({ apiKey: ANTHROPIC_KEY ? ANTHROPIC_KEY.trim() : undefined });

const MAX_PAGES = 20;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Initialise the database on startup
db.initSchema().catch(err => console.error('DB init failed:', err.message));

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ASSETS & PAGE ROUTES
// ─────────────────────────────────────────────────────────────────────────────
// Serve static assets (CSS, JS, images)
app.use('/assets', express.static(path.join(PUBLIC, 'assets')));

// Page routes — each returns one HTML file
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'home.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(PUBLIC, 'audit.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(PUBLIC, 'signup.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC, 'dashboard.html')));
app.get('/report/:id', (req, res) => res.sendFile(path.join(PUBLIC, 'report.html')));
app.get('/report/:id/:section', (req, res) => res.sendFile(path.join(PUBLIC, 'report.html')));
app.get('/services', (req, res) => res.sendFile(path.join(PUBLIC, 'services.html')));
app.get('/check-builder', (req, res) => res.sendFile(path.join(PUBLIC, 'check-builder.html')));

// ─────────────────────────────────────────────────────────────────────────────
// STOCK DOMAINS — instant flag
// ─────────────────────────────────────────────────────────────────────────────
const STOCK_DOMAINS = [
  'shutterstock.com','istockphoto.com','gettyimages.com','getty.com',
  'dreamstime.com','depositphotos.com','alamy.com','123rf.com',
  'adobe.com/stock','stock.adobe.com','unsplash.com','pexels.com',
  'freepik.com','canva.com','pixabay.com','stocksy.com',
];

function reverseImageSearch(imageUrl) {
  return new Promise((resolve) => {
    if (!SERPAPI_KEY) return resolve({ verdict: 'unknown', reason: 'No SerpAPI key configured' });
    const params = new URLSearchParams({
      engine: 'google_reverse_image',
      image_url: imageUrl,
      api_key: SERPAPI_KEY,
    });
    const url = 'https://serpapi.com/search.json?' + params.toString();
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const allResults = [
            ...(json.image_results || []),
            ...(json.inline_images || []),
            ...(json.reverse_image_search || []),
          ];
          const sources = allResults.map(r => (r.link || r.source || '')).filter(Boolean);
          const stockMatch = sources.find(src =>
            STOCK_DOMAINS.some(domain => src.toLowerCase().includes(domain))
          );
          if (stockMatch) {
            const domain = STOCK_DOMAINS.find(d => stockMatch.toLowerCase().includes(d));
            return resolve({
              verdict: 'stock',
              reason: 'Found on ' + domain,
              source: stockMatch,
              matchCount: sources.length,
              matchedSites: [stockMatch],
            });
          }
          const externalMatches = sources.filter(src => {
            try { return !src.includes(new URL(imageUrl).hostname); } catch { return false; }
          });
          if (externalMatches.length >= 3) {
            /* Extract unique hostnames from matches */
            const hostnameMap = {};
            externalMatches.forEach(src => {
              try {
                const h = new URL(src).hostname.replace(/^www\./, '');
                if (!hostnameMap[h]) hostnameMap[h] = src;
              } catch {}
            });
            const uniqueSites = Object.entries(hostnameMap).slice(0, 8).map(([hostname, fullUrl]) => ({ hostname, url: fullUrl }));
            return resolve({
              verdict: 'duplicated',
              reason: 'Image found on ' + Object.keys(hostnameMap).length + ' other websites',
              sources: externalMatches.slice(0, 3),
              matchCount: externalMatches.length,
              matchedSites: uniqueSites,
            });
          }
          resolve({ verdict: 'original', reason: 'No stock or duplicate matches found', matchCount: sources.length });
        } catch (e) {
          resolve({ verdict: 'error', reason: 'Parse error: ' + e.message });
        }
      });
    }).on('error', (e) => resolve({ verdict: 'error', reason: 'Request failed: ' + e.message }));
  });
}

function selectImagesForVerification(allImages, max = 14) {
  /* Filter by size + exclude obvious non-project images via URL hints */
  const candidates = allImages
    .filter(img => img.width > 400 && img.height > 300)
    .filter(img => {
      /* Skip images that are clearly square (likely avatars/icons/logos) */
      const ratio = img.width / img.height;
      if (ratio > 0.85 && ratio < 1.15 && img.width < 600) return false;
      return true;
    })
    .filter(img => {
      const s = img.src.toLowerCase();
      const excludeHints = [
        'logo', 'icon', 'badge', 'avatar', 'favicon', 'headshot',
        'staff', 'profile', 'signature', 'thumb', 'sprite',
        '/team/', '/staff/', '/people/', '/about/', '/employees/',
        'accreditation', 'certification', 'trustmark', 'fmb-',
        'nhbc-', 'chas-', 'gas-safe', 'niceic-', 'checkatrade-',
        'which-trusted', 'award', 'certificate', 'illustration',
        'cartoon', 'vector', '.svg', 'graphic', 'banner-',
        'header-', 'footer-', 'nav-', 'bg-', 'background-',
        'pattern-', 'texture-', 'gradient-',
      ];
      return !excludeHints.some(h => s.includes(h));
    })
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  const seen = new Set();
  const unique = [];
  for (const img of candidates) {
    if (!seen.has(img.src)) {
      seen.add(img.src);
      unique.push(img);
    }
    if (unique.length >= max) break;
  }
  return unique;
}

/*
 * Classify images via Claude vision to only audit real project/property photos.
 * Sends the candidate images as URLs (batch) and asks Claude to return
 * which are construction work / interiors / exteriors vs UI / team / logo.
 */
async function classifyProjectImages(candidates) {
  if (candidates.length === 0) return [];

  /* Batch up to 10 images per Claude call. */
  const batches = [];
  for (let i = 0; i < candidates.length; i += 10) {
    batches.push(candidates.slice(i, i + 10));
  }

  const classifications = [];
  for (const batch of batches) {
    try {
      const imgBlocks = batch.map(img => ({
        type: 'image',
        source: { type: 'url', url: img.src },
      }));

      const prompt = 'You are classifying images from a UK construction company website. You must be STRICT and CAUTIOUS.\n\n' +
        'For each of the ' + batch.length + ' images I have provided (in order), decide whether it is a PROJECT IMAGE or NOT.\n\n' +
        'PROJECT IMAGE = A photograph (not illustration, not cartoon, not vector) of:\n' +
        '- A finished building or property (exterior, full-house shot, front view)\n' +
        '- Construction work in progress (scaffolding, bricklaying, framing)\n' +
        '- Interior rooms that show completed work (kitchens, bathrooms, living rooms, bedrooms)\n' +
        '- Extensions, loft conversions, garden/landscape work\n' +
        'These are images that prove what the builder has actually built.\n\n' +
        'NOT A PROJECT IMAGE — classify as not_project if ANY of these apply:\n' +
        '- Any photo containing a person as the main subject (team photos, headshots, portraits, staff photos, customer photos)\n' +
        '- Any illustration, cartoon, drawing, sketch, vector graphic, or animated image (NOT a real photograph)\n' +
        '- Company logos, brand marks, or wordmarks\n' +
        '- Accreditation badges or logos (FMB, NHBC, CHAS, TrustMark, Gas Safe, NICEIC, Checkatrade, Which Trusted Trader, etc)\n' +
        '- Awards, certificates, or trophy images\n' +
        '- Icons, symbols, or UI elements\n' +
        '- Charts, diagrams, floor plans, or technical drawings\n' +
        '- Decorative banners, textures, patterns, or abstract backgrounds\n' +
        '- Screenshots of anything\n' +
        '- Stock illustration style images even if they show buildings (look for cartoon/flat design style)\n\n' +
        'IMPORTANT: When in doubt, classify as not_project. False positives (flagging a team photo as a project) are worse than false negatives.\n\n' +
        'Return ONLY a JSON array with one entry per image in order. Each entry must be:\n' +
        '{"type": "project" | "not_project", "subject": "<brief description>"}\n\n' +
        'Example: [{"type":"project","subject":"kitchen extension interior"},{"type":"not_project","subject":"team member headshot"},{"type":"not_project","subject":"cartoon illustration of houses"}]\n\n' +
        'Return nothing else. No markdown, no explanation.';

      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: [...imgBlocks, { type: 'text', text: prompt }] }],
      });

      const text = resp.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(text);
      parsed.forEach((c, i) => {
        if (batch[i]) classifications.push({ ...batch[i], classification: c });
      });
    } catch (err) {
      console.warn('Classify batch failed:', err.message);
      /* On failure, assume NOT project to avoid false flags on team photos / logos */
      batch.forEach(img => classifications.push({ ...img, classification: { type: 'not_project', subject: 'classifier_failed' } }));
    }
  }

  return classifications;
}

async function verifyImages(allImages) {
  const candidates = selectImagesForVerification(allImages, 12);
  console.log('Classifying ' + candidates.length + ' candidate images...');

  /* 1. Classify with vision — only audit real project photos */
  const classified = await classifyProjectImages(candidates);
  const projectImages = classified.filter(c => c.classification?.type === 'project');
  const skippedImages = classified.filter(c => c.classification?.type !== 'project');

  console.log('Kept ' + projectImages.length + ' project images, skipped ' + skippedImages.length + ' (logos/team/icons)');

  /* Cap at 8 reverse-image lookups to save SerpAPI credits */
  const toCheck = projectImages.slice(0, 8);

  /* 2. Reverse-image search only project photos */
  const results = [];
  for (const img of toCheck) {
    const result = await reverseImageSearch(img.src);
    results.push({
      src: img.src,
      alt: img.alt,
      width: img.width,
      height: img.height,
      subject: img.classification?.subject || '',
      ...result,
    });
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    checked: results.filter(r => r.verdict !== 'error' && r.verdict !== 'unknown').length,
    total: allImages.length,
    projectImagesFound: projectImages.length,
    skippedNonProject: skippedImages.length,
    stockImages: results.filter(r => r.verdict === 'stock'),
    duplicatedImages: results.filter(r => r.verdict === 'duplicated'),
    originalImages: results.filter(r => r.verdict === 'original'),
    allResults: results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRAWLER
// ─────────────────────────────────────────────────────────────────────────────
async function crawlWebsite(startUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const visited = new Set();
  const queue = [normaliseUrl(startUrl)];
  const origin = new URL(startUrl).origin;
  const pages = [];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await context.newPage();
      await page.waitForTimeout(500 + Math.random() * 1000);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (response && (response.status() === 403 || response.status() === 429)) {
        await page.close();
        continue;
      }
      await page.waitForTimeout(1500);

      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 75 });
      const screenshotB64 = screenshot.toString('base64');

      const textContent = await page.evaluate(() => {
        const el = document.body.cloneNode(true);
        ['nav','footer','script','style','noscript'].forEach(tag => el.querySelectorAll(tag).forEach(n => n.remove()));
        return el.innerText.replace(/\s+/g, ' ').trim().slice(0, 8000);
      });

      const images = await page.evaluate(() => {
        return [...document.querySelectorAll('img')].map(img => ({
          src: img.src || '', alt: img.alt || '',
          width: img.naturalWidth, height: img.naturalHeight,
        })).filter(i => i.src.startsWith('http'));
      });

      const meta = await page.evaluate(() => {
        const text = document.body.innerText;
        const badges = ['FMB','NHBC','CHAS','TrustMark','Gas Safe','NICEIC','Checkatrade','Which? Trusted','Federation of Master Builders'];
        return {
          title: document.title,
          copyrightYear: (text.match(/\u00a9\s*(\d{4})/) || [])[1] || null,
          hasPhone: /(\+44|0\d{10}|0\d{4}\s\d{6})/.test(text),
          hasAddress: /(street|road|avenue|lane|close|drive|,\s*[A-Z]{1,2}\d)/i.test(text),
          hasVAT: /VAT\s*(no|number|reg)?\s*:?\s*\d+/i.test(text),
          hasCompaniesHouse: /company\s*(no|number|reg)?\s*:?\s*\d+/i.test(text),
          accreditations: badges.filter(b => new RegExp(b,'i').test(text)),
          testimonialCount: (text.match(/[\u201c\u201d][^\u201c\u201d]{40,}[\u201c\u201d]/g) || []).length,
          hasGoogleMaps: !!document.querySelector('iframe[src*="google.com/maps"]'),
          hasExternalReviewLinks: /checkatrade|trustpilot|google.*review|houzz|rated\.people/i.test(text),
          professionalEmail: !/gmail|hotmail|yahoo|outlook\.com/i.test(text),
        };
      });

      const links = await page.evaluate((base) => {
        return [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.startsWith(base));
      }, origin);

      links.forEach(l => {
        const clean = normaliseUrl(l);
        if (!visited.has(clean) && !queue.includes(clean)) queue.push(clean);
      });

      pages.push({ url, textContent, images, meta, screenshotB64 });
      await page.close();
    } catch (err) {
      console.warn('Failed:', url, err.message);
    }
  }

  await browser.close();
  return pages;
}

function normaliseUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch { return raw; }
}


// ─────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  serpapi: !!SERPAPI_KEY,
  database: db.isEnabled(),
}));

// Run an audit — streams progress via SSE, saves to DB on complete
app.post('/api/audit', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Please provide a valid URL starting with http/https' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

  try {
    send('status', { message: 'Crawling website...', step: 1, total: 4 });
    const pages = await crawlWebsite(url);

    if (pages.length === 0) {
      send('error', { message: 'Could not reach the website. It may be blocking automated access.' });
      return res.end();
    }

    const allImages = pages.flatMap(p => p.images);
    send('status', {
      message: 'Crawled ' + pages.length + ' pages, ' + allImages.length + ' images. Verifying photos...',
      step: 2, total: 4,
    });

    const imageVerification = await verifyImages(allImages);
    const flagged = imageVerification.stockImages.length + imageVerification.duplicatedImages.length;
    send('status', {
      message: flagged > 0 ? flagged + ' suspicious image' + (flagged > 1 ? 's' : '') + ' found. Running AI analysis...' : 'Images verified. Running AI analysis...',
      step: 3, total: 4,
    });

    const userContext = req.user ? {
      businessType: req.user.business_type,
      region: req.user.region,
      companyName: req.user.company_name,
    } : null;
    const audience = (req.body.audience === 'homeowner') ? 'homeowner' : 'builder';
    const report = await scoreWebsite(pages, url, imageVerification, {}, userContext, audience);

    send('status', { message: 'Saving your report...', step: 4, total: 4 });

    // Save to database and return an ID
    const auditId = 'rpt_' + nanoid();
    if (db.isEnabled()) {
      await db.saveAudit({ id: auditId, url, report });
    }

    send('complete', { id: auditId, url, scannedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    send('error', { message: err.message || 'Audit failed. Please try again.' });
  }
  res.end();
});

/* ═══════════════════════════════════════════════════════════════════════════
   AUTH ROUTES
   ═══════════════════════════════════════════════════════════════════════════ */

const VALID_BUSINESS_TYPES = ['ltd', 'sole_trader', 'partnership', 'llp'];

const VALID_REGIONS = [
  'London','South East','South West','East of England','East Midlands',
  'West Midlands','Yorkshire and the Humber','North West','North East',
  'Scotland','Wales','Northern Ireland',
];

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, companyName, businessType, region, claimAuditId } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!companyName || companyName.trim().length < 2) {
    return res.status(400).json({ error: 'Please enter your company name' });
  }
  if (!VALID_BUSINESS_TYPES.includes(businessType)) {
    return res.status(400).json({ error: 'Please select a business type' });
  }
  if (!VALID_REGIONS.includes(region)) {
    return res.status(400).json({ error: 'Please select your region' });
  }

  try {
    const passwordHash = await auth.hashPassword(password);
    const userId = 'usr_' + nanoid();
    const user = await db.createUser({
      id: userId,
      email,
      passwordHash,
      companyName: companyName.trim(),
      businessType,
      region,
    });

    if (claimAuditId) {
      try { await db.claimAudit(claimAuditId, userId); } catch (e) { console.warn('claim failed:', e.message); }
    }

    auth.setSessionCookie(res, userId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await db.getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Incorrect email or password' });

  const ok = await auth.verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });

  await db.recordLogin(user.id);
  auth.setSessionCookie(res, user.id);
  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      companyName: user.company_name,
      businessType: user.business_type,
      region: user.region,
    },
  });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      companyName: req.user.company_name,
      businessType: req.user.business_type,
      region: req.user.region,
      weeklyEmailOptIn: !!req.user.weekly_email_opt_in,
      lastWeeklyEmailAt: req.user.last_weekly_email_at,
    },
  });
});

/* Update user settings — currently just the weekly-email toggle */
app.post('/api/auth/settings', auth.requireAuth, async (req, res) => {
  const { weeklyEmailOptIn } = req.body || {};
  if (typeof weeklyEmailOptIn !== 'boolean') {
    return res.status(400).json({ error: 'Expected { weeklyEmailOptIn: boolean }' });
  }
  try {
    await db.updateUserSettings(req.user.id, { weeklyEmailOptIn });
    res.json({ success: true, weeklyEmailOptIn });
  } catch (err) {
    console.error('Settings update failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD / MY AUDITS / ENQUIRIES
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/my/audits', auth.requireAuth, async (req, res) => {
  const audits = await db.listAuditsForUser(req.user.id);
  res.json({ audits });
});

app.get('/api/my/enquiries', auth.requireAuth, async (req, res) => {
  const enquiries = await db.listEnquiriesForUser(req.user.id);
  res.json({ enquiries });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE ENQUIRIES
   ═══════════════════════════════════════════════════════════════════════════ */

const VALID_SERVICES = ['web_rebuild', 'seo', 'photography', 'testimonials', 'managed_service'];

app.post('/api/enquiry', auth.requireAuth, async (req, res) => {
  const { service, notes, auditId } = req.body;

  if (!VALID_SERVICES.includes(service)) {
    return res.status(400).json({ error: 'Invalid service' });
  }

  let audit = null;
  if (auditId) {
    audit = await db.getAudit(auditId);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    if (audit.user_id !== req.user.id) return res.status(403).json({ error: 'Not your audit' });
  }

  const enquiryId = 'enq_' + nanoid();
  await db.createEnquiry({
    id: enquiryId,
    userId: req.user.id,
    auditId: auditId || null,
    service,
    notes: notes?.trim() || null,
  });

  const host = req.get('host') || 'builderaudit.co.uk';
  const protocol = req.protocol || 'https';
  const reportUrl = auditId ? `${protocol}://${host}/report/${auditId}` : `${protocol}://${host}/dashboard`;

  const userForEmail = {
    email: req.user.email,
    companyName: req.user.company_name,
    businessType: req.user.business_type,
    region: req.user.region,
  };

  const emailResult = await email.sendEnquiryNotification({
    service,
    notes,
    user: userForEmail,
    auditUrl: audit?.url || null,
    auditId,
    reportUrl,
  });

  email.sendEnquiryConfirmationToUser({ service, user: userForEmail }).catch(err => {
    console.warn('Confirmation email failed:', err.message);
  });

  res.json({
    success: true,
    enquiryId,
    emailSent: emailResult?.success || false,
  });
});

// Get full report data (requires login + ownership, or auto-claim unowned)
app.get('/api/report/:id/data', async (req, res) => {
  const { id } = req.params;

  if (!db.isEnabled()) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const audit = await db.getAudit(id);
    if (!audit) {
      return res.status(404).json({ error: 'Report not found' });
    }

    /* AUTO-CLAIM: if logged-in user visits an audit with no owner, claim it for them. */
    if (req.user && !audit.user_id) {
      try {
        await db.claimAudit(id, req.user.id);
        audit.user_id = req.user.id;
        console.log('Auto-claimed audit', id, 'for user', req.user.id);
      } catch (e) {
        console.warn('Auto-claim failed:', e.message);
      }
    }

    const isOwner = req.user && audit.user_id === req.user.id;
    const isUnclaimed = !audit.user_id && req.cookies['audit_unlock_' + id] === '1';

    if (!isOwner && !isUnclaimed) {
      return res.json({
        locked: true,
        needsAuth: !req.user,
        url: audit.url,
        score: audit.score,
        companyName: audit.report_json?.business_snapshot?.company_name || null,
        headline: audit.report_json?.hero?.headline || null,
        scannedAt: audit.created_at,
      });
    }

    res.json({
      locked: false,
      id: audit.id,
      url: audit.url,
      report: audit.report_json,
      overrides: audit.overrides || {},
      audience: audit.audience || 'builder',
      scannedAt: audit.created_at,
    });
  } catch (err) {
    console.error('GET /api/report/' + id + '/data failed:', err);
    res.status(500).json({ error: 'Could not load report: ' + err.message });
  }
});

// Meta check (for the report shell to show the right locked/unlocked UI)
app.get('/api/report/:id/meta', async (req, res) => {
  const { id } = req.params;
  if (!db.isEnabled()) return res.status(500).json({ error: 'Database not configured' });
  const meta = await db.getAuditMeta(id);
  if (!meta) return res.status(404).json({ error: 'Not found' });

  /* AUTO-CLAIM unowned audit for logged-in user */
  if (req.user && !meta.user_id) {
    try {
      await db.claimAudit(id, req.user.id);
      meta.user_id = req.user.id;
    } catch (e) { /* swallow */ }
  }

  const isOwner = req.user && meta.user_id === req.user.id;
  const isUnclaimed = !meta.user_id && req.cookies['audit_unlock_' + id] === '1';

  res.json({
    id: meta.id,
    url: meta.url,
    score: meta.score,
    scannedAt: meta.created_at,
    lastAnalyzedAt: meta.last_analyzed_at,
    canReanalyze: meta.has_raw_data,
    unlocked: isOwner || isUnclaimed,
    hasUser: !!meta.user_id,
    loggedIn: !!req.user,
  });
});

/* Re-analyse — reuses stored raw data, just runs the AI prompt again.
   Cheap and fast: no crawl, no image search. Costs roughly one AI call. */
app.post('/api/report/:id/reanalyze', async (req, res) => {
  const { id } = req.params;

  if (!db.isEnabled()) return res.status(500).json({ error: 'Database not configured' });
  if (req.cookies['audit_unlock_' + id] !== '1') {
    return res.status(403).json({ error: 'Report not unlocked' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

  try {
    send('status', { message: 'Loading stored data...', step: 1, total: 2 });

    const audit = await db.getAudit(id);
    if (!audit) { send('error', { message: 'Report not found' }); return res.end(); }

    const rawData = audit.raw_data;
    if (!rawData || !rawData.pages) {
      send('error', { message: 'This report was audited before re-analyse was available. Please run a new audit.' });
      return res.end();
    }

    send('status', { message: 'Running fresh AI analysis...', step: 2, total: 2 });

    let userContext = null;
    if (audit.user_id) {
      const owner = await db.getUserById(audit.user_id);
      if (owner) userContext = {
        businessType: owner.business_type,
        region: owner.region,
        companyName: owner.company_name,
      };
    }

    const newReport = await scoreWebsite(
      rawData.pages,
      audit.url,
      rawData.imageVerification || null,
      audit.overrides || {},
      userContext,
      audit.audience || 'builder'
    );

    await db.updateAnalysis(id, newReport);

    send('complete', { id, success: true });
  } catch (err) {
    console.error('Re-analyse failed:', err);
    send('error', { message: err.message || 'Re-analyse failed' });
  }
  res.end();
});

/* Override a flagged image — user says "this is actually mine" */
app.post('/api/report/:id/override', async (req, res) => {
  const { id } = req.params;
  const { imageSrc, decision } = req.body;

  if (!db.isEnabled()) return res.status(500).json({ error: 'Database not configured' });
  if (!imageSrc) return res.status(400).json({ error: 'Missing imageSrc' });
  if (req.cookies['audit_unlock_' + id] !== '1') return res.status(403).json({ error: 'Report not unlocked' });

  try {
    console.log('Override request:', { id, imageSrc, decision });
    await db.setImageOverride(id, imageSrc, decision);

    /* Recalculate score based on remaining (non-overridden) flags */
    const audit = await db.getAudit(id);
    if (!audit) return res.status(404).json({ error: 'Not found' });

    const overrides = audit.overrides || {};
    const iv = audit.report_json?.imageVerification || {};
    const stockRemaining = (iv.stockImages || []).filter(img => overrides[img.src] !== 'rejected').length;
    const dupRemaining = (iv.duplicatedImages || []).filter(img => overrides[img.src] !== 'rejected').length;
    const flaggedRemaining = stockRemaining + dupRemaining;

    /* Score bump: each removed flag restores some trust.
       Stock photo is the most damaging (weight 4), duplicate less so (weight 2).
       Original score was based on AI's view of the flags; removing flags should increase the score. */
    const baseScore = audit.report_json?.hero?.score || 0;
    const originalFlagged = (iv.stockImages || []).length + (iv.duplicatedImages || []).length;
    const removedFlags = originalFlagged - flaggedRemaining;
    let adjustedScore = baseScore + (removedFlags * 3); /* 3 points per removed flag */
    if (adjustedScore > 100) adjustedScore = 100;
    if (adjustedScore < 0) adjustedScore = 0;

    res.json({
      success: true,
      overrides,
      adjustedScore,
      stockRemaining,
      dupRemaining,
      flaggedRemaining,
      originalScore: baseScore,
    });
  } catch (err) {
    console.error('Override failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Diagnostic endpoint — shows what columns exist in the DB.
   Visit /api/_diag/schema to confirm migrations ran. Safe to leave in prod — read-only. */
app.get('/api/_diag/schema', async (req, res) => {
  if (!db.isEnabled()) return res.json({ error: 'DB not configured' });
  try {
    const result = {};
    const { rows: auditCols } = await db.pool().query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'audits' ORDER BY ordinal_position`
    );
    result.audits = auditCols.map(c => c.column_name);

    const { rows: userCols } = await db.pool().query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'users' ORDER BY ordinal_position`
    );
    result.users = userCols.map(c => c.column_name);

    const { rows: tables } = await db.pool().query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    result.tables = tables.map(t => t.tablename);

    res.json(result);
  } catch (err) {
    res.json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
