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

CONTEXT: A homeowner is considering spending £10k-£250k on a project. They are cautious, risk-aware, and comparing multiple builders.

Return ONLY valid JSON. No markdown fences. No text outside the JSON.`;

  const userPrompt = `Website being audited: ${targetUrl}

EXTRACTED SIGNALS:
${JSON.stringify(aggregatedSignals, null, 2)}

FULL PAGE TEXT (${pages.length} pages crawled):
${allText.slice(0, 6000)}

I have also provided ${screenshotsToAnalyse.length} page screenshots for visual analysis.

Return this exact JSON structure. Follow every instruction carefully:

{
  "hero": {
    "score": <0-100 integer — honest, not generous>,
    "headline": "<confronting but fair — e.g. 'Your website is quietly losing you jobs'>",
    "subtext": "<1 sentence expanding on the headline — specific to what you found>",
    "ai_voice_intro": "<2-3 sentences speaking directly to the business owner. Tone: honest advisor who has just reviewed their site. Reference specific things you found.>"
  },
  "homeowner_journey": [
    {
      "stage": "first_impression",
      "thought": "<first person homeowner thought — realistic, slightly uncomfortable. What do they feel in the first 5 seconds?>"
    },
    {
      "stage": "scrolling",
      "thought": "<what doubt creeps in as they scroll? Reference something specific from the site>"
    },
    {
      "stage": "decision_moment",
      "thought": "<the exact moment they decide to enquire or leave — what tips it?>"
    }
  ],
  "live_audit_feed": [
    {
      "status": "success",
      "message": "<short punchy finding — something that IS present and working>"
    },
    {
      "status": "warning",
      "message": "<something present but weak or incomplete>"
    },
    {
      "status": "critical",
      "message": "<something missing that directly hurts trust>"
    }
  ],
  "trust_breakpoints": [
    {
      "title": "<short title of the trust failure>",
      "homeowner_reaction": "<exactly what goes through their head at this moment>",
      "evidence": "<what you specifically found or did not find>",
      "impact": "critical|high|medium|low",
      "fix": "<specific fix achievable within days>"
    }
  ],
  "photo_analysis": {
    "strong_images": [
      {
        "description": "<describe what you see>",
        "why_it_works": "<why this builds trust>"
      }
    ],
    "weak_images": [
      {
        "description": "<describe what you see>",
        "issue": "<what is wrong with it>",
        "impact": "<how this hurts trust>"
      }
    ]
  },
  "trust_questions": [
    {
      "question": "Can I verify this is a legitimate registered business?",
      "score": <0-100>,
      "explanation": "<specific answer based on evidence>"
    },
    {
      "question": "Do I believe these are real projects by this company?",
      "score": <0-100>,
      "explanation": "<specific answer based on evidence>"
    },
    {
      "question": "Do other homeowners trust and recommend this company?",
      "score": <0-100>,
      "explanation": "<specific answer based on evidence>"
    },
    {
      "question": "Do they have the credentials to handle my project safely?",
      "score": <0-100>,
      "explanation": "<specific answer based on evidence>"
    },
    {
      "question": "Will it be easy to contact and communicate with them?",
      "score": <0-100>,
      "explanation": "<specific answer based on evidence>"
    },
    {
      "question": "Is this business actively trading right now?",
      "score": <0-100>,
      "explanation": "<specific answer based on evidence>"
    }
  ],
  "competitor_gap": {
    "summary": "<1-2 sentences on how this compares to a well-optimised UK builder site>",
    "they_have": ["<thing a top competitor would have that this site lacks>"],
    "you_have": ["<genuine strengths this site does have>"]
  },
  "top_actions": [
    "<action 1 — most impactful, specific, achievable this week>",
    "<action 2>",
    "<action 3>",
    "<action 4>",
    "<action 5>"
  ]
}`;

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
  return JSON.parse(clean);
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
