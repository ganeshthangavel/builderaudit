/**
 * scorer.js
 * Sends crawled page data to Claude API for multi-dimensional scoring.
 * Uses vision (screenshots) + text analysis in a single structured call.
 */
 
const Anthropic = require('@anthropic-ai/sdk');
 
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
 
// ── Scoring dimensions with weights ──────────────────────────────────────────
const DIMENSIONS = {
  credibility:      { weight: 0.25, label: 'Credibility' },
  photoQuality:     { weight: 0.20, label: 'Photo quality' },
  testimonials:     { weight: 0.20, label: 'Testimonials' },
  accreditations:   { weight: 0.15, label: 'Accreditations' },
  contactClarity:   { weight: 0.10, label: 'Contact clarity' },
  contentFreshness: { weight: 0.10, label: 'Content freshness' },
};
 
async function scoreWebsite(pages, targetUrl) {
  console.log('🤖 Sending data to Claude for analysis...\n');
 
  // ── Aggregate signals across all pages ───────────────────────────────────
  const allText = pages.map(p => `[PAGE: ${p.url}]\n${p.textContent}`).join('\n\n---\n\n');
  const allMeta = pages.map(p => p.meta);
  const allImages = pages.flatMap(p => p.images);
 
  // Pick up to 4 screenshots (homepage + key pages) to send as vision input
  const screenshotsToAnalyse = pages.slice(0, 4);
 
  // ── Build the message content ─────────────────────────────────────────────
  const imageBlocks = screenshotsToAnalyse.map((p, i) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: p.screenshotB64,
    },
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
    imageSample: allImages.slice(0, 20).map(i => ({
      src: i.src,
      alt: i.alt,
      width: i.width,
      height: i.height,
    })),
  };
 
  const prompt = `You are an expert auditor reviewing a UK construction company website for trustworthiness and customer conversion quality.
 
Website: ${targetUrl}
 
I am providing you with:
1. Screenshots of up to 4 pages (look at these carefully)
2. Aggregated signals extracted by crawler: ${JSON.stringify(aggregatedSignals, null, 2)}
3. Full text content from all pages (first 6000 chars): ${allText.slice(0, 6000)}
 
Your job: Analyse everything and return a JSON audit report. Be harsh and realistic — most small builder websites score poorly.
 
Return ONLY valid JSON in exactly this structure (no markdown, no explanation):
 
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
      "title": "<short issue title>",
      "detail": "<actionable explanation, 1-2 sentences, specific to what you saw>",
      "fix": "<concrete fix they can do this week>"
    }
  ],
  "photoAnalysis": {
    "totalDetected": <number>,
    "likelyStockPhotos": <number>,
    "lowResCount": <number>,
    "qualityNote": "<1 sentence on photo quality overall>"
  },
  "testimonialAnalysis": {
    "count": <number>,
    "haveFullNames": <boolean>,
    "haveLinks": <boolean>,
    "qualityNote": "<1 sentence>"
  },
  "accreditationsFound": [<list of accreditation names detected>],
  "positives": ["<thing done well>", "<thing done well>"],
  "summary": "<2 sentence plain English summary of the site's main trust problems>",
  "competitorGap": "<1 sentence on how this compares to a well-optimised UK builder site>"
}
 
Scoring guide:
- credibility: Companies House/VAT number visible, professional domain email, physical address, SSL, no broken links
- photoQuality: Real project photos (not stock), high resolution, labelled with project type/location, before/after shots
- testimonials: Named reviews with location, linked to Google/Checkatrade/Houzz, specific project details mentioned
- accreditations: FMB, NHBC, CHAS, TrustMark, Gas Safe, NICEIC, Checkatrade badges prominently displayed
- contactClarity: Phone number on every page, email, contact form, response time stated, service area clear
- contentFreshness: Copyright year current, recent projects posted, blog/news updated, no dead links`;
 
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
 
  const rawText = response.content.map(b => b.text || '').join('');
 
  // Strip any accidental markdown fences
  const clean = rawText.replace(/```json|```/g, '').trim();
  const result = JSON.parse(clean);
 
  // ── Compute weighted overall score ────────────────────────────────────────
  let overall = 0;
  for (const [key, cfg] of Object.entries(DIMENSIONS)) {
    overall += (result.scores[key] || 0) * cfg.weight;
  }
  result.overallScore = Math.round(overall);
  result.dimensions = DIMENSIONS;
 
  return result;
}
 
module.exports = { scoreWebsite, DIMENSIONS };
