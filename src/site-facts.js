/**
 * site-facts.js
 *
 * Deterministic site-fact extraction. Runs after the crawler, before the AI.
 *
 * Why this exists:
 * The AI was hallucinating facts that contradicted the crawled content — calling
 * a Doncaster business "London-focused", saying named teams were "anonymous",
 * missing testimonials that clearly existed. The pattern was: AI given lots of
 * unstructured text, AI tried to do BOTH fact extraction AND interpretation,
 * AI got facts wrong.
 *
 * The fix: extract every important fact programmatically using regex/heuristics
 * BEFORE the AI sees anything. The AI's job becomes interpretation only.
 *
 * Every fact returned here should be deterministic — given the same page text,
 * we always get the same result. No AI, no guessing.
 *
 * Returns a structured `siteFacts` object passed to the AI as authoritative
 * ground truth. The AI prompt instructs it to USE these facts and not contradict
 * them.
 */

/* ─── UK location data ────────────────────────────────────────────────────── */
const UK_LOCATIONS = [
  /* Major cities */
  'London','Manchester','Birmingham','Leeds','Liverpool','Bristol','Newcastle','Sheffield','Cardiff','Glasgow','Edinburgh',
  /* Yorkshire & Humber */
  'Doncaster','Rotherham','Barnsley','Wakefield','Bradford','Huddersfield','York','Hull','Halifax','Harrogate','Mexborough','Worksop',
  /* East Midlands */
  'Nottingham','Derby','Leicester','Lincoln','Loughborough','Mansfield','Gainsborough','Retford','Bawtry','Market Rasen','Scunthorpe','Northampton',
  /* North West */
  'Coventry','Wolverhampton','Stoke','Stockport','Oldham','Bolton','Preston','Blackpool','Lancaster','Chester','Warrington','Wigan',
  /* South & South East */
  'Brighton','Reading','Oxford','Cambridge','Norwich','Ipswich','Colchester','Southampton','Portsmouth','Bournemouth','Plymouth','Exeter','Bath','Watford','Slough','Luton','Guildford','Maidstone',
  /* Wales / Scotland / NI */
  'Swansea','Newport','Wrexham','Belfast','Dundee','Aberdeen','Inverness','Stirling',
  /* Counties */
  'Yorkshire','Lancashire','Lincolnshire','Nottinghamshire','Derbyshire','Warwickshire','Worcestershire','Staffordshire','Cheshire','Greater Manchester',
  'Surrey','Kent','Sussex','Hampshire','Dorset','Devon','Cornwall','Somerset','Gloucestershire','Wiltshire','Berkshire','Oxfordshire',
  'Buckinghamshire','Hertfordshire','Bedfordshire','Cambridgeshire','Essex','Suffolk','Norfolk','Northamptonshire','Leicestershire','Rutland',
  'Cumbria','Northumberland','Durham','Tyne and Wear','Merseyside','South Yorkshire','West Yorkshire','North Yorkshire','East Yorkshire',
];

/* ─── Accreditations & memberships UK builders display ────────────────────── */
const ACCREDITATION_PATTERNS = [
  { name: 'FMB', regex: /\b(FMB|Federation of Master Builders)\b/i },
  { name: 'NHBC', regex: /\bNHBC\b/i },
  { name: 'CHAS', regex: /\bCHAS\b/i },
  { name: 'TrustMark', regex: /\bTrustMark\b/i },
  { name: 'Gas Safe', regex: /\bGas Safe\b/i },
  { name: 'NICEIC', regex: /\bNICEIC\b/i },
  { name: 'Checkatrade', regex: /\bCheckatrade\b/i },
  { name: 'Which? Trusted Trader', regex: /\bWhich\??\s*Trusted\s*Trader/i },
  { name: 'MyBuilder', regex: /\bMyBuilder\b/i },
  { name: 'Rated People', regex: /\bRated\s*People\b/i },
  { name: 'TrustATrader', regex: /\bTrust\s*A\s*Trader\b/i },
  { name: 'CIOB', regex: /\bCIOB\b|Chartered Institute of Building/i },
  { name: 'RICS', regex: /\bRICS\b|Royal Institution of Chartered Surveyors/i },
  { name: 'CITB', regex: /\bCITB\b/i },
  { name: 'SafeContractor', regex: /\bSafeContractor\b/i },
  { name: 'CSCS', regex: /\bCSCS\b/i },
  { name: 'Constructionline', regex: /\bConstructionline\b/i },
  { name: 'Considerate Constructors', regex: /Considerate\s*Constructors/i },
  { name: 'ISO 9001', regex: /\bISO\s*9001\b/i },
  { name: 'ISO 14001', regex: /\bISO\s*14001\b/i },
];

