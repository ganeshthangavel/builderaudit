const express = require('express');
const cors = require('cors');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const client = new Anthropic();
const MAX_PAGES = 20;

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
async function scoreWebsite(pages, targetUrl) {
  console.log('Sending to Claude for analysis...');

  const allText = pages.map(p => '[PAGE: ' + p.url + ']\n' + p.textContent).join('\n\n---\n\n');
  const allMeta = pages.map(p => p.meta);
  const allImages = pages.flatMap(p => p.images);
  const screenshotsToAnalyse = pages.slice(0, 4);

  const imageBlocks = screenshotsToAnalyse.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: p.screenshotB64 },
  }));

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
  };

  const systemPrompt = `You are a senior conversion and trust auditor specialising in UK construction, renovation, and home improvement companies.
Your job is to analyse websites and identify factors that affect homeowner trust, lead conversion, and perceived business legitimacy.
You are NOT an SEO auditor. You are NOT a design critic.
You are a high-end commercial due diligence analyst for £10k-£500k construction projects.

PRIMARY OBJECTIVE: Identify what would prevent a homeowner from enquiring or trusting this business enough to spend high-value (£5k-£250k+) on construction work.
You must base all conclusions on provided evidence only. Do NOT assume facts not supported by the input data.

CRITICAL THINKING RULE: Think like a homeowner deciding whether to trust this company with £30,000 of their home renovation budget.

Return ONLY valid JSON, no markdown fences, no explanation outside the JSON.`;

  const userPrompt = `Website being audited: ${targetUrl}

EXTRACTED SIGNALS:
${JSON.stringify(aggregatedSignals, null, 2)}

FULL PAGE TEXT (${pages.length} pages crawled):
${allText.slice(0, 6000)}

I have also provided ${screenshotsToAnalyse.length} page screenshots above for visual analysis.

Analyse everything and return this exact JSON structure:
{
  "overall_score": <0-100 integer>,
  "category_scores": {
    "credibility": <0-100>,
    "photo_quality": <0-100>,
    "testimonials": <0-100>,
    "accreditations": <0-100>,
    "contact_clarity": <0-100>,
    "content_freshness": <0-100>
  },
  "executive_summary": "<2-3 sentences: the core trust problem a homeowner would feel>",
  "critical_issues": [
    {
      "issue": "<short title>",
      "evidence": "<specific evidence you found or did not find>",
      "why_it_matters": "<why a homeowner spending £30k would care>",
      "impact_on_leads": "low|medium|high|critical",
      "recommended_fix": "<concrete actionable fix>"
    }
  ],
  "visual_findings": [
    {
      "image_or_page": "<which page or image>",
      "finding": "<what you observed>",
      "confidence": "low|medium|high",
      "why_it_matters": "<trust impact>"
    }
  ],
  "trust_gaps": [
    {
      "gap": "<missing trust element>",
      "severity": "low|medium|high|critical",
      "explanation": "<why this gap hurts conversion>"
    }
  ],
  "what_is_working": [
    {
      "strength": "<positive element>",
      "evidence": "<what you saw>"
    }
  ],
  "benchmark_comparison": "<1-2 sentences comparing to a well-optimised UK construction company site>",
  "top_5_actions": [
    "<action 1 - most impactful first>",
    "<action 2>",
    "<action 3>",
    "<action 4>",
    "<action 5>"
  ]
}

Scoring guide:
- credibility: Companies House/VAT visible, professional email domain, physical address, SSL, legal clarity
- photo_quality: Real project photos vs stock, resolution, before/after, location-specific proof
- testimonials: Named reviews, external links (Google/Checkatrade), recency, project specificity
- accreditations: FMB, NHBC, CHAS, TrustMark, Gas Safe, NICEIC - prominence and verifiability
- contact_clarity: Phone on every page, email, CTA clarity, service area, response time
- content_freshness: Copyright year, recent project dates, active blog, evidence of live business`;

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
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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
    send('status', { message: 'Crawling website...', step: 1, total: 3 });
    const pages = await crawlWebsite(url);

    if (pages.length === 0) {
      send('error', { message: 'Could not reach the website. It may be blocking automated access. Try a different site.' });
      return res.end();
    }

    send('status', {
      message: 'Crawled ' + pages.length + ' pages and ' + pages.reduce((s, p) => s + p.images.length, 0) + ' images. Running AI analysis...',
      step: 2,
      total: 3,
    });

    const report = await scoreWebsite(pages, url);

    send('status', { message: 'Building your report...', step: 3, total: 3 });
    send('complete', { report, url, scannedAt: new Date().toISOString() });

  } catch (err) {
    console.error(err);
    send('error', { message: err.message || 'Audit failed. Please try again.' });
  }

  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
