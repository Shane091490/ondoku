// Turns a fetched page (or pasted text/HTML) into a clean, safe article: Mozilla Readability finds the story,
// metadata comes from JSON-LD / OpenGraph / meta tags, DOMPurify sanitizes the result, and every readable block
// (paragraph, heading, list item, quote) is numbered with data-seg so read-aloud can follow along.
// Segment 0 is always the title; content segments start at 1.
import crypto from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';

const quiet = new VirtualConsole(); // swallows CSS parse noise from real-world pages
const purifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(purifyWindow);

const WORDS_PER_MINUTE = 230;
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'NAV', 'UL', 'OL', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE', 'DETAILS', 'SUMMARY', 'HR', 'ADDRESS']);
// Blocks never read aloud (code, tables and captions read badly as speech).
const SILENT_TAGS = new Set(['PRE', 'TABLE', 'FIGCAPTION', 'FIGURE']);
const HEADING_RE = /^H[1-6]$/;
// Leftover page furniture that Readability sometimes keeps as its own block.
const JUNK_RE = /^(advertisement|ad feedback|paid content|sponsored( content)?|story continues below( this)?( advertisement)?|continue reading( below)?|read more|show more|share( this)?( article| story| page)?|skip to (main )?content|most (read|popular|viewed)|related( articles| stories| content)?|recommended( stories)?|\d[\d,.]*k? comments?|comments?|view comments|listen to (this )?(article|story)|copy link|link copied|play video|watch( video)?:?|loading\.*|(\d+|an?|one) (seconds?|minutes?|hours?|days?|weeks?) ago|updated|follow us|sign up|subscribe( now)?|newsletter|back to top|table of contents|contents|in this article|jump to|(new\s*)?you can now listen to [\w\s.'’]+?(articles|stories)!?)$/i;

export class ExtractError extends Error {}

let currentBase = 'https://example.invalid/';
function absolute(url) {
  try { return new URL(url, currentBase).href; } catch { return null; }
}

// srcset candidates as the HTML spec reads them: a URL runs to the next space and may itself contain commas
// ("…/c_fill,w_300/a.jpg 300w"); its descriptor ("300w", "2x") runs to the next comma.
export function parseSrcset(value) {
  const s = String(value || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) { url = url.replace(/,+$/, ''); i = j; } else {
      let k = j;
      while (k < s.length && s[k] !== ',') k++;
      desc = s.slice(j, k).trim();
      i = k + 1;
    }
    if (url) out.push({ url, desc });
  }
  return out;
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href');
    const abs = href ? absolute(href) : null;
    if (abs && /^(https?:|mailto:)/i.test(abs)) {
      node.setAttribute('href', abs);
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    } else node.removeAttribute('href');
  }
  if (node.tagName === 'IMG') {
    const abs = node.getAttribute('src') ? absolute(node.getAttribute('src')) : null;
    if (abs && /^https?:/i.test(abs)) node.setAttribute('src', abs);
    else node.removeAttribute('src');
    const srcset = node.getAttribute('srcset');
    if (srcset) {
      const fixed = parseSrcset(srcset).map(({ url, desc }) => {
        const a = absolute(url);
        return a && /^https?:/i.test(a) ? (desc ? `${a} ${desc}` : a) : null;
      }).filter(Boolean).join(', ');
      if (fixed) node.setAttribute('srcset', fixed); else node.removeAttribute('srcset');
    }
    node.setAttribute('loading', 'lazy');
    node.setAttribute('decoding', 'async');
    node.setAttribute('referrerpolicy', 'no-referrer');
  } else {
    node.removeAttribute('width');
    node.removeAttribute('height');
  }
});

const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'script', 'form', 'input', 'button', 'select', 'option', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'noscript', 'link', 'meta', 'base', 'dialog', 'template'],
  FORBID_ATTR: ['style', 'class', 'id', 'align', 'bgcolor', 'border', 'color', 'face', 'size', 'tabindex', 'role', 'contenteditable'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ADD_ATTR: ['data-rl-caption'], // caption marker from preClean(); removed again in finish()
};

