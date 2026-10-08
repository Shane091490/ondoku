# Ondoku API

JSON over HTTP. Base path `/api/v1` (also served at `/api`).

## Authentication

Create a key in **Settings → API keys** and send it with every request:

```
Authorization: Bearer od_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`x-api-key: od_…` works too (keys made before the app was renamed start with `rl_` and keep working). A key acts as the user who created it. Keys can be **read-only** (GET only). No key
can manage accounts, API keys, passwords, sessions or server settings (`/me/password`, `/me/sessions/*`,
`/me/api-keys`, `/admin/*` return 403). The browser app uses a session cookie instead.

Errors are `{"error": "message"}` with a 4xx/5xx status. Timestamps are ISO 8601 UTC.

## Articles

### Article object

```json
{
  "id": 12,
  "url": "https://example.com/story",          // as saved, tracking parameters (utm_*, fbclid, …) removed
  "finalUrl": "https://www.example.com/story", // after redirects
  "domain": "example.com",
  "title": "The Quiet Return of Night Trains",
  "byline": "Ada Fielding",
  "siteName": "Example Times",
  "excerpt": "Across Europe, sleeper routes are coming back…",
  "leadImage": "/api/articles/12/images/3f9c…e1.jpg", // the saved copy when there is one, else the site's address
  "leadImageOriginal": "https://example.com/lead.jpg",
  "publishedAt": "2026-10-05T08:30:00.000Z",
  "lang": "en",
  "wordCount": 1830,
  "readingMinutes": 8,
  "status": "ok",              // pending (being fetched) | ok | failed
  "error": null,               // why fetching failed
  "source": "url",             // url | text (pasted) | html (supplied)
  "starred": false,
  "archived": false,
  "progress": 0.42,            // reading position 0..1
  "listenSeg": 7,              // read-aloud position (segment index)
  "tags": ["travel"],
  "createdAt": "…", "updatedAt": "…", "fetchedAt": "…", "openedAt": "…", "archivedAt": null
}
```

`GET /articles/:id` adds:

- `contentHtml`: the cleaned, sanitized article body. Every readable block has a `data-seg="N"` attribute.
- `segments`: the text of each read-aloud segment. Index 0 is the title.
- `contentHash`: changes whenever the text changes.
- `leadInContent`: `true` when the body already shows the lead image.
- `feed`: `{id, title}` of the followed feed it was saved from, or `null`.
- `share`: `{url, createdAt, views}` when it has a public link, else `null`.

Pictures are saved on the server shortly after an article is fetched (unless an admin turned this off). In
`contentHtml` a saved picture's `src` is then `/api/articles/:id/images/<file>` (and its `srcset` is dropped); one that
couldn't be saved keeps its original address. These paths need the same authentication as the rest of the API.
- `audio`: natural-voice tracks for the current text (see below).

### Endpoints

| Method | Path | |
|---|---|---|
| GET | `/articles` | List. Query: `view` = `queue` (default, not archived) / `starred` / `archive` / `all`; `q` search (see below; adds `snippet`, matches wrapped in `\u0002…\u0003`); `tag` (one tag name); `domain`; `sort` = `newest` / `oldest` / `shortest` / `longest` / `relevance`; `limit` (≤200, default 50); `offset`. Returns `{items, total, limit, offset, counts}`. |
| GET | `/counts` | `{queue, starred, archive, all, pending}` |
| POST | `/articles` | Save. Body: `{"url": "…", "tags": ["…"]}` (tags are lower-cased; a leading `#` is dropped). The page is fetched in the background (`status: "pending"`); poll `GET /articles/:id`. Returns 201 `{article, duplicate: false}`, or 200 `{article, duplicate: true}` when the link was already saved (it moves back to the top of the queue). |
| | | With text instead of a link: `{"title": "…", "text": "…", "url": "optional source"}` (blank lines separate paragraphs). |
| | | With HTML you already have (e.g. a rendered page from a browser extension): `{"url": "…", "html": "<html>…"}`. A full page goes through article extraction; a fragment is sanitized as is. |
| | | Several links: `{"urls": ["…", "…"]}` (or a `url` string containing several links) returns `{created, duplicates, invalid}`. |
| GET | `/articles/:id` | Full article. |
| PATCH | `/articles/:id` | Any of `{"starred": true, "archived": true, "progress": 0.5, "listenSeg": 3, "title": "…", "tags": ["a","b"]}`. `tags` replaces the list. Archiving also removes the article's audio when the owner turned on `dropAudioOnArchive`. |
| PUT | `/articles/:id/content` | Replace the text: `{"title": "…", "text": "…"}` or `{"html": "…"}`. For paywalled or script-only pages. |
| POST | `/articles/:id/refetch` | Fetch the page again (202). |
| DELETE | `/articles/:id` | Delete, including generated audio and saved pictures (204). |
| POST | `/articles/:id/share` | Create (or return) the article's public link: `{url, createdAt, views}`. Anyone with the link can read it at `/s/<token>` without signing in. |
| DELETE | `/articles/:id/share` | Stop sharing; the link stops working (204). |
| GET | `/shares` | Shared articles: `[{articleId, title, url, source, createdAt, views}]`. |
| GET | `/articles/:id/images/:file` | A saved picture of the article (JPEG, PNG, GIF, WebP or AVIF). 404 for anything else. |
| POST | `/articles/bulk` | `{"ids": [1,2], "action": "archive" / "unarchive" / "star" / "unstar" / "delete" / "tag", "tags": [...]}`. `tag` adds tags. |

### Auto-tag rules

Rules tag an article when it first gets its text (fetching it again doesn't re-add tags you removed). `site` matches the
domain and its subdomains; `title` and `text` match whole words, ignoring case (`text` includes the title).

| Method | Path | |
|---|---|---|
| GET | `/tag-rules` | `[{id, kind, pattern, tag, createdAt}]`. |
| POST | `/tag-rules` | `{"kind": "site" / "title" / "text", "pattern": "foxnews.com", "tag": "news"}` (201; 409 if it exists; up to 200). A site may be given as an address. |
| PATCH | `/tag-rules/:id` | Any of `kind`, `pattern`, `tag`. |
| DELETE | `/tag-rules/:id` | 204. |
| POST | `/tag-rules/apply` | Run the rules over all saved articles (they only add tags): `{updated}`. |

### Followed feeds

New entries of followed RSS/Atom feeds are saved to the queue, checked every `FEED_INTERVAL_MINUTES` (60). The first
check saves the 3 newest entries; later checks save every new one (up to 20 per check). A link that's already saved is
left alone (a feed never brings an archived article back).

| Method | Path | |
|---|---|---|
| GET | `/feeds` | `[{id, url, title, siteUrl, tags, active, saved, lastCheckedAt, lastSuccessAt, lastError, createdAt}]`. |
| POST | `/feeds` | `{"url": "https://example.com", "tags": ["news"]}`: a feed address, or a page that links to one (it's found). Runs the first check: `{feed, added}` (201; 409 if already followed). |
| PATCH | `/feeds/:id` | Any of `title`, `tags`, `active` (false pauses it). |
| DELETE | `/feeds/:id` | Unfollow; articles already saved stay (204). |
| POST | `/feeds/:id/check` | Check now: `{feed, added}`. |

### Search syntax

`q` is split into tag filters and free text:

- `#travel` keeps only articles tagged `travel`; several tags must all match (`#travel #europe`). A tag with spaces is
  quoted: `#"long reads"`. The last tag is matched as a prefix while it is still being typed (`#tra` with nothing after
  it), so suggestions can show results as you type; a tag followed by a space must match exactly.
- Everything else is full-text search over the title, author, site, text and tag names (with stemming, so "train"
  finds "trains"; the last word is a prefix).

Example: `q=#travel #"long reads" night trains`.

### Tags

| Method | Path | |
|---|---|---|
| GET | `/tags` | `[{id, name, count}]` |
| PATCH | `/tags/:id` | Rename `{"name": "…"}` (renaming onto an existing tag merges them). Returns the tag list. |
| DELETE | `/tags/:id` | Remove the tag from all articles. |

## Read aloud

Audio is generated on the server by the bundled Piper service, one segment at a time, then encoded to a single MP3.

A **voice key** is a Piper model id (`en_US-lessac-medium`) or, for a model with several speakers, model id + `#` +
speaker name (`en_GB-vctk-medium#p239`). Without a speaker, a multi-speaker model uses its first speaker.

| Method | Path | |
|---|---|---|
| GET | `/tts/status` | `{online, voices: [{id, name, language, languageName, region, quality, speakers, speakerNames, supported, unsupportedReason}], defaultVoice, cache: {tracks, bytes}}`. Lists installed voices; `supported: false` voices can't speak in this version (`unsupportedReason` says why). |
| GET | `/tts/preview?voice=<key>` | A short WAV sample of exactly that installed voice (synthesized on the server). 404 if it isn't installed, 400 if it can't speak in this version. |
| POST | `/articles/:id/audio` | Start (or find) the track: `{"voice": "<key>"}` (optional; defaults to the user's choice, then the server default). Returns a track. These requests go ahead of automatic background jobs, and asking for a different voice cancels the article's job in the old voice. With `"background": true` the track is queued behind everything else instead (continuous play prepares the next article this way). |
| GET | `/articles/:id/audio?voice=<key>` | The track for that voice (or `null`). Without `voice`: all tracks for the current text. |
| GET | `/articles/:id/audio/:trackId.mp3` | The finished MP3 (supports Range requests). |
| GET | `/articles/:id/audio/:trackId/seg/:n` | WAV of one finished segment while the track is still generating. |

### Pronunciation fixes

Words read aloud differently in every voice, per account. Whole words only; case is ignored unless `matchCase`; the
longest matching entry wins. An empty `say` skips the word. Audio made before a change that affects an article is
made again the next time it is requested (`POST /articles/:id/audio` returns it as `queued`).

| Method | Path | |
|---|---|---|
| GET | `/pronunciations` | `[{id, word, say, matchCase, createdAt}]`, sorted by word. |
| POST | `/pronunciations` | `{"word": "GIF", "say": "jif", "matchCase": false}`. 201 when added; 200 when an entry with exactly this word existed and was updated. Up to 500 entries; `word` ≤ 100 characters with at least one letter or number, `say` ≤ 200. |
| PATCH | `/pronunciations/:id` | Any of `word`, `say`, `matchCase`. 409 if the new word is already in the list. |
| DELETE | `/pronunciations/:id` | 204. |
| GET | `/pronunciations/say?text=…&voice=<key>` | WAV of the text as read aloud would say it, fixes applied (`raw=1`: exactly as written). |

### Voice library

| Method | Path | |
|---|---|---|
| GET | `/tts/catalog` | Every medium-quality Piper voice (the only quality offered): `{voices: [{id, name, language, languageName, languageNative, region, quality, speakers, speakerNames, sizeBytes, installed, supported, unsupportedReason}], fetchedAt, stale}`. Voices with `supported: false` can't be installed in this version. The catalog is cached for a day; `?refresh=1` fetches it again. |
| GET | `/tts/sample?voice=<id>&speaker=<n>` | The published MP3 sample of a voice (any voice in the catalog; `speaker` is the speaker's index). |
| GET | `/tts/downloads` | Voice downloads in progress or finished in the last 10 minutes: `[{voice, status: queued/downloading/done/error, bytes, total, error}]`. |
| POST | `/admin/tts/voices` | Admin, session only: install a voice from the catalog, `{"voice": "en_US-amy-medium"}`. Returns the download (202). |
| DELETE | `/admin/tts/voices/:id` | Admin, session only: remove an installed voice (or cancel its download) and the audio generated with it (204, also when it was already gone). |

Track:

```json
{
  "id": 3, "voice": "en_US-lessac-medium",
  "status": "generating",          // queued | generating | ready | failed
  "segmentsDone": 12, "segmentsTotal": 40, "progress": 0.3,
  "duration": 241.6,               // seconds generated so far
  "url": null,                     // MP3 URL once ready
  "segments": [{"seg": 0, "start": 0, "end": 5.5, "n": 0}, …],  // seg = article segment, n = clip number
  "error": null
}
```

## Import and export

| Method | Path | |
|---|---|---|
| POST | `/import` | `{"text": "anything containing links", "tags": []}`: saves every http(s) link (up to 1000). Returns `{found, created, duplicates, invalid}`. |
| GET | `/export` | All articles with plain text, plus the pronunciation fixes, tag rules and followed feeds, as a JSON download. `?html=1` adds `contentHtml`. Exports use the sites' own picture addresses. |

## Account (session only, except `GET /me`)

| Method | Path | |
|---|---|---|
| GET | `/me` | `{user, apiKey}`. With an API key, `apiKey` shows its name and permission. |
| PATCH | `/me` | `{"displayName": "…", "prefs": {"piperVoice": "<voice key>", "rate": 1.2, "autoAudio": true, "speakers": ["en_GB-vctk-medium#p239"], "archiveOnFinish": true, "archiveOnListen": true, "archiveAfterDays": 0, "dropAudioOnArchive": false, "deleteArchivedAfterDays": 730, "continuousPlay": false}}`. `continuousPlay`: read aloud moves on to the next article in the queue when one ends. `speakers` are the speakers picked from multi-speaker models; they appear in the player's voice list. `archiveOnFinish` / `archiveOnListen` are followed by the web app (it archives when you scroll to the end of an article, or read aloud finishes it). `archiveAfterDays` (0 = never) archives articles saved longer ago than that and not opened since (starred ones stay), hourly; changing it applies at once and the answer adds `archived`: how many moved. `deleteArchivedAfterDays` (default 730, 0 = never, up to 36500) deletes archived articles that many days after they were archived, with their audio and saved pictures (starred ones are kept), hourly; a new value applies at once and the answer adds `deleted`. Check `GET /archive/expired?days=N` first: it can't be undone. 400 "Unknown voice" for a malformed `piperVoice`, 400 "You can keep up to 100 speakers". |
| GET | `/archive/expired?days=N` | `{days, count}`: how many archived articles a `deleteArchivedAfterDays` of N would delete now (default: the account's current value). |
| POST | `/me/password` | `{"currentPassword", "newPassword"}` |
| POST | `/me/sessions/logout-others` | |
| GET / POST / DELETE | `/me/api-keys`, `/me/api-keys/:id` | List, create (`{"name", "permission": "read"/"write"}`, the secret is returned once), revoke. |

## Other entry points

- `GET /share?url=&title=&text=`: PWA share target and bookmarklet. Redirects to the in-app save screen.
- `GET /s/<token>`: a shared article's public page (no sign-in; 404 once sharing stops).
- `GET /healthz`: `{ok, app, version}`.

## Examples

```bash
KEY=od_…; BASE=https://ondoku.example.com/api/v1

# Save a link with a tag
curl -s -X POST "$BASE/articles" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/story", "tags": ["weekend"]}'

# Queue, shortest first
curl -s "$BASE/articles?view=queue&sort=shortest&limit=10" -H "Authorization: Bearer $KEY"

# Search
curl -s "$BASE/articles?view=all&q=night%20trains" -H "Authorization: Bearer $KEY"

# Archive
curl -s -X PATCH "$BASE/articles/12" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"archived": true}'
```
