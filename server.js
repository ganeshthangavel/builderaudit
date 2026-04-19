/**
 * server.js
 * Express API server — accepts a URL, runs the full audit pipeline,
 * streams progress, returns JSON report.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { crawlWebsite } = require('./crawler');
const { scoreWebsite } = require('./scorer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Main audit endpoint ───────────────────────────────────────────────────────
app.post('/api/audit', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Please provide a valid URL starting with http/https' });
  }

  // Use SSE so the frontend can show live progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('status', { message: '🕷  Crawling website...', step: 1, total: 3 });
    const pages = await crawlWebsite(url);

    if (pages.length === 0) {
      send('error', { message: 'Could not reach the website. Check the URL and try again.' });
      return res.end();
    }

    send('status', {
      message: `✅ Crawled ${pages.length} pages and ${pages.reduce((s,p)=>s+p.images.length,0)} images. Running AI analysis...`,
      step: 2,
      total: 3,
    });

    const report = await scoreWebsite(pages, url);

    send('status', { message: '📊 Building your report...', step: 3, total: 3 });
    send('complete', { report, url, scannedAt: new Date().toISOString() });

  } catch (err) {
    console.error(err);
    send('error', { message: err.message || 'Audit failed. Please try again.' });
  }

  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SiteAudit server running at http://localhost:${PORT}\n`);
});