/* ─── Insurance keywords ──────────────────────────────────────────────────── */
const INSURANCE_PATTERNS = [
  { type: 'public_liability', regex: /\bpublic\s*liability\b/i },
  { type: 'employers_liability', regex: /\bemployer'?s?\s*liability\b/i },
  { type: 'professional_indemnity', regex: /\bprofessional\s*indemnity\b/i },
  { type: 'contract_works', regex: /\bcontract(ors?)?\s*all\s*risks?|contract\s*works/i },
  { type: 'fully_insured', regex: /\bfully\s*insured\b|\binsurance\s*backed\b/i },
];

/* ─── External review platform link patterns ──────────────────────────────── */
const REVIEW_PLATFORM_PATTERNS = [
  { name: 'Google Reviews', regex: /\b(?:g\.co\/|google\.com\/maps|google\.com\/reviews|search\.google\.com\/local)/i },
  { name: 'Checkatrade', regex: /\bcheckatrade\.com/i },
  { name: 'Trustpilot', regex: /\btrustpilot\.com/i },
  { name: 'MyBuilder', regex: /\bmybuilder\.com/i },
  { name: 'Houzz', regex: /\bhouzz\.com/i },
  { name: 'Rated People', regex: /\bratedpeople\.com/i },
  { name: 'Facebook Reviews', regex: /\bfacebook\.com\/[^/]+\/reviews/i },
];

/* ─── Helper: collapse a page list to one big text blob for searching ─────── */
function combinePageText(pages, maxPerPage = 8000) {
  return pages.map(p => p.textContent || '').join(' ').slice(0, pages.length * maxPerPage);
}

/* ─── LOCATION EXTRACTION ────────────────────────────────────────────────── */
function extractLocation(pages) {
  /* Search corpus prioritises authoritative signals: page titles, about page,
     team page, homepage opening — NOT body text where client lists may mention
     other cities (e.g. "Google London" as a notable client). */
  const aboutPage = pages.find(p => /about|our-story|who-we-are/i.test(p.url));
  const teamPage = pages.find(p => /team|staff|people|meet/i.test(p.url));
  const home = pages[0];

  const corpus = [
    pages.map(p => (p.meta && p.meta.title) || '').join(' '),
    aboutPage ? aboutPage.textContent : '',
    teamPage ? teamPage.textContent : '',
    home ? home.textContent.slice(0, 2000) : '',
  ].join(' ');

  /* Count occurrences of each location, weighted by source */
  const counts = {};
  UK_LOCATIONS.forEach(loc => {
    const re = new RegExp('\\b' + loc.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'gi');
    const matches = corpus.match(re);
    if (matches && matches.length > 0) counts[loc] = matches.length;
  });
  const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  /* Try to find a postal address in any page text. UK postcodes are reliable. */
  const fullText = combinePageText(pages);
  const postcodeMatch = fullText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  const postcode = postcodeMatch ? postcodeMatch[1].toUpperCase() : null;

  /* Try to find a street address — common UK pattern */
  const addressMatch = fullText.match(/\d{1,4}[a-zA-Z]?\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,4}\s+(?:Street|Road|Avenue|Lane|Close|Drive|Way|Court|Terrace|Place|Park|Hill|Crescent|Square|Gardens?)\b/);
  const streetAddress = addressMatch ? addressMatch[0] : null;

  return {
    primary: sorted[0] || null,
    allMentioned: sorted.slice(0, 8),
    counts: counts,
    postcode,
    streetAddress,
    /* Convenience: have a verifiable address been found? */
    hasFullAddress: !!(streetAddress && postcode),
  };
}

