/**
 * scorer-ai.js
 * The AI-powered forensic scorer. Takes crawled pages + image verification,
 * returns a structured forensic report. Used by both server.js (live audits)
 * and weekly-cron.js (re-analysis for opted-in users).
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { extractSiteFacts } = require('./site-facts');

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = (config.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set. ' +
      'In Railway: Project → Variables → add ANTHROPIC_API_KEY. Redeploy the service after adding it.'
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

async function ensureImageWithinLimits(base64Data) {
  if (!base64Data) return null;
  try {
    const sharp = require('sharp');
    const buffer = Buffer.from(base64Data, 'base64');
    const metadata = await sharp(buffer).metadata();
    const MAX_DIM = 7800;
    if ((metadata.width || 0) <= MAX_DIM && (metadata.height || 0) <= MAX_DIM) {
      return base64Data;
    }
    console.log(`[scorer-ai] Resizing oversize screenshot ${metadata.width}x${metadata.height} -> max ${MAX_DIM}px`);
    const resized = await sharp(buffer)
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return resized.toString('base64');
  } catch (err) {
    console.warn('[scorer-ai] Image resize failed, skipping screenshot:', err.message);
    return null;
  }
}

/* Decide whether an image is likely a real PROJECT / property / construction
   photo (worth sending to the vision model) vs a logo, badge, icon, headshot
   or banner (not worth the tokens). Uses only the cheap metadata we already
   have: filename in src, alt text, and dimensions. */
function isLikelyProjectImage(img) {
  const src = (img.src || '').toLowerCase();
  const alt = (img.alt || '').toLowerCase();
  const hay = src + ' ' + alt;
  const w = img.width || 0, h = img.height || 0;

  // Hard excludes — obvious non-project assets
  if (/\.svg(\?|$)/.test(src)) return false;
  if (/(logo|favicon|icon|sprite|badge|award|cert|accredit|trustmark|trustpilot|checkatrade|fmb|niceic|gas-?safe|which|google-?review|stars?|rating|banner|placeholder|avatar|headshot|profile|team|staff|partner|sponsor|paypal|visa|mastercard|map|pin|arrow|chevron|btn|button|bg-|background|pattern|texture|divider|swatch)/.test(hay)) return false;

  // Dimension-based excludes (when we know them)
  if (w && h) {
    if (w < 300 || h < 200) return false;             // too small to be a project hero/gallery shot
    const ratio = w / h;
    if (ratio > 4 || ratio < 0.25) return false;       // banner/skyscraper strips, not photos
  }

  // Positive signals push it in even if dimensions are unknown
  const projectHints = /(project|portfolio|gallery|work|job|build|construction|extension|renovat|refurb|conversion|loft|kitchen|bathroom|bedroom|interior|exterior|property|home|house|development|site|completed|before|after|case-?study|new-?build|landscap|driveway|patio|roof|brick|render)/;
  if (projectHints.test(hay)) return true;

  // Otherwise, keep only reasonably large images (likely content photos)
  if (w && h) return (w >= 400 && h >= 300);
  return true; // unknown dimensions, not excluded above — let it through
}

/* Fetch an image URL and return safe base64 + media type, resized/compressed to
   stay within the vision API limits. Returns null on any failure (never throws,
   so one bad image can't break a scan). */
async function fetchImageAsBlock(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    if (!/image\/(jpeg|jpg|png|webp|gif)/.test(ctype)) return null;
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length > 5 * 1024 * 1024 || buf.length < 1024) {
      // Too big for the API (>5MB) or too tiny to be a real photo — resize if big
      if (buf.length < 1024) return null;
    }
    // Normalise: cap at 1024px long edge, JPEG q80 — keeps tokens ~1000-1300/image
    const sharp = require('sharp');
    const out = await sharp(buf)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { type: 'base64', media_type: 'image/jpeg', data: out.toString('base64') };
  } catch (err) {
    return null;
  }
}

