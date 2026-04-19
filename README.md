# BuilderAudit 🏗️

AI-powered website health checker for UK construction companies.
Crawls an entire site, analyses photos + text with Claude vision, and returns
actionable scores across Credibility, Photos, Testimonials, Accreditations,
Contact Clarity, and Content Freshness.

---

## Quick Start

### 1. Prerequisites
- Node.js 18+
- An Anthropic API key → https://console.anthropic.com

### 2. Install
```bash
npm install
npm run install-browsers   # downloads Chromium for Playwright
```

### 3. Set your API key
```bash
# Mac/Linux
export ANTHROPIC_API_KEY=sk-ant-...

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

### 4a. Web server (dashboard UI)
```bash
npm start
# Open http://localhost:3000
```

### 4b. CLI (direct audit to JSON)
```bash
node audit.js https://example-builder.co.uk
# Report saved to ./reports/<domain>-<timestamp>.json
```

---

## How It Works

```
URL input
   │
   ▼
Playwright crawler (headless Chromium)
   ├─ Visits every internal page (up to 20)
   ├─ Takes JPEG screenshots
   ├─ Extracts all text, image URLs, meta tags
   └─ Detects: phone numbers, addresses, accreditation badges,
               testimonial quotes, copyright years, VAT/Companies House numbers
   │
   ▼
Claude API (claude-opus-4-5, multimodal)
   ├─ Receives: 4 page screenshots + aggregated crawler signals + full text
   ├─ Returns: structured JSON with scores + issues + recommendations
   └─ Scores 6 dimensions, each 0-100
   │
   ▼
Weighted overall score + prioritised issue list
   └─ Rendered in web dashboard or CLI summary
```

---

## Scoring Dimensions

| Dimension | Weight | What it checks |
|-----------|--------|----------------|
| Credibility | 25% | Companies House/VAT number, professional email, SSL, physical address |
| Photo Quality | 20% | Real vs stock photos, resolution, labelling, before/after shots |
| Testimonials | 20% | Named reviews, Google/Checkatrade links, specific project details |
| Accreditations | 15% | FMB, NHBC, CHAS, TrustMark, Gas Safe, NICEIC badges |
| Contact Clarity | 10% | Phone on every page, email, contact form, service area stated |
| Content Freshness | 10% | Copyright year, recent projects, blog/news dates |

---

## Project Structure

```
builderaudit/
├── src/
│   ├── crawler.js      # Playwright-based site spider
│   ├── scorer.js       # Claude API multimodal analysis
│   └── server.js       # Express API + SSE progress streaming
├── public/
│   └── index.html      # Frontend dashboard
├── audit.js            # CLI entry point
├── reports/            # JSON reports saved here (auto-created)
└── package.json
```

---

## Deployment (Railway / Render / Fly.io)

1. Push to GitHub
2. Connect repo to Railway/Render
3. Set environment variable: `ANTHROPIC_API_KEY`
4. Set start command: `npm start`
5. Railway auto-installs Playwright browsers via `npm install`

For Dockerfile deployments, use `mcr.microsoft.com/playwright:v1.44.0-jammy` as base image.

---

## SaaS Monetisation Ideas

- **Free tier**: Score only (no issue details) — drives signups
- **Pro £49/mo**: Full report + monthly re-scans + email alerts when score drops
- **Agency £149/mo**: 10 sites, white-label PDF reports, competitor comparison
- **Lead gen**: Sell warm leads (builders who just saw their bad score) to web agencies

---

## Extending the Scorer

Add new dimensions in `scorer.js` → `DIMENSIONS` object and update the Claude prompt
to include scoring criteria. Everything else (weighting, bar charts, sorting) is automatic.

Ideas for v2:
- Google Business Profile score (via Places API)
- Checkatrade/TrustATrader review count & rating
- Page speed (Lighthouse API)
- Competitor benchmarking (scan 3 local competitors automatically)
- Monthly re-scan scheduler with change detection
