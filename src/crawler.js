/**
 * crawler-scrapfly.js
 *
 * ScrapFly-based website crawler. Used in place of the Playwright crawler
 * for sites that block headless browsers (Cloudflare, custom WAF, etc).
 *
 * ScrapFly handles:
 *   - Cloudflare bypass (residential proxies)
 *   - JavaScript rendering (real browser farm)
 *   - Anti-bot challenge solving
 *
 * Returns the same `{ url, textContent, images, meta, screenshotB64 }` shape
 * as the Playwright crawler, so downstream code (scorer-ai.js) doesn't change.
 */

const config = require('./config');

const SCRAPFLY_API_BASE = 'https://api.scrapfly.io/scrape';
const MAX_PAGES = 20;

const SCREENSHOT_PRIORITY = /\/(our-?team|team|about|meet|who-?we-?are|services|what-?we-?do|contact|home|index)?\/?$/i;
const PRIORITY_PATTERN = /\/(our-?team|team|about|meet|who-?we-?are|services|what-?we-?do|contact|testimonials|reviews)/i;

function normaliseUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid'].forEach(p => u.searchParams.delete(p));
    u.host = u.host.toLowerCase();
    return u.toString().replace(/\/$/, u.pathname === '/' ? '/' : '');
  } catch (e) {
    return url;
  }
}

async function scrapflyFetch(url, { withScreenshot = false, debug = false } = {}) {
  if (!config.SCRAPFLY_API_KEY) {
    throw new Error('SCRAPFLY_API_KEY not configured');
  }

  const params = new URLSearchParams({
    key: config.SCRAPFLY_API_KEY,
    url: url,
    render_js: 'true',
    asp: 'true',
    country: 'gb',
    rendering_wait: '3000',
    format: 'json',
  });

  if (withScreenshot) {
    params.set('screenshots[main]', 'viewport');
    params.set('screenshot_flags', 'load_images');
  }

  const requestUrl = `${SCRAPFLY_API_BASE}?${params.toString()}`;
  const res = await fetch(requestUrl, { method: 'GET' });
  const data = await res.json();

  if (!res.ok || !data.result) {
    const errMsg = data.message || data.error || `HTTP ${res.status}`;
    throw new Error(`ScrapFly: ${errMsg}`);
  }

  const result = data.result;
  if (debug) {
    console.log(`[scrapfly] ${url} → status ${result.status_code}, ${result.content?.length || 0} bytes, ${data.context?.cost?.total || '?'} credits`);
  }

  return {
    url: result.url || url,
    statusCode: result.status_code,
    html: result.content || '',
    screenshotUrl: result.screenshots?.main?.url || null,
    cost: data.context?.cost?.total || 0,
  };
}

