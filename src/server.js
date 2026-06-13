const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const { customAlphabet } = require('nanoid');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const email = require('./email');
const { scoreWebsite } = require('./scorer-ai');
const { crawlWebsiteScrapFly, isAvailable: isScrapFlyAvailable } = require('./crawler-scrapfly');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

const app = express();
// Railway (and most hosts) run the app behind an HTTPS-terminating proxy.
// Without this, Express doesn't recognise the connection as secure, which can
// break `secure: true` session cookies — users appear logged out after sign-in.
app.set('trust proxy', 1);
app.use(cors({ credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.attachUser);

const PUBLIC = path.join(__dirname, '../public');

/* ── Anthropic client with explicit key + startup diagnostics ──
   Read from config.js (a boot-time snapshot) to bypass Railway Runtime V2
   which strips user env vars at request time. */
const ANTHROPIC_KEY = config.ANTHROPIC_API_KEY;
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
const SERPAPI_KEY = config.SERPAPI_KEY;
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
/* /report/:id used to serve report.html. Now we redirect to the dashboard
   which loads the same audit data via /api/report/:id/data.
   Old report links (emails, bookmarks) still work — they just land on the dashboard. */
app.get('/report/:id', (req, res) => res.redirect(302, '/dashboard?id=' + req.params.id));
app.get('/report/:id/:section', (req, res) => res.redirect(302, '/dashboard?id=' + req.params.id + '&page=' + req.params.section));
app.get('/services', (req, res) => res.sendFile(path.join(PUBLIC, 'services.html')));
app.get('/check-builder', (req, res) => res.sendFile(path.join(PUBLIC, 'check-builder.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(PUBLIC, 'terms.html')));
app.get('/insights', (req, res) => res.sendFile(path.join(PUBLIC, 'insights.html')));

// SEO / crawler files
app.get('/robots.txt', (req, res) => res.type('text/plain').sendFile(path.join(PUBLIC, 'robots.txt')));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').sendFile(path.join(PUBLIC, 'sitemap.xml')));

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
// CRAWLER — ScrapFly only.
// ─────────────────────────────────────────────────────────────────────────────
// We removed the in-house Playwright crawler in favour of ScrapFly. ScrapFly
// handles Cloudflare, residential proxies, JS rendering and screenshots in
// one HTTP call, so the server no longer needs a local Chromium image.
// If SCRAPFLY_API_KEY is missing or ScrapFly fails, we surface a clear error
// instead of silently falling back to a broken second crawler.
async function smartCrawl(startUrl, opts = {}) {
  if (!isScrapFlyAvailable()) {
    throw new Error('Crawler unavailable: SCRAPFLY_API_KEY is not configured on the server.');
  }
  console.log('[smart-crawl] Using ScrapFly for', startUrl);
  const result = await crawlWebsiteScrapFly(startUrl, opts);
  const pages = opts.debug ? result.pages : result;
  if (!pages || pages.length === 0) {
    throw new Error('ScrapFly returned no pages. The target site may block all bots, be offline, or require captcha.');
  }
  return result;
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

/* ─────────────────────────────────────────────────────────────────────────────
   COMPETITOR CHECK — full-quality audit, gated behind account sign-up.
   Logged-in users get the full crawl + Sonnet scoring (same as a normal audit).
   Anonymous users get { locked: true } — they must create a free account.
   This is the lead-generation gate: free access in exchange for contact details
   + consent for builder marketing/recommendation services.
   POST /api/competitor-check  { url: "https://theirsite.co.uk" }
   ───────────────────────────────────────────────────────────────────────────── */
app.post('/api/competitor-check', async (req, res) => {
  /* Gate: must be logged in */
  if (!req.user) {
    return res.status(401).json({ locked: true, reason: 'account_required' });
  }

  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Provide a full URL starting with https://' });
  }
  if (!isScrapFlyAvailable()) {
    return res.status(503).json({ error: 'Crawler not configured' });
  }

  try {
    console.log('[competitor-check] Full crawl for', url, 'by user', req.user.id);
    const { pages, imageVerification } = await crawlWebsiteScrapFly(url);

    if (!pages || pages.length === 0) {
      return res.status(422).json({ error: 'Could not crawl that site — it may be blocking automated requests.' });
    }

    const userContext = {
      businessType: req.user.business_type,
      region:       req.user.region,
      companyName:  req.user.company_name,
    };

    /* Full Sonnet scoring — same quality as a normal audit */
    const report = await scoreWebsite(pages, url, imageVerification, {}, userContext, 'builder');

    const domain = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch(e){ return url; } })();
    res.json({
      url,
      domain,
      score:       report.hero?.score || 0,
      company_name: report.business_snapshot?.company_name || domain,
      verdict:     report.hero?.headline || '',
      subtext:     report.hero?.subtext || '',
      categories:  (report.trust_questions || []).map(q => ({
        name:  q.question.replace('?','').replace('Can I verify this is a legitimate registered business','Legitimacy').replace('Do I believe these are real projects by this company','Real projects').replace('Do other homeowners trust and recommend this company','Reviews').replace('Do they have credentials to handle my project safely','Credentials').replace('Will they be easy to contact and communicate with','Contactability').replace('Is this business actively trading right now','Trading'),
        score: q.score || 50,
        note:  q.explanation || '',
      })),
      top_actions: (report.top_actions || []).slice(0, 3).map(a => typeof a === 'string' ? a : a.title),
    });
  } catch (err) {
    console.error('[competitor-check] Error:', err.message);
    res.status(500).json({ error: err.message || 'Competitor check failed' });
  }
});

/* Fetch charges (mortgages/charges registered against a company).
   Used to flag financial encumbrances to homeowners.
   GET /api/company-charges/:number */
app.get('/api/company-charges/:number', async (req, res) => {
  const { number } = req.params;
  const CH_KEY = config.COMPANIES_HOUSE_API_KEY;
  if (!CH_KEY) return res.json({ available: false });
  try {
    const authHeader = 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64');
    const r = await fetch(`https://api.company-information.service.gov.uk/company/${number}/charges`, { headers:{ Authorization: authHeader } });
    if (!r.ok) return res.json({ available: true, totalCount: 0, outstanding: 0, satisfied: 0 });
    const d = await r.json();
    const items = d.items || [];
    res.json({
      available:   true,
      totalCount:  d.total_count || 0,
      outstanding: items.filter(c => c.status === 'outstanding').length,
      satisfied:   items.filter(c => c.status === 'fully-satisfied' || c.status === 'part-satisfied').length,
    });
  } catch(e) {
    res.json({ available: false });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
   BUILDER MATCH — free homeowner service, lead generation.
   Captures project details + contact info and emails the team.
   POST /api/builder-match
   ───────────────────────────────────────────────────────────────────────────── */
app.post('/api/builder-match', async (req, res) => {
  const { name, email: leadEmail, phone, location, projectType, budget, timeline, hasPlans, planningStatus, description, consentTos, consentAgency } = req.body;

  if (!name || !name.trim())           return res.status(400).json({ error: 'Please enter your name' });
  if (!leadEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!phone || phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please enter a valid phone number' });
  if (!location || !location.trim())   return res.status(400).json({ error: 'Please enter your location or postcode' });
  if (!projectType)                    return res.status(400).json({ error: 'Please select a project type' });
  if (!budget)                         return res.status(400).json({ error: 'Please select a budget range' });
  if (!consentTos)                     return res.status(400).json({ error: 'You must agree to the Terms of Service' });

  const lead = {
    name: name.trim(), email: leadEmail.trim().toLowerCase(), phone: phone.trim(),
    location: location.trim(), projectType, budget,
    timeline: timeline || null, hasPlans: hasPlans || null, planningStatus: planningStatus || null,
    description: (description || '').trim().slice(0, 2000) || null,
    consentAgency: !!consentAgency,
  };

  try {
    /* Persist in DB if available — reuse consent log table for GDPR trail */
    if (db.isEnabled() && req.user) {
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
      const ua = req.headers['user-agent'] || null;
      await db.logConsent({ userId: req.user.id, consentType: 'builder_match_lead', granted: true, ipAddress: ip, userAgent: ua });
    }

    /* Email the lead to the team */
    await email.sendBuilderMatchLead({ lead });

    console.log('[builder-match] New lead:', lead.email, lead.projectType, lead.budget, lead.location);
    res.json({ success: true });
  } catch (err) {
    console.error('[builder-match] Failed:', err.message);
    /* Still return success if only the email failed — we logged the lead */
    res.json({ success: true, emailDelivered: false });
  }
});


app.get('/api/company-profile/:number', async (req, res) => {
  const { number } = req.params;
  const CH_KEY = config.COMPANIES_HOUSE_API_KEY;
  if (!CH_KEY) return res.json({ available: false, reason: 'Companies House API key not configured' });

  try {
    const auth = 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64');
    const [profileRes, officersRes] = await Promise.all([
      fetch(`https://api.company-information.service.gov.uk/company/${number}`,         { headers:{ Authorization: auth } }),
      fetch(`https://api.company-information.service.gov.uk/company/${number}/officers?items_per_page=10`, { headers:{ Authorization: auth } }),
    ]);
    if (!profileRes.ok) return res.status(profileRes.status).json({ error: 'Company not found' });
    const pd = await profileRes.json();
    const officers = officersRes.ok ? await officersRes.json() : {};

    res.json({
      available: true,
      profile: {
        number:            pd.company_number,
        name:              pd.company_name,
        status:            pd.company_status,
        type:              pd.type,
        incorporated:      pd.date_of_creation,
        lastAccounts:      pd.accounts?.last_accounts?.made_up_to || null,
        nextConfirmation:  pd.confirmation_statement?.next_due || null,
        registeredAddress: pd.registered_office_address
          ? [pd.registered_office_address.address_line_1, pd.registered_office_address.address_line_2, pd.registered_office_address.locality, pd.registered_office_address.postal_code].filter(Boolean).join(', ')
          : null,
        sicCodes: pd.sic_codes || [],
        officers: (officers.items || []).filter(o => !o.resigned_on).map(o => ({
          name:      o.name,
          role:      o.officer_role,
          appointed: o.appointed_on,
        })),
        chUrl: `https://find-and-update.company-information.service.gov.uk/company/${pd.company_number}`,
      },
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


/* Proxies requests to the free UK Companies House API so the key never
   reaches the browser. Returns structured data for the homeowner company check.
   GET /api/company-check?name=Create+Builders&domain=create-builders.co.uk
   ───────────────────────────────────────────────────────────────────────────── */
app.get('/api/company-check', async (req, res) => {
  const { name, domain } = req.query;
  if (!name && !domain) return res.status(400).json({ error: 'Provide ?name= or ?domain=' });

  const CH_KEY = config.COMPANIES_HOUSE_API_KEY;
  if (!CH_KEY) {
    return res.json({ available: false, reason: 'Companies House API key not configured' });
  }

  const searchTerm = name || (domain || '').replace(/^www\./, '').replace(/\.[a-z]+$/, '').replace(/-/g, ' ');

  try {
    /* Search for companies matching the name */
    const searchRes = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(searchTerm)}&items_per_page=5`,
      { headers: { Authorization: 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64') } }
    );

    if (!searchRes.ok) {
      console.warn('[ch] Search failed:', searchRes.status, await searchRes.text().catch(()=>''));
      return res.json({ available: false, reason: 'Companies House search failed (' + searchRes.status + ')' });
    }

    const searchData = await searchRes.json();
    const companies = (searchData.items || []).map(c => ({
      name: c.title,
      number: c.company_number,
      status: c.company_status,
      type: c.company_type,
      incorporated: c.date_of_creation,
      address: c.registered_office_address
        ? [c.registered_office_address.address_line_1, c.registered_office_address.locality, c.registered_office_address.postal_code].filter(Boolean).join(', ')
        : null,
      matchScore: (() => {
        const s = (c.title || '').toLowerCase();
        const q = searchTerm.toLowerCase();
        const words = q.split(/\s+/);
        return words.filter(w => s.includes(w)).length / words.length;
      })(),
    })).sort((a, b) => b.matchScore - a.matchScore);

    /* If we have a strong match, fetch full profile for the top result */
    let profile = null;
    const topMatch = companies[0];
    if (topMatch && topMatch.matchScore >= 0.5) {
      try {
        const profileRes = await fetch(
          `https://api.company-information.service.gov.uk/company/${topMatch.number}`,
          { headers: { Authorization: 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64') } }
        );
        if (profileRes.ok) {
          const pd = await profileRes.json();
          /* Also fetch officers (directors) */
          const officersRes = await fetch(
            `https://api.company-information.service.gov.uk/company/${topMatch.number}/officers?items_per_page=10`,
            { headers: { Authorization: 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64') } }
          );
          const officers = officersRes.ok ? await officersRes.json() : {};
          profile = {
            number: pd.company_number,
            name: pd.company_name,
            status: pd.company_status,          /* active | dissolved | liquidation | etc */
            type: pd.type,
            incorporated: pd.date_of_creation,
            lastAccounts: pd.accounts?.last_accounts?.made_up_to || null,
            nextConfirmation: pd.confirmation_statement?.next_due || null,
            registeredAddress: pd.registered_office_address
              ? [pd.registered_office_address.address_line_1, pd.registered_office_address.address_line_2, pd.registered_office_address.locality, pd.registered_office_address.postal_code].filter(Boolean).join(', ')
              : null,
            sicCodes: pd.sic_codes || [],
            officers: (officers.items || []).filter(o => o.resigned_on == null).map(o => ({
              name: o.name,
              role: o.officer_role,
              appointed: o.appointed_on,
            })),
            chUrl: `https://find-and-update.company-information.service.gov.uk/company/${pd.company_number}`,
          };
        }
      } catch (e) {
        console.warn('[ch] Profile fetch failed:', e.message);
      }
    }

    res.json({
      available: true,
      searchTerm,
      companies: companies.slice(0, 5),
      profile,   /* full profile for best match, or null */
    });
  } catch (err) {
    console.error('[ch] Error:', err.message);
    res.json({ available: false, reason: err.message });
  }
});

/* In-memory map of audit-ID → { email, audience }.
 * When a user opts in to "email me when ready" mid-audit, we store their
 * email here. When the audit completes, we look it up and fire the email.
 *
 * Why a Map and not the DB: this is the lean-MVP path. The audit lifecycle
 * is server-bound (one request, one process), so an in-memory map is fine.
 * If the server crashes mid-audit, the audit is lost anyway. We'll move to
 * a DB column when the audit goes fully async (separate worker process). */
const pendingNotifications = new Map();
const NOTIFICATION_TTL_MS = 30 * 60 * 1000; // 30 minutes — well beyond max audit duration

/* Periodic cleanup so the map doesn't grow forever on a long-running server */
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingNotifications) {
    if (now - entry.registeredAt > NOTIFICATION_TTL_MS) {
      pendingNotifications.delete(id);
    }
  }
}, 5 * 60 * 1000); // every 5 minutes

/* Register an email for an in-progress audit. Called from the client when the
 * user submits the "email me when ready" form. Idempotent: re-submitting with
 * the same audit ID overwrites the email. */
app.post('/api/audit/notify', (req, res) => {
  const { auditId, email } = req.body || {};
  if (!auditId || typeof auditId !== 'string') {
    return res.status(400).json({ error: 'auditId required' });
  }
  if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  /* Only allow registering against IDs that look like our format */
  if (!/^rpt_[A-Za-z0-9]{6,}$/.test(auditId)) {
    return res.status(400).json({ error: 'Invalid audit ID format' });
  }
  pendingNotifications.set(auditId, { email: email.trim().toLowerCase(), registeredAt: Date.now() });
  console.log('[audit-notify] Registered', email, 'for', auditId);
  res.json({ ok: true });
});

// Run an audit — streams progress via SSE, saves to DB on complete
app.post('/api/audit', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Please provide a valid URL starting with http/https' });
  }

  /* Generate the audit ID NOW (not at the end) so the client can register an
   * email against it via /api/audit/notify while the audit is still running. */
  const auditId = 'rpt_' + nanoid();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  /* Tell proxies (Railway, nginx, Cloudflare) to never buffer this response.
     Without this, the SSE stream gets buffered and the client sees nothing
     until the connection ends. */
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

  /* SSE heartbeat: long crawls (5+ minutes for stubborn sites) cause Railway's
     proxy to time out the connection after ~60s of idle. We send a comment
     line every 15s — EventSource ignores it client-side but the bytes keep
     the TCP connection from being killed for inactivity. */
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat ' + Date.now() + '\n\n');
    } catch (e) { /* connection already closed; let the audit finish on its own */ }
  }, 15000);

  /* Always clear the heartbeat when we're done — never leave intervals running */
  const cleanup = () => clearInterval(heartbeat);
  res.on('close', cleanup);
  res.on('finish', cleanup);

  try {
    /* Send the audit ID FIRST so the client can register an email against it
     * via /api/audit/notify while the audit is still in progress. */
    send('audit_id', { id: auditId });

    send('status', { message: 'Crawling website...', step: 1, total: 4 });
    const pages = await smartCrawl(url);

    /* Blocked-site detection. We bail out early in three cases:
       1. Zero pages crawled (hard block, DNS failure, total timeout)
       2. Only 1 page crawled — likely the homepage came back but no internal links
          could be reached. Almost always indicates anti-bot protection.
       3. Pages came back but their text content is below 200 chars total — that means
          we got challenge pages (e.g. Cloudflare "Just a moment...") rather than real content.
       In all three cases the AI would hallucinate, so we'd rather refuse than fake it. */
    const totalTextLength = pages.reduce((sum, p) => sum + (p.textContent || '').length, 0);
    const isBlocked =
      pages.length === 0 ||
      (pages.length === 1 && totalTextLength < 500) ||
      totalTextLength < 200;

    if (isBlocked) {
      const reason = pages.length === 0 ? 'no_pages_reached'
        : pages.length === 1 ? 'only_homepage_no_links'
        : 'empty_content';
      console.warn('[audit] Site blocked or empty:', url, { reason, pages: pages.length, totalTextLength });
      send('blocked', {
        reason,
        pagesAttempted: pages.length,
        message: 'We could not audit this website. It appears to be using bot protection (e.g. Cloudflare, custom WAF) that blocks automated analysis tools.',
        suggestion: 'This is unusual for legitimate UK construction websites. If you own this site, check your anti-bot settings or contact us at gthangavel1@gmail.com so we can review your case.',
      });
      /* Notify the user that the audit didn't complete, if they opted in */
      const notify = pendingNotifications.get(auditId);
      if (notify && email.isEnabled()) {
        try {
          await email.sendAuditReady({
            email: notify.email,
            auditId,
            auditUrl: url,
            score: null,
            appBaseUrl: process.env.APP_BASE_URL,
          });
        } catch (e) { console.warn('[audit] notify-on-blocked failed:', e.message); }
        pendingNotifications.delete(auditId);
      }
      cleanup();
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

    /* Save to database using the ID we generated up front.
       rawData includes the crawled pages + image URLs — stored so the dashboard
       can show real photo thumbnails and link back to the page they're on. */
    if (db.isEnabled()) {
      await db.saveAudit({ id: auditId, userId: req.user?.id || null, url, report, rawData: { pages, imageVerification }, audience });
    }

    /* Notify the user if they opted in via /api/audit/notify */
    const notify = pendingNotifications.get(auditId);
    if (notify && email.isEnabled()) {
      try {
        await email.sendAuditReady({
          email: notify.email,
          auditId,
          auditUrl: url,
          score: report?.hero?.score ?? null,
          appBaseUrl: process.env.APP_BASE_URL,
        });
      } catch (e) { console.warn('[audit] sendAuditReady failed:', e.message); }
      pendingNotifications.delete(auditId);
    }

    send('complete', { id: auditId, url, scannedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    send('error', { message: err.message || 'Audit failed. Please try again.' });
  }
  cleanup();
  res.end();
});

/* ═══════════════════════════════════════════════════════════════════════════
   AUTH ROUTES
   ═══════════════════════════════════════════════════════════════════════════ */

const VALID_BUSINESS_TYPES = ['ltd', 'sole_trader', 'partnership', 'llp', 'homeowner'];

const VALID_REGIONS = [
  'London','South East','South West','East of England','East Midlands',
  'West Midlands','Yorkshire and the Humber','North West','North East',
  'Scotland','Wales','Northern Ireland',
];

app.post('/api/auth/signup', async (req, res) => {
  const {
    email, password, phone, companyName, businessType, region,
    consentTos, consentAuth, consentAgency, consentWeekly,
    claimAuditId,
  } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!phone || phone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ error: 'Please enter a valid UK phone number' });
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
  /* Required GDPR consents — refuse signup if not given */
  if (!consentTos) {
    return res.status(400).json({ error: 'You must agree to the Terms of Service and Privacy Policy' });
  }
  if (!consentAuth) {
    return res.status(400).json({ error: 'You must confirm you are authorised to use this service for the business' });
  }

  try {
    const passwordHash = await auth.hashPassword(password);
    const userId = 'usr_' + nanoid();

    /* Create the user with consent state. createUser writes the booleans + timestamps. */
    const user = await db.createUser({
      id: userId,
      email,
      passwordHash,
      companyName: companyName.trim(),
      businessType,
      region,
      phone: phone.trim(),
      consentTos: !!consentTos,
      consentAuth: !!consentAuth,
      consentAgency: !!consentAgency,
      consentWeekly: !!consentWeekly,
    });

    /* Append consent events to the immutable audit log. Required by GDPR Art 7(1).
       We capture IP and user-agent at consent time so we can defend against later challenges. */
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;
    await db.logConsent({ userId, consentType: 'tos_and_privacy', granted: true, ipAddress: ip, userAgent: ua });
    await db.logConsent({ userId, consentType: 'authorised_to_use', granted: true, ipAddress: ip, userAgent: ua });
    if (consentAgency) {
      await db.logConsent({ userId, consentType: 'agency_partners', granted: true, ipAddress: ip, userAgent: ua });
    }
    if (consentWeekly) {
      await db.logConsent({ userId, consentType: 'weekly_emails', granted: true, ipAddress: ip, userAgent: ua });
    }

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
      phone: req.user.phone || null,
      companyName: req.user.company_name,
      businessType: req.user.business_type,
      region: req.user.region,
      weeklyEmailOptIn: !!req.user.weekly_email_opt_in,
      lastWeeklyEmailAt: req.user.last_weekly_email_at,
      consentAgency: !!req.user.consent_agency,
      consentAgencyAt: req.user.consent_agency_at,
    },
  });
});

/* Update user settings — weekly-email toggle and agency-consent toggle */
app.post('/api/auth/settings', auth.requireAuth, async (req, res) => {
  const { weeklyEmailOptIn, consentAgency } = req.body || {};

  /* Accept any subset; reject if neither specified */
  if (typeof weeklyEmailOptIn !== 'boolean' && typeof consentAgency !== 'boolean') {
    return res.status(400).json({ error: 'Provide weeklyEmailOptIn and/or consentAgency as booleans' });
  }

  try {
    await db.updateUserSettings(req.user.id, { weeklyEmailOptIn, consentAgency });

    /* Log consent changes to the immutable audit trail */
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;
    if (typeof consentAgency === 'boolean') {
      await db.logConsent({ userId: req.user.id, consentType: 'agency_partners', granted: consentAgency, ipAddress: ip, userAgent: ua });
    }
    if (typeof weeklyEmailOptIn === 'boolean') {
      await db.logConsent({ userId: req.user.id, consentType: 'weekly_emails', granted: weeklyEmailOptIn, ipAddress: ip, userAgent: ua });
    }

    res.json({ success: true, weeklyEmailOptIn, consentAgency });
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

/* Returns the user's most recent FULL audit (with report_json + image URLs),
   so the dashboard can show real data on login without needing ?id= in the URL. */
app.get('/api/my/latest-audit', auth.requireAuth, async (req, res) => {
  try {
    const audits = await db.listAuditsForUser(req.user.id);
    if (!audits || audits.length === 0) return res.json({ audit: null });
    const latestId = audits[0].id;               // listAuditsForUser is ordered newest-first
    const full = await db.getAudit(latestId);
    if (!full || full.user_id !== req.user.id) return res.json({ audit: null });

    /* Pull image URLs out of raw_data so photo thumbnails work, same as ?id= path */
    let imageUrls = [];
    try {
      const pages = full.raw_data?.pages || [];
      imageUrls = pages.flatMap(p => (p.images || []).map(im => im.src || im.url || im)).filter(Boolean).slice(0, 60);
    } catch (e) { /* non-fatal */ }

    res.json({
      audit: {
        id: full.id,
        url: full.url,
        report_json: full.report_json,
        created_at: full.created_at,
        last_analyzed_at: full.last_analyzed_at,
        imageUrls,
        overrides: full.image_overrides || {},
      },
    });
  } catch (err) {
    console.error('[my/latest-audit] failed:', err.message);
    res.json({ audit: null });
  }
});

/* ── Persisted competitor audits ──────────────────────────────────────────── */
app.get('/api/my/competitors', auth.requireAuth, async (req, res) => {
  const role = req.query.role === 'homeowner' ? 'homeowner' : 'builder';
  try {
    const rows = await db.listCompetitorsForUser(req.user.id, role);
    res.json({ competitors: rows.map(r => ({ slotIndex: r.slot_index, url: r.url, data: r.data_json })) });
  } catch (err) {
    console.error('[my/competitors] failed:', err.message);
    res.json({ competitors: [] });
  }
});

app.post('/api/my/competitors', auth.requireAuth, async (req, res) => {
  const { slotIndex, url, data, role: bodyRole } = req.body;
  const role = bodyRole === 'homeowner' ? 'homeowner' : 'builder';
  if (typeof slotIndex !== 'number' || !url || !data) {
    return res.status(400).json({ error: 'slotIndex, url and data are required' });
  }
  try {
    await db.saveCompetitor({ userId: req.user.id, role, slotIndex, url, data });
    res.json({ success: true });
  } catch (err) {
    console.error('[my/competitors save] failed:', err.message);
    res.status(500).json({ error: 'Could not save competitor' });
  }
});

app.delete('/api/my/competitors/:slot', auth.requireAuth, async (req, res) => {
  const role = req.query.role === 'homeowner' ? 'homeowner' : 'builder';
  const slotIndex = parseInt(req.params.slot, 10);
  if (Number.isNaN(slotIndex)) return res.status(400).json({ error: 'Invalid slot' });
  try {
    await db.deleteCompetitor(req.user.id, role, slotIndex);
    res.json({ success: true });
  } catch (err) {
    console.error('[my/competitors delete] failed:', err.message);
    res.status(500).json({ error: 'Could not delete competitor' });
  }
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
  const reportUrl = auditId ? `${protocol}://${host}/dashboard?id=${auditId}` : `${protocol}://${host}/dashboard`;

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

    /* Extract real image URLs from raw_data pages so the dashboard can show
       actual photos rather than placeholder boxes. We pair AI analysis descriptions
       with the actual scraped image src URLs by position. */
    const rawPages = audit.raw_data?.pages || [];
    const allImageUrls = rawPages.flatMap(p =>
      (p.images || []).map(img => ({ src: img.src, alt: img.alt || '', pageUrl: p.url }))
    ).filter(img => /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(img.src));

    res.json({
      locked: false,
      id: audit.id,
      url: audit.url,
      report: audit.report_json,
      overrides: audit.overrides || {},
      audience: audit.audience || 'builder',
      scannedAt: audit.created_at,
      imageUrls: allImageUrls.slice(0, 30), /* Cap at 30 to keep response lean */
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

/* Override a flagged image OR save fix completions / photo exclusions.
   Accepts:
     - { imageSrc, decision }                    → image override (existing)
     - { fixId, completed: true|false }           → fix completion toggle
     - { photoId, excluded: true|false }          → photo exclusion toggle */
app.post('/api/report/:id/override', async (req, res) => {
  const { id } = req.params;
  const { imageSrc, decision, fixId, completed, photoId, excluded } = req.body;

  if (!db.isEnabled()) return res.status(500).json({ error: 'Database not configured' });

  try {
    const auditMeta = await db.getAuditMeta(id);
    if (!auditMeta) return res.status(404).json({ error: 'Report not found' });

    const isOwner = req.user && auditMeta.user_id === req.user.id;
    const hasUnlockCookie = req.cookies['audit_unlock_' + id] === '1';
    if (req.user && !auditMeta.user_id && !isOwner) {
      try { await db.claimAudit(id, req.user.id); } catch (e) {}
    }
    const isOwnerAfterClaim = req.user && (isOwner || !auditMeta.user_id);
    if (!isOwnerAfterClaim && !hasUnlockCookie) {
      return res.status(403).json({ error: 'Report not unlocked' });
    }

    /* ── Fix completion ── */
    if (fixId !== undefined) {
      const key = 'fix_' + fixId;
      await db.setImageOverride(id, key, completed ? 'completed' : 'pending');
      const audit = await db.getAudit(id);
      const overrides = audit.overrides || {};
      const report = audit.report_json || {};
      const actions = report.top_actions || [];
      const completedPts = actions.reduce((sum, a, i) => {
        const pts = typeof a === 'object' && a.impact_pts ? a.impact_pts : [8,6,5,3,2][i] || 2;
        return overrides['fix_' + i] === 'completed' ? sum + pts : sum;
      }, 0);
      const adjustedScore = Math.min(100, (report.hero?.score || 0) + completedPts);
      return res.json({ success: true, overrides, adjustedScore });
    }

    /* ── Photo exclusion ── */
    if (photoId !== undefined) {
      const key = 'photo_excluded_' + photoId;
      await db.setImageOverride(id, key, excluded ? 'excluded' : 'included');
      const audit = await db.getAudit(id);
      const overrides = audit.overrides || {};
      const report = audit.report_json || {};
      const excludedCount = Object.keys(overrides).filter(k => k.startsWith('photo_excluded_') && overrides[k] === 'excluded').length;
      const baseScore = report.hero?.score || 0;
      /* Each excluded flagged photo restores ~5 pts to the "real projects" trust question */
      const adjustedScore = Math.min(100, baseScore + (excludedCount * 5));
      return res.json({ success: true, overrides, adjustedScore });
    }

    /* ── Image override (existing) ── */
    if (!imageSrc) return res.status(400).json({ error: 'Missing imageSrc, fixId, or photoId' });
    console.log('Override request:', { id, imageSrc, decision });
    await db.setImageOverride(id, imageSrc, decision);

    const audit = await db.getAudit(id);
    if (!audit) return res.status(404).json({ error: 'Not found' });
    const overrides = audit.overrides || {};
    const iv = audit.report_json?.imageVerification || {};
    const stockRemaining = (iv.stockImages || []).filter(img => overrides[img.src] !== 'rejected').length;
    const dupRemaining = (iv.duplicatedImages || []).filter(img => overrides[img.src] !== 'rejected').length;
    const flaggedRemaining = stockRemaining + dupRemaining;
    const baseScore = audit.report_json?.hero?.score || 0;
    const originalFlagged = (iv.stockImages || []).length + (iv.duplicatedImages || []).length;
    const removedFlags = originalFlagged - flaggedRemaining;
    let adjustedScore = baseScore + (removedFlags * 3);
    if (adjustedScore > 100) adjustedScore = 100;
    if (adjustedScore < 0) adjustedScore = 0;

    res.json({ success: true, overrides, adjustedScore, stockRemaining, dupRemaining, flaggedRemaining, originalScore: baseScore });
  } catch (err) {
    console.error('Override failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Crawl test endpoint — runs the crawler on a URL and returns the page list.
   Use to verify that target sites' key pages (about, team, services) are being reached.
   GET /api/_diag/crawl?url=https://example.com  */
app.get('/api/_diag/crawl', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    return res.status(400).json({ error: 'Provide ?url=https://...' });
  }
  if (!isScrapFlyAvailable()) {
    return res.status(503).json({ error: 'SCRAPFLY_API_KEY not configured on the server.' });
  }
  console.log(`[crawl-test] Starting ScrapFly crawl of ${targetUrl}`);
  try {
    const t0 = Date.now();
    const result = await crawlWebsiteScrapFly(targetUrl, { debug: true });
    const engineUsed = 'scrapfly';
    const pages = result.pages || result;
    const debugLog = result.debugLog || [];
    const totalCost = result.totalCost || null;
    const elapsed = Date.now() - t0;

    /* Classify pages the same way scorer-ai.js does */
    const pageMap = pages.map(p => {
      const path = (() => { try { return new URL(p.url).pathname.toLowerCase(); } catch (e) { return p.url.toLowerCase(); } })();
      let kind = 'other';
      if (path === '/' || path === '') kind = 'home';
      else if (/team|staff|people|meet|who-?we-?are/.test(path)) kind = 'team';
      else if (/about/.test(path)) kind = 'about';
      else if (/service|what-?we-?do|expertise/.test(path)) kind = 'services';
      else if (/contact|get-?in-?touch|enquir/.test(path)) kind = 'contact';
      else if (/portfolio|project|gallery|work|case-?stud/.test(path)) kind = 'portfolio';
      else if (/testimonial|review|client/.test(path)) kind = 'testimonials';
      else if (/blog|news|article|insight/.test(path)) kind = 'blog';
      else if (/faq|help|support/.test(path)) kind = 'faq';
      else if (/price|pricing|cost|quote/.test(path)) kind = 'pricing';
      return { url: p.url, kind, textLength: (p.textContent || '').length, imageCount: (p.images || []).length };
    });

    res.json({
      target: targetUrl,
      engine_used: engineUsed,
      crawler_version: require('./crawler-scrapfly').version || 'unknown',
      elapsed_ms: elapsed,
      total_pages_crawled: pages.length,
      total_cost_credits: totalCost,
      pages: pageMap,
      page_kinds_present: [...new Set(pageMap.map(p => p.kind))].filter(k => k !== 'other').sort(),
      max_pages_cap: MAX_PAGES,
      hit_cap: pages.length >= MAX_PAGES,
      debug: debugLog,
      team_page_text_sample: (() => {
        const teamPage = pages.find(p => /team|staff|people|meet|who-?we-?are/.test(new URL(p.url).pathname.toLowerCase()));
        return teamPage ? (teamPage.textContent || '').slice(0, 800) : null;
      })(),
    });
  } catch (err) {
    console.error('[crawl-test] failed:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

/* Diagnostic endpoint — shows DB schema + env var visibility.
   Visit /api/_diag/schema to confirm migrations ran. Safe to leave in prod — no secrets exposed. */
app.get('/api/_diag/schema', async (req, res) => {
  /* Compare process.env (which Runtime V2 strips) with config snapshot (captured at boot) */
  const directDb = process.env.DATABASE_URL;
  const allKeys = Object.keys(process.env);

  console.log('[_diag] runtime DATABASE_URL=' + (!!directDb) +
    ' config DATABASE_URL=' + (!!config.DATABASE_URL) +
    ' isEnabled=' + db.isEnabled());

  const result = {
    runtime_env: {
      DATABASE_URL_present: !!directDb,
      ANTHROPIC_API_KEY_present: !!process.env.ANTHROPIC_API_KEY,
      total_keys: allKeys.length,
    },
    config_snapshot: {
      DATABASE_URL_present: !!config.DATABASE_URL,
      DATABASE_URL_length: config.DATABASE_URL ? config.DATABASE_URL.length : 0,
      ANTHROPIC_API_KEY_present: !!config.ANTHROPIC_API_KEY,
      JWT_SECRET_present: !!config.JWT_SECRET,
      RESEND_API_KEY_present: !!config.RESEND_API_KEY,
      SERPAPI_KEY_present: !!config.SERPAPI_KEY,
      SCRAPFLY_API_KEY_present: !!config.SCRAPFLY_API_KEY,
      SCRAPFLY_API_KEY_runtime_present: !!process.env.SCRAPFLY_API_KEY,
    },
    db_enabled: db.isEnabled(),
  };

  if (!db.isEnabled()) {
    result.error = 'DB not configured — db.isEnabled() returned false. Check config.DATABASE_URL.';
    return res.json(result);
  }

  try {
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
    result.db_error = err.message;
    res.json(result);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
   