function sanitize(html, baseUrl) {
  currentBase = baseUrl || 'https://example.invalid/';
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const isUrlish = (s) => /^https?:\/\//i.test(s || '');

// ----- metadata -----
function meta(doc, ...selectors) {
  for (const sel of selectors) {
    const v = norm(doc.querySelector(sel)?.getAttribute('content'));
    if (v) return v;
  }
  return '';
}

function jsonLdArticle(doc) {
  const items = [];
  const push = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(push);
    if (v['@graph']) push(v['@graph']);
    items.push(v);
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { push(JSON.parse(s.textContent)); } catch { /* malformed JSON-LD is common */ }
  }
  const typeOf = (i) => [].concat(i['@type'] || []).join(' ');
  return items.find((i) => /NewsArticle|Article|BlogPosting|Report|Story/i.test(typeOf(i))) || null;
}
function ldName(v) {
  if (!v) return '';
  if (typeof v === 'string') return isUrlish(v) ? '' : norm(v);
  if (Array.isArray(v)) return v.map(ldName).filter(Boolean).join(', ');
  return norm(v.name || '');
}
function ldImage(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return ldImage(v[0]);
  return v.url || v.contentUrl || '';
}
function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readMetadata(doc, url) {
  const ld = jsonLdArticle(doc);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const author = meta(doc, 'meta[name="author"]', 'meta[property="author"]', 'meta[name="parsely-author"]', 'meta[name="sailthru.author"]');
  return {
    title: meta(doc, 'meta[property="og:title"]', 'meta[name="twitter:title"]') || norm(ld?.headline) || norm(doc.title),
    siteName: meta(doc, 'meta[property="og:site_name"]', 'meta[name="application-name"]') || ldName(ld?.publisher) || host,
    byline: ldName(ld?.author) || (isUrlish(author) ? '' : author),
    publishedAt: isoDate(meta(doc, 'meta[property="article:published_time"]', 'meta[name="parsely-pub-date"]', 'meta[itemprop="datePublished"]', 'meta[name="date"]', 'meta[name="pubdate"]', 'meta[name="publish-date"]') || ld?.datePublished),
    image: meta(doc, 'meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]') || ldImage(ld?.image),
    description: meta(doc, 'meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]') || norm(ld?.description),
    lang: norm(doc.documentElement.getAttribute('lang') || meta(doc, 'meta[http-equiv="content-language"]')).slice(0, 12) || null,
    canonical: doc.querySelector('link[rel="canonical"]')?.href || meta(doc, 'meta[property="og:url"]') || null,
    articleBody: typeof ld?.articleBody === 'string' ? ld.articleBody : '',
  };
}

// Lazy-loading images keep the real URL in data-* attributes; promote it so Readability and the reader see it.
function fixLazyImages(doc) {
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('data-url') || img.getAttribute('data-hi-res-src');
    if (lazy && (!src || src.startsWith('data:') || /placeholder|blank|spacer|grey|gray|transparent/i.test(src))) img.setAttribute('src', lazy);
    const lazySet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
    if (lazySet && !img.getAttribute('srcset')) img.setAttribute('srcset', lazySet);
    // A stand-in shown until a script loads the real picture (BBC puts one before every image).
    const file = (img.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop();
    if (!img.getAttribute('srcset') && /placeholder|^(spacer|blank|transparent|pixel)\.(gif|png)$/i.test(file)) img.remove();
  }
  // A <picture> offers its sizes in <source> elements, which the sanitizer removes. Use the one a browser would pick
  // for a desktop reading view: a list of sizes becomes the <img> srcset, a single picture (sites that pick one per
  // screen size with media queries) its src.
  for (const pic of doc.querySelectorAll('picture')) {
    const img = pic.querySelector('img');
    if (!img || img.getAttribute('srcset')) continue;
    const source = [...pic.querySelectorAll('source')].find((el) => {
      const type = el.getAttribute('type') || '';
      return (!type || /^image\/(jpeg|png|webp|avif|gif)$/i.test(type)) && mediaMatches(el.getAttribute('media'));
    });
    const set = source && (source.getAttribute('srcset') || source.getAttribute('data-srcset'));
    const cands = parseSrcset(set);
    if (cands.length === 1 && !cands[0].desc) img.setAttribute('src', cands[0].url);
    else if (cands.length) img.setAttribute('srcset', set);
  }
}

