// Fetches a web page for extraction. Guards against requests into the local network (SSRF) unless
// ALLOW_PRIVATE_URLS=true: every address a hostname resolves to is checked at connect time, so a redirect or a
// DNS answer pointing at 192.168.x.x / 127.0.0.1 / metadata endpoints is refused. Bodies are capped and decoded
// using the charset from the header, a BOM or a <meta> tag.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { envBool } from './config.js';

const MAX_BYTES = Number(process.env.MAX_PAGE_MB || 8) * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_SECONDS || 25) * 1000;
const MAX_REDIRECTS = 8;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PLAIN_UA = 'Mozilla/5.0 (compatible; Ondoku/1.0; read-later app)';

const allowPrivate = () => envBool('ALLOW_PRIVATE_URLS', false);

const blockList = new net.BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4']) {
  const [addr, prefix] = cidr.split('/');
  blockList.addSubnet(addr, Number(prefix), 'ipv4');
}
for (const cidr of ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '64:ff9b::/96']) {
  const [addr, prefix] = cidr.split('/');
  blockList.addSubnet(addr, Number(prefix), 'ipv6');
}
export function isPrivateAddress(ip) {
  const type = net.isIPv6(ip) ? 'ipv6' : net.isIPv4(ip) ? 'ipv4' : null;
  if (!type) return true;
  return blockList.check(ip, type);
}

export class FetchError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// dns.lookup wrapper used by the HTTP agent: drops private addresses (handles both single and `all` lookups).
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (allowPrivate()) return callback(null, address, family);
    if (Array.isArray(address)) {
      const ok = address.filter((a) => !isPrivateAddress(a.address));
      if (!ok.length) return callback(new FetchError(`${hostname} points to a private network address`));
      return callback(null, ok);
    }
    if (isPrivateAddress(address)) return callback(new FetchError(`${hostname} points to a private network address`));
    callback(null, address, family);
  });
}
const agent = new Agent({ connect: { lookup: guardedLookup, timeout: 15000 }, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });

export function parseHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new FetchError('That does not look like a web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http and https links can be saved');
  if (u.username || u.password) throw new FetchError('Links with embedded credentials are not supported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate()) {
    if (net.isIP(host) && isPrivateAddress(host)) throw new FetchError('Links to private network addresses are blocked');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new FetchError('Links to local hostnames are blocked');
  }
  return u;
}

