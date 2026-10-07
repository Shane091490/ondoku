# Ondoku

Ondoku (音読, "reading aloud") is a self-hosted read-later app. Save news articles by link, read them as clean text, or have them read aloud.

- **Save by link**: paste a link, share from your phone (installable PWA with a share target), use the bookmarklet,
  paste many links at once, or call the API. Tracking parameters are removed and duplicates are recognized.
- **Article extraction**: the page is fetched on the server and run through Mozilla Readability. Title, author,
  site, date and lead image come from JSON-LD, OpenGraph and meta tags. Lazy-loaded images are fixed, page clutter
  ("Advertisement", "12 Comments", repeated captions) is dropped, and the result is sanitized with DOMPurify. When a
  page needs a login or JavaScript, paste the text in instead.
- **A full copy of each article**: its pictures are downloaded when it's saved (a size that's sharp in the reader,
  from `srcset` or `<picture>`) and served by Ondoku itself, so a saved article keeps them if the site later changes,
  removes the page or adds a paywall. Pictures that can't be downloaded keep their original address. Older articles
  get theirs in the background. Can be turned off in Settings → Admin.
- **Read later**: Queue, Starred and Archive lists, tags, full-text search with stemming, and sorting by date or
  length. Tag articles from the list (⋯ menu), the tag row under an article's title, or by typing `#tags` after a link
  when saving; search for `#tag` (suggestions appear as you type) or use the Tags filter; rename, merge and delete tags
  in Settings → Tags. Reading position is remembered, and opened articles stay readable offline. Finished articles
  archive themselves (Settings → Reading): when you scroll to the end, when read aloud finishes, and optionally after N
  days left unopened in the queue, with an option to remove an archived article's audio. Archived articles are deleted
  for good 730 days (2 years) after archiving by default; the period is set in days, or turned off, in the same place,
  and starred articles are never deleted. Shortening it asks first when that would delete anything. The list has a Standard layout
  (photo, title, summary, tags, buttons) and a Compact one (photo, title, source and time; buttons on hover), plus a
  text size setting (85–150%), under View.