async function fetchScreenshotAsBase64(screenshotUrl) {
  if (!screenshotUrl) return null;
  try {
    const url = screenshotUrl.includes('?') ? `${screenshotUrl}&key=${config.SCRAPFLY_API_KEY}` : `${screenshotUrl}?key=${config.SCRAPFLY_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString('base64');
  } catch (err) {
    console.warn('Screenshot fetch failed:', err.message);
    return null;
  }
}

function parsePageContent(html, pageUrl, origin) {
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const textContent = cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);

  const images = [];
  const imgRegex = /<img\b[^>]*>/gi;
  const matches = html.match(imgRegex) || [];
  for (const tag of matches) {
    const src = (tag.match(/(?:^|\s)src=["']([^"']+)["']/i) || tag.match(/data-src=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
    if (!src) continue;
    let abs = src;
    try { abs = new URL(src, pageUrl).toString(); } catch (e) { continue; }
    if (!abs.startsWith('http')) continue;
    images.push({ src: abs, alt, width: 0, height: 0 });
  }

  const links = [];
  const linkRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let linkMatch;
  const originHost = (() => { try { return new URL(origin).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    let raw = linkMatch[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    let abs;
    try { abs = new URL(raw, pageUrl).toString(); } catch (e) { continue; }
    if (!abs.startsWith('http')) continue;
    let absHost;
    try { absHost = new URL(abs).hostname.replace(/^www\./, ''); } catch (e) { continue; }
    if (absHost !== originHost) continue;
    links.push(abs);
  }

  const badges = ['FMB','NHBC','CHAS','TrustMark','Gas Safe','NICEIC','Checkatrade','Which? Trusted','Federation of Master Builders'];
  const text = textContent;
  const meta = {
    title,
    copyrightYear: (text.match(/©\s*(\d{4})/) || [])[1] || null,
    hasPhone: /(\+44|0\d{10}|0\d{4}\s\d{6})/.test(text),
    hasAddress: /(street|road|avenue|lane|close|drive|,\s*[A-Z]{1,2}\d)/i.test(text),
    hasVAT: /VAT\s*(no|number|reg)?\s*:?\s*\d+/i.test(text),
    hasCompaniesHouse: /company\s*(no|number|reg)?\s*:?\s*\d+/i.test(text),
    accreditations: badges.filter(b => new RegExp(b, 'i').test(text)),
    testimonialCount: (text.match(/[\u201c\u201d][^\u201c\u201d]{40,}[\u201c\u201d]/g) || []).length,
    hasGoogleMaps: /google\.com\/maps/i.test(html),
    hasExternalReviewLinks: /checkatrade|trustpilot|google.*review|houzz|rated\.people/i.test(text),
    professionalEmail: !/gmail|hotmail|yahoo|outlook\.com/i.test(text),
  };

  return { textContent, images, meta, links };
}

async function crawlWebsiteScrapFly(startUrl, opts = {}) {
  const debug = opts.debug || false;
  const debugLog = [];

  if (!config.SCRAPFLY_API_KEY) {
    throw new Error('SCRAPFLY_API_KEY not configured — cannot crawl');
  }

  const visited = new Set();
  const queue = [normaliseUrl(startUrl)];
  const origin = new URL(startUrl).origin;
  const pages = [];
  let totalCost = 0;

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let path;
    try { path = new URL(url).pathname; } catch (e) { path = '/'; }
    const isHomepage = path === '/' || path === '';
    const isKeyPage = SCREENSHOT_PRIORITY.test(path);
    const withScreenshot = isHomepage || isKeyPage;

    try {
      const result = await scrapflyFetch(url, { withScreenshot, debug });
      totalCost += result.cost;

      if (result.statusCode >= 400) {
        if (debug) debugLog.push({ url, stage: 'http-error', status: result.statusCode, cost: result.cost });
        continue;
      }

      const { textContent, images, meta, links } = parsePageContent(result.html, url, origin);

      let screenshotB64 = null;
      if (withScreenshot && result.screenshotUrl) {
        screenshotB64 = await fetchScreenshotAsBase64(result.screenshotUrl);
      }

      links.forEach(l => {
        const clean = normaliseUrl(l);
        if (!visited.has(clean) && !queue.includes(clean)) {
          if (PRIORITY_PATTERN.test(clean)) {
            queue.unshift(clean);
          } else {
            queue.push(clean);
          }
        }
      });

      pages.push({ url, textContent, images, meta, screenshotB64 });
      if (debug) debugLog.push({
        url,
        stage: 'success',
        textLen: textContent.length,
        imageCount: images.length,
        linksFound: links.length,
        linksSample: links.slice(0, 5),
        hadScreenshot: !!screenshotB64,
        cost: result.cost,
      });
    } catch (err) {
      console.warn('ScrapFly crawl failed:', url, err.message);
      if (debug) debugLog.push({ url, stage: 'exception', message: err.message });
    }
  }

  console.log(`[scrapfly] Crawl complete: ${pages.length} pages, total cost ${totalCost} credits`);

  if (debug) return { pages, debugLog, totalCost };
  return pages;
}

module.exports = {
  crawlWebsiteScrapFly,
  isAvailable: () => !!config.SCRAPFLY_API_KEY,
  version: '2026-04-26-link-fix',
};