// Whether a <source media="…"> query matches the view pictures are chosen for: 1024px wide on a 2x screen (a reading
// column of about 700px, sharp). Features it doesn't know make a query not match.
const VIEW = { width: 1024, dpr: 2 };
function mediaMatches(media) {
  if (!media || !media.trim()) return true;
  return media.split(',').some((query) => query.split(/\band\b/i).every((part) => {
    const f = part.trim().replace(/^\(|\)$/g, '').trim().toLowerCase();
    if (!f || /^(only )?(screen|all)$/.test(f)) return true;
    const m = /^(min-width|max-width|-webkit-min-device-pixel-ratio|min-resolution):\s*([\d.]+)(px|dpi|dppx|x)?$/.exec(f);
    if (!m) return false;
    const n = Number(m[2]);
    if (m[1] === 'min-width') return m[3] === 'px' && VIEW.width >= n;
    if (m[1] === 'max-width') return m[3] === 'px' && VIEW.width <= n;
    if (m[1] === 'min-resolution') return m[3] === 'dpi' ? VIEW.dpr * 96 >= n : VIEW.dpr >= n;
    return VIEW.dpr >= n;
  }));
}

// Identifies a picture across its sizes: "a/photo-1152x648.jpg", "a/photo-scaled.jpg" and "a/photo.jpg?s=2600" are the
// same one. Only for addresses of image files (a script serving many pictures by query string has no key).
export function pictureKey(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || '';
    if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(file)) return null;
    const stem = file.replace(/\.\w+$/, '').replace(/([-_]\d{2,5}x\d{2,5}|[-_]scaled|[-_]\d{3,4}w|@\dx)+$/i, '').toLowerCase();
    return stem ? `${u.hostname}${u.pathname.slice(0, -file.length)}${stem}` : null;
  } catch { return null; }
}

// The same picture again (a lightbox or "enlarge" copy at another size): keep the first.
function dedupeImages(root) {
  const seen = new Set();
  for (const img of root.querySelectorAll('img')) {
    const key = pictureKey(img.getAttribute('src'));
    if (!key) continue;
    if (seen.has(key)) img.remove(); else seen.add(key);
  }
}

// Widgets that sit inside article bodies: text-to-speech players ("You can now listen to …"), newsletter boxes.
const WIDGET_SELECTOR = ['beyondwords', 'trinity', 'speechkit', 'audio-player', 'article-audio', 'listen-button', 'tts-player', 'newsletter-signup', 'newsletter-promo']
  .flatMap((k) => [`[id*="${k}" i]`, `[class*="${k}" i]`]).join(', ');
const CAPTION_CLASS = /(^|[\s_-])(caption|credit)s?([\s_-]|$)/i;
const CAPTION_ATTR = 'data-rl-caption';

// Runs on the raw page before Readability, while class names still tell us what things are.
function preClean(doc) {
  for (const el of doc.querySelectorAll(WIDGET_SELECTOR)) el.remove();
  // Captions marked only by a class would otherwise turn into ordinary paragraphs (and be read aloud). Only tag
  // them here: changing the structure would change which block Readability picks as the article. The tag is put on
  // inner blocks too, because Readability replaces a div holding a single <p> with that <p>. finish() turns them into
  // real <figcaption>s.
  for (const el of doc.querySelectorAll('[class]')) {
    if (!CAPTION_CLASS.test(el.getAttribute('class') || '') || el.tagName === 'FIGCAPTION' || el.closest('figcaption')) continue;
    if (el.querySelector('img, picture, video, iframe, figure, table') || el.textContent.length > 500 || !el.textContent.trim()) continue;
    for (const node of [el, ...el.querySelectorAll('p, div')]) node.setAttribute(CAPTION_ATTR, '');
  }
}

