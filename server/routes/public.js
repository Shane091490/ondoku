// Public share links: /s/<token> shows one article to anyone with the link, without signing in, until its owner stops
// sharing it. A plain server-rendered page (no scripts; its own strict CSP) with the article's saved pictures served
// under the same token. Nothing about the owner is shown. Search engines are asked not to index it.
import express from 'express';
import { sharedArticle } from '../lib/articles.js';
import { imageFile } from '../lib/images.js';
import { IMAGE_MIME } from '../lib/fetcher.js';
import { db } from '../lib/db.js';
import { APP_NAME, publicUrl } from '../lib/config.js';

export const publicRouter = express.Router();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSP = "default-src 'none'; img-src 'self' https: data:; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function page(res, status, { title, head = '', body, lang = 'en' }) {
  res.status(status)
    .set('Content-Security-Policy', CSP)
    .set('X-Robots-Tag', 'noindex, nofollow')
    .set('Cache-Control', 'no-cache')
    .type('html')
    .send(`<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${head}
<link rel="stylesheet" href="/share.css">
</head>
<body>
${body}
</body>
</html>`);
}

function notFound(res) {
  page(res, 404, {
    title: 'Not available',
    body: '<main class="gone"><h1>This shared article isn\'t available</h1><p>The link may be mistyped, or the person who shared it stopped sharing.</p></main>',
  });
}

publicRouter.get('/:token', (req, res) => {
  const a = sharedArticle(req.params.token);
  if (!a || a.fetch_status !== 'ok') return notFound(res);
  db.prepare('UPDATE articles SET share_views = share_views + 1 WHERE id = ?').run(a.id);
  const base = `/s/${a.share_token}/images/`;
  // Saved pictures are only served to their owner under /api; here they come from the share link instead.
  const body = String(a.content_html || '').replace(new RegExp(`/api/articles/${a.id}/images/`, 'g'), base);
  const lead = a.lead_image_file ? `${base}${a.lead_image_file}` : a.lead_image;
  const site = a.site_name || domainOf(a.final_url || a.url) || '';
  const source = a.final_url || a.url;
  const date = a.published_at ? new Date(a.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const origin = publicUrl(req);
  const absLead = lead ? (lead.startsWith('/') ? `${origin}${lead}` : lead) : '';
  const showLead = lead && !a.lead_in_content;
  page(res, 200, {
    title: a.title || 'Shared article',
    lang: a.lang || 'en',
    head: [
      `<meta property="og:type" content="article">`,
      `<meta property="og:title" content="${esc(a.title)}">`,
      a.excerpt ? `<meta property="og:description" content="${esc(a.excerpt)}">` : '',
      absLead ? `<meta property="og:image" content="${esc(absLead)}">` : '',
      site ? `<meta property="og:site_name" content="${esc(site)}">` : '',
      `<meta name="twitter:card" content="${absLead ? 'summary_large_image' : 'summary'}">`,
    ].filter(Boolean).join('\n'),
    body: `<main class="article">
<div class="kicker">${source ? `<a href="${esc(source)}" rel="noopener noreferrer nofollow">${esc(site)}</a>` : esc(site || 'Shared text')}${date ? ` <span>${esc(date)}</span>` : ''}</div>
<h1>${esc(a.title)}</h1>
${a.byline ? `<p class="byline">${esc(/^by\s/i.test(a.byline) ? a.byline : `By ${a.byline}`)}</p>` : ''}
${a.reading_minutes > 0 ? `<p class="facts">${a.reading_minutes} min read</p>` : ''}
${showLead ? `<figure class="lead"><img src="${esc(lead)}" alt="" referrerpolicy="no-referrer"></figure>` : ''}
<div class="body">${body}</div>
<footer>${source ? `Originally published at <a href="${esc(source)}" rel="noopener noreferrer nofollow">${esc(domainOf(source))}</a>. ` : ''}Shared with ${esc(APP_NAME)}.</footer>
</main>`,
  });
});

publicRouter.get('/:token/images/:file', (req, res) => {
  const a = sharedArticle(req.params.token);
  const file = a ? imageFile(a.id, req.params.file) : null;
  if (!file) return res.status(404).type('text').send('Not found');
  res.sendFile(file, {
    headers: {
      'Content-Type': IMAGE_MIME[req.params.file.split('.').pop()],
      'Cache-Control': 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Robots-Tag': 'noindex',
    },
  });
});