- **Reader**: night (default), black, sepia and light themes; Literata serif, sans or Atkinson Hyperlegible type;
  adjustable size, spacing and width, and switches to hide photos (P) and links (links are hidden by default: they
  read as plain text and can't be tapped by accident). Display settings are stored per device.
- **Read aloud**: articles are read by natural-sounding voices generated locally by a bundled
  [Piper](https://github.com/OHF-Voice/piper1-gpl) container (no cloud service). The paragraph being read is
  highlighted and followed, playback starts before the whole article is ready, and the finished MP3 keeps playing with
  the phone locked (lock-screen controls via Media Session). You can tap a paragraph to jump there, skip back or
  forward a paragraph, change speed and voice, and pick up where you stopped. Audio is cached per article and voice,
  and can be prepared automatically for every new article. A pronunciation list (Settings → Read aloud) fixes how
  names, acronyms and words like "GIF" are said, in every voice; audio made before a change is regenerated when next
  played.
- **Voice library**: Settings → Read aloud lists every Piper voice (177 voices in 53 languages). Listen to the
  published sample of any voice, install it with one click (admins), preview or remove installed voices, and pick
  individual speakers from multi-speaker models (VCTK has 109, LibriTTS 904). Only medium-quality voices are
  offered: they sound good, are about 5× faster to generate than high-quality ones and half the size.
- **Fast on a plain CPU**: two paragraphs are generated at once, each on its own share of the CPU cores (about 1.3×
  faster than one at a time on a 4-core CPU). Ten minutes of audio take well under a minute to prepare.
- **Phones and installing**: an installable PWA (Install button in Settings → Saving and, on phones, a dismissible
  card on the queue; Safari users get the Add to Home Screen steps). Installed, it opens in its own window, is in the
  Android share sheet, keeps opened articles and their pictures readable offline, says when it's offline, and offers a
  reload when a new version arrives. On touch screens: swipe a list row left to archive (or back to the queue) and
  right to star, bigger tap targets, 16px text fields (no zoom on iPhone), menus that stay on screen, and room for
  notches and the home indicator.
- **Accounts**: email + password (the first account is the admin), optional OpenID Connect single sign-on
  (Keycloak etc.), admin user management.
- **API**: per-user API keys (read-only or read/write) for other apps and scripts. See [docs/API.md](docs/API.md).

## Run it

```bash
cp .env.example .env     # optional
docker compose up -d --build
```

Open http://localhost:3102 and create the first account. On first start the `tts` container downloads the default
voices (every US and British English voice in medium quality: 20 voices, about 1.3 GB) into `./data/voices`.
After that, speech is generated entirely offline. Install more, or remove some, in Settings → Read aloud.

Everything is stored in `./data`: `readlog.db` (SQLite), `audio/` (cached MP3s) and `voices/` (Piper models).
There are no Docker volumes; back up the folder.

| Container | Purpose | Port |
|---|---|---|
| `app` | Node 24 API + web UI | 3102 (`PORT`) |
| `tts` | Piper text-to-speech (Python) | internal only (5000) |

### Configuration

All settings are optional; see [.env.example](.env.example). Most can also be changed in **Settings → Admin**,
where saved values override the environment.

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | (request host) | Public address behind a proxy. Needed for SSO callbacks; `https://` turns on secure cookies. |
| `REGISTRATION_ENABLED` | `false` | Let anyone create an account. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | Single sign-on. Callback: `<PUBLIC_URL>/auth/oidc/callback`. Accounts are matched by subject, then by email. |
| `OIDC_NAME`, `OIDC_ONLY`, `OIDC_AUTO_CREATE`, `OIDC_ADMIN_CLAIM`, `OIDC_ADMIN_VALUE` | | Button label, hide the password form, auto-create accounts, grant admin from a claim. |
| `PIPER_VOICES` | the 20 medium US and British English voices | Voices downloaded on first start, comma-separated ([list](https://huggingface.co/rhasspy/piper-voices/tree/main)). Each is downloaded once; one removed in the app stays removed. The first is the default voice. |
| `TTS_DEFAULT_VOICE` | first voice | A voice key: `en_US-lessac-medium`, or `en_GB-vctk-medium#p239` for one speaker of a multi-speaker model. |
| `TTS_MAX_CONCURRENT` | `2` | Paragraphs generated at the same time (the CPU cores are split between them). |
| `TTS_MAX_LOADED_VOICES` | `4` | Voice models kept in memory (about 60–80 MB each, two copies while in use). |
| `AUDIO_CACHE_MB` | `2048` | Least recently played audio is deleted beyond this. |
| `SAVE_IMAGES` | `true` | Keep a copy of each article's pictures in `data/images`. |
| `MAX_IMAGE_MB`, `MAX_IMAGES_PER_ARTICLE`, `MAX_ARTICLE_IMAGES_MB` | `8`, `60`, `60` | Limits for saved pictures; past them a picture keeps its original address. |
| `ALLOW_PRIVATE_URLS` | `false` | Links to LAN, localhost and `.local` addresses are blocked to protect your network. Set `true` to save from intranet sites. |
| `FETCH_TIMEOUT_SECONDS`, `MAX_PAGE_MB`, `FETCH_CONCURRENCY` | `25`, `8`, `3` | Page fetching limits. |
| `CORS_ORIGINS` | | Origins allowed to call the API from a browser with an API key. |

### Saving from other places

- **Bookmarklet**: Settings → Saving, drag the button to the bookmarks bar. Clicking it saves the page and opens the saved article in a new tab.
- **Android**: install the app (Settings → Saving → Install, or Chrome menu → Install app). Ondoku then appears in the share sheet.
- **iPhone**: a Shortcut that POSTs the shared URL to `/api/v1/articles` with an API key (steps in Settings → Saving).
- **Other apps**: see [docs/API.md](docs/API.md).

## How it works

```
server/            Express 5 + node:sqlite (Node 24)
  server.js        routes, CSP, share target, static PWA
  lib/fetcher.js   page fetching: SSRF guard checked at connect time, redirects, size cap, charset detection
  lib/extract.js   Readability + metadata + DOMPurify + cleanup; numbers readable blocks (data-seg) for read aloud
  lib/extractWorker.js, extractPool.js   extraction runs in a worker thread (jsdom is CPU-heavy)
  lib/articles.js  storage, background fetch queue, search (SQLite FTS5), tags, archiving
  lib/images.js    saved copies of article pictures (download queue, address rewriting, backfill)
  lib/pronounce.js pronunciation fixes applied to the text sent to Piper
  lib/tts.js       Piper client, audio job queue, segment timing manifest, MP3 encoding (ffmpeg), cache eviction
  lib/auth.js, oidc.js, routes/   accounts, sessions, API keys, OIDC (authorization code + PKCE)
web/               React 19 + Vite PWA (hash routing, no UI framework)
  src/lib/naturalEngine.js  read-aloud player: segment clips while Piper is generating, then the single MP3
  src/lib/pwa.js   install prompt, service worker registration and update notices
  public/sw.js     service worker: offline app shell, articles, pictures
tts/               Piper sidecar: downloads voices once, POST /synthesize returns WAV
tests/             API end-to-end test with a fixture site (see tests/README.md)
```

Security notes: extracted HTML is sanitized on the server (no scripts, styles, iframes, forms or event handlers;
links get `rel="noopener noreferrer nofollow"`), and pages are served with a CSP that allows no inline or remote
scripts. Saved pictures are fetched through the same network guard as pages, kept only when their first bytes show
JPEG, PNG, GIF, WebP or AVIF (never SVG), and served only to the article's owner with `nosniff` and a `default-src
'none'; sandbox` CSP. Pictures not saved load from their sites with `referrerpolicy="no-referrer"`. API keys and
sessions are stored hashed or random, and passwords use scrypt.

## License

Ondoku is released under the [MIT License](LICENSE). The speech engine it installs in the `tts` image,
[Piper](https://github.com/OHF-Voice/piper1-gpl), is GPL-3.0, and each Piper voice has its own license (shown on the
voice's model card on Hugging Face).
