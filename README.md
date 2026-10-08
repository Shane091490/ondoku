# Ondoku

Ondoku (音読, "reading aloud") is a self-hosted read-later app. Save news articles by link, read them as clean text, or have them read aloud.

- **Save by link**: Paste a link, share it from your phone, use the bookmarklet, or call the API.
- **Clean articles**: Pages are fetched on the server and cut down to the readable text with Mozilla Readability.
- **Full copies**: Article pictures are saved too, so articles survive deleted pages and new paywalls.
- **Read later**: Queue, Starred and Archive lists with tags and full-text search.
- **Follow feeds**: New posts from the sites and RSS/Atom feeds you follow land in your queue.
- **Auto-tag rules**: Articles get tags automatically by their site, title or text.
- **Smart archiving**: Finished articles archive themselves, and archived ones are deleted after 2 years by default.
- **Reader**: Four themes, three typefaces, and adjustable text size, spacing and width.
- **Read aloud**: Natural voices generated locally by [Piper](https://github.com/OHF-Voice/piper1-gpl), with the current paragraph highlighted.
- **Voice library**: Hear, install and remove any of Piper's 123 medium-quality voices in 52 languages.
- **Continuous play**: Listen through your queue like a playlist, with a sleep timer.
- **Pronunciation fixes**: Teach read aloud how to say names, acronyms and words like "GIF".
- **Public share links**: Share an article, pictures included, with anyone through a link you can revoke.
- **Fast on a plain CPU**: Ten minutes of audio take well under a minute to prepare.
- **Installable app**: An offline-capable PWA that appears in Android's share menu when installed from Chrome.
- **Phone friendly**: Swipe list rows to archive or star, with touch-sized controls throughout.
- **Accounts**: Email sign-in with optional OpenID Connect single sign-on, such as Keycloak.
- **API**: Per-user API keys let other apps and scripts save and read articles ([docs/API.md](docs/API.md)).

## Run it

```bash
cp .env.example .env     # optional
docker compose up -d --build
```

Open http://localhost:3102 and create the first account. On first start the `tts` container downloads the default
voices (every US and British English voice in medium quality: 20 voices, about 1.3 GB) into `./data/voices`.
After that, speech is generated entirely offline. Install more, or remove some, in Settings → Read aloud.

Everything is stored in `./data`: `readlog.db` (SQLite), `audio/` (cached MP3s), `images/` (saved article pictures)
and `voices/` (Piper models).
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
| `FEED_INTERVAL_MINUTES` | `60` | How often followed feeds are checked. |
| `CORS_ORIGINS` | | Origins allowed to call the API from a browser with an API key. |

### Saving from other places

- **Bookmarklet**: Drag the button in Settings → Saving to your bookmarks bar to save any page with one click.
- **Android**: Install the app from Chrome (Settings → Saving → Install) and Ondoku appears in the share menu.
- **iPhone**: A Shortcut can send shared links to `/api/v1/articles` with an API key (steps in Settings → Saving).
- **Other apps**: Use the API described in [docs/API.md](docs/API.md).

## License

Ondoku is released under the [MIT License](LICENSE). The speech engine it installs in the `tts` image,
[Piper](https://github.com/OHF-Voice/piper1-gpl), is GPL-3.0, and each Piper voice has its own license (shown on the
voice's model card on Hugging Face).
