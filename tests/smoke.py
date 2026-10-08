#!/usr/bin/env python3
"""End-to-end API checks for Ondoku against a running instance with an EMPTY database.

Starts a small fixture web server (tests/fixtures) that the app fetches articles from, so the app container must
be able to reach this machine (run it with ALLOW_PRIVATE_URLS=true; see tests/README.md).

  BASE          app URL (default http://localhost:3199)
  FIXTURE_HOST  host name the app uses to reach the fixture server (default host.docker.internal)
  FIXTURE_PORT  fixture server port (default 3198)
"""
import http.cookiejar
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.environ.get("BASE", "http://localhost:3199").rstrip("/")
FIX_HOST = os.environ.get("FIXTURE_HOST", "host.docker.internal")
FIX_PORT = int(os.environ.get("FIXTURE_PORT", "3198"))
FIX = f"http://{FIX_HOST}:{FIX_PORT}"
HERE = os.path.dirname(os.path.abspath(__file__))
failures = 0
FEED_STATE = {"extra": False}  # True: the fixture feed has a newer post


def check(ok, what):
    global failures
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures += 1


class Fixtures(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(HERE, "fixtures"), **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "/article.html?utm_source=newsletter&id=7")
            self.end_headers()
            return
        if self.path == "/plain.txt":
            body = b"A plain text note\n\nFirst paragraph of the note.\n\nSecond paragraph, a little longer than the first one."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/feed.xml"):
            items = [(n, f"{FIX}/article.html?feed={n}", f"0{n} Oct 2026 08:00:00 GMT") for n in range(1, 6)]
            if FEED_STATE["extra"]:
                items.append((6, f"{FIX}/article.html?feed=6", "07 Oct 2026 09:00:00 GMT"))
            etag = '"feed-%d"' % len(items)
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            entries = "".join(f"<item><title>Feed story {n} &amp; more&nbsp;news</title><link>{link}</link><guid>story-{n}</guid><pubDate>{date}</pubDate></item>" for n, link, date in reversed(items))
            body = f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Example Times</title><link>{FIX}/</link>{entries}</channel></rss>'.encode()
            return self.send_body(body, "application/rss+xml; charset=utf-8", {"ETag": etag})
        if self.path == "/feed-site.html":
            return self.send_body(b'<!doctype html><html><head><title>Example Times</title><link rel="alternate" type="application/rss+xml" title="News" href="/feed.xml"></head><body>Home</body></html>', "text/html")
        if self.path == "/atom.xml":
            entries = "".join(f'<entry><title>Atom note {n}</title><link href="{FIX}/article.html?atom={n}"/><id>urn:atom:{n}</id><updated>2026-10-0{n}T10:00:00Z</updated></entry>' for n in (1, 2))
            body = f'<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Plain Notes</title><link rel="self" href="{FIX}/atom.xml"/><link href="{FIX}/"/><id>urn:test</id>{entries}</feed>'.encode()
            return self.send_body(body, "application/atom+xml")
        if self.path == "/doc.pdf":
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", "4")
            self.end_headers()
            self.wfile.write(b"%PDF")
            return
        super().do_GET()

    def send_body(self, body, content_type, headers=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


class Client:
    def __init__(self, headers=None):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())
        self.headers = headers or {}

    def req(self, method, path, body=None, headers=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        h = {**self.headers, **(headers or {})}
        if data is not None:
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
        try:
            res = self.opener.open(r, timeout=60)
            status, hdrs, content = res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            status, hdrs, content = e.code, e.headers, e.read()
        if raw:
            return status, hdrs, content
        try:
            return status, json.loads(content) if content else None
        except ValueError:
            return status, content.decode("utf-8", "replace")

    def get(self, p, **kw): return self.req("GET", p, **kw)
    def post(self, p, b=None, **kw): return self.req("POST", p, b if b is not None else {}, **kw)
    def patch(self, p, b, **kw): return self.req("PATCH", p, b, **kw)
    def put(self, p, b, **kw): return self.req("PUT", p, b, **kw)
    def delete(self, p, **kw): return self.req("DELETE", p, **kw)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


def wait_article(c, aid, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        s, a = c.get(f"/api/articles/{aid}")
        if s == 200 and a["status"] != "pending":
            return a
        time.sleep(0.5)
    return c.get(f"/api/articles/{aid}")[1]


def wait_images(c, aid, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        a = c.get(f"/api/articles/{aid}")[1]
        if f"/api/articles/{aid}/images/" in (a.get("contentHtml") or ""):
            return a
        time.sleep(0.5)
    return c.get(f"/api/articles/{aid}")[1]


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", FIX_PORT), Fixtures)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    anon = Client()
    s, st = anon.get("/api/auth/status")
    check(s == 200 and st["setupNeeded"], "fresh instance needs setup")
    s, h, _ = anon.get("/", raw=True)
    check("script-src 'self'" in (h.get("Content-Security-Policy") or ""), "pages carry a strict CSP")

    # ----- accounts -----
    c = Client()
    s, r = c.post("/api/auth/register", {"email": "Shane@Example.com", "password": "testpass123"})
    check(s == 201 and r["user"]["isAdmin"] and r["user"]["email"] == "shane@example.com", "first account is admin, email lower-cased")
    s, _ = Client().post("/api/auth/register", {"email": "other@example.com", "password": "testpass123"})
    check(s == 403, "registration closed after the first account")
    s, _ = Client().post("/api/auth/login", {"email": "shane@example.com", "password": "wrong-password"})
    check(s == 401, "wrong password rejected")
    s, _ = Client().post("/api/auth/login", {"email": "SHANE@example.com", "password": "testpass123"})
    check(s == 200, "login with email is case-insensitive")
    # Pictures are first left on the fixture server so the extraction checks below see their addresses; saving them
    # is switched on further down (which also saves them for articles fetched meanwhile).
    s, _ = c.put("/api/admin/settings", {"save_images": "false"})
    check(s == 200, "image saving can be switched off")

    # ----- saving and extraction -----
    s, r = c.post("/api/articles", {"url": f"{FIX}/article.html?utm_source=x&utm_medium=y&fbclid=abc", "tags": ["Travel"]})
    check(s == 201 and r["article"]["status"] == "pending", "link saved and queued for fetching")
    aid = r["article"]["id"]
    check("utm_" not in r["article"]["url"] and "fbclid" not in r["article"]["url"], "tracking parameters stripped")
    a = wait_article(c, aid)
    check(a["status"] == "ok", f"article fetched ({a.get('error')})")
    check(a["title"] == "The Quiet Return of Night Trains", "title from og:title (no site suffix)")
    check(a["siteName"] == "Example Times", "site name")
    check(a["byline"] == "Ada Fielding", "byline from JSON-LD @graph")
    check((a["publishedAt"] or "").startswith("2026-10-05"), "published date")
    check(a["leadImage"] == f"{FIX}/images/lead.jpg" == a["leadImageOriginal"], "lead image made absolute")
    check(a["wordCount"] > 150 and a["readingMinutes"] >= 1, f"word count {a['wordCount']} / reading time")
    check(a["tags"] == ["travel"], "tags normalized")
    html = a["contentHtml"]
    check("<script" not in html and "tracking" not in html and "<style" not in html, "scripts and styles removed")
    check("Advertisement" not in html and "12 Comments" not in html and ">Share<" not in html, "page furniture removed")
    check("Most read" not in html and "Privacy" not in html, "navigation, sidebar and footer left out")
    check(html.count("A modern sleeper cabin on the Paris route") == 1, "duplicated caption shown once")
    check(f'src="{FIX}/images/cabin.jpg"' in html, "lazy image promoted and made absolute")
    check("pixel.gif" not in html, "tracking pixel removed")
    check('class="table-wrap"' in html, "tables wrapped for scrolling")
    check('rel="noopener noreferrer nofollow"' in html or "<a " not in html, "links open safely")
    segs = a["segments"]
    check(segs[0] == a["title"], "segment 0 is the title")
    check("Why travellers are switching" in segs, "headings are read-aloud segments")
    check("No security queues or baggage fees." in segs, "list items are separate segments")
    check(any("3.5 times" in x for x in segs), "numbers kept intact")
    check(not any("Paris to Berlin" == x for x in segs), "tables are not read aloud")
    check(f'data-seg="{len(segs) - 1}"' in html, "every segment is tagged in the HTML")
    check("SLEEPER TRAIN PRICES" not in html and "CLICK HERE" not in html and "Rail strikes" not in html, "promo links to other stories removed")
    check("You can now listen" not in html, "text-to-speech widget removed")
    check(not any("Passengers board" in x for x in segs) and "<figcaption>" in html and "Passengers board the overnight service" in html, "class-marked caption shown as a caption, not read aloud")
    check("data-rl-caption" not in html, "internal caption marker removed")

    check(f'srcset="{FIX}/images/small.jpg 400w, {FIX}/images/large.jpg 1200w, {FIX}/images/huge.jpg 2400w"' in html, "srcset addresses made absolute")

    # ----- saved images -----
    s, _ = c.put("/api/admin/settings", {"save_images": "true"})
    end = time.time() + 30
    while time.time() < end:
        a = c.get(f"/api/articles/{aid}")[1]
        if a["leadImage"].startswith("/api/"):
            break
        time.sleep(0.5)
    html = a["contentHtml"]
    local = f"/api/articles/{aid}/images/"
    check(a["leadImage"].startswith(local) and a["leadImageOriginal"] == f"{FIX}/images/lead.jpg", "lead image saved on the server (original kept)")
    pics = re.findall(r'src="(/api/articles/\d+/images/([0-9a-f]{20})\.(\w+))"', html)
    check(len(pics) == 2 and sorted(p[2] for p in pics) == ["jpg", "png"], f"article pictures saved, type from content not name ({[p[2] for p in pics]})")
    check(f'src="{FIX}/images/platform.jpg"' in html, "an SVG posing as a JPEG is not saved (keeps its address)")
    check("srcset=" not in html and "sizes=" not in html, "saved pictures drop srcset and sizes")
    png = next((p[0] for p in pics if p[2] == "png"), None)
    if png:
        s, h, body = c.get(png, raw=True)
        check(s == 200 and h.get("Content-Type") == "image/png" and body[:4] == b"\x89PNG", "saved picture served with its real type")
        check("default-src 'none'" in (h.get("Content-Security-Policy") or "") and h.get("X-Content-Type-Options") == "nosniff", "saved pictures carry locked-down headers")
        check("private" in (h.get("Cache-Control") or ""), "saved pictures are privately cached")
    for bad_name in ["..%2Freadlog.db", "abc.jpg", "0123456789abcdef0123.svg"]:
        s, _ = c.get(local + bad_name)
        check(s == 404, f"bad image name refused ({bad_name})")
    s, h, body = c.get("/api/export?html=1", raw=True)
    ex_a = next(x for x in json.loads(body)["articles"] if x["id"] == aid)
    check(f'src="{FIX}/images/large.jpg"' in ex_a["contentHtml"] and local not in ex_a["contentHtml"], "export restores original picture addresses (largest srcset size up to 1600w was kept)")
    check(ex_a["leadImage"] == f"{FIX}/images/lead.jpg", "export gives the original lead image")
    s, info = c.get("/api/admin/info")
    check(info["images"]["files"] >= 3 and info["images"]["enabled"], "admin status counts saved pictures")

    s, r = c.post("/api/articles", {"url": f"{FIX.replace('http://', 'HTTP://')}/article.html#comments"})
    check(s == 200 and r["duplicate"] and r["article"]["id"] == aid, "same article saved twice is recognized")

    s, r = c.post("/api/articles", {"url": f"{FIX}/redirect"})
    rid = r["article"]["id"]
    ra = wait_article(c, rid)
    check(ra["status"] == "ok" and ra["finalUrl"] == f"{FIX}/article.html?id=7", "redirect followed, final URL cleaned")

    s, r = c.post("/api/articles", {"url": f"{FIX}/plain.txt"})
    pa = wait_article(c, r["article"]["id"])
    check(pa["status"] == "ok" and len(pa["segments"]) == 4, "plain text page saved as paragraphs")

    s, r = c.post("/api/articles", {"url": f"{FIX}/missing-page"})
    fa = wait_article(c, r["article"]["id"])
    check(fa["status"] == "failed" and "not found" in fa["error"], "404 reported as a fetch failure")
    s, r = c.post("/api/articles", {"url": f"{FIX}/doc.pdf"})
    pdf = wait_article(c, r["article"]["id"])
    check(pdf["status"] == "failed" and "PDF" in pdf["error"], "PDF links explained")

    s, r = c.put(f"/api/articles/{fa['id']}/content", {"title": "Rescued article", "text": "First pasted paragraph.\n\nSecond pasted paragraph."})
    check(s == 200 and r["status"] == "ok" and r["source"] == "text" and r["segments"][1] == "First pasted paragraph.", "pasted text replaces a failed fetch")

    s, r = c.post("/api/articles", {"title": "A pasted note", "text": "Line one of a note.\n\nLine two of a note."})
    check(s == 201 and r["article"]["status"] == "ok" and r["article"]["url"] is None, "text without a link can be saved")
    note_id = r["article"]["id"]

    for bad in ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"]:
        s, r = c.post("/api/articles", {"url": bad})
        check(s == 400, f"rejects {bad.split(':')[0]} links")

    s, r = c.post("/api/articles", {"url": f"see {FIX}/article.html?a=1 and {FIX}/plain.txt?b=2"})
    check(s == 201 and len(r["created"]) == 2, "several links in one paste are all saved")

    # ----- search, list views, updates -----
    s, r = c.get("/api/articles?view=all&q=sleeper")
    check(s == 200 and any(i["id"] == aid for i in r["items"]) and "\u0002" in r["items"][0].get("snippet", ""), "full-text search with highlighted snippet")
    s, r = c.get("/api/articles?view=all&q=travellers+switch")
    check(any(i["id"] == aid for i in r["items"]), "search matches word stems")

    s, r = c.patch(f"/api/articles/{aid}", {"starred": True, "progress": 0.4, "listenSeg": 3, "tags": ["rail", "Europe"]})
    check(s == 200 and r["starred"] and abs(r["progress"] - 0.4) < 1e-9 and r["listenSeg"] == 3 and r["tags"] == ["europe", "rail"], "star, progress, listening position and tags saved")
    s, r = c.get("/api/articles?view=starred")
    check([i["id"] for i in r["items"]] == [aid], "starred view")
    s, r = c.get("/api/articles?view=all&tag=rail")
    check([i["id"] for i in r["items"]] == [aid], "tag filter")
    s, tags = c.get("/api/tags")
    check({t["name"] for t in tags} == {"europe", "rail"}, "unused tags are cleaned up")

    # ----- tags in search -----
    Q = lambda q: c.get("/api/articles?view=all&q=" + urllib.request.quote(q))[1]
    s, r = c.patch(f"/api/articles/{aid}", {"tags": ["rail", "Europe", "#Weekend Reads"]})
    check(r["tags"] == ["europe", "rail", "weekend reads"], "a leading # is dropped from tag names")
    check([i["id"] for i in Q("#rail")["items"]] == [aid], "#tag search filters by tag")
    check([i["id"] for i in Q("#ra")["items"]] == [aid], "a #tag still being typed matches as a prefix")
    check(Q("#ra ")["total"] == 0, "a finished #tag must match exactly")
    check([i["id"] for i in Q('#"weekend reads" sleeper')["items"]] == [aid], "quoted multi-word #tag combined with words")
    check(Q("#rail #nosuchtag ")["total"] == 0, "several #tags must all match")
    check(any(i["id"] == aid for i in Q("reads")["items"]), "plain words also match tag names")
    ids = {t["name"]: t["id"] for t in c.get("/api/tags")[1]}
    s, lst = c.patch(f"/api/tags/{ids['rail']}", {"name": "#Trains"})
    check(s == 200 and "trains" in {t["name"] for t in lst}, "tag renamed")
    check([i["id"] for i in Q("#trains ")["items"]] == [aid] and Q("#rail ")["total"] == 0, "search follows a renamed tag")
    s, lst = c.patch(f"/api/tags/{ids['weekend reads']}", {"name": "trains"})
    check(s == 200 and "weekend reads" not in {t["name"] for t in lst}, "renaming onto an existing tag merges them")
    check(not any(i["id"] == aid for i in Q("reads")["items"]), "a merged-away tag name no longer matches")
    s, _ = c.delete(f"/api/tags/{ids['europe']}")
    check(s == 204 and c.get(f"/api/articles/{aid}")[1]["tags"] == ["trains"], "deleting a tag removes it from its articles")
    check(Q("#europe ")["total"] == 0, "a deleted tag no longer matches")
    c.patch(f"/api/articles/{aid}", {"tags": ["rail", "europe"]})

    s, r = c.patch(f"/api/articles/{aid}", {"title": "Night Trains Are Back"})
    check(r["title"] == "Night Trains Are Back" and r["segments"][0] == "Night Trains Are Back" and r["contentHash"] != a["contentHash"], "rename updates the spoken title")

    s, r = c.post("/api/articles/bulk", {"ids": [note_id, rid], "action": "archive"})
    check(s == 200 and r["updated"] == 2, "bulk archive")
    s, r = c.get("/api/articles?view=archive")
    check({i["id"] for i in r["items"]} == {note_id, rid} and r["counts"]["archive"] == 2, "archive view and counts")
    s, r = c.get("/api/articles?view=queue&sort=shortest")
    check(note_id not in [i["id"] for i in r["items"]], "archived articles leave the queue")

    s, r = c.post("/api/import", {"text": f"Links: {FIX}/article.html and https://example.com/new-story, again {FIX}/article.html"})
    check(s == 201 and r["found"] == 2 and r["duplicates"] == 1 and r["created"] == 1, "import finds links and skips duplicates")

    s, h, body = c.get("/api/export", raw=True)
    ex = json.loads(body)
    check(s == 200 and "attachment" in h.get("Content-Disposition", "") and ex["count"] >= 8 and any("sleeper" in (x.get("text") or "") for x in ex["articles"]), "JSON export with text")

    s, h, _ = c.get("/share?title=Hi&text=" + urllib.request.quote(f"Look {FIX}/article.html"), raw=True)
    check(s == 302 and "/#/save?url=" in h.get("Location", ""), "share target hands the link to the save screen")

    # ----- API keys -----
    s, wk = c.post("/api/me/api-keys", {"name": "script"})
    s2, rk = c.post("/api/me/api-keys", {"name": "reader", "permission": "read"})
    check(s == 201 and wk["secret"].startswith("od_") and s2 == 201, "API keys created")
    w = Client({"Authorization": f"Bearer {wk['secret']}"})
    ro = Client({"x-api-key": rk["secret"]})
    s, r = ro.get("/api/v1/articles?view=all")
    check(s == 200 and r["total"] >= 8, "read-only key can list articles")
    s, _ = ro.post("/api/v1/articles", {"url": "https://example.com/x"})
    check(s == 403, "read-only key cannot save")
    s, r = w.post("/api/v1/articles", {"text": "Saved by a script.", "title": "Script note"})
    check(s == 201, "write key can save")
    s, _ = w.get("/api/v1/me/api-keys")
    check(s == 403, "keys cannot manage keys")
    s, _ = w.get("/api/v1/admin/users")
    check(s == 403, "keys cannot use admin endpoints")
    s, _ = Client({"Authorization": "Bearer rl_notarealkeynotarealkey123"}).get("/api/v1/articles")
    check(s == 401, "unknown key rejected")

    # ----- second user and isolation -----
    s, u2 = c.post("/api/admin/users", {"email": "reader@example.com", "password": "readerpass1"})
    check(s == 201 and not u2["isAdmin"], "admin creates a user by email")
    c2 = Client()
    s, _ = c2.post("/api/auth/login", {"email": "reader@example.com", "password": "readerpass1"})
    check(s == 200, "new user signs in")
    s, _ = c2.get(f"/api/articles/{aid}")
    check(s == 404, "users cannot see each other's articles")
    if png:
        s, _ = c2.get(png)
        check(s == 404, "users cannot load each other's saved pictures")
    s, r = c2.get("/api/articles?view=all")
    check(r["total"] == 0, "new user starts empty")
    s, _ = c2.get("/api/admin/users")
    check(s == 403, "non-admin blocked from admin")
    s, r = c2.post("/api/articles", {"url": f"{FIX}/article.html"})
    check(s == 201 and not r["duplicate"], "same link can be saved by another user")
    s, _ = c.put("/api/admin/settings", {"registration_enabled": "true"})
    check(s == 200 and Client().get("/api/auth/status")[1]["registrationEnabled"] is True, "open registration switch takes effect")
    s, _ = Client().post("/api/auth/register", {"email": "newbie@example.com", "password": "newbiepass1"})
    check(s == 201, "anyone can register while registration is open")
    c.put("/api/admin/settings", {"registration_enabled": "false"})
    check(Client().get("/api/auth/status")[1]["registrationEnabled"] is False, "open registration switch turns off again")
    c.patch(f"/api/admin/users/{u2['id']}", {"disabled": True})
    s, _ = c2.get("/api/articles")
    check(s == 401, "disabling a user ends their session")

    # ----- pronunciation fixes -----
    s, e1 = c.post("/api/pronunciations", {"word": " GIF ", "say": "jif"})
    check(s == 201 and e1["word"] == "GIF" and e1["say"] == "jif" and not e1["matchCase"], "pronunciation fix added (trimmed)")
    s, e1b = c.post("/api/pronunciations", {"word": "GIF", "say": "jiff"})
    check(s == 200 and e1b["id"] == e1["id"] and e1b["say"] == "jiff", "adding the same word again updates it")
    s, e2 = c.post("/api/pronunciations", {"word": "US", "say": "U.S.", "matchCase": True})
    check(s == 201 and e2["matchCase"], "case-sensitive fix added")
    for bad_body, why in [({"word": "", "say": "x"}, "empty word"), ({"word": "!!!", "say": "x"}, "no letters")]:
        s, _ = c.post("/api/pronunciations", bad_body)
        check(s == 400, f"pronunciation rejected: {why}")
    s, _ = c.patch(f"/api/pronunciations/{e2['id']}", {"word": "GIF"})
    check(s == 409, "renaming onto an existing word is refused")
    s, e2b = c.patch(f"/api/pronunciations/{e2['id']}", {"say": "you ess"})
    check(s == 200 and e2b["say"] == "you ess" and e2b["word"] == "US", "pronunciation fix edited")
    s, lst = c.get("/api/pronunciations")
    check([x["word"] for x in lst] == ["GIF", "US"], "pronunciation list")
    s, _ = c2.get("/api/pronunciations")
    check(s == 401, "pronunciation list needs a signed-in account")
    s, lst_w = w.get("/api/v1/pronunciations")
    check(s == 200 and len(lst_w) == 2, "API keys can read the pronunciation list")
    s, ex = c.get("/api/export")
    check([x["word"] for x in ex.get("pronunciations", [])] == ["GIF", "US"], "export includes pronunciation fixes")

    # ----- archiving preferences -----
    s, me = c.get("/api/me")
    p0 = me["user"]["prefs"]
    check(p0["archiveOnFinish"] is True and p0["archiveOnListen"] is True and p0["archiveAfterDays"] == 0 and p0["dropAudioOnArchive"] is False, "archiving defaults")
    s, _ = c.patch("/api/me", {"prefs": {"archiveAfterDays": -3}})
    check(s == 400, "a negative archive period is refused")
    s, r = c.patch("/api/me", {"prefs": {"archiveAfterDays": 7, "archiveOnFinish": False}})
    check(s == 200 and r["user"]["prefs"]["archiveAfterDays"] == 7 and r["user"]["prefs"]["archiveOnFinish"] is False and r.get("archived", 0) == 0, "archive period saved; nothing recent is archived")
    s, r = c.get("/api/articles?view=queue")
    check(any(i["id"] == aid for i in r["items"]), "fresh articles stay in the queue")
    c.patch("/api/me", {"prefs": {"archiveAfterDays": 0, "archiveOnFinish": True}})
    check(p0["deleteArchivedAfterDays"] == 730, "archived articles are deleted after 2 years by default")
    for bad_days in [-1, True, 1.5, "abc", 40000]:
        s, _ = c.patch("/api/me", {"prefs": {"deleteArchivedAfterDays": bad_days}})
        check(s == 400, f"delete period refused: {bad_days!r}")
    s, r = c.get("/api/archive/expired")
    check(s == 200 and r == {"days": 730, "count": 0}, "nothing has been archived long enough to be deleted")
    s, _ = c.get("/api/archive/expired?days=1.5")
    check(s == 400, "preview needs a whole number of days")
    s, r = c.patch("/api/me", {"prefs": {"deleteArchivedAfterDays": 1}})
    check(s == 200 and r["user"]["prefs"]["deleteArchivedAfterDays"] == 1 and r.get("deleted") == 0, "a shorter delete period applies at once (nothing old enough)")
    s, r = c.patch("/api/me", {"prefs": {"deleteArchivedAfterDays": 0}})
    check(s == 200 and r["user"]["prefs"]["deleteArchivedAfterDays"] == 0 and "deleted" not in r, "deleting archived articles can be turned off")
    c.patch("/api/me", {"prefs": {"deleteArchivedAfterDays": 730}})
    s, r = c.patch(f"/api/articles/{aid}", {"archived": True})
    check(r["archived"] and r["archivedAt"], "archived from the article")
    s, r = c.patch(f"/api/articles/{aid}", {"archived": False})
    check(not r["archived"] and r["archivedAt"] is None, "moved back to the queue")

    # ----- auto-tag rules -----
    s, r1 = c.post("/api/tag-rules", {"kind": "site", "pattern": f"HTTP://www.{FIX_HOST}:{FIX_PORT}/some/page", "tag": "#Fixture"})
    check(s == 201 and r1["pattern"] == FIX_HOST.lower() and r1["tag"] == "fixture", "site rule added (an address is trimmed to its host)")
    s, r2 = c.post("/api/tag-rules", {"kind": "title", "pattern": "night   trains", "tag": "rail"})
    s3, r3 = c.post("/api/tag-rules", {"kind": "text", "pattern": "sleeper", "tag": "sleepers"})
    check(s == 201 and s3 == 201 and r2["pattern"] == "night trains", "title and text rules added")
    s, _ = c.post("/api/tag-rules", {"kind": "site", "pattern": FIX_HOST, "tag": "fixture"})
    check(s == 409, "a duplicate rule is refused")
    for bad_rule, why in [({"kind": "colour", "pattern": "x", "tag": "y"}, "unknown kind"), ({"kind": "title", "pattern": "!!", "tag": "y"}, "no words"),
                          ({"kind": "site", "pattern": "not a site", "tag": "y"}, "bad site"), ({"kind": "title", "pattern": "ok", "tag": "  "}, "no tag")]:
        s, _ = c.post("/api/tag-rules", bad_rule)
        check(s == 400, f"rule refused: {why}")
    s, r = c.post("/api/articles", {"url": f"{FIX}/article.html?rules=1", "tags": ["mine"]})
    ra_ = wait_article(c, r["article"]["id"])
    check(set(ra_["tags"]) == {"mine", "fixture", "rail", "sleepers"}, f"rules tag a newly saved article, keeping its own tags ({ra_['tags']})")
    c.patch(f"/api/articles/{ra_['id']}", {"tags": ["mine"]})
    c.post(f"/api/articles/{ra_['id']}/refetch")
    time.sleep(1)
    ra2 = wait_article(c, ra_["id"])
    check(ra2["tags"] == ["mine"], "fetching again doesn't bring back tags the rules added")
    s, r4 = c.post("/api/tag-rules", {"kind": "title", "pattern": "pasted note", "tag": "notes"})
    s, out = c.post("/api/tag-rules/apply")
    check(s == 200 and out["updated"] >= 1 and "notes" in c.get(f"/api/articles/{note_id}")[1]["tags"], f"rules applied to saved articles ({out.get('updated')})")
    s, lst = c.get("/api/tag-rules")
    check([x["kind"] for x in lst] == ["site", "title", "title", "text"], "rules listed by kind")
    s, r4b = c.patch(f"/api/tag-rules/{r4['id']}", {"tag": "#Notebook"})
    check(s == 200 and r4b["tag"] == "notebook" and r4b["pattern"] == "pasted note", "rule edited")
    s, _ = c.delete(f"/api/tag-rules/{r4['id']}")
    check(s == 204 and len(c.get("/api/tag-rules")[1]) == 3, "rule removed")

    # ----- public share links -----
    full = wait_images(c, aid)
    s, sh = c.post(f"/api/articles/{aid}/share")
    check(s == 200 and "/s/" in sh["url"] and sh["views"] == 0, "public link created")
    path = "/s/" + sh["url"].split("/s/", 1)[1]
    anon2 = Client()
    s, h, body = anon2.get(path, raw=True)
    page = body.decode("utf-8", "replace")
    check(s == 200 and full["title"] in page, "anyone can open a shared article without signing in")
    check("noindex" in page and "noindex" in (h.get("X-Robots-Tag") or ""), "shared pages ask search engines not to index them")
    csp = h.get("Content-Security-Policy") or ""
    check("default-src 'none'" in csp and "script" not in csp and "<script" not in page, "shared pages run no scripts")
    shared_pics = re.findall(r'src="(/s/[^"]+/images/[^"]+)"', page)
    check(len(shared_pics) >= 2 and "/api/articles/" not in page, f"shared page serves the saved pictures through the link ({len(shared_pics)})")
    if shared_pics:
        s, hp, _ = anon2.get(shared_pics[0], raw=True)
        check(s == 200 and (hp.get("Content-Type") or "").startswith("image/"), "a shared picture loads without signing in")
    check("shane@example.com" not in page.lower(), "the shared page shows nothing about the owner")
    s, again = c.post(f"/api/articles/{aid}/share")
    check(again["url"] == sh["url"], "sharing again keeps the same link")
    s, shares = c.get("/api/shares")
    check(len(shares) == 1 and shares[0]["views"] >= 1 and shares[0]["articleId"] == aid, "shared links listed with how often they were opened")
    check(c.get(f"/api/articles/{aid}")[1]["share"]["url"] == sh["url"], "the article knows its public link")
    s, _ = c.delete(f"/api/articles/{aid}/share")
    s2, _, _ = anon2.get(path, raw=True)
    s3, _, _ = anon2.get(shared_pics[0], raw=True) if shared_pics else (404, None, None)
    check(s == 204 and s2 == 404 and s3 == 404, "stopping sharing ends the link and its pictures")
    s, _, _ = anon2.get("/s/abcdefghijklmnopqrstuvwxyz012345", raw=True)
    check(s == 404, "unknown share links are 404")

    # ----- followed feeds -----
    s, pre = c.post("/api/articles", {"url": f"{FIX}/article.html?feed=5"})
    c.patch(f"/api/articles/{pre['article']['id']}", {"archived": True})
    s, fr = c.post("/api/feeds", {"url": f"{FIX}/feed-site.html", "tags": ["Feeds"]})
    check(s == 201 and fr["feed"]["url"] == f"{FIX}/feed.xml" and fr["feed"]["title"] == "Example Times", f"feed found from the site's page ({fr})")
    check(fr.get("added") == 2, f"first check saves the newest 3 posts, skipping one already saved ({fr.get('added')})")
    fid = fr["feed"]["id"]
    s, fa = c.get("/api/articles?view=all&tag=feeds")
    titles = sorted(x["url"].split("=")[-1] for x in fa["items"])
    check(titles == ["3", "4"], f"feed posts saved with the feed's tags ({titles})")
    check(c.get(f"/api/articles/{pre['article']['id']}")[1]["archived"], "a feed doesn't bring an archived article back")
    one = wait_article(c, fa["items"][0]["id"])
    check((one.get("feed") or {}).get("title") == "Example Times", "an article knows the feed it came from")
    s, _ = c.post("/api/feeds", {"url": f"{FIX}/feed.xml"})
    check(s == 409, "following the same feed twice is refused")
    s, chk = c.post(f"/api/feeds/{fid}/check")
    check(s == 200 and chk["added"] == 0 and not chk["feed"]["lastError"], "an unchanged feed adds nothing (conditional request)")
    FEED_STATE["extra"] = True
    s, chk = c.post(f"/api/feeds/{fid}/check")
    check(chk["added"] == 1 and chk["feed"]["saved"] == 3, f"a new post is saved on the next check, older ones are not ({chk['added']})")
    s, fa2 = c.post("/api/feeds", {"url": f"{FIX}/atom.xml"})
    check(s == 201 and fa2["added"] == 2 and fa2["feed"]["title"] == "Plain Notes", "Atom feeds work too")
    s, fp = c.patch(f"/api/feeds/{fid}", {"active": False, "tags": ["news", "Feeds"]})
    check(s == 200 and fp["active"] is False and fp["tags"] == ["news", "feeds"], "a feed can be paused and retagged")
    s, _ = c.post("/api/feeds", {"url": f"{FIX}/missing-feed"})
    check(s == 400, "an address without a feed is explained")
    s, flist = c.get("/api/feeds")
    check(len(flist) == 2, "followed feeds listed")
    s, ex = c.get("/api/export")
    check(len(ex.get("feeds", [])) == 2 and len(ex.get("tagRules", [])) == 3, "export includes feeds and tag rules")
    kept = fa["items"][0]["id"]
    s, _ = c.delete(f"/api/feeds/{fid}")
    s2, k = c.get(f"/api/articles/{kept}")
    check(s == 204 and s2 == 200 and k["feed"] is None, "unfollowing keeps the articles the feed saved")

    # ----- continuous play preference -----
    s, r = c.patch("/api/me", {"prefs": {"continuousPlay": True}})
    check(s == 200 and r["user"]["prefs"]["continuousPlay"] is True, "continuous play can be turned on")
    c.patch("/api/me", {"prefs": {"continuousPlay": False}})

    # ----- natural voice (only when the TTS service is reachable) -----
    s, tts = c.get("/api/tts/status?fresh=1")
    if tts.get("online") and tts.get("voices"):
        voice = next(v["id"] for v in tts["voices"] if v.get("supported", True))
        s, h, wav = c.get(f"/api/tts/preview?voice={voice}", raw=True)
        check(s == 200 and wav[:4] == b"RIFF", "voice preview returns WAV")
        s, t = c.post(f"/api/articles/{note_id}/audio", {"voice": voice})
        check(s == 200 and t["status"] in ("queued", "generating", "ready"), "audio requested")
        end = time.time() + 180
        while time.time() < end and t["status"] != "ready" and t["status"] != "failed":
            time.sleep(1)
            t = c.get(f"/api/articles/{note_id}/audio?voice={voice}")[1]
        check(t["status"] == "ready", f"audio generated ({t.get('error')})")
        if t["status"] == "ready":
            segs_meta = t["segments"]
            check(len(segs_meta) == t["segmentsTotal"] == 3 and all(segs_meta[i]["end"] <= segs_meta[i + 1]["start"] + 1e-6 for i in range(len(segs_meta) - 1)), "segment timings are in order")
            s, h, b = c.req("GET", t["url"], headers={"Range": "bytes=0-99"}, raw=True)
            check(s == 206 and h.get("Content-Type") == "audio/mpeg" and len(b) == 100, "MP3 served with range requests")
            s, t2 = c.post(f"/api/articles/{note_id}/audio", {"voice": voice})
            check(t2["id"] == t["id"] and t2["status"] == "ready", "finished audio is reused")
            s, tb = c.post(f"/api/articles/{rid}/audio", {"voice": voice, "background": True})
            check(s == 200 and tb["status"] in ("queued", "generating", "ready"), "audio can be prepared in the background (continuous play)")
            s, h, wav = c.get(f"/api/pronunciations/say?text=GIF&voice={voice}", raw=True)
            check(s == 200 and wav[:4] == b"RIFF" and h.get("Content-Type") == "audio/wav", "a pronunciation fix can be heard")
            # A fix for a word the article doesn't contain leaves its audio alone; one for a word it does contain
            # makes the audio again.
            s, t3 = c.post(f"/api/articles/{note_id}/audio", {"voice": voice})
            check(t3["status"] == "ready", "fixes for other words keep the audio")
            s, e3 = c.post("/api/pronunciations", {"word": "note", "say": "memo"})
            s, t4 = c.post(f"/api/articles/{note_id}/audio", {"voice": voice})
            check(t4["id"] == t["id"] and t4["status"] in ("queued", "generating"), "a fix for a word in the article makes the audio again")
            s, listed = c.get(f"/api/articles/{note_id}/audio")
            check(not any(x["status"] == "ready" for x in listed), "audio made before the fix is not offered")
            end = time.time() + 180
            while time.time() < end and t4["status"] not in ("ready", "failed"):
                time.sleep(1)
                t4 = c.get(f"/api/articles/{note_id}/audio?voice={voice}")[1]
            check(t4["status"] == "ready", "audio remade with the fix")
            s, t5 = c.post(f"/api/articles/{note_id}/audio", {"voice": voice})
            check(t5["status"] == "ready", "audio with the fix is reused")
            c.delete(f"/api/pronunciations/{e3['id']}")
            s, t6 = c.post(f"/api/articles/{note_id}/audio", {"voice": voice})
            check(t6["status"] in ("queued", "generating"), "removing the fix makes the audio again")
            while time.time() < end and t6["status"] not in ("ready", "failed"):
                time.sleep(1)
                t6 = c.get(f"/api/articles/{note_id}/audio?voice={voice}")[1]
            # "Remove the audio when archiving"
            c.patch("/api/me", {"prefs": {"dropAudioOnArchive": True}})
            c.patch(f"/api/articles/{note_id}", {"archived": False})  # archived by the bulk action above
            s, kept = c.get(f"/api/articles/{note_id}/audio?voice={voice}")
            check(kept and kept["status"] == "ready", "moving back to the queue keeps the audio")
            c.patch(f"/api/articles/{note_id}", {"archived": True})
            s, gone = c.get(f"/api/articles/{note_id}/audio?voice={voice}")
            check(s == 200 and gone is None, "archiving removes the audio when asked to")
            c.patch("/api/me", {"prefs": {"dropAudioOnArchive": False}})
        c.delete(f"/api/articles/{note_id}")
        s, _ = c.get(f"/api/articles/{note_id}/audio?voice={voice}")
        check(s == 404, "deleting an article removes its audio")
    else:
        print("SKIP natural voice checks (TTS service offline: %s)" % tts.get("error"))

    end = time.time() + 30
    while time.time() < end and c.get("/api/admin/info")[1]["images"]["queued"]:
        time.sleep(0.5)
    files_before = c.get("/api/admin/info")[1]["images"]["files"]
    s, _ = c.delete(f"/api/articles/{aid}")
    s2, _ = c.get(f"/api/articles/{aid}")
    check(s == 204 and s2 == 404, "article deleted")
    s, info = c.get("/api/admin/info")
    check(info["images"]["files"] == files_before - 3, f"deleting an article removes its saved pictures ({files_before} -> {info['images']['files']})")

    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{failures} FAILED'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
