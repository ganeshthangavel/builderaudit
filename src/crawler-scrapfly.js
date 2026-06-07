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

/* Hit ScrapFly for a single URL. Returns the parsed result or throws.
 *
 * `mode` controls how aggressively we try to extract content:
 *   - 'standard' (default): JS render + ASP + UK datacenter proxy. ~5 credits.
 *     Works for the vast majority of UK builder sites including most Cloudflare-protected ones.
 *   - 'stubborn': adds longer rendering wait + auto-scroll. ~7 credits.
 *     For JS-heavy sites where the initial render returns near-empty HTML.
 *   - 'fortress': switches to residential proxy pool. ~25 credits.
 *     For sites with serious bot detection that block datacenter IPs entirely.
 */
async function scrapflyFetch(url, { withScreenshot = false, debug = false, mode = 'standard' } = {}) {
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
    /* UK-based proxies — cheaper than premium and works for UK sites */
    country: 'gb',
    /* Wait after page load for content to settle. Longer in stubborn/fortress mode. */
    rendering_wait: mode === 'standard' ? '3000' : '8000',
    /* NOTE: Do NOT set format=json. That option converts the page to structured
       JSON with markdown content, which strips out all the <a href> tags we need
       to follow internal links. We want raw HTML so our parser can extract links
       and images directly. The default response is already JSON-wrapped at the
       outer level — `data.result.content` contains the raw HTML. */
  });

  /* Stubborn mode adds auto-scroll to trigger lazy-loaded content */
  if (mode === 'stubborn' || mode === 'fortress') {
    params.set('auto_scroll', 'true');
  }

  /* Fortress mode switches to residential proxies (much harder for sites to block) */
  if (mode === 'fortress') {
    params.set('proxy_pool', 'public_residential_pool');
  }

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
    console.log(`[scrapfly:${mode}] ${url} → status ${result.status_code}, ${result.content?.length || 0} bytes, ${data.context?.cost?.total || '?'} credits`);
  }

  return {
    url: result.url || url,
    statusCode: result.status_code,
    html: result.content || '',
    /* Screenshots (if requested) come back as URL refs; ScrapFly hosts them.
       We fetch and base64 encode so the AI can see them inline. */
    screenshotUrl: result.screenshots?.main?.url || null,
    cost: data.context?.cost?.total || 0,
    mode,
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

/* Sitemap discovery — used when the initial homepage crawl yields few internal
 * links. Many builder sites hide their site structure behind JS menus that even
 * with auto-scroll we don't fully expand. /sitemap.xml is the canonical list.
 * Returns a list of same-origin URLs (max 30) or [] if no sitemap is found. */
async function tryFetchSitemap(origin, debug) {
  const sitemapCandidates = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
  const originHost = new URL(origin).hostname.replace(/^www\./, '');
  for (const candidate of sitemapCandidates) {
    try {
      /* Sitemaps don't need JS rendering — but they often sit behind Cloudflare
         too, so we still go through ScrapFly with minimal settings. */
      const params = new URLSearchParams({
        key: config.SCRAPFLY_API_KEY,
        url: origin + candidate,
        country: 'gb',
        asp: 'true',
      });
      const res = await fetch(SCRAPFLY_API_BASE + '?' + params.toString());
      const data = await res.json();
      if (!res.ok || !data.result || data.result.status_code >= 400) continue;
      const xml = data.result.content || '';
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
      const sameOrigin = locs.filter(u => {
        try {
          const h = new URL(u).hostname.replace(/^www\./, '');
          return h === originHost;
        } catch (e) { return false; }
      });
      if (sameOrigin.length > 0) {
        if (debug) console.log(`[scrapfly] Sitemap found: ${candidate} (${sameOrigin.length} URLs)`);
        return sameOrigin.slice(0, 30);
      }
    } catch (err) {
      /* Try next candidate */
    }
  }
  return [];
}

/* Fetch a page with smart escalation. Tries 'standard' first; if the response
 * is suspiciously empty (likely a JS-heavy page that didn't finish rendering),
 * retries with 'stubborn' mode. Returns the better of the two results.
 * Never escalates to 'fortress' automatically — that's reserved for the
 * homepage retry path because it costs 5x more. */
async function fetchPageWithEscalation(url, { withScreenshot, debug }) {
  /* First attempt — cheap, fast */
  let result = await scrapflyFetch(url, { withScreenshot, debug, mode: 'standard' });

  /* If the page came back near-empty AND status is OK, retry with stubborn mode.
     "Near-empty" = under 800 bytes of content (a 200-OK with empty body is a
     classic sign the JS didn't finish rendering in 3s). */
  if (result.statusCode === 200 && (result.html || '').length < 800) {
    if (debug) console.log(`[scrapfly] Sparse response from ${url} (${result.html.length} bytes), retrying with stubborn mode`);
    try {
      const retry = await scrapflyFetch(url, { withScreenshot, debug, mode: 'stubborn' });
      if ((retry.html || '').length > (result.html || '').length) {
        result = retry;
      }
    } catch (err) {
      /* Stubborn retry failed — keep the original (sparse) response */
      if (debug) console.warn(`[scrapfly] Stubborn retry of ${url} failed:`, err.message);
    }
  }
  return result;
}

/* Main crawler entry point — same signature as the old Playwright function.
 * Smart-fallback flow:
 *   1. Fetch homepage with standard settings (cheap)
 *   2. If homepage returns near-empty content, retry with stubborn mode
 *      (longer wait + auto-scroll)
 *   3. If homepage STILL fails or returns very few internal links (<5),
 *      try sitemap discovery to seed the queue
 *   4. For each subsequent page, retry with stubborn mode if the first
 *      attempt is suspiciously empty
 *   5. Throttle, rate-limit detection, consecutive-error abort — unchanged
 */
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
  let consecutiveErrors = 0;
  let rateLimitHit = false;
  let homepageProcessed = false;
  let sitemapAttempted = false;

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

    /* Throttle ourselves: ScrapFly's free/starter plans cap at ~25 requests/min.
       2.5s between requests gives us max ~24/min, safely under the limit. */
    if (pages.length > 0) {
      await new Promise(r => setTimeout(r, 2500));
    }

    let homepageFortressTried = false;

    try {
      let result = await fetchPageWithEscalation(url, { withScreenshot, debug });
      totalCost += result.cost;

      /* Homepage-specific: if standard + stubborn both failed (no HTML or 4xx/5xx),
         try one more time with fortress mode (residential proxies). Worth the
         extra credits because if we can't get the homepage we get nothing. */
      if (isHomepage && (result.statusCode >= 400 || (result.html || '').length < 800)) {
        homepageFortressTried = true;
        if (debug) console.log(`[scrapfly] Homepage ${url} weak after stubborn, escalating to fortress mode`);
        try {
          await new Promise(r => setTimeout(r, 1500));
          const fortress = await scrapflyFetch(url, { withScreenshot, debug, mode: 'fortress' });
          totalCost += fortress.cost;
          if (fortress.statusCode < 400 && (fortress.html || '').length >= (result.html || '').length) {
            result = fortress;
          }
        } catch (err) {
          if (debug) console.warn(`[scrapfly] Fortress retry of ${url} failed:`, err.message);
        }
      }

      consecutiveErrors = 0;

      if (result.statusCode >= 400) {
        if (debug) debugLog.push({ url, stage: 'http-error', status: result.statusCode, cost: result.cost, mode: result.mode });
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
        anchorTagCount: (result.html.match(/<a\s/gi) || []).length,
        imageCount: images.length,
        linksFound: links.length,
        linksSample: links.slice(0, 5),
        hadScreenshot: !!screenshotB64,
        cost: result.cost,
        mode: result.mode,
        homepageFortressTried,
      });

      /* After processing the homepage, decide whether to seed sitemap URLs.
         Trigger: homepage succeeded but yielded fewer than 5 internal links.
         JS menus often hide the real site structure — sitemap rescues it. */
      if (isHomepage && !homepageProcessed) {
        homepageProcessed = true;
        if (links.length < 5 && !sitemapAttempted) {
          sitemapAttempted = true;
          if (debug) console.log(`[scrapfly] Homepage had only ${links.length} internal links, trying sitemap`);
          const sitemapUrls = await tryFetchSitemap(origin, debug);
          if (debug) debugLog.push({ stage: 'sitemap', found: sitemapUrls.length, sample: sitemapUrls.slice(0, 5) });
          /* Seed sitemap URLs into the queue, prioritising key pages */
          sitemapUrls.forEach(u => {
            const clean = normaliseUrl(u);
            if (!visited.has(clean) && !queue.includes(clean)) {
              if (PRIORITY_PATTERN.test(clean)) {
                queue.unshift(clean);
              } else {
                queue.push(clean);
              }
            }
          });
        }
      }
    } catch (err) {
      const msg = err.message || '';
      console.warn('ScrapFly crawl failed:', url, msg);
      if (debug) debugLog.push({ url, stage: 'exception', message: msg });

      consecutiveErrors++;

      /* Rate limit hit — stop entirely. Continuing makes it worse and ScrapFly
         warns about IP-level firewall blocks if we keep hammering. */
      if (msg.includes('429') || msg.includes('throttled') || msg.includes('too many')) {
        rateLimitHit = true;
        console.warn('[scrapfly] Rate limit hit, aborting crawl');
        if (debug) debugLog.push({ stage: 'aborted', reason: 'rate_limit', pagesCrawled: pages.length });
        break;
      }

      /* Three consecutive errors → something else is wrong, stop firing requests */
      if (consecutiveErrors >= 3) {
        console.warn('[scrapfly] 3 consecutive errors, aborting crawl');
        if (debug) debugLog.push({ stage: 'aborted', reason: 'consecutive_errors' });
        break;
      }

      /* If the HOMEPAGE failed outright, try sitemap as an emergency seed —
         maybe the homepage has aggressive bot detection but the sitemap doesn't. */
      if (isHomepage && !sitemapAttempted) {
        sitemapAttempted = true;
        if (debug) console.log(`[scrapfly] Homepage threw — trying sitemap as fallback`);
        try {
          const sitemapUrls = await tryFetchSitemap(origin, debug);
          if (debug) debugLog.push({ stage: 'sitemap', found: sitemapUrls.length, reason: 'homepage_failed' });
          sitemapUrls.forEach(u => {
            const clean = normaliseUrl(u);
            if (!visited.has(clean) && !queue.includes(clean)) {
              if (PRIORITY_PATTERN.test(clean)) {
                queue.unshift(clean);
              } else {
                queue.push(clean);
              }
            }
          });
        } catch (e) {
          if (debug) debugLog.push({ stage: 'sitemap', error: e.message });
        }
      }
    }
  }

  console.log(`[scrapfly] Crawl complete: ${pages.length} pages, total cost ${totalCost} credits${rateLimitHit ? ' (rate limited)' : ''}`);

  if (debug) return { pages, debugLog, totalCost, rateLimitHit };
  return pages;
}

module.exports = {
  crawlWebsiteScrapFly,
  isAvailable: () => !!config.SCRAPFLY_API_KEY,
  /* Version stamp — bump when this file changes so we can see which build is live */
  version: '2026-06-07-smart-fallback',
};