/* ─── TEAM EXTRACTION ─────────────────────────────────────────────────────── */
function extractTeam(pages) {
  const teamPage = pages.find(p => /team|staff|people|meet/i.test(p.url));
  if (!teamPage || !teamPage.textContent) {
    return { hasTeamPage: false, namedPeople: [], ownerName: null, teamSize: null };
  }

  const text = teamPage.textContent;

  /* Look for "Name — Role" or "Name - Role" patterns. Common roles in UK builders. */
  const rolePatterns = [
    'Founder','CEO','Director','Managing Director','Owner','Operations Manager','Project Manager',
    'Site Manager','Site Foreman','Foreman','Quantity Surveyor','Architect','Designer',
    'Head of [A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?','Manager','Co-Founder','Partner','Principal',
    'Estimator','Buyer','Finance Director','Finance Manager','Finance Assistant',
    'Marketing Manager','Sales Manager','Office Manager','Administrator','Apprentice',
  ];

  /* Pattern: "FirstName LastName — Role" or "FirstName LastName - Role" or
     "FirstName LastName" followed within 80 chars by a Role keyword.
     We require 2 capitalised words (first + last name). */
  const named = [];
  const seen = new Set();
  /* Approach: find "Capital + lowercase word(s)" patterns followed by — / - / : / : / newline within ~120 chars */
  const namePattern = /\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\s*(?:[-—:]|–)\s*([A-Z][a-zA-Z\s&]{3,40}?)(?=\s*(?:[A-Z][a-z]+\s+[A-Z][a-z]+|$|joined|founder|with\s|over|since|\d{4}|\.|\n))/g;
  let m;
  while ((m = namePattern.exec(text)) !== null) {
    const name = m[1].trim();
    const role = m[2].trim().replace(/\s+/g, ' ');
    if (seen.has(name.toLowerCase())) continue;
    /* Sanity check: role should look like a job title, not a fragment */
    if (role.length < 3 || role.length > 60) continue;
    /* Skip common false positives */
    if (/^(The|This|That|Our|Your|And|For|With|From)\b/i.test(role)) continue;
    seen.add(name.toLowerCase());
    named.push({ name, role });
    if (named.length >= 30) break;
  }

  /* Try to identify the owner — often the first-listed founder/CEO/director */
  const ownerEntry = named.find(p => /found|ceo|owner|managing\s*director|principal/i.test(p.role));
  const ownerName = ownerEntry ? ownerEntry.name : (named[0] ? named[0].name : null);

  /* Try to extract team size if mentioned */
  const sizeMatch = text.match(/(?:team\s*of|we\s*are|over)\s*(\d{1,3})\s*(?:people|staff|employees|tradespeople|professionals)/i);
  const teamSize = sizeMatch ? parseInt(sizeMatch[1], 10) : null;

  return {
    hasTeamPage: true,
    teamPageUrl: teamPage.url,
    namedPeople: named,
    ownerName,
    teamSize,
  };
}

/* ─── CONTACT EXTRACTION ──────────────────────────────────────────────────── */
function extractContact(pages) {
  const fullText = combinePageText(pages);

  /* UK phones — very permissive but filtered to plausible formats */
  const phones = new Set();
  const phoneMatches = fullText.match(/(?:\+44\s?|0)(?:\d\s?){9,11}/g) || [];
  phoneMatches.forEach(p => {
    /* Strip whitespace, take canonical form */
    const cleaned = p.replace(/\s+/g, '').trim();
    if (cleaned.length >= 10 && cleaned.length <= 14) phones.add(cleaned);
  });

  /* Emails — distinguish business domains from generic free-mail */
  const emails = new Set();
  const emailMatches = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  emailMatches.forEach(e => emails.add(e.toLowerCase()));

  /* Group emails by domain to detect "dual domain confusion" */
  const emailDomains = {};
  for (const e of emails) {
    const domain = e.split('@')[1];
    if (!domain) continue;
    emailDomains[domain] = (emailDomains[domain] || 0) + 1;
  }
  const distinctBusinessDomains = Object.keys(emailDomains).filter(d =>
    !['gmail.com','outlook.com','hotmail.com','yahoo.com','aol.com','icloud.com','live.com'].includes(d)
  );
  const hasGenericEmail = Object.keys(emailDomains).some(d =>
    ['gmail.com','outlook.com','hotmail.com','yahoo.com','aol.com','icloud.com','live.com'].includes(d)
  );

  return {
    phones: Array.from(phones),
    emails: Array.from(emails),
    distinctBusinessDomains,
    hasGenericEmail,
    multipleBusinessDomains: distinctBusinessDomains.length > 1,
  };
}

/* ─── ACCREDITATIONS ──────────────────────────────────────────────────────── */
function extractAccreditations(pages) {
  const fullText = combinePageText(pages);
  const found = [];
  ACCREDITATION_PATTERNS.forEach(({ name, regex }) => {
    if (regex.test(fullText)) found.push(name);
  });
  return found;
}

