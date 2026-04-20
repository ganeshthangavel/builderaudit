const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const https = require('https');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const { customAlphabet } = require('nanoid');
const db = require('./db');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const PUBLIC = path.join(__dirname, '../public');

const client = new Anthropic();
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
app.get('/report/:id', (req, res) => res.sendFile(path.join(PUBLIC, 'report.html')));
app.get('/report/:id/:section', (req, res) => res.sendFile(path.join(PUBLIC, 'report.html')));

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

function selectImagesForVerification(allImages, max = 12) {
  /* Filter by size + exclude obvious non-project images via URL hints */
  const candidates = allImages
    .filter(img => img.width > 300 && img.height > 200)
    .filter(img => {
      const s = img.src.toLowerCase();
      const excludeHints = ['logo', 'icon', 'badge', 'avatar', 'favicon', '/team/', 'headshot', 'staff-', 'profile-', 'signature'];
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

      const prompt = 'You are classifying images from a UK construction company website.\n\n' +
        'For each of the ' + batch.length + ' images I have provided (in order), decide whether it is a PROJECT IMAGE or NOT.\n\n' +
        'PROJECT IMAGE = photo of a finished building, construction work in progress, property exterior, interior room, kitchen, bathroom, extension, renovation, landscape/garden work. These are the images a homeowner would judge the builder\'s capability on.\n\n' +
        'NOT PROJECT IMAGE = company logo, team photo / headshot, accreditation badge (FMB/NHBC/etc), icon, illustration, chart, diagram, certificate scan, random decorative image.\n\n' +
        'Return ONLY a JSON array with one entry per image in order. Each entry must be:\n' +
        '{"type": "project" | "not_project", "subject": "<brief description e.g. kitchen interior, company logo, team photo>"}\n\n' +
        'Example output:\n[{"type":"project","subject":"kitchen extension interior"},{"type":"not_project","subject":"FMB accreditation badge"}]\n\n' +
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
      /* On failure, assume project to avoid dropping real images */
      batch.forEach(img => classifications.push({ ...img, classification: { type: 'project', subject: 'unknown' } }));
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
// AI SCORER
// ─────────────────────────────────────────────────────────────────────────────
async function scoreWebsite(pages, targetUrl, imageVerification) {
  const allText = pages.map(p => '[PAGE: ' + p.url + ']\n' + p.textContent).join('\n\n---\n\n');
  const allMeta = pages.map(p => p.meta);
  const allImages = pages.flatMap(p => p.images);
  const screenshotsToAnalyse = pages.slice(0, 4);

  const imageBlocks = screenshotsToAnalyse.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: p.screenshotB64 },
  }));

  const imgVerifySummary = imageVerification ? {
    imagesChecked: imageVerification.checked,
    totalImagesOnSite: imageVerification.total,
    confirmedStockImages: imageVerification.stockImages.map(i => ({ url: i.src, foundOn: i.reason, source: i.source || null })),
    duplicatedElsewhere: imageVerification.duplicatedImages.map(i => ({ url: i.src, foundOn: i.reason, matchCount: i.matchCount })),
    confirmedOriginal: imageVerification.originalImages.length,
  } : null;

  const aggregatedSignals = {
    totalPages: pages.length,
    totalImages: allImages.length,
    pagesWithPhone: allMeta.filter(m => m.hasPhone).length,
    pagesWithAddress: allMeta.filter(m => m.hasAddress).length,
    copyrightYears: [...new Set(allMeta.map(m => m.copyrightYear).filter(Boolean))],
    allAccreditations: [...new Set(allMeta.flatMap(m => m.accreditations))],
    totalTestimonialQuotes: allMeta.reduce((s, m) => s + m.testimonialCount, 0),
    hasGoogleMaps: allMeta.some(m => m.hasGoogleMaps),
    hasVAT: allMeta.some(m => m.hasVAT),
    hasCompaniesHouse: allMeta.some(m => m.hasCompaniesHouse),
    hasExternalReviewLinks: allMeta.some(m => m.hasExternalReviewLinks),
    professionalEmail: allMeta.some(m => m.professionalEmail),
    imageSample: allImages.slice(0, 20).map(i => ({ src: i.src, alt: i.alt, width: i.width, height: i.height })),
    imageVerification: imgVerifySummary,
  };

  const systemPrompt = `You are a forensic conversion analyst for UK construction companies.
Your job is NOT to produce a generic audit.
Your job is to simulate:
- how a homeowner experiences this website
- where trust is lost
- why enquiries are not happening
- and what the business must fix immediately

You must output structured JSON designed to power a highly engaging, narrative-driven UI.
The tone should feel like a brutally honest consultant — commercially focused, emotionally persuasive, grounded in real homeowner psychology.
Avoid generic or polite language. Be direct, specific, and evidence-based.

IMPORTANT: You have been given VERIFIED image data from a reverse image search engine. If images are confirmed as stock photos or found on other websites, treat this as hard evidence — not suspicion. Call it out explicitly and specifically.

CONTEXT: A homeowner is considering spending £10k-£250k on a project. They are cautious, risk-aware, and comparing multiple builders.

Return ONLY valid JSON. No markdown fences. No text outside the JSON.`;

  const userPrompt = 'Website being audited: ' + targetUrl + '\n\nEXTRACTED SIGNALS:\n' + JSON.stringify(aggregatedSignals, null, 2) + '\n\nFULL PAGE TEXT (' + pages.length + ' pages crawled):\n' + allText.slice(0, 6000) + '\n\nI have also provided ' + screenshotsToAnalyse.length + ' page screenshots for visual analysis.\n\n' +
  (imgVerifySummary && (imgVerifySummary.confirmedStockImages.length > 0 || imgVerifySummary.duplicatedElsewhere.length > 0) ?
    'CRITICAL IMAGE VERIFICATION RESULTS — HARD EVIDENCE:\n' + JSON.stringify(imgVerifySummary, null, 2) + '\n\nThese are not guesses. These images have been confirmed by reverse image search. Reference them specifically in your findings.\n\n' : '') +
  'Return this exact JSON structure:\n\n{\n  "business_snapshot": {\n    "company_name": "<the business name as shown>",\n    "one_liner": "<1 sentence describing what they do>",\n    "established": "<year founded if mentioned, or \\"not stated\\">",\n    "years_trading": "<e.g. \\"20+ years\\" if mentioned, else null>",\n    "location": "<where they are based>",\n    "service_area": "<where they cover>",\n    "work_types": ["<main project types>"],\n    "project_value_range": "<if mentioned e.g. \\"£20k-£500k\\" or null>",\n    "team": {\n      "owners": ["<names of owners/directors if mentioned>"],\n      "team_size": "<if mentioned else null>",\n      "key_people": ["<named team members and their role>"]\n    },\n    "accreditations": ["<every accreditation found>"],\n    "awards": ["<any awards or recognition>"],\n    "notable_clients": ["<notable clients or architects>"],\n    "unique_selling_points": ["<2-4 differentiators they emphasise>"],\n    "contact": {\n      "phone": "<phone if visible>",\n      "email": "<email if visible>",\n      "address": "<address if visible>"\n    },\n    "what_we_could_not_find": ["<expected info the site does not mention>"]\n  },\n  "hero": {\n    "score": <0-100 integer>,\n    "headline": "<confronting but fair>",\n    "subtext": "<1 sentence specific to what you found>",\n    "ai_voice_intro": "<2-3 sentences speaking directly to the business owner, referencing specific findings>"\n  },\n  "homeowner_journey": [\n    {"stage": "first_impression", "thought": "<first person homeowner>"},\n    {"stage": "scrolling", "thought": "<doubt as they scroll>"},\n    {"stage": "decision_moment", "thought": "<the moment they decide>"}\n  ],\n  "live_audit_feed": [{"status": "success|warning|critical", "message": "<punchy finding>"}],\n  "trust_breakpoints": [\n    {\n      "title": "<trust failure title>",\n      "homeowner_reaction": "<inner monologue>",\n      "evidence": "<specific evidence>",\n      "impact": "critical|high|medium|low",\n      "fix": "<specific fix within days>"\n    }\n  ],\n  "photo_analysis": {\n    "summary": "<overall verdict>",\n    "strong_images": [{"description": "", "why_it_works": ""}],\n    "weak_images": [{"description": "", "issue": "", "impact": "", "confirmed_stock": true|false, "stock_source": "<if confirmed>"}]\n  },\n  "trust_questions": [\n    {"question": "Can I verify this is a legitimate registered business?", "score": <0-100>, "explanation": ""},\n    {"question": "Do I believe these are real projects by this company?", "score": <0-100>, "explanation": ""},\n    {"question": "Do other homeowners trust and recommend this company?", "score": <0-100>, "explanation": ""},\n    {"question": "Do they have credentials to handle my project safely?", "score": <0-100>, "explanation": ""},\n    {"question": "Will they be easy to contact and communicate with?", "score": <0-100>, "explanation": ""},\n    {"question": "Is this business actively trading right now?", "score": <0-100>, "explanation": ""}\n  ],\n  "competitor_gap": {\n    "summary": "<1-2 sentences>",\n    "they_have": ["<thing competitors have>"],\n    "you_have": ["<genuine strength>"]\n  },\n  "top_actions": [\n    "<action 1 most impactful>",\n    "<action 2>",\n    "<action 3>",\n    "<action 4>",\n    "<action 5>"\n  ]\n}';

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 6000,
    system: systemPrompt,
    messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: userPrompt }] }],
  });

  const rawText = response.content.map(b => b.text || '').join('');
  const clean = rawText.replace(/```json|```/g, '').trim();
  let result;
  try {
    result = JSON.parse(clean);
  } catch (e) {
    console.error('JSON parse failed. Stop reason:', response.stop_reason, 'Last 300 chars:', clean.slice(-300));
    throw new Error('AI response was incomplete. Try again.');
  }
  result.imageVerification = imageVerification;
  return result;
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

    const report = await scoreWebsite(pages, url, imageVerification);

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

