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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; SiteAuditBot/1.0)',
    viewport: { width: 1280, height: 800 },
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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);

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
      console.log('Crawled:', url, '—', images.length, 'images');
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

  const allText = pages.map(p => `[PAGE: ${p.url}]\n${p.textContent}`).join('\n\n---\n\n');
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
    imageSample: allImages.slice(0, 20).map(i => ({ src: i.src, alt: i.alt, width: i.width, height: i.height })),
  };

  const prompt = `You are an expert auditor reviewing a UK construction company website for trustworthiness and customer conversion quality.

Website: ${targetUrl}
Signals: ${JSON.stringify(aggregatedSignals, null, 2)}
Text (first 5000 chars): ${allText.slice(0, 5000)}

Return ONLY valid JSON, no markdown, no explanation:

{
  "scores": {
    "credibility": <0-100>,
    "photoQuality": <0-100>,
    "testimonials": <0-100>,
    "accreditations": <0-100>,
    "contactClarity": <0-100>,
    "contentFreshness": <0-100>
  },
  "issues": [
    {
      "severity": "critical|warning|good",
      "category": "credibility|photoQuality|testimonials|accreditations|contactClarity|contentFreshness",
      "title": "<short title>",
      "detail": "<1-2 sentences specific to what you saw>",
      "fix": "<concrete action they can take this week>"
    }
  ],
  "positives": ["<thing done well>"],
  "summary": "<2 sentence plain English summary of main trust problems>",
  "competitorGap": "<1 sentence comparing to a well-optimised UK builder site>"
}

Scoring guide:
- credibility: Companies House/VAT visible, professional email, physical address, SSL
- photoQuality: Real project photos not stock, high res, labelled with project/location
- testimonials: Named reviews with location, linked to Google/Checkatrade, specific details
- accreditations: FMB, NHBC, CHAS, TrustMark, Gas Safe, NICEIC badges prominently shown
- contactClarity: Phone on every page, email, contact form, service area clear
- contentFreshness: Copyright year current, recent projects, no dead links`;

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: prompt }],
    }],
  });

  const rawText = response.content.map(b => b.text || '').join('');
  const clean = rawText.replace(/```json|```/g, '').trim();
  const result = JSON.parse(clean);

  const weights = { credibility: 0.25, photoQuality: 0.20, testimonials: 0.20, accreditations: 0.15, contactClarity: 0.10, contentFreshness: 0.10 };
  let overall = 0;
  for (const [key, w] of Object.entries(weights)) overall += (result.scores[key] || 0) * w;
  result.overallScore = Math.round(overall);

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

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    send('status', { message: 'Crawling website...', step: 1, total: 3 });
    const pages = await crawlWebsite(url);

    if (pages.length === 0) {
      send('error', { message: 'Could not reach the website. Check the URL and try again.' });
      return res.end();
    }

    send('status', {
      message: `Crawled ${pages.length} pages and ${pages.reduce((s, p) => s + p.images.length, 0)} images. Running AI analysis...`,
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
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
