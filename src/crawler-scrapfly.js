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
 *
 * Cost notes:
 *   - Plain JS render: ~5 credits per page
 *   - JS render + ASP (anti-scraping): ~25 credits per page
 *   - Add screenshot: ~5 extra credits per page
 *
 * We use the hybrid screenshot strategy — only homepage + about/team/services
 * pages get screenshots. That keeps cost down without losing visual analysis
 * for the pages that matter most.
 */

const config = require('./config');

const SCRAPFLY_API_BASE = 'https://api.scrapfly.io/scrape';
const MAX_PAGES = 20;

/* Pages we want screenshots for (visual analysis) */
const SCREENSHOT_PRIORITY = /\/(our-?team|team|about|meet|who-?we-?are|services|what-?we-?do|contact|home|index)?\/?$/i;

/* Used to push high-priority pages to the front of the crawl queue */
const PRIORITY_PATTERN = /\/(our-?team|team|about|meet|who-?we-?are|services|what-?we-?do|contact|testimonials|reviews)/i;

function normaliseUrl(url) {
  try {
    const u = new URL(url);
    /* Strip fragments + tracking params, lowercase host */
    u.hash = '';
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid'].forEach(p => u.searchParams.delete(p));
    u.host = u.host.toLowerCase();
    /* Trailing slash on root only */
    return u.toString().replace(/\/$/, u.pathname === '/' ? '/' : '');
  } catch (e) {
    return url;
  }
}

/* Hit ScrapFly for a single URL. Returns the parsed result or throws. */
async function scrapflyFetch(url, { withScreenshot = false, debug = false } = {}) {
  if (!config.SCRAPFLY_API_KEY) {
    throw new Error('SCRAPFLY_API_KEY not configured');
  }

  const params = new URLSearchParams({
    key: config.SCRAPFLY_API_KEY,
    url: url,
    /* Render JavaScript (essential for modern WordPress and SPAs) */
    render_js: 'true',
    /* Anti-Scraping Protection — bypasses Cloudflare and similar */
    asp: 'true',
    /* UK-based residential proxies — cheaper than premium and works for UK sites */
    country: 'gb',
    /* Wait up to 8 seconds after page load for content to settle */
    rendering_wait: '3000',
    /* Get the page as JSON (HTML in `result.content`) */
    format: 'json',
  });

  if (withScreenshot) {
    /* Viewport-only screenshot (1920x1080 max) — full-page screenshots of long
       WordPress sites can exceed Claude's 8000px dimension limit and cause API errors.
       The visible viewport gives the AI hero/nav/above-the-fold which is what matters
       most for trust-signal analysis; below-the-fold content is captured in page text. */
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
    /* Screenshots (if requested) come back as URL refs; ScrapFly hosts them.
       We fetch and base64 encode so the AI can see them inline. */
    screenshotUrl: result.screenshots?.main?.url || null,
    cost: data.context?.cost?.total || 0,
  };
}

/* Fetch a screenshot from ScrapFly's CDN and convert to base64 for AI consumption */
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

/* Parse the HTML response from ScrapFly into the same shape Playwright produced.
   We use simple regex-based extraction — no DOM in Node, but for what we need
   (text, images, meta signals) regex is plenty. */
function parsePageContent(html, pageUrl, origin) {
  /* Remove script/style/noscript blocks before extracting text */
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');

  /* Extract title */
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  /* Extract visible text — strip tags, decode common entities */
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

  /* Extract images — prefer src, fall back to data-src and srcset */
  const images = [];
  const imgRegex = /<img\b[^>]*>/gi;
  const matches = html.match(imgRegex) || [];
  for (const tag of matches) {
    const src = (tag.match(/(?:^|\s)src=["']([^"']+)["']/i) || tag.match(/data-src=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
    if (!src) continue;
    /* Resolve relative URLs */
    let abs = src;
    try { abs = new URL(src, pageUrl).toString(); } catch (e) { continue; }
    if (!abs.startsWith('http')) continue;
    images.push({ src: abs, alt, width: 0, height: 0 });
  }

  /* Extract internal links for the crawl queue.
     We compare hostnames after stripping `www.` so links to the bare domain
     get queued too. We also resolve protocol-relative URLs (//host/path) and
     fragment-only links (#anchor). */
  const links = [];
  const linkRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let linkMatch;
  const originHost = (() => { try { return new URL(origin).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    let raw = linkMatch[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    /* Resolve relative + protocol-relative URLs against the page URL */
    let abs;
    try { abs = new URL(raw, pageUrl).toString(); } catch (e) { continue; }
    if (!abs.startsWith('http')) continue;
    /* Same-host match ignoring www. */
    let absHost;
    try { absHost = new URL(abs).hostname.replace(/^www\./, ''); } catch (e) { continue; }
    if (absHost !== originHost) continue;
    links.push(abs);
  }

  /* Build the meta signals object the same way the Playwright crawler did */
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

/* Main crawler entry point — same signature as the old Playwright function */
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

    /* Decide if this URL deserves a screenshot (homepage + key pages only) */
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

      /* Get the screenshot if we asked for one */
      let screenshotB64 = null;
      if (withScreenshot && result.screenshotUrl) {
        screenshotB64 = await fetchScreenshotAsBase64(result.screenshotUrl);
      }

      /* Add new internal links to the queue, prioritising team/about/services */
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
        htmlLen: result.html.length,
        htmlSample: result.html.slice(0, 1500),
        anchorTagCount: (result.html.match(/<a\s/gi) || []).length,
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
  /* Version stamp — bump when this file changes so we can see which build is live */
  version: '2026-04-26-html-debug',
};
