const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const client = new Anthropic();
const MAX_PAGES = 20;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// ── Stock photo domains — instant flag, no API call needed ────────────────────
const STOCK_DOMAINS = [
  'shutterstock.com','istockphoto.com','gettyimages.com','getty.com',
  'dreamstime.com','depositphotos.com','alamy.com','123rf.com',
  'adobe.com/stock','stock.adobe.com','unsplash.com','pexels.com',
  'freepik.com','canva.com','pixabay.com','stocksy.com',
];

// ── Reverse image search via SerpAPI ─────────────────────────────────────────
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

          // Check inline_images and image_results for stock site matches
          const allResults = [
            ...(json.image_results || []),
            ...(json.inline_images || []),
            ...(json.reverse_image_search || []),
          ];

          const sources = allResults.map(r => (r.link || r.source || '')).filter(Boolean);

          // Check for stock site matches
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
            });
          }

          // Check if image appears on many OTHER websites (stolen/shared)
          const externalMatches = sources.filter(src => {
            try {
              return !src.includes(new URL(imageUrl).hostname);
            } catch { return false; }
          });

          if (externalMatches.length >= 3) {
            return resolve({
              verdict: 'duplicated',
              reason: 'Image found on ' + externalMatches.length + ' other websites',
              sources: externalMatches.slice(0, 3),
              matchCount: externalMatches.length,
            });
          }

          resolve({ verdict: 'original', reason: 'No stock or duplicate matches found', matchCount: sources.length });

        } catch (e) {
          resolve({ verdict: 'error', reason: 'Parse error: ' + e.message });
        }
      });
    }).on('error', (e) => {
      resolve({ verdict: 'error', reason: 'Request failed: ' + e.message });
    });
  });
}