/* ─── COMPANY IDENTITY ────────────────────────────────────────────────────── */
function extractCompanyIdentity(pages) {
  const fullText = combinePageText(pages);

  /* Companies House number — 8 digits, sometimes prefixed with letters for Scotland (SC) etc. */
  const companyNumberMatch = fullText.match(/\b(?:Company\s*(?:No\.?|Number|Reg(?:istration)?(?:\s*No\.?)?)\s*:?\s*)([A-Z]{0,2}\d{6,8})\b/i);
  const companyNumber = companyNumberMatch ? companyNumberMatch[1].toUpperCase() : null;

  /* VAT number — UK format GB followed by 9-12 digits */
  const vatMatch = fullText.match(/\b(?:VAT\s*(?:No\.?|Number|Reg(?:istration)?)?\s*:?\s*)((?:GB\s*)?\d{9,12})\b/i);
  const vatNumber = vatMatch ? vatMatch[1].replace(/\s+/g, '').toUpperCase() : null;

  /* Founded year — "since YYYY", "established YYYY", "founded YYYY" */
  const foundedMatch = fullText.match(/\b(?:since|established|founded|est\.?|trading\s+since)\s+(?:in\s+)?(\d{4})\b/i);
  const foundedYear = foundedMatch ? parseInt(foundedMatch[1], 10) : null;

  /* Years trading — calculated or stated */
  const yearsMatch = fullText.match(/\b(?:over\s+|with\s+|with\s+over\s+)?(\d{1,3})\+?\s*years?\s*(?:of\s*)?(?:experience|trading|in\s*business|building)/i);
  const yearsTrading = yearsMatch ? parseInt(yearsMatch[1], 10) : (foundedYear ? new Date().getFullYear() - foundedYear : null);

  /* Company name from titles. Title format is usually one of:
     - "Page name | Company Name"
     - "Company Name — Tagline"
     - "Company Name"
     We prefer the part that appears in MULTIPLE page titles (it's the brand name)
     rather than just picking the longest one. */
  const home = pages[0];
  let companyName = null;
  if (home && home.meta && home.meta.title) {
    /* Collect all parts from all page titles, count frequency */
    const partCounts = {};
    pages.forEach(p => {
      if (p.meta && p.meta.title) {
        const parts = p.meta.title.split(/[|·—–-]/).map(x => x.trim()).filter(Boolean);
        parts.forEach(part => {
          if (part.length >= 3 && part.length <= 60) {
            partCounts[part] = (partCounts[part] || 0) + 1;
          }
        });
      }
    });
    /* Most-frequent part is most likely the brand name */
    const sorted = Object.keys(partCounts).sort((a, b) => partCounts[b] - partCounts[a] || b.length - a.length);
    companyName = sorted[0] || home.meta.title;
  }

  /* Detect Ltd / LLP / Sole Trader hints */
  let companyType = null;
  if (/\bLtd\b|\bLimited\b/i.test(fullText)) companyType = 'ltd';
  else if (/\bLLP\b|Limited\s+Liability\s+Partnership/i.test(fullText)) companyType = 'llp';
  else if (/\bSole\s+Trader\b/i.test(fullText)) companyType = 'sole_trader';
  else if (/\bPartnership\b/i.test(fullText)) companyType = 'partnership';

  return {
    companyName,
    companyType,
    companyNumber,
    vatNumber,
    foundedYear,
    yearsTrading,
    /* For Ltd companies, the company number is mandatory under Companies Act 2006.
       This flag tells the AI whether the absence is a genuine compliance issue. */
    missingMandatoryCompaniesHouse: companyType === 'ltd' && !companyNumber,
  };
}

