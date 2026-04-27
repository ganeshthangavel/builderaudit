/**
 * scorer-ai.js
 * The AI-powered forensic scorer. Takes crawled pages + image verification,
 * returns a structured forensic report. Used by both server.js (live audits)
 * and weekly-cron.js (re-analysis for opted-in users).
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { extractSiteFacts } = require('./site-facts');

/* Lazy-initialised Anthropic client. We don't instantiate at module load because
   that can run before env vars are available (and it lets us give a clearer error
   message if the key is genuinely missing). */
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

/* Resize a base64 JPEG so neither dimension exceeds Claude's 8000px limit.
   Returns either the original base64 (if already within limits) or a resized version.
   If sharp fails for any reason, returns null so we skip this image rather than
   crash the whole audit. */
async function ensureImageWithinLimits(base64Data) {
  if (!base64Data) return null;
  try {
    const sharp = require('sharp');
    const buffer = Buffer.from(base64Data, 'base64');
    const metadata = await sharp(buffer).metadata();
    const MAX_DIM = 7800; // a bit under 8000 to be safe
    if ((metadata.width || 0) <= MAX_DIM && (metadata.height || 0) <= MAX_DIM) {
      return base64Data; // already fine
    }
    /* Resize while keeping aspect ratio. The largest side becomes MAX_DIM. */
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

async function scoreWebsite(pages, targetUrl, imageVerification, overrides, userContext, audience) {
  const client = getClient();
  audience = audience || 'builder';

  /* Classify each crawled page by URL pattern. This lets the AI know what pages
     EXIST on the site, even if their content was truncated out of the text budget below.
     Without this, the AI sometimes mistakenly says "no team page" when the team page
     was crawled but its body text didn't make it into the 6000-char window. */
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

  /* Order pages so important ones (about, team, services, contact) appear first
     in the text budget. The AI gets the full text of these before it gets sliced. */
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

  /* Pull out the FULL text of team and testimonials pages as dedicated fields.
     Without this, the AI was treating "team page exists" as enough info and
     not actually extracting the named individuals. By giving the team page text
     its own labelled field in the signals object, we force the AI to read it. */
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

  /* Apply overrides — user has said these flagged images are actually theirs, so remove them from evidence */
  overrides = overrides || {};
  const filteredVerification = imageVerification ? {
    ...imageVerification,
    stockImages: (imageVerification.stockImages || []).filter(img => overrides[img.src] !== 'rejected'),
    duplicatedImages: (imageVerification.duplicatedImages || []).filter(img => overrides[img.src] !== 'rejected'),
  } : null;

  /* Only include image blocks for pages that have screenshots (fresh audits).
     Replays use text-only analysis since screenshots arent stored.

     Each screenshot is run through sharp to ensure it's within Claude's vision
     API limit (8000px in any dimension). Oversize images are resized in place,
     keeping aspect ratio. If resize fails for any reason, that image is skipped
     and the audit continues with text-only analysis for that page. */
  const candidatePages = pages.slice(0, 4).filter(p => p.screenshotB64);
  const safeScreenshots = await Promise.all(
    candidatePages.map(async p => {
      const safeB64 = await ensureImageWithinLimits(p.screenshotB64);
      return safeB64 ? { ...p, screenshotB64: safeB64 } : null;
    })
  );
  const screenshotsToAnalyse = safeScreenshots.filter(Boolean);
  const imageBlocks = screenshotsToAnalyse.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: p.screenshotB64 },
  }));

  const imgVerifySummary = filteredVerification ? {
    imagesChecked: filteredVerification.checked,
    totalImagesOnSite: filteredVerification.total,
    confirmedStockImages: filteredVerification.stockImages.map(i => ({ url: i.src, foundOn: i.reason, source: i.source || null })),
    duplicatedElsewhere: filteredVerification.duplicatedImages.map(i => ({ url: i.src, foundOn: i.reason, matchCount: i.matchCount })),
    confirmedOriginal: (filteredVerification.originalImages || []).length,
    userOverrideCount: Object.values(overrides).filter(v => v === 'rejected').length,
  } : null;

  const aggregatedSignals = {
    totalPages: pages.length,
    /* Crawled URLs by classification — tells the AI which pages exist on the site
       so it can verify claims like "they don't have a team page" against actual data. */
    pagesCrawled: pageMap.map(p => ({ url: p.url, kind: p.kind })),
    pageKindsPresent: [...new Set(pageMap.map(p => p.kind))].filter(k => k !== 'other').sort(),

    /* Dedicated FULL text from the most important pages. These bypass the
       12K char text budget below — the AI ALWAYS sees them in full. Without this,
       team-page content was getting truncated and the AI was reporting "team page
       exists" without actually reading the names. */
    teamPageContent: teamPage ? {
      url: teamPage.url,
      fullText: teamPage.textContent,
    } : null,
    testimonialsPageContent: testimonialsPage ? {
      url: testimonialsPage.url,
      fullText: testimonialsPage.textContent,
    } : null,
    aboutPageContent: aboutPage ? {
      url: aboutPage.url,
      fullText: aboutPage.textContent,
    } : null,

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

  /* Build a user-context line that tailors the AI feedback */
  let contextLine = '';

  /* Extract structured site facts deterministically (site-facts.js).
     This is the FUTURE-PROOFED replacement for the AI doing fact-extraction itself.
     The AI was hallucinating — calling Doncaster builders "London-focused", missing
     named team members, claiming "no testimonials" when they exist. The fix: we
     extract every important fact via regex/heuristics BEFORE the AI sees anything,
     then tell the AI to use these facts as authoritative ground truth. */
  const siteFacts = extractSiteFacts(pages);

  if (userContext && userContext.businessType) {
    const typeLabels = {
      ltd: 'Limited Company (Ltd) — homeowners expect Companies House number, VAT number, registered office address, director names',
      sole_trader: 'Sole Trader — homeowners expect UTR or trading name, physical business address, insurance details; Companies House is NOT applicable',
      partnership: 'Partnership — homeowners expect trading name, partner names, registered address, partnership agreement reference',
      llp: 'Limited Liability Partnership (LLP) — homeowners expect Companies House LLP number, registered address, members names',
    };
    contextLine += '\n\nBUSINESS CONTEXT: This website belongs to a ' + (typeLabels[userContext.businessType] || userContext.businessType) + '.';
    if (userContext.region) {
      contextLine += '\nRegion (from user signup): ' + userContext.region + '. Consider regional accreditations (e.g. local FMB chapter, Trading Standards) and regional homeowner expectations.';
    }
    contextLine += '\nYour feedback MUST acknowledge this business type. For example: do not penalise a Sole Trader for not having a Companies House number. Do not expect regional Ltd accreditations if they are a Partnership. Tailor the trust_questions, trust_breakpoints, and scoring accordingly.';
  }

  /* Tell the AI where the builder operates — uses the deterministic location
     extraction from site-facts. This applies regardless of audience (builder
     report or homeowner report). */
  if (siteFacts.location && siteFacts.location.primary) {
    const otherLocs = siteFacts.location.allMentioned.slice(1, 5);
    contextLine += '\n\nBUILDER\'S OPERATING REGION (DETERMINISTICALLY EXTRACTED): The site primarily references ' + siteFacts.location.primary +
      (otherLocs.length ? ' (and also: ' + otherLocs.join(', ') + ')' : '') + '. ' +
      'When framing the homeowner persona — whether the report is for the builder or the homeowner directly — ASSUME the homeowner is located in or near these areas. ' +
      'Do NOT reference cities or regions the builder does not operate in (e.g. don\'t say "London homeowners" if the site references Yorkshire). ' +
      'If you mention a city or region, it must be one of the detected locations above.';
  }

  /* Pick the AI persona based on audience */
  const builderPrompt = `You are a forensic conversion analyst for UK construction companies.
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

Return ONLY valid JSON. No markdown fences. No text outside the JSON.` + contextLine;

  const homeownerPrompt = `You are a forensic consumer-protection analyst helping a UK homeowner decide whether to hire a specific builder. Your audience is NOT the builder — it is the homeowner about to spend £10k-£250k on building work.

Your tone should be:
- Protective of the homeowner (like a friend who is an expert)
- Evidence-based — flag concrete red flags, don't speculate
- Fair — acknowledge positive signs too
- Practical — give questions they should ask before signing

CONTEXT: A homeowner has typed in a builder's website to check whether the builder stands up to scrutiny. They want the truth before they write a cheque.

Return ONLY valid JSON. No markdown fences. No text outside the JSON.` + contextLine;

  const systemPrompt = audience === 'homeowner' ? homeownerPrompt : builderPrompt;

  const userPrompt = 'Website being audited: ' + targetUrl + '\n\n' +
    '════ AUTHORITATIVE SITE FACTS (extracted programmatically — TREAT AS GROUND TRUTH) ════\n' +
    JSON.stringify(siteFacts, null, 2) + '\n\n' +
    'CRITICAL — HOW TO USE THE FACTS ABOVE:\n' +
    '- These facts have been extracted from the site by deterministic code (regex/heuristics), not by guessing. They are MORE RELIABLE than your reading of the truncated text below.\n' +
    '- For business_snapshot.location: use `siteFacts.location.primary` and `siteFacts.location.allMentioned`.\n' +
    '- For business_snapshot.team.key_people: use `siteFacts.team.namedPeople` (each item is { name, role }). If empty, the site genuinely lacks named individuals.\n' +
    '- For business_snapshot.team.owners: use `siteFacts.team.ownerName`.\n' +
    '- For business_snapshot.contact.address: use `siteFacts.location.streetAddress` and `siteFacts.location.postcode` if present.\n' +
    '- For accreditations: use `siteFacts.accreditations`.\n' +
    '- For company number / VAT / founded year: use `siteFacts.companyIdentity`.\n' +
    '- For testimonials: use `siteFacts.testimonials.quoteCount` and `siteFacts.testimonials.sampleQuotes`. If quoteCount > 0, the site DOES have testimonials.\n' +
    '- For external review links: use `siteFacts.externalReviews.platformsLinked`. If non-empty, the site has those.\n' +
    '- For insurance: use `siteFacts.insurance`. If `mentioned: false`, then it\'s genuinely not on site — flag it.\n' +
    '- For automatic red flags worth surfacing: use `siteFacts.flags`. Each flag is pre-validated.\n' +
    '- DO NOT contradict siteFacts. If siteFacts says the team has named members, do NOT call the business "anonymous". If siteFacts says the location is "Doncaster", do NOT say "London homeowners".\n' +
    '- The text below is a SECONDARY signal for nuance, tone, and details siteFacts may have missed. siteFacts wins disputes.\n\n' +
    'EXTRACTED SIGNALS (additional context):\n' + JSON.stringify(aggregatedSignals, null, 2) + '\n\n' +
    'CRITICAL FACT-EXTRACTION RULES — FOLLOW THESE EXACTLY:\n' +
    '1. If `teamPageContent` is non-null, you MUST read its `fullText` field carefully and extract every named individual into business_snapshot.team.key_people. Format each as "Full Name — Role". Do NOT say the business is "anonymous" or that there are "no named individuals" if siteFacts.team.namedPeople is non-empty.\n' +
    '2. If `testimonialsPageContent` is non-null with substantial content, the business HAS testimonials. Do NOT report "no testimonials" if siteFacts.testimonials.quoteCount > 0.\n' +
    '3. If `aboutPageContent` is non-null, use it to identify the company story, year founded, and key milestones.\n' +
    '4. Before claiming the site lacks any kind of page, CHECK the `pagesCrawled` list. If a relevant URL exists, the page DOES exist.\n' +
    '5. siteFacts is AUTHORITATIVE — the truncated text below is just for tone and missed nuance.\n\n' +
    'FULL PAGE TEXT (' + pages.length + ' pages crawled, prioritising about/team/services/contact):\n' + allText.slice(0, 12000) + '\n\n' +
    'I have also provided ' + screenshotsToAnalyse.length + ' page screenshots for visual analysis.\n\n' +
  (imgVerifySummary && (imgVerifySummary.confirmedStockImages.length > 0 || imgVerifySummary.duplicatedElsewhere.length > 0) ?
    'CRITICAL IMAGE VERIFICATION RESULTS — HARD EVIDENCE:\n' + JSON.stringify(imgVerifySummary, null, 2) + '\n\nThese are not guesses. These images have been confirmed by reverse image search. Reference them specifically in your findings.\n\n' : '') +
  (audience === 'homeowner'
    ? 'Return this exact JSON structure (HOMEOWNER VIEW):\n\n{\n  "business_snapshot": {'
    : 'Return this exact JSON structure:\n\n{\n  "business_snapshot": {'
  ) + '\n    "company_name": "<the business name as shown>",\n    "one_liner": "<1 sentence describing what they do>",\n    "established": "<year founded if mentioned, or \\"not stated\\">",\n    "years_trading": "<e.g. \\"20+ years\\" if mentioned, else null>",\n    "location": "<where they are based>",\n    "service_area": "<where they cover>",\n    "work_types": ["<main project types>"],\n    "project_value_range": "<if mentioned e.g. \\"£20k-£500k\\" or null>",\n    "team": {\n      "owners": ["<names of owners/directors if mentioned>"],\n      "team_size": "<if mentioned else null>",\n      "key_people": ["<named team members and their role>"]\n    },\n    "accreditations": ["<every accreditation found>"],\n    "awards": ["<any awards or recognition>"],\n    "notable_clients": ["<notable clients or architects>"],\n    "unique_selling_points": ["<2-4 differentiators they emphasise>"],\n    "contact": {\n      "phone": "<phone if visible>",\n      "email": "<email if visible>",\n      "address": "<address if visible>"\n    },\n    "what_we_could_not_find": ["<expected info the site does not mention>"]\n  },\n  "hero": {\n    "score": <0-100 integer>,\n    "headline": "<confronting but fair>",\n    "subtext": "<1 sentence specific to what you found>",\n    "ai_voice_intro": "<2-3 sentences speaking directly to the business owner, referencing specific findings>"\n  },\n  "homeowner_journey": [\n    {"stage": "first_impression", "thought": "<first person homeowner>"},\n    {"stage": "scrolling", "thought": "<doubt as they scroll>"},\n    {"stage": "decision_moment", "thought": "<the moment they decide>"}\n  ],\n  "live_audit_feed": [{"status": "success|warning|critical", "message": "<punchy finding>"}],\n  "trust_breakpoints": [\n    {\n      "title": "<trust failure title>",\n      "homeowner_reaction": "<inner monologue>",\n      "evidence": "<specific evidence>",\n      "impact": "critical|high|medium|low",\n      "fix": "<specific fix within days>"\n    }\n  ],\n  "photo_analysis": {\n    "summary": "<overall verdict>",\n    "strong_images": [{"description": "", "why_it_works": ""}],\n    "weak_images": [{"description": "", "issue": "", "impact": "", "confirmed_stock": true|false, "stock_source": "<if confirmed>"}]\n  },\n  "trust_questions": [\n    {"question": "Can I verify this is a legitimate registered business?", "score": <0-100>, "explanation": ""},\n    {"question": "Do I believe these are real projects by this company?", "score": <0-100>, "explanation": ""},\n    {"question": "Do other homeowners trust and recommend this company?", "score": <0-100>, "explanation": ""},\n    {"question": "Do they have credentials to handle my project safely?", "score": <0-100>, "explanation": ""},\n    {"question": "Will they be easy to contact and communicate with?", "score": <0-100>, "explanation": ""},\n    {"question": "Is this business actively trading right now?", "score": <0-100>, "explanation": ""}\n  ],\n  "competitor_gap": {\n    "summary": "<1-2 sentences>",\n    "they_have": ["<thing competitors have>"],\n    "you_have": ["<genuine strength>"]\n  },\n  "top_actions": [\n    "<action 1 most impactful>",\n    "<action 2>",\n    "<action 3>",\n    "<action 4>",\n    "<action 5>"\n  ]\n}' +
  (audience === 'homeowner' ? '\n\nIMPORTANT: Frame every section from the HOMEOWNER point of view.\n- hero.headline should be a verdict on THIS BUILDER (e.g. "Proceed with caution — several red flags")\n- hero.ai_voice_intro speaks TO the homeowner, not the builder\n- homeowner_journey thoughts are what the homeowner thinks as they decide whether to hire\n- trust_breakpoints are red flags the homeowner should notice, with "fix" replaced by "question to ask the builder before signing"\n- top_actions are QUESTIONS the homeowner should ask the builder, not fixes\n- competitor_gap compares this builder to what a trustworthy builder would show\nDo NOT advise the homeowner to fix the builder\'s website. Advise them on what to ask, what to verify, and what should make them walk away.' : '');

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 6000,
    system: systemPrompt,
    messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: userPrompt }] }],
  });

  const rawText = response.content.map(b => b.text || '').join('');
  const clean = rawText.replace(/```json|```/g, '').trim();
  let result;
  try {
    result = JSON.parse(clean);
  } catch (e) {
    console.error('JSON parse failed. Stop reason:', response.stop_reason, 'Last 300 chars:', clean.slice(-300));
    throw new Error('AI response was incomplete. Try again.');
  }
  /* Attach the ORIGINAL (unfiltered) imageVerification so the UI can still show flags + overrides.
     The AI has been shown the filtered version so its reasoning reflects the users overrides. */
  result.imageVerification = imageVerification;
  return result;
}

module.exports = { scoreWebsite };
