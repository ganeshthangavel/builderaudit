/**
 * scorer-ai.js
 * The AI-powered forensic scorer. Takes crawled pages + image verification,
 * returns a structured forensic report. Used by both server.js (live audits)
 * and weekly-cron.js (re-analysis for opted-in users).
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

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

async function scoreWebsite(pages, targetUrl, imageVerification, overrides, userContext, audience) {
  const client = getClient();
  audience = audience || 'builder';
  const allText = pages.map(p => '[PAGE: ' + p.url + ']\n' + p.textContent).join('\n\n---\n\n');
  const allMeta = pages.map(p => p.meta);
  const allImages = pages.flatMap(p => p.images);

  /* Apply overrides — user has said these flagged images are actually theirs, so remove them from evidence */
  overrides = overrides || {};
  const filteredVerification = imageVerification ? {
    ...imageVerification,
    stockImages: (imageVerification.stockImages || []).filter(img => overrides[img.src] !== 'rejected'),
    duplicatedImages: (imageVerification.duplicatedImages || []).filter(img => overrides[img.src] !== 'rejected'),
  } : null;

  /* Only include image blocks for pages that have screenshots (fresh audits).
     Replays use text-only analysis since screenshots arent stored. */
  const screenshotsToAnalyse = pages.slice(0, 4).filter(p => p.screenshotB64);
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
  if (userContext && userContext.businessType) {
    const typeLabels = {
      ltd: 'Limited Company (Ltd) — homeowners expect Companies House number, VAT number, registered office address, director names',
      sole_trader: 'Sole Trader — homeowners expect UTR or trading name, physical business address, insurance details; Companies House is NOT applicable',
      partnership: 'Partnership — homeowners expect trading name, partner names, registered address, partnership agreement reference',
      llp: 'Limited Liability Partnership (LLP) — homeowners expect Companies House LLP number, registered address, members names',
    };
    contextLine += '\n\nBUSINESS CONTEXT: This website belongs to a ' + (typeLabels[userContext.businessType] || userContext.businessType) + '.';
    if (userContext.region) {
      contextLine += '\nRegion: ' + userContext.region + '. Consider regional accreditations (e.g. local FMB chapter, Trading Standards) and regional homeowner expectations.';
    }
    contextLine += '\nYour feedback MUST acknowledge this business type. For example: do not penalise a Sole Trader for not having a Companies House number. Do not expect regional Ltd accreditations if they are a Partnership. Tailor the trust_questions, trust_breakpoints, and scoring accordingly.';
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

Return ONLY valid JSON. No markdown fences. No text outside the JSON.`;

  const systemPrompt = audience === 'homeowner' ? homeownerPrompt : builderPrompt;

  const userPrompt = 'Website being audited: ' + targetUrl + '\n\nEXTRACTED SIGNALS:\n' + JSON.stringify(aggregatedSignals, null, 2) + '\n\nFULL PAGE TEXT (' + pages.length + ' pages crawled):\n' + allText.slice(0, 6000) + '\n\nI have also provided ' + screenshotsToAnalyse.length + ' page screenshots for visual analysis.\n\n' +
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