function markedCaptionsToFigcaption(doc, root) {
  for (const el of root.querySelectorAll(`[${CAPTION_ATTR}]`)) {
    if (!el.isConnected || el.parentElement?.closest(`[${CAPTION_ATTR}], figcaption`)) continue;
    const fc = doc.createElement('figcaption');
    while (el.firstChild) fc.appendChild(el.firstChild);
    el.replaceWith(fc);
  }
  for (const el of root.querySelectorAll(`[${CAPTION_ATTR}]`)) el.removeAttribute(CAPTION_ATTR);
}

// ----- post-processing on the sanitized HTML -----
function textToParagraphs(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n').trim();
  const blocks = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
  return blocks.map((b) => norm(b)).filter(Boolean);
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hasBlockChild(el) {
  for (const c of el.children) if (BLOCK_TAGS.has(c.tagName)) return true;
  return false;
}
function hasBlockDescendant(el) {
  for (const c of el.querySelectorAll('*')) if (BLOCK_TAGS.has(c.tagName)) return true;
  return false;
}
const isMeaningfulInline = (n) => (n.nodeType === 3 ? n.textContent.trim() !== '' : n.nodeType === 1 && !BLOCK_TAGS.has(n.tagName));

// A container holding both loose text and blocks: wrap each loose run in <p> so it can be read aloud.
function wrapLooseText(doc, root) {
  const containers = [root, ...root.querySelectorAll('div, section, article, blockquote, li, main, aside, header, footer, details')];
  for (const el of containers) {
    if (!hasBlockChild(el)) continue;
    let run = [];
    const flush = () => {
      if (run.some((n) => (n.textContent || '').trim())) {
        const p = doc.createElement('p');
        run[0].parentNode.insertBefore(p, run[0]);
        for (const n of run) p.appendChild(n);
      }
      run = [];
    };
    for (const n of [...el.childNodes]) {
      if (isMeaningfulInline(n) || (n.nodeType === 3 && run.length)) run.push(n);
      else flush();
    }
    flush();
  }
}

const PROMO_LABEL = /^(related|read more|read next|more|see also|also read|read also|watch|listen|recommended|trending|don'?t miss|must read|click here|more from|latest|top stories)\b\s*[:|–—-]/i;

// Text of the links in el that go to another page (in-page anchors such as heading permalinks don't count).
function offPageLinkText(el, pageUrl) {
  const page = String(pageUrl || '').split('#')[0];
  return norm([...el.querySelectorAll('a[href]')].filter((a) => a.getAttribute('href').split('#')[0] !== page).map((a) => a.textContent).join(' '));
}

// "Related story" promos dropped into the text: a paragraph that is nothing but a link to another page
// (Fox News: "FILTERED WATER AT SPECIFIC AGES COULD…", "CLICK HERE TO SIGN UP…"), a "RELATED: …" line,
// or a list made only of links.
function removeLinkPromos(root, pageUrl) {
  for (const el of root.querySelectorAll('p, div')) {
    if (!el.isConnected || hasBlockDescendant(el) || el.querySelector('img, picture')) continue;
    const text = norm(el.textContent);
    if (!text) continue;
    const linkText = offPageLinkText(el, pageUrl);
    if (!linkText) continue;
    if (linkText.length >= text.length * 0.9 || (PROMO_LABEL.test(text) && linkText.length >= text.length * 0.4)) el.remove();
  }
  for (const list of root.querySelectorAll('ul, ol')) {
    const items = [...list.children].filter((li) => li.tagName === 'LI');
    if (items.length && items.every((li) => { const t = norm(li.textContent); return t && offPageLinkText(li, pageUrl).length >= t.length * 0.9; })) list.remove();
  }
}

function removeJunk(root, byline) {
  const bylineNorm = norm(byline).toLowerCase().replace(/^by\s+/, '');
  for (const el of root.querySelectorAll('p, div, li, h2, h3, h4, h5, h6')) {
    if (el.querySelector('img, picture, table') || hasBlockDescendant(el)) continue;
    const text = norm(el.textContent).replace(/[.:·•|]+$/, '');
    if (!text || text.length > 60) continue;
    const lower = text.toLowerCase().replace(/^by\s+/, '');
    if (JUNK_RE.test(text) || (bylineNorm && lower === bylineNorm)) el.remove();
  }
}

// Sites often repeat a caption (a hidden lightbox copy next to the real <figcaption>) or a block. With classes
// stripped both would show, so drop a block that repeats the previous one or is the start of the next one.
function dedupeBlocks(root) {
  const leaves = [...root.querySelectorAll('p, h2, h3, h4, h5, h6, li, figcaption, blockquote, div')].filter((el) => !hasBlockDescendant(el) && norm(el.textContent));
  let prev = null;
  for (const el of leaves) {
    const t = norm(el.textContent);
    if (prev && prev.isConnected) {
      const pt = norm(prev.textContent);
      if (pt === t && t.length >= 12) {
        if (el.closest('figcaption') && !prev.closest('figcaption')) { prev.remove(); prev = el; } else el.remove();
        continue;
      }
      if (pt.length >= 20 && t.length > pt.length && t.startsWith(pt) && t.length - pt.length < 160) prev.remove();
    }
    prev = el;
  }
}

function removeEmpty(root) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of root.querySelectorAll('p, div, span, section, li, ul, ol, blockquote, figure, a, strong, em, b, i, h1, h2, h3, h4, h5, h6')) {
      if (el.textContent.trim() || el.querySelector('img, hr, br, picture, table')) continue;
      el.remove();
      changed = true;
    }
  }
  // Tracking pixels and icons
  for (const img of root.querySelectorAll('img')) {
    const w = Number(img.getAttribute('width') || 0);
    const h = Number(img.getAttribute('height') || 0);
    if (!img.getAttribute('src') || (w && w < 40 && h && h < 40)) img.remove();
  }
}