async function readCapped(res, maxBytes = MAX_BYTES, tooBig = `The page is larger than ${Math.round(MAX_BYTES / 1048576)} MB`) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchError(tooBig);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sniffCharset(buf, contentType) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  const fromHeader = /charset=["']?([\w.:-]+)/i.exec(contentType || '')?.[1];
  if (fromHeader) return fromHeader;
  const head = buf.subarray(0, 4096).toString('latin1');
  return /<meta[^>]+charset=["']?\s*([\w.:-]+)/i.exec(head)?.[1] || 'utf-8';
}
function decode(buf, contentType) {
  const label = sniffCharset(buf, contentType);
  try { return new TextDecoder(label).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// GET with redirects followed by hand, so every hop is checked by parseHttpUrl (and its address by guardedLookup).
// Resolves with a successful response whose body has not been read yet (or notModified for a 304, when the request
// was conditional).
async function open(startUrl, headers) {
  let url = parseHttpUrl(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(url, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
    } catch (e) {
      const cause = e.cause || e;
      if (cause instanceof FetchError) throw cause;
      if (e.name === 'TimeoutError' || cause.name === 'TimeoutError') throw new FetchError('The site took too long to respond');
      if (cause.code === 'ENOTFOUND') throw new FetchError(`Could not find the site ${url.hostname}`);
      if (cause.code === 'ECONNREFUSED') throw new FetchError(`${url.hostname} refused the connection`);
      if (/certificate|SSL|TLS/i.test(cause.message || '')) throw new FetchError(`Secure connection to ${url.hostname} failed`);
      throw new FetchError(`Could not reach ${url.hostname}: ${cause.message || e.message}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new FetchError('The site sent a redirect without a destination');
      url = parseHttpUrl(new URL(loc, url).href);
      continue;
    }
    if (res.status === 304 && (headers['If-None-Match'] || headers['If-Modified-Since'])) {
      await res.body?.cancel().catch(() => {});
      return { res, url, notModified: true };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const why = { 401: 'requires a login', 402: 'requires payment', 403: 'refused the request', 404: 'says the page was not found', 410: 'says the page is gone', 429: 'is rate-limiting requests', 451: 'is unavailable for legal reasons' }[res.status];
      throw new FetchError(`The site ${why || `returned an error (${res.status})`}`, res.status);
    }
    return { res, url };
  }
  throw new FetchError('Too many redirects');
}

async function fetchOnce(startUrl, userAgent) {
  const { res, url } = await open(startUrl, {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'Accept-Language': process.env.FETCH_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
  });
  const contentType = res.headers.get('content-type') || '';
  if (/application\/pdf/i.test(contentType)) { await res.body?.cancel().catch(() => {}); throw new FetchError('PDF documents cannot be saved yet. Paste the text instead.'); }
  if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/i.test(contentType)) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError(`This link is not a web page (${contentType.split(';')[0]})`);
  }
  const buf = await readCapped(res);
  return { finalUrl: url.href, contentType, body: decode(buf, contentType), isText: /text\/plain/i.test(contentType) };
}

// Fetches a feed (or the page that links to one). etag / lastModified make the request conditional: an unchanged feed
// answers 304 and comes back as { notModified: true }.
const MAX_FEED_BYTES = 5 * 1048576;
export async function fetchFeed(url, { etag, lastModified } = {}) {
  const attempt = async (userAgent) => {
    const headers = { 'User-Agent': userAgent, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.7, */*;q=0.3' };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    return open(url, headers);
  };
  let opened;
  try { opened = await attempt(BROWSER_UA); } catch (e) {
    if (e.status !== 403 && e.status !== 429) throw e;
    opened = await attempt(PLAIN_UA);
  }
  if (opened.notModified) return { notModified: true, finalUrl: opened.url.href };
  const { res, url: final } = opened;
  const contentType = res.headers.get('content-type') || '';
  if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/i.test(contentType)) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError(`This link is not a feed (${contentType.split(';')[0]})`);
  }
  const buf = await readCapped(res, MAX_FEED_BYTES, 'The feed is larger than 5 MB');
  return { finalUrl: final.href, contentType, body: decode(buf, contentType), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

// The picture formats kept for saved articles, recognised by their first bytes rather than the server's word. SVG is
// never kept: served from this site it could run scripts.
const IMAGE_TYPES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.toString('ascii', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: 'avif', mime: 'image/avif', test: (b) => b.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(b.toString('ascii', 8, 32)) },
];
export const IMAGE_MIME = Object.fromEntries(IMAGE_TYPES.map((t) => [t.ext, t.mime]));
export function imageType(buf) {
  const t = IMAGE_TYPES.find((x) => x.test(buf));
  return t ? { ext: t.ext, mime: t.mime } : null;
}

// Downloads one picture for a saved article. referer: the article's address, which some image hosts require (a
// refusal is retried once without it).
export async function fetchImage(url, { referer, maxBytes }) {
  const headers = { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' };
  let opened;
  try {
    opened = await open(url, referer ? { ...headers, Referer: referer } : headers);
  } catch (e) {
    if (!referer || e.status !== 403) throw e;
    opened = await open(url, headers);
  }
  const { res } = opened;
  const contentType = res.headers.get('content-type') || '';
  const length = Number(res.headers.get('content-length')) || 0;
  const tooBig = `The picture is larger than ${Math.max(1, Math.round(maxBytes / 1048576))} MB`;
  if (/svg|text\/html/i.test(contentType) || length > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError(length > maxBytes ? tooBig : `Not a picture that can be saved (${contentType.split(';')[0]})`);
  }
  const buf = await readCapped(res, maxBytes, tooBig);
  const type = imageType(buf);
  if (!type) throw new FetchError('Not a picture that can be saved (unknown format)');
  return { buf, ...type };
}

// Some sites block browser-looking clients that do not run JavaScript; retry those with a plain user agent.
export async function fetchPage(url) {
  try {
    return await fetchOnce(url, BROWSER_UA);
  } catch (e) {
    if (e.status === 403 || e.status === 429) return fetchOnce(url, PLAIN_UA);
    throw e;
  }
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|mc_cid|mc_eid|igshid|ocid|cmpid|smid|smtyp|sr_share|ref_src|ref_url|_hsenc|_hsmi|mkt_tok|yclid|msclkid|twclid|s_cid|at_medium|at_campaign|guccounter|guce_referrer|guce_referrer_sig)$/i;

// Strips tracking parameters and the fragment; the result is what gets stored and opened.
export function cleanUrl(raw) {
  const u = new URL(raw);
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.href;
}
// Key used to spot the same article saved twice (scheme, www., trailing slash and param order ignored).
export function urlKey(raw) {
  const u = new URL(cleanUrl(raw));
  u.searchParams.sort();
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  return host + pathname + (u.search || '');
}