// Unlock report with email → set cookie
app.post('/api/report/:id/unlock', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }

  if (!db.isEnabled()) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const meta = await db.getAuditMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'Report not found' });
  }

  await db.unlockAudit(id, email);

  res.cookie('audit_unlock_' + id, '1', {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
  });

  res.json({ success: true });
});

// Get full report data (requires unlock cookie)
app.get('/api/report/:id/data', async (req, res) => {
  const { id } = req.params;

  if (!db.isEnabled()) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const audit = await db.getAudit(id);
  if (!audit) {
    return res.status(404).json({ error: 'Report not found' });
  }

  const isUnlocked = req.cookies['audit_unlock_' + id] === '1';

  if (!isUnlocked) {
    // Return only preview data
    return res.json({
      locked: true,
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
    scannedAt: audit.created_at,
  });
});

// Meta check (for the report shell to show the right locked/unlocked UI)
app.get('/api/report/:id/meta', async (req, res) => {
  const { id } = req.params;
  if (!db.isEnabled()) return res.status(500).json({ error: 'Database not configured' });
  const meta = await db.getAuditMeta(id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const isUnlocked = req.cookies['audit_unlock_' + id] === '1';
  res.json({
    id: meta.id,
    url: meta.url,
    score: meta.score,
    scannedAt: meta.created_at,
    unlocked: isUnlocked,
  });
});

/* Override a flagged image — user says "this is actually mine" */
app.post('/api/report/:id/override', async (req, res) => {
  const { id } = req.params;
  const { imageSrc, decision } = req.body;

  if (!db.isEnabled()) return res.status(500).json({ error: 'Database not configured' });
  if (!imageSrc) return res.status(400).json({ error: 'Missing imageSrc' });
  if (req.cookies['audit_unlock_' + id] !== '1') return res.status(403).json({ error: 'Report not unlocked' });

  try {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
