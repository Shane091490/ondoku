# Tests

`smoke.py` checks the API end to end against an instance with an **empty database**: accounts, saving links
(fetch, extraction details, tracking-parameter stripping, duplicates, redirects, plain text, 404 and PDF failures),
pasted text, search, list views, tags, rename, bulk actions, import/export, the share target, API keys, user
isolation, saved pictures (type checks, SVG refused, srcset choice, headers, owner-only access, export, cleanup),
pronunciation fixes, archiving and archive-deletion preferences, auto-tag rules, public share links, followed feeds
(discovery, RSS and Atom, conditional checks, no resurrected archived articles) and, when the TTS service is reachable, natural-voice generation, MP3
serving, audio being remade after a pronunciation change, and audio removal on archive.

It serves `fixtures/` from a small web server of its own, and the app has to fetch from it. Everything runs in
throwaway containers on a network of their own (some hosts' firewalls block containers from reaching servers on
the host): the app, a Piper service with one voice, and the test itself. The app needs `ALLOW_PRIVATE_URLS=true`
because the fixture server has a private address. Nothing is left running afterwards.

```bash
docker build -q -t ondoku-test-app . && docker build -q -t ondoku-test-tts ./tts
docker network create ondoku-test
docker run -d --name ondoku-test-tts --network ondoku-test --network-alias tts \
  -e PIPER_VOICES=en_US-lessac-medium -v /tmp/ondoku-test-voices:/voices ondoku-test-tts
docker run -d --name ondoku-test --network ondoku-test -e ALLOW_PRIVATE_URLS=true -e TTS_URL=http://tts:5000 ondoku-test-app
# wait until the voice is downloaded (about 60 MB the first time; kept in /tmp/ondoku-test-voices)
until docker exec ondoku-test wget -qO- http://tts:5000/voices 2>/dev/null | grep -q lessac; do sleep 3; done
docker run --rm --name ondoku-smoke --network ondoku-test -v "$PWD/tests:/tests:ro" \
  -e BASE=http://ondoku-test:3102 -e FIXTURE_HOST=ondoku-smoke python:3.12-slim python /tests/smoke.py
docker rm -f ondoku-test ondoku-test-tts && docker network rm ondoku-test
```

It exits non-zero if any check fails. Without the Piper service the natural-voice checks are skipped.