async function scoreWebsite(pages, targetUrl, imageVerification, overrides, userContext, audience, options = {}) {
  const lite = options.lite === true;   // competitor scans: skip slow individual-image vision fetching
  const client = getClient();
  audience = audience || 'builder';

  const pageMap = pages.map(p => {
    const url = p.url;
    const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (e) { return url.toLowerCase(); } })();
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
    return { url: p.url, kind, textLength: (p.textContent || '').length };
  });

  const priority = { home: 0, about: 1, team: 1, services: 2, contact: 3, testimonials: 4,
    portfolio: 5, pricing: 5, faq: 6, blog: 7, other: 8 };
  const sortedPages = [...pages].sort((a, b) => {
    const am = pageMap.find(m => m.url === a.url);
    const bm = pageMap.find(m => m.url === b.url);
    return (priority[am.kind] ?? 9) - (priority[bm.kind] ?? 9);
  });

  const allText = sortedPages.map(p => '[PAGE: ' + p.url + ']\n' + p.textContent).join('\n\n---\n\n');
  const allMeta = pages.map(p => p.meta);
  const allImages = pages.flatMap(p => p.images);

  const teamPage = pages.find(p => {
    const path = (() => { try { return new URL(p.url).pathname.toLowerCase(); } catch (e) { return ''; } })();
    return /team|staff|people|meet|who-?we-?are/.test(path);
  });
  const testimonialsPage = pages.find(p => {
    const path = (() => { try { return new URL(p.url).pathname.toLowerCase(); } catch (e) { return ''; } })();
    return /testimonial|review/.test(path);
  });
  const aboutPage = pages.find(p => {
    const path = (() => { try { return new URL(p.url).pathname.toLowerCase(); } catch (e) { return ''; } })();
    return /about|our-story|who-we-are/.test(path);
  });

  overrides = overrides || {};
  const filteredVerification = imageVerification ? {
    ...imageVerification,
    stockImages: (imageVerification.stockImages || []).filter(img => overrides[img.src] !== 'rejected'),
    duplicatedImages: (imageVerification.duplicatedImages || []).filter(img => overrides[img.src] !== 'rejected'),
  } : null;

  const candidatePages = pages.slice(0, 4).filter(p => p.screenshotB64);
  const safeScreenshots = await Promise.all(
    candidatePages.map(async p => {
      const safeB64 = await ensureImageWithinLimits(p.screenshotB64);
      return safeB64 ? { ...p, screenshotB64: safeB64 } : null;
    })
  );
  const screenshotsToAnalyse = safeScreenshots.filter(Boolean);
  const screenshotBlocks = screenshotsToAnalyse.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: p.screenshotB64 },
  }));

  /* ── Individual project-photo analysis ───────────────────────────────────
     Give every image in the sample a stable ref (img_1…), then pick only the
     likely project/property/construction photos (skipping logos, badges,
     headshots, icons, banners) and send those — up to 12 — to the vision model
     as actual images, each labelled with its ref. This lets the AI describe
     the real photo instead of guessing from filenames, and keeps cost down by
     not sending the junk. */
  const refImages = allImages.slice(0, 30).map((i, idx) => ({
    ref: 'img_' + (idx + 1), src: i.src, alt: i.alt, width: i.width, height: i.height,
  }));
  const PROJECT_IMAGE_CAP = 12;
  const projectCandidates = lite ? [] : refImages.filter(isLikelyProjectImage).slice(0, PROJECT_IMAGE_CAP);
  const fetchedProjectImages = lite ? [] : (await Promise.all(
    projectCandidates.map(async (im) => {
      const source = await fetchImageAsBlock(im.src);
      return source ? { ref: im.ref, source } : null;
    })
  )).filter(Boolean);
  if (!lite) console.log(`[scorer-ai] Project photos: ${projectCandidates.length} selected, ${fetchedProjectImages.length} fetched for vision analysis`);

  /* Interleave a ref label before each project image so the AI can tie its
     description to the exact image (and thus the exact URL on the dashboard). */
  const projectImageBlocks = [];
  if (fetchedProjectImages.length) {
    projectImageBlocks.push({
      type: 'text',
      text: 'INDIVIDUAL PROJECT/PROPERTY PHOTOS FROM THIS SITE — each labelled with its ref. '
        + 'When you fill photo_analysis, set image_ref to the matching label and make the description match what you actually see in that image:',
    });
    fetchedProjectImages.forEach((fi) => {
      projectImageBlocks.push({ type: 'text', text: fi.ref + ':' });
      projectImageBlocks.push({ type: 'image', source: fi.source });
    });
  }

  const imageBlocks = [...screenshotBlocks, ...projectImageBlocks];

  const imgVerifySummary = filteredVerification ? {
    imagesChecked: filteredVerification.checked,
    totalImagesOnSite: filteredVerification.total,
    confirmedStockImages: filteredVerification.stockImages.map(i => ({ url: i.src, foundOn: i.reason, source: i.source || null })),
    duplicatedElsewhere: filteredVerification.duplicatedImages.map(i => ({ url: i.src, foundOn: i.reason, matchCount: i.matchCount })),
    confirmedOriginal: (filteredVerification.originalImages || []).length,
    userOverrideCount: Object.values(overrides).filter(v => v === 'rejected').length,
  } : null;

  /* Extract deterministic site facts — these override AI guesses */
  const siteFacts = extractSiteFacts(pages);

  const aggregatedSignals = {
    totalPages: pages.length,
    pagesCrawled: pageMap.map(p => ({ url: p.url, kind: p.kind })),
    pageKindsPresent: [...new Set(pageMap.map(p => p.kind))].filter(k => k !== 'other').sort(),
    teamPageContent: teamPage ? { url: teamPage.url, fullText: teamPage.textContent } : null,
    testimonialsPageContent: testimonialsPage ? { url: testimonialsPage.url, fullText: testimonialsPage.textContent } : null,
    aboutPageContent: aboutPage ? { url: aboutPage.url, fullText: aboutPage.textContent } : null,
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
    /* Deterministic media facts — the page genuinely contains these elements.
       Used to stop the AI calling a paused/poster video frame "broken". */
    hasVideo: allMeta.some(m => m.hasVideo),
    hasVideoEmbed: allMeta.some(m => m.hasVideoEmbed),
    hasSliderOrCarousel: allMeta.some(m => m.hasSliderOrCarousel),
    hasAnimation: allMeta.some(m => m.hasAnimation),
    imageSample: refImages,
    imageVerification: imgVerifySummary,
  };

  let contextLine = '';

  if (userContext) {
    const typeLabels = {
      sole_trader: 'Sole Trader',
      limited_company: 'Limited Company',
      partnership: 'Partnership',
      other: 'building company',
    };
    if (userContext.businessType) {
      contextLine += '\n\nBUSINESS CONTEXT: This website belongs to a ' + (typeLabels[userContext.businessType] || userContext.businessType) + '.';
      if (userContext.region) {
        contextLine += '\nRegion (from user signup): ' + userContext.region + '. Consider regional accreditations (e.g. local FMB chapter, Trading Standards) and regional homeowner expectations.';
      }
      contextLine += '\nYour feedback MUST acknowledge this business type. For example: do not penalise a Sole Trader for not having a Companies House number. Do not expect regional Ltd accreditations if they are a Partnership. Tailor the trust_questions, trust_breakpoints, and scoring accordingly.';
    }
  }

  if (siteFacts && siteFacts.location && siteFacts.location.primary) {
    const otherLocs = siteFacts.location.allMentioned.slice(1, 5);
    contextLine += '\n\nBUILDER\'S OPERATING REGION (DETERMINISTICALLY EXTRACTED): The site primarily references ' + siteFacts.location.primary +
      (otherLocs.length > 0 ? ' (also mentions: ' + otherLocs.join(', ') + ')' : '') + '.' +
      '\nDo NOT reference cities or regions the builder does not operate in (e.g. don\'t say "London homeowners" if the site references Yorkshire). ' +
      'If you mention a city or region, it must be one of the detected locations above.';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SYSTEM PROMPTS — sharpened to reject generic output
     ═══════════════════════════════════════════════════════════════════════════ */

  const builderPrompt = `You are a forensic conversion analyst for UK construction companies. You are reviewing a SPECIFIC website — not a generic builder site.

Your output must be hyper-specific to THIS site. Generic statements are not acceptable.

BANNED PHRASES (do not use these or any paraphrase of them):
- "Add more reviews" → instead: name the platform, quote the count you found, describe the specific gap
- "Improve your photos" → instead: name which page, describe the specific image, explain exactly what's wrong
- "Get accreditations" → instead: name which ones are missing, say whether the site mentions them at all, give the application URL
- "Make your site faster" → instead: name the specific page and the specific file causing the slowdown
- "Add a team page" → instead: check pagesCrawled first — if it exists, describe what's MISSING from it
- Any sentence that would be equally true for a different UK builder

Every finding must reference something you actually found on THIS site:
- Quote exact text from the site (wrapped in quotes)
- Name specific URLs from pagesCrawled
- Reference specific images by their alt text or description
- PHOTO PAIRING (critical): The data includes imageSample — a numbered list of the actual images on the site, each with a "ref" (e.g. img_1, img_2), its src URL and alt text. For EVERY entry in photo_analysis.strong_images and weak_images you MUST set "image_ref" to the exact ref of the specific image you are describing. Match by what the image actually is — use the alt text and the filename in the src URL (e.g. a src containing "team" or "staff" is a person/team photo; "project", "reno", "extension", "kitchen" is project work; "logo", "badge", "award" is a badge). Your description MUST match the image at that ref. Do not invent a ref that is not in imageSample. If you genuinely cannot tie a point to one specific image, leave image_ref as an empty string rather than guessing.
- Use exact numbers (e.g. "9 testimonials" not "some testimonials", "4.2s load time" not "slow")
- Name the city/region from siteFacts, not generic "UK homeowners"

Your job is to simulate how a homeowner experiences THIS website — where trust is lost, why enquiries are not happening, and what must be fixed immediately.

Tone: brutally honest consultant — commercially focused, emotionally persuasive, grounded in real homeowner psychology.

IMPORTANT: You have been given VERIFIED image data from a reverse image search engine. If images are confirmed as stock photos or found on other websites, treat this as hard evidence — reference the specific image URL and where it was found.

CONTEXT: A homeowner is considering spending £10k-£250k on a project. They are cautious, risk-aware, and comparing multiple builders.

Return ONLY valid JSON. No markdown fences. No text outside the JSON.` + contextLine;

  const homeownerPrompt = `You are a forensic consumer-protection analyst helping a UK homeowner decide whether to hire a SPECIFIC builder. Your audience is NOT the builder — it is the homeowner about to spend £10k-£250k.

You are reviewing a SPECIFIC website. Generic observations are useless to this homeowner. They need to know what YOU found on THIS site.

Every finding must be specific:
- Quote exact text, name specific pages, reference specific images
- Use exact numbers from the data provided
- Name the location from siteFacts
- Reference the actual accreditations (or lack thereof) found

Tone: protective friend who is an expert — evidence-based, fair, practical.

CONTEXT: A homeowner has typed in a builder's website to check whether the builder stands up to scrutiny. They want the truth before they write a cheque.

Return ONLY valid JSON. No markdown fences. No text outside the JSON.` + contextLine;

  const systemPrompt = audience === 'homeowner' ? homeownerPrompt : builderPrompt;

  /* ═══════════════════════════════════════════════════════════════════════════
     USER PROMPT — site data + JSON schema
     ═══════════════════════════════════════════════════════════════════════════ */

  const jsonSchema = `{
  "business_snapshot": {
    "company_name": "<the business name as shown>",
    "one_liner": "<1 sentence describing what they do>",
    "established": "<year founded if mentioned, or not stated>",
    "years_trading": "<e.g. 20+ years if mentioned, else null>",
    "location": "<where they are based>",
    "service_area": "<where they cover>",
    "work_types": ["<main project types>"],
    "project_value_range": "<if mentioned e.g. £20k-£500k or null>",
    "team": {
      "owners": ["<names of owners/directors if mentioned>"],
      "team_size": "<if mentioned else null>",
      "key_people": ["<named team members and their role>"]
    },
    "accreditations": ["<every accreditation found>"],
    "awards": ["<any awards or recognition>"],
    "notable_clients": ["<notable clients or architects>"],
    "unique_selling_points": ["<2-4 differentiators they emphasise>"],
    "contact": {
      "phone": "<phone if visible>",
      "email": "<email if visible>",
      "address": "<address if visible>"
    },
    "what_we_could_not_find": ["<expected info the site does not mention>"]
  },
  "hero": {
    "score": 0,
    "headline": "<confronting but fair — specific to THIS site>",
    "subtext": "<1 sentence specific to what you found on THIS site>",
    "ai_voice_intro": "<2-3 sentences speaking directly to the business owner, referencing specific findings from THIS site>"
  },
  "homeowner_journey": [
    {"stage": "first_impression", "thought": "<first person homeowner — reference something specific on the homepage>"},
    {"stage": "scrolling", "thought": "<doubt as they scroll — reference a specific page or element they found>"},
    {"stage": "decision_moment", "thought": "<the moment they decide — reference the specific trust signal that tipped them>"}
  ],
  "live_audit_feed": [{"status": "success|warning|critical", "message": "<punchy specific finding — include a number or quote>"}],
  "trust_breakpoints": [
    {
      "title": "<specific trust failure — name the exact issue, not a category>",
      "homeowner_reaction": "<first-person inner monologue — must reference something specific on the site>",
      "evidence": "<exact evidence: quote text, name the URL, give a count, reference specific images>",
      "impact": "critical|high|medium|low",
      "fix": "<specific action: name the tool/platform/badge, give a URL if relevant, estimate time and cost>"
    }
  ],
  "photo_analysis": {
    "summary": "<verdict specific to THIS site — mention the actual count and which pages>",
    "strong_images": [{"image_ref": "<the exact ref id from imageSample, e.g. img_3, of the image you are describing>", "description": "<specific description of what THIS image shows>", "why_it_works": "<specific reason — mention visual trust signals it contains>"}],
    "weak_images": [{"image_ref": "<the exact ref id from imageSample, e.g. img_7, of the image you are describing>", "description": "<specific description of what THIS image shows>", "issue": "<exact problem — if stock, name where it was found>", "impact": "<specific homeowner consequence>", "confirmed_stock": false, "stock_source": "<if confirmed>"}]
  },
  "trust_questions": [
    {"question": "Can I verify this is a legitimate registered business?", "score": 0, "explanation": "<specific evidence from THIS site — company number, address, VAT etc>"},
    {"question": "Do I believe these are real projects by this company?", "score": 0, "explanation": "<reference specific images or project pages found>"},
    {"question": "Do other homeowners trust and recommend this company?", "score": 0, "explanation": "<quote count, platform names, or absence thereof>"},
    {"question": "Do they have credentials to handle my project safely?", "score": 0, "explanation": "<list every accreditation found or specifically missing>"},
    {"question": "Will they be easy to contact and communicate with?", "score": 0, "explanation": "<specific contact details found or missing>"},
    {"question": "Is this business actively trading right now?", "score": 0, "explanation": "<recent content, dates, copyright year etc>"}
  ],
  "_trust_questions_scale_note": "EVERY trust_questions score MUST be an integer from 0 to 100 (NOT 0-10). E.g. strong = 80, weak = 35, missing = 10. A score like 7 means 7/100 (almost failing) — only use single-digit numbers if the signal genuinely scores under 10/100.",
  "competitor_gap": {
    "summary": "<1-2 sentences specific to THIS builder's positioning>",
    "they_have": ["<specific thing a well-optimised UK builder shows that THIS site lacks>"],
    "you_have": ["<genuine specific strength found on THIS site>"]
  },
  "top_actions": [
    {
      "title": "<specific action — not a category>",
      "why": "<specific reason grounded in THIS site — quote text or give a number>",
      "how": "<concrete steps — name tools, URLs, or services where relevant>",
      "time": "<realistic time estimate>",
      "impact_pts": 5
    }
  ]
}`;

  const homeownerAddendum = audience === 'homeowner' ? `

IMPORTANT: Frame every section from the HOMEOWNER point of view.
- hero.headline should be a verdict on THIS BUILDER (e.g. "Proceed with caution — several red flags")
- hero.ai_voice_intro speaks TO the homeowner, not the builder
- homeowner_journey thoughts are what the homeowner thinks as they decide whether to hire
- trust_breakpoints are red flags the homeowner should notice, with "fix" replaced by "question to ask the builder before signing"
- top_actions are QUESTIONS the homeowner should ask the builder, not fixes
- competitor_gap compares this builder to what a trustworthy builder would show
Do NOT advise the homeowner to fix the builder's website. Advise them on what to ask, what to verify, and what should make them walk away.` : '';

  const criticalRules = `CRITICAL FACT-EXTRACTION RULES:
1. If teamPageContent is non-null, read its fullText and extract every named individual into business_snapshot.team.key_people.
2. If testimonialsPageContent is non-null with substantial content, the business HAS testimonials.
3. If aboutPageContent is non-null, use it to identify the company story, year founded, and key milestones.
4. Before claiming the site lacks any page, CHECK pagesCrawled. If a relevant URL exists, the page DOES exist.
5. siteFacts is AUTHORITATIVE — the truncated text below is just for tone and missed nuance.
6. DO NOT contradict siteFacts. If siteFacts says the team has named members, do NOT call the business "anonymous".
7. ANIMATED COUNTER WARNING: Many builder sites use JavaScript count-up animations for stats ("5.0 Google Rating", "1,500+ Happy Clients", "56 Years Experience"). The scraped HTML often captures these counters at their PRE-ANIMATION value of "0" or "0.0". Therefore:
   - NEVER claim a review rating, client count, or years figure is "0", "0.0", or "broken" based on scraped text alone. A zero next to a stats label is almost always an animation artifact, not the real value.
   - If you see "0.0" or "0" beside labels like "Google Rating", "Reviews", "Happy Clients", "Years", treat the real value as UNVERIFIED — say "the rating shown on the site could not be captured by our scan; verify it directly on Google" rather than asserting it is zero or broken.
   - Only treat a low review score as real if it comes from an external review link or explicit written text (e.g. "rated 2 stars"), never from a bare number that could be a counter.
8. VIDEO / ANIMATION / MOVING-MEDIA WARNING: You are given STATIC screenshots. A still image CANNOT show whether a video plays, whether a slider rotates, or whether an animation runs. In a screenshot, a working video almost always looks like a black box, a blank rectangle, a still "poster" frame, or a play-button overlay — this is NORMAL and does NOT mean it is broken.
   - NEVER claim a video is "broken", "not loading", "missing", "won't play", or "appears as a black/blank box" based on a screenshot. You have no way to know that from a still image.
   - The signals hasVideo, hasVideoEmbed, hasSliderOrCarousel and hasAnimation are DETERMINISTIC facts extracted from the page's HTML. If any is true, that media element genuinely EXISTS and is wired up on the page. Treat its presence as a positive (the builder invested in richer content), not a fault.
   - If hasVideo or hasVideoEmbed is true, do NOT say the site lacks video, and do NOT flag the video as faulty. At most you may note you "couldn't verify playback in an automated scan" — but never assert it is broken.
   - The same applies to carousels, sliders, hero animations and lazy-loaded sections: a blank or half-rendered area in a screenshot is a capture artifact, not a defect. Do not list it as a problem or a fix.`;

  const imageVerifSection = (imgVerifySummary && (imgVerifySummary.confirmedStockImages.length > 0 || imgVerifySummary.duplicatedElsewhere.length > 0))
    ? 'CRITICAL IMAGE VERIFICATION RESULTS — HARD EVIDENCE:\n' + JSON.stringify(imgVerifySummary, null, 2) + '\n\nThese are not guesses. These images have been confirmed by reverse image search. Reference them specifically in your findings.\n\n'
    : '';

  const userPrompt =
    'Website being audited: ' + targetUrl + '\n\n' +
    '════ AUTHORITATIVE SITE FACTS (extracted programmatically — TREAT AS GROUND TRUTH) ════\n' +
    JSON.stringify(siteFacts, null, 2) + '\n\n' +
    'CRITICAL — HOW TO USE THE FACTS ABOVE:\n' +
    '- These facts have been extracted by deterministic code (regex/heuristics), not by guessing. They are MORE RELIABLE than the truncated text below.\n' +
    '- For business_snapshot.location: use siteFacts.location.primary and siteFacts.location.allMentioned.\n' +
    '- For business_snapshot.team.key_people: use siteFacts.team.namedPeople. If empty, the site genuinely lacks named individuals.\n' +
    '- For business_snapshot.team.owners: use siteFacts.team.ownerName.\n' +
    '- For business_snapshot.contact.address: use siteFacts.location.streetAddress and siteFacts.location.postcode if present.\n' +
    '- For accreditations: use siteFacts.accreditations.\n' +
    '- For company number / VAT / founded year: use siteFacts.companyIdentity.\n' +
    '- For testimonials: use siteFacts.testimonials.quoteCount and siteFacts.testimonials.sampleQuotes.\n' +
    '- For external review links: use siteFacts.externalReviews.platformsLinked.\n' +
    '- For insurance: use siteFacts.insurance. If mentioned: false, flag it.\n' +
    '- For automatic red flags: use siteFacts.flags.\n\n' +
    'EXTRACTED SIGNALS (additional context):\n' + JSON.stringify(aggregatedSignals, null, 2) + '\n\n' +
    criticalRules + '\n\n' +
    'FULL PAGE TEXT (' + pages.length + ' pages crawled, prioritising about/team/services/contact):\n' +
    allText.slice(0, 18000) + '\n\n' +
    'I have also provided ' + screenshotsToAnalyse.length + ' page screenshots for visual analysis, '
      + 'plus ' + fetchedProjectImages.length + ' individual project/property photos each labelled with its ref (img_N) for precise photo pairing.\n\n' +
    imageVerifSection +
    'Return this exact JSON structure:\n\n' + jsonSchema + homeownerAddendum;

  async function callModel(maxTokens, blocks) {
    return client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: userPrompt }] }],
    });
  }

  /* Pull the JSON object out of the response even if the model wrapped it in
     prose or fences — slices from the first { to the last } and parses that. */
  function parseReport(resp) {
    const rawText = resp.content.map(b => b.text || '').join('');
    let clean = rawText.replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(clean);
    } catch (e) {
      const first = clean.indexOf('{');
      const last = clean.lastIndexOf('}');
      if (first !== -1 && last > first) {
        return JSON.parse(clean.slice(first, last + 1));
      }
      throw e;
    }
  }

  const tail = (resp) => resp.content.map(b => b.text || '').join('').slice(-400);

  let response, result;
  /* Attempt order:
     1) full prompt (screenshots + labelled project images) at 8000
     2) same, bigger budget (14000) — handles truncation
     3) screenshots only, no project images (12000) — handles a bad/confusing
        image batch so the audit still succeeds, just with keyword pairing */
  const attempts = [
    { blocks: imageBlocks,    budget: 12000, label: 'full prompt @12000' },
    { blocks: imageBlocks,    budget: 16000, label: 'full prompt @16000' },
    { blocks: screenshotBlocks, budget: 16000, label: 'screenshots-only @16000 (no project images)' },
  ];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    try {
      response = await callModel(a.budget, a.blocks);
      result = parseReport(response);
      if (i > 0) console.warn('[scorer-ai] Succeeded on fallback attempt: ' + a.label);
      break;
    } catch (err) {
      console.warn('[scorer-ai] Attempt failed (' + a.label + '). stop_reason=' + (response?.stop_reason || 'n/a') + ' err=' + err.message + ' tail=' + (response ? tail(response) : 'no response'));
      if (i === attempts.length - 1) {
        console.error('[scorer-ai] All attempts failed.');
        throw new Error('AI response was incomplete. Try again.');
      }
    }
  }
  result.imageVerification = imageVerification;
  return result;
}

module.exports = { scoreWebsite };