/* ─── TESTIMONIALS ────────────────────────────────────────────────────────── */
function extractTestimonials(pages) {
  const testimonialsPage = pages.find(p => /testimonial|review|client/i.test(p.url));
  /* Count quoted testimonials across the site (curly quotes around 40+ chars) */
  const fullText = combinePageText(pages);
  const quoteMatches = fullText.match(/[\u201c"][^\u201c\u201d"]{40,500}[\u201d"]/g) || [];
  const sampleQuotes = quoteMatches.slice(0, 3).map(q => q.slice(1, -1).trim().slice(0, 200));

  /* Try to find names attached to testimonials — "Name — Location" or "— Name" */
  const namedSampleMatches = fullText.match(/[\u2014—–-]\s*([A-Z][a-z]+\s+[A-Z][a-z]+)(?:,\s+(\w+(?:\s+\w+)?))?/g) || [];
  const samplePeople = [...new Set(namedSampleMatches.slice(0, 10))];

  return {
    hasTestimonialsPage: !!testimonialsPage,
    testimonialsPageUrl: testimonialsPage ? testimonialsPage.url : null,
    quoteCount: quoteMatches.length,
    sampleQuotes,
    samplePeople,
  };
}

/* ─── EXTERNAL REVIEWS ────────────────────────────────────────────────────── */
function extractExternalReviews(pages) {
  /* Build a corpus that includes both visible text AND raw HTML hrefs by checking
     for review platform domains in the page contents. */
  const fullText = combinePageText(pages);
  const platforms = REVIEW_PLATFORM_PATTERNS
    .filter(({ regex }) => regex.test(fullText))
    .map(({ name }) => name);

  return {
    platformsLinked: platforms,
    hasGoogle: platforms.includes('Google Reviews'),
    hasCheckatrade: platforms.includes('Checkatrade'),
    hasTrustpilot: platforms.includes('Trustpilot'),
    /* Sites often display "Google Rating 0.0" when the widget is broken — flag it */
    hasBrokenGoogleWidget: /google\s*rating\s*[:=]?\s*0(?:\.0)?\s*\b/i.test(fullText),
  };
}

/* ─── INSURANCE ───────────────────────────────────────────────────────────── */
function extractInsurance(pages) {
  const fullText = combinePageText(pages);
  const types = INSURANCE_PATTERNS
    .filter(({ regex }) => regex.test(fullText))
    .map(({ type }) => type);
  return {
    mentioned: types.length > 0,
    types,
  };
}

/* ─── FLAGS — site-level red flags worth surfacing ───────────────────────── */
function detectFlags(pages, extracted) {
  const flags = [];

  /* Dual / multiple business email domains */
  if (extracted.contact.multipleBusinessDomains) {
    flags.push({
      type: 'dual_email_domains',
      severity: 'medium',
      detail: 'Multiple distinct business email domains found: ' + extracted.contact.distinctBusinessDomains.join(', ') + '. May confuse visitors about business identity.',
    });
  }

  /* Generic email (gmail/hotmail) on a Ltd company */
  if (extracted.contact.hasGenericEmail && extracted.companyIdentity.companyType === 'ltd') {
    flags.push({
      type: 'generic_email_for_ltd',
      severity: 'medium',
      detail: 'Limited company is using a free email service. Reduces professional perception.',
    });
  }

  /* Missing mandatory Companies House for Ltd */
  if (extracted.companyIdentity.missingMandatoryCompaniesHouse) {
    flags.push({
      type: 'missing_companies_house_number',
      severity: 'high',
      detail: 'Limited companies are required by UK Companies Act 2006 to display the company number. None found.',
    });
  }

  /* Broken Google review widget */
  if (extracted.externalReviews.hasBrokenGoogleWidget) {
    flags.push({
      type: 'broken_google_widget',
      severity: 'high',
      detail: 'Site displays "Google Rating 0.0" — likely a broken or unconfigured Google review widget.',
    });
  }

  /* No address at all */
  if (!extracted.location.hasFullAddress && !extracted.location.postcode) {
    flags.push({
      type: 'no_verifiable_address',
      severity: 'high',
      detail: 'No street address or UK postcode found anywhere on the site.',
    });
  }

  /* Insurance not mentioned */
  if (!extracted.insurance.mentioned) {
    flags.push({
      type: 'no_insurance_mentioned',
      severity: 'medium',
      detail: 'No mention of public liability, employer\'s liability, or other insurance details.',
    });
  }

  /* No external review links — major trust gap */
  if (extracted.externalReviews.platformsLinked.length === 0) {
    flags.push({
      type: 'no_external_reviews',
      severity: 'high',
      detail: 'No links to Google Reviews, Checkatrade, Trustpilot, or any independent review platform.',
    });
  }

  return flags;
}

/* ─── MAIN EXTRACTION ENTRYPOINT ─────────────────────────────────────────── */
function extractSiteFacts(pages) {
  if (!pages || pages.length === 0) {
    return {
      version: '2026-04-26-v1',
      pagesAnalysed: 0,
      empty: true,
    };
  }

  const location = extractLocation(pages);
  const team = extractTeam(pages);
  const contact = extractContact(pages);
  const accreditations = extractAccreditations(pages);
  const companyIdentity = extractCompanyIdentity(pages);
  const testimonials = extractTestimonials(pages);
  const externalReviews = extractExternalReviews(pages);
  const insurance = extractInsurance(pages);

  const facts = {
    version: '2026-04-26-v1',
    pagesAnalysed: pages.length,
    location,
    team,
    contact,
    accreditations,
    companyIdentity,
    testimonials,
    externalReviews,
    insurance,
  };

  facts.flags = detectFlags(pages, facts);

  return facts;
}

module.exports = {
  extractSiteFacts,
};