// ── Select best images to check (largest, most prominent) ────────────────────
function selectImagesForVerification(allImages, max = 8) {
  // Filter out tiny images (icons, logos) and prefer larger ones
  const candidates = allImages
    .filter(img => img.width > 300 && img.height > 200)
    .filter(img => !img.src.includes('logo') && !img.src.includes('icon') && !img.src.includes('badge'))
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  // Deduplicate by URL
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

// ── Run image verification across selected images ─────────────────────────────
async function verifyImages(allImages) {
  const toCheck = selectImagesForVerification(allImages, 8);
  console.log('Checking ' + toCheck.length + ' images for stock/duplication...');

  const results = [];

  for (const img of toCheck) {
    console.log('  Checking:', img.src.slice(0, 80));
    const result = await reverseImageSearch(img.src);
    results.push({
      src: img.src,
      alt: img.alt,
      width: img.width,
      height: img.height,
      ...result,
    });
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  const stockImages = results.filter(r => r.verdict === 'stock');
  const duplicatedImages = results.filter(r => r.verdict === 'duplicated');
  const originalImages = results.filter(r => r.verdict === 'original');
  const checkedCount = results.filter(r => r.verdict !== 'error' && r.verdict !== 'unknown').length;

  console.log('Image check complete:', stockImages.length, 'stock,', duplicatedImages.length, 'duplicated,', originalImages.length, 'original');

  return {
    checked: checkedCount,
    total: allImages.length,
    stockImages,
    duplicatedImages,
    originalImages,
    allResults: results,
  };
}

// ── Crawler ───────────────────────────────────────────────────────────────────
async function crawlWebsite(startUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
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

  console.log('Crawling:', startUrl);

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await context.newPage();
      await page.waitForTimeout(500 + Math.random() * 1000);

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      if (response && (response.status() === 403 || response.status() === 429)) {
        console.warn('Blocked:', url, response.status());
        await page.close();
        continue;
      }

      await page.waitForTimeout(1500);

      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 75 });
      const screenshotB64 = screenshot.toString('base64');

      const textContent = await page.evaluate(() => {
        const el = document.body.cloneNode(true);
        ['nav','footer','script','style','noscript'].forEach(tag => {
          el.querySelectorAll(tag).forEach(n => n.remove());
        });
        return el.innerText.replace(/\s+/g, ' ').trim().slice(0, 8000);
      });

      const images = await page.evaluate(() => {
        return [...document.querySelectorAll('img')].map(img => ({
          src: img.src || '',
          alt: img.alt || '',
          width: img.naturalWidth,
          height: img.naturalHeight,
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
        return [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => h.startsWith(base));
      }, origin);

      links.forEach(l => {
        const clean = normaliseUrl(l);
        if (!visited.has(clean) && !queue.includes(clean)) queue.push(clean);
      });

      pages.push({ url, textContent, images, meta, screenshotB64 });
      console.log('Crawled:', url, '--', images.length, 'images');
      await page.close();
    } catch (err) {
      console.warn('Failed:', url, err.message);
    }
  }

  await browser.close();
  console.log('Crawl complete:', pages.length, 'pages');
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

// ── Scorer ────────────────────────────────────────────────────────────────────
async function scoreWebsite(pages, targetUrl, imageVerification) {
  console.log('Sending to Claude for analysis...');

  const allText = pages.map(p => '[PAGE: ' + p.url + ']\n' + p.textContent).join('\n\n---\n\n');
  const allMeta = pages.map(p => p.meta);
  const allImages = pages.flatMap(p => p.images);
  const screenshotsToAnalyse = pages.slice(0, 4);

  const imageBlocks = screenshotsToAnalyse.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: p.screenshotB64 },
  }));

  // Build image verification summary for the prompt
  const imgVerifySummary = imageVerification ? {
    imagesChecked: imageVerification.checked,
    totalImagesOnSite: imageVerification.total,
    confirmedStockImages: imageVerification.stockImages.map(i => ({
      url: i.src,
      foundOn: i.reason,
      source: i.source || null,
    })),
    duplicatedElsewhere: imageVerification.duplicatedImages.map(i => ({
      url: i.src,
      foundOn: i.reason,
      matchCount: i.matchCount,
    })),
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
  'Return this exact JSON structure:\n\n{\n  "hero": {\n    "score": <0-100 integer>,\n    "headline": "<confronting but fair>",\n    "subtext": "<1 sentence specific to what you found>",\n    "ai_voice_intro": "<2-3 sentences speaking directly to the business owner, referencing specific findings including any confirmed stock photos>"\n  },\n  "homeowner_journey": [\n    {"stage": "first_impression", "thought": "<first person homeowner — realistic>"},\n    {"stage": "scrolling", "thought": "<doubt as they scroll>"},\n    {"stage": "decision_moment", "thought": "<the moment they decide to leave or enquire>"}\n  ],\n  "live_audit_feed": [\n    {"status": "success|warning|critical", "message": "<punchy finding>"}\n  ],\n  "trust_breakpoints": [\n    {\n      "title": "<trust failure title>",\n      "homeowner_reaction": "<inner monologue>",\n      "evidence": "<specific evidence — for confirmed stock images name the source>",\n      "impact": "critical|high|medium|low",\n      "fix": "<specific fix achievable within days>"\n    }\n  ],\n  "photo_analysis": {\n    "summary": "<overall verdict on the photo strategy>",\n    "strong_images": [{"description": "", "why_it_works": ""}],\n    "weak_images": [{"description": "", "issue": "<if confirmed stock, state where it was found>", "impact": "", "confirmed_stock": true|false, "stock_source": "<source URL if confirmed>"}]\n  },\n  "trust_questions": [\n    {"question": "Can I verify this is a legitimate registered business?", "score": <0-100>, "explanation": ""},\n    {"question": "Do I believe these are real projects by this company?", "score": <0-100>, "explanation": "<if stock images confirmed, state this clearly>"},\n    {"question": "Do other homeowners trust and recommend this company?", "score": <0-100>, "explanation": ""},\n    {"question": "Do they have credentials to handle my project safely?", "score": <0-100>, "explanation": ""},\n    {"question": "Will they be easy to contact and communicate with?", "score": <0-100>, "explanation": ""},\n    {"question": "Is this business actively trading right now?", "score": <0-100>, "explanation": ""}\n  ],\n  "competitor_gap": {\n    "summary": "<1-2 sentences>",\n    "they_have": ["<thing competitors have>"],\n    "you_have": ["<genuine strength>"]\n  },\n  "top_actions": [\n    "<action 1 — most impactful first>",\n    "<action 2>",\n    "<action 3>",\n    "<action 4>",\n    "<action 5>"\n  ]\n}';

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: userPrompt }],
    }],
  });

  const rawText = response.content.map(b => b.text || '').join('');
  const clean = rawText.replace(/```json|```/g, '').trim();
  const result = JSON.parse(clean);

  // Attach the raw image verification data to the report
  result.imageVerification = imageVerification;
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', serpapi: !!SERPAPI_KEY }));

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
      send('error', { message: 'Could not reach the website. It may be blocking automated access. Try a different site.' });
      return res.end();
    }

    const allImages = pages.flatMap(p => p.images);
    send('status', {
      message: 'Crawled ' + pages.length + ' pages, ' + allImages.length + ' images found. Verifying photos...',
      step: 2,
      total: 4,
    });

    const imageVerification = await verifyImages(allImages);

    const stockCount = imageVerification.stockImages.length;
    const dupCount = imageVerification.duplicatedImages.length;
    const flagged = stockCount + dupCount;
    send('status', {
      message: flagged > 0
        ? flagged + ' suspicious image' + (flagged > 1 ? 's' : '') + ' found. Running AI analysis...'
        : 'Images verified. Running AI analysis...',
      step: 3,
      total: 4,
    });

    const report = await scoreWebsite(pages, url, imageVerification);

    send('status', { message: 'Building your report...', step: 4, total: 4 });
    send('complete', { report, url, scannedAt: new Date().toISOString() });

  } catch (err) {
    console.error(err);
    send('error', { message: err.message || 'Audit failed. Please try again.' });
  }

  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
