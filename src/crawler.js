/**
 * crawler.js
 * Spiders a construction company website using Playwright.
 * Returns structured page data: text, images, links, screenshots.
 */

const { chromium } = require('playwright');
const { URL } = require('url');

const MAX_PAGES = 20;
const PAGE_TIMEOUT = 15000;

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

  console.log(`\n🕷  Crawling: ${startUrl}`);

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(800); // let lazy-load images settle

      // ── Screenshot ──────────────────────────────────────────
      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 75 });
      const screenshotB64 = screenshot.toString('base64');

      // ── Text content ─────────────────────────────────────────
      const textContent = await page.evaluate(() => {
        const el = document.body.cloneNode(true);
        // remove nav/footer noise for cleaner text
        ['nav','footer','script','style','noscript'].forEach(tag => {
          el.querySelectorAll(tag).forEach(n => n.remove());
        });
        return el.innerText.replace(/\s+/g, ' ').trim().slice(0, 8000);
      });

      // ── Images ───────────────────────────────────────────────
      const images = await page.evaluate((base) => {
        return [...document.querySelectorAll('img')].map(img => ({
          src: img.src || '',
          alt: img.alt || '',
          width: img.naturalWidth,
          height: img.naturalHeight,
        })).filter(i => i.src.startsWith('http') && !i.src.includes('data:'));
      }, origin);

      // ── Meta & trust signals ─────────────────────────────────
      const meta = await page.evaluate(() => {
        const get = sel => document.querySelector(sel)?.content || '';
        const text = document.body.innerText;
        return {
          title: document.title,
          description: get('meta[name="description"]'),
          copyrightYear: (text.match(/©\s*(\d{4})/) || [])[1] || null,
          hasPhone: /(\+44|0\d{10}|0\d{4}\s\d{6})/.test(text),
          hasAddress: /(street|road|avenue|lane|close|drive|way|,\s*[A-Z]{1,2}\d)/i.test(text),
          hasVAT: /VAT\s*(no|number|reg|registration)?\s*:?\s*\d+/i.test(text),
          hasCompaniesHouse: /company\s*(no|number|reg)?\s*:?\s*\d+/i.test(text),
          accreditations: detectAccreditations(text),
          testimonialCount: countTestimonials(text),
          hasGoogleMaps: !!document.querySelector('iframe[src*="google.com/maps"]'),
        };

        function detectAccreditations(t) {
          const badges = ['FMB','NHBC','CHAS','TrustMark','Gas Safe','NICEIC',
                          'Checkatrade','Which? Trusted','Federation of Master Builders',
                          'Build Assure','Premier Guarantee'];
          return badges.filter(b => new RegExp(b,'i').test(t));
        }

        function countTestimonials(t) {
          // count quotation blocks over 40 chars
          const quotes = t.match(/[""][^""]{40,}[""]/g) || [];
          return quotes.length;
        }
      });

      // ── Internal links for queue ─────────────────────────────
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
      console.log(`  ✓ ${url} (${images.length} images)`);

      await page.close();
    } catch (err) {
      console.warn(`  ✗ Failed: ${url} — ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\n✅ Crawl complete. ${pages.length} pages, ${pages.reduce((s,p)=>s+p.images.length,0)} images\n`);
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

module.exports = { crawlWebsite };