function tagSegments(root, title) {
  const segments = [{ t: norm(title), h: 1 }];
  const visit = (el) => {
    for (const child of el.children) {
      if (SILENT_TAGS.has(child.tagName)) continue;
      if (!BLOCK_TAGS.has(child.tagName)) continue;
      if (hasBlockDescendant(child)) { visit(child); continue; }
      const text = norm(child.textContent);
      if (!text) continue;
      child.setAttribute('data-seg', String(segments.length));
      segments.push(HEADING_RE.test(child.tagName) ? { t: text, h: 1 } : { t: text });
    }
  };
  visit(root);
  return segments;
}

function finish({ html, title, meta: m, url }) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`, { virtualConsole: quiet });
  const doc = dom.window.document;
  const root = doc.getElementById('root');

  // Unwrap Readability's single wrapper divs.
  while (root.children.length === 1 && root.firstElementChild.tagName === 'DIV' && !root.firstElementChild.getAttribute('data-seg')) {
    const only = root.firstElementChild;
    while (only.firstChild) root.insertBefore(only.firstChild, only);
    only.remove();
  }
  markedCaptionsToFigcaption(doc, root);
  wrapLooseText(doc, root);
  removeJunk(root, m.byline);
  removeLinkPromos(root, url);
  dedupeImages(root);
  removeEmpty(root);
  dedupeBlocks(root);
  removeEmpty(root);

  // Drop a leading heading that repeats the title.
  const firstHeading = root.querySelector('h1, h2');
  if (firstHeading && norm(firstHeading.textContent).toLowerCase() === norm(title).toLowerCase()) firstHeading.remove();

  for (const table of root.querySelectorAll('table')) {
    const wrap = doc.createElement('div');
    wrap.setAttribute('class', 'table-wrap');
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  }

  const segments = tagSegments(root, title);
  const bodyText = segments.slice(1).map((s) => s.t).join('\n\n');
  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const contentHtml = root.innerHTML;
  dom.window.close();

  return {
    title: norm(title).slice(0, 500),
    byline: norm(m.byline).slice(0, 300),
    siteName: norm(m.siteName).slice(0, 200),
    excerpt: norm(m.description || bodyText.slice(0, 400)).slice(0, 500),
    leadImage: m.image ? (() => { try { const u = new URL(m.image, url || undefined).href; return /^https?:/.test(u) ? u : null; } catch { return null; } })() : null,
    publishedAt: m.publishedAt || null,
    lang: m.lang || null,
    contentHtml,
    textContent: bodyText,
    segments,
    contentHash: crypto.createHash('sha1').update(JSON.stringify(segments)).digest('hex'),
    wordCount: words,
    readingMinutes: words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0,
  };
}

// Extract an article from a full HTML page.
export function extractFromHtml(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: quiet });
  const doc = dom.window.document;
  try {
    const m = readMetadata(doc, url);
    fixLazyImages(doc);
    preClean(doc);
    const parsed = new Readability(doc, { keepClasses: false, charThreshold: 400 }).parse();
    let content = parsed?.content || '';
    const readableLength = norm(parsed?.textContent).length;

    // Some sites ship the full story in JSON-LD but render it with JavaScript; prefer that when it is clearly longer.
    if (m.articleBody && norm(m.articleBody).length > Math.max(readableLength * 1.3, 400)) {
      content = textToParagraphs(m.articleBody).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    } else if (readableLength < 200) {
      throw new ExtractError('Could not find the article text on this page. It may need JavaScript, a login or a subscription. You can paste the text instead.');
    }
    const title = m.title || parsed?.title || url;
    const merged = { ...m, byline: m.byline || parsed?.byline || '', siteName: m.siteName || parsed?.siteName || '', description: m.description || parsed?.excerpt || '', lang: m.lang || parsed?.lang || null, publishedAt: m.publishedAt || isoDate(parsed?.publishedTime) };
    const out = finish({ html: sanitize(content, url), title, meta: merged, url });
    if (out.segments.length < 2) throw new ExtractError('Could not find the article text on this page. You can paste the text instead.');
    return { ...out, canonical: m.canonical };
  } finally {
    dom.window.close();
  }
}

// Plain text served by the site (text/plain) or pasted by the user.
export function extractFromText(text, { title, url, siteName } = {}) {
  const paras = textToParagraphs(text);
  if (!paras.length) throw new ExtractError('There is no text to save');
  const t = norm(title) || paras[0].slice(0, 120);
  const html = paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const host = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';
  return finish({ html, title: t, meta: { siteName: siteName || host, byline: '', description: '' }, url });
}

// HTML supplied directly (pasted, or sent by an integration that already has the rendered page).
export function extractFromSuppliedHtml(html, { title, url } = {}) {
  const looksLikePage = /<html|<body|<head/i.test(html);
  if (looksLikePage) {
    const out = extractFromHtml(html, url || 'https://example.invalid/');
    return title ? { ...out, ...retitle(out, title) } : out;
  }
  const t = norm(title) || 'Untitled';
  return finish({ html: sanitize(html, url), title: t, meta: { siteName: url ? new URL(url).hostname.replace(/^www\./, '') : '', byline: '', description: '' }, url });
}

function retitle(out, title) {
  const segments = [{ t: norm(title), h: 1 }, ...out.segments.slice(1)];
  return { title: norm(title), segments, contentHash: crypto.createHash('sha1').update(JSON.stringify(segments)).digest('hex') };
}

// Speech text for each segment (headings get a full stop so the voice pauses like at a sentence end).
export function speechSegments(segments) {
  return segments.map((s, i) => ({ seg: i, text: s.h && !/[.!?:;]$/.test(s.t) ? `${s.t}.` : s.t })).filter((s) => s.text);
}
