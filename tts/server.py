"""Piper TTS sidecar for Ondoku.

Voices come from the rhasspy/piper-voices repository on Hugging Face. The ones in PIPER_VOICES are downloaded on
first start; others are installed from the catalog through the API. Speech itself is synthesized entirely locally.

A voice key is a model id ("en_US-lessac-medium") or, for multi-speaker models, model id + "#" + speaker name
("en_GB-vctk-medium#p239"). Model ids can contain non-ASCII letters ("pt_PT-tugão-medium").

Some voices need a phonemizer this image doesn't include (see PHONEMIZERS). Every voice entry says whether it can be
used: "supported": true, or "supported": false with a short "unsupportedReason".

  GET    /health            -> {"ok": true, "voices": [...ids], "downloading": bool}
  GET    /voices            -> {"voices": [{id, name, language, languageName, region, quality, speakers, speakerNames, supported}], "default": id}
  GET    /catalog[?refresh=1] -> {"voices": [... every Piper voice, with "installed" and "supported"], "fetchedAt", "stale"}
  POST   /install           {"voice": id} -> queue a download (400 for a voice this version can't use)
  GET    /downloads         -> [{voice, status: queued|downloading|done|error, bytes, total, error}]
  DELETE /voices/<id>       -> remove an installed voice, or stop its download
  POST   /synthesize        {"text", "voice": key, "length_scale"} -> audio/wav
"""

import functools
import importlib
import importlib.util
import io
from contextlib import contextmanager
import json
import logging
import math
import os
import queue
import re
import threading
import time
import urllib.error
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import Request, urlopen

from piper import PhonemeType, PiperConfig, PiperVoice, SynthesisConfig
from piper.download_voices import URL_FORMAT, VOICE_PATTERN, VOICES_JSON

import onnxruntime as ort

# Every US and British English voice in medium quality (medium is the only quality offered: high voices are about 5x
# slower to generate and twice the size, low ones sound noticeably worse). Multi-speaker models and other languages can be
# added from the voice library.
DEFAULT_VOICES = (
    "en_US-lessac-medium,en_US-amy-medium,en_US-bryce-medium,en_US-hfc_female-medium,en_US-hfc_male-medium,"
    "en_US-joe-medium,en_US-john-medium,en_US-kristin-medium,en_US-kusal-medium,en_US-ljspeech-medium,"
    "en_US-mike-medium,en_US-norman-medium,en_US-reza_ibrahim-medium,en_US-ryan-medium,en_US-sam-medium,"
    "en_GB-alan-medium,en_GB-alba-medium,en_GB-cori-medium,en_GB-jenny_dioco-medium,en_GB-northern_english_male-medium"
)
OFFERED_QUALITY = "medium"
VOICES_DIR = Path(os.environ.get("VOICES_DIR", "/voices"))
WANTED = [v.strip() for v in (os.environ.get("PIPER_VOICES") or DEFAULT_VOICES).split(",") if v.strip()]
PORT = int(os.environ.get("PORT", "5000"))
SENTENCE_SILENCE = float(os.environ.get("SENTENCE_SILENCE", "0.25"))
MAX_TEXT = int(os.environ.get("MAX_TEXT_CHARS", "6000"))
MAX_CONCURRENT = max(1, int(os.environ.get("MAX_CONCURRENT") or 2))  # 0 would block every synthesis
THREADS = max(1, (os.cpu_count() or 4) // MAX_CONCURRENT)  # CPU threads per paragraph being spoken
MAX_LOADED = max(1, int(os.environ.get("MAX_LOADED_VOICES") or 4))  # models kept in memory (60-140 MB each)
CATALOG_FILE = VOICES_DIR / ".catalog.json"
SEEDED_FILE = VOICES_DIR / ".seeded.json"
CATALOG_MAX_AGE = 24 * 3600
CATALOG_RETRY_AFTER = 300  # after a failed catalog fetch, the cached copy is used this long before trying again
# \w is Unicode-aware: it takes letters like the "ã" in pt_PT-tugão-medium, but never "/", "." or "-"
ID_RE = re.compile(r"^[A-Za-z]{2,3}_[A-Za-z]{2}-\w+-[a-z_]+\Z")
QUALITY_RANK = {"x_low": 0, "low": 1, "medium": 2, "high": 3}

# Voices that don't use espeak-ng need one of Piper's own phonemizers, which import their packages only when such a
# voice first speaks. Per phoneme type: what it reads, and the modules it needs (piper-tts 1.8.0). This image leaves
# out the extras for Chinese (pinyin), Japanese and Thai, so those voices are reported as unsupported instead of
# failing when they are used.
PHONEMIZERS = {
    "pinyin": ("Chinese (pinyin)", ("piper.phonemize_chinese", "g2pw", "transformers", "sentence_stream")),
    "hebrew": ("Hebrew", ("piper.phonemize_hebrew",)),
    "japanese": ("Japanese", ("piper.phonemize_japanese", "pyopenjtalk")),
    "thai": ("Thai", ("piper.phonemize_thai", "tltk", "unicode_rbnf")),
}
# The catalog doesn't say which phonemizer a voice uses (only its .onnx.json does). These are the catalog voices that
# don't use espeak-ng, from every voice's .onnx.json in October 2026. A voice missing here is checked when its small
# config file is downloaded, before the model.
CATALOG_PHONEME_TYPES = {
    "he_IL-saspeech-medium": "hebrew",
    "ja_JP-hi_fi_captain-medium": "japanese",
    "lt_LT-reginute1-medium": "lithuanian",  # not a phoneme type piper-tts 1.8.0 knows
    "th_TH-tsync2-medium": "thai",
    "uk_UA-ukrainian_tts-medium": "text",
    "zh_CN-chaowen-medium": "pinyin",
    "zh_CN-xiao_ya-medium": "pinyin",
}
DAMAGED = "This voice's settings file is damaged"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

_loaded = OrderedDict()
_load_lock = threading.Lock()
_synth_slots = threading.Semaphore(MAX_CONCURRENT)
_catalog_lock = threading.Lock()
_catalog_failure = {"at": 0.0, "error": None}  # the last failed catalog fetch
_downloads = {}  # voice id -> progress
_downloads_lock = threading.Lock()  # held to add or remove entries, and to copy them
_download_queue = queue.Queue()  # progress entries to download
_seeding = {"active": False}
_seed_lock = threading.Lock()
_support = {}  # phoneme type -> None if this image can speak it, else why not (probed once each)
_phoneme_types = {}  # voice id -> phoneme type, from configs downloaded since the start


class DownloadCancelled(Exception):
    """The voice was removed while it was downloading."""


# ----- installed voices -----
def is_installed(voice_id):
    return (VOICES_DIR / f"{voice_id}.onnx").exists() and (VOICES_DIR / f"{voice_id}.onnx.json").exists()


def speaker_names(cfg):
    id_map = cfg.get("speaker_id_map") or {}
    if id_map:
        return [name for name, _ in sorted(id_map.items(), key=lambda kv: kv[1])]
    count = cfg.get("num_speakers", 1)
    return [str(i) for i in range(count)] if count > 1 else []


def describe(voice_id, cfg):
    lang = cfg.get("language", {})
    names = speaker_names(cfg)
    return {
        "id": voice_id,
        "name": str(cfg.get("dataset") or cfg.get("name") or voice_id.split("-")[1]).replace("_", " ").title(),
        "language": lang.get("code") or voice_id.split("-")[0],
        "languageName": lang.get("name_english", ""),
        "region": lang.get("country_english", ""),
        "quality": cfg.get("audio", {}).get("quality") or cfg.get("quality") or voice_id.rsplit("-", 1)[-1],
        "speakers": max(len(names), 1),
        "speakerNames": names,
    }


def sort_key(v):
    # English first (US, then the rest), then by name, best quality first
    lang = v["language"]
    return (0 if lang == "en_US" else 1 if lang.startswith("en_") else 2, lang, v["name"].lower(), -QUALITY_RANK.get(v["quality"], 0))


def read_config(path):
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return cfg if isinstance(cfg, dict) else None


def available_voices():
    out = []
    for cfg_path in VOICES_DIR.glob("*.onnx.json"):
        voice_id = cfg_path.name[: -len(".onnx.json")]
        # A file name that isn't a voice id could be listed but never used or removed
        if not ID_RE.match(voice_id) or not (VOICES_DIR / f"{voice_id}.onnx").exists():
            continue
        cfg = read_config(cfg_path)
        if cfg is None:
            continue
        out.append({**describe(voice_id, cfg), **support(config_problem(cfg))})
    return sorted(out, key=sort_key)


def default_voice(voices):
    ids = [v["id"] for v in voices if v.get("supported", True)]
    return next((v for v in WANTED if v in ids), ids[0] if ids else None)


# ----- which voices this image can speak -----
def phoneme_type_problem(kind):
    """Why voices of this phoneme type can't be used here (a short reason), or None if they can."""
    if kind not in _support:
        _support[kind] = probe_phoneme_type(kind)
    return _support[kind]


def probe_phoneme_type(kind):
    try:
        PhonemeType(kind)
    except ValueError:  # e.g. "lithuanian", which only newer versions of Piper read
        return "This voice needs a newer version of Piper"
    label, modules = PHONEMIZERS.get(kind, (kind, ()))
    for name in modules:
        # Piper's own phonemizer modules are imported (cheap); the packages they need are only looked up
        try:
            found = importlib.import_module(name) if name.startswith("piper.") else importlib.util.find_spec(name)
        except Exception as exc:  # noqa: BLE001
            log.info("Phonemizer module %s is unavailable: %s", name, exc)
            found = None
        if found is None:
            log.info("%s voices are not supported: %s is missing", label, name)
            return f"{label} voices aren't available in this version"
    return None


def config_problem(cfg):
    """Why a voice with this config can't be used here, or None if it can."""
    reason = phoneme_type_problem(str(cfg.get("phoneme_type") or "espeak"))
    if reason:
        return reason
    try:
        PiperConfig.from_dict(cfg)
    except Exception:  # noqa: BLE001 - a setting Piper needs is missing or malformed
        return DAMAGED
    return None


def voice_problem(voice_id):
    """Why a voice can't be used here, or None: from its config once it is installed, before that from the
    phonemizer it is known to use."""
    if is_installed(voice_id):
        cfg = read_config(VOICES_DIR / f"{voice_id}.onnx.json")
        return config_problem(cfg) if cfg is not None else DAMAGED
    return phoneme_type_problem(_phoneme_types.get(voice_id) or CATALOG_PHONEME_TYPES.get(voice_id, "espeak"))


def support(reason):
    return {"supported": False, "unsupportedReason": reason} if reason else {"supported": True}


# ----- catalog -----
def read_catalog_cache():
    try:
        data = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    ok = isinstance(data, dict) and isinstance(data.get("voices"), dict) and isinstance(data.get("fetchedAt"), (int, float))
    return data if ok else None


def load_catalog(refresh=False, allow_network=True):
    # The cached copy is replaced atomically, so it is read without the lock. One request fetches at a time while
    # the others use the cached copy, and after a failed fetch the cached copy is used for a while, so a network that
    # hangs can't queue requests up behind each other's timeouts. allow_network=False only fetches without a cache.
    started = time.time()
    cached = read_catalog_cache()
    fresh = bool(cached) and started - cached["fetchedAt"] < CATALOG_MAX_AGE
    if cached and (not allow_network or (fresh and not refresh)):
        return cached, not fresh
    if cached and started < _catalog_failure["at"] + CATALOG_RETRY_AFTER:
        return cached, True
    if not _catalog_lock.acquire(blocking=not cached):
        return cached, not fresh  # another request is fetching it
    try:
        latest = read_catalog_cache()
        if latest and latest["fetchedAt"] >= started:
            return latest, False  # fetched by the request this one waited for
        if not cached and _catalog_failure["at"] >= started:
            raise RuntimeError(_catalog_failure["error"])  # which failed while this one waited
        try:
            with urlopen(Request(VOICES_JSON, headers={"User-Agent": "ondoku-tts"}), timeout=30) as resp:
                raw = json.load(resp)
            if not isinstance(raw, dict):
                raise ValueError("voices.json is not a list of voices")
            data = {"fetchedAt": time.time(), "voices": raw}
            tmp = CATALOG_FILE.with_name(CATALOG_FILE.name + ".part")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            tmp.replace(CATALOG_FILE)
            return data, False
        except Exception as exc:  # noqa: BLE001 - fall back to the cached copy
            log.warning("Could not fetch the voice catalog: %s", exc)
            _catalog_failure.update({"at": time.time(), "error": str(exc)})
            if cached:
                return cached, True
            raise
    finally:
        _catalog_lock.release()


def catalog_entries(data):
    out = []
    for voice_id, v in data["voices"].items():
        if not ID_RE.match(voice_id) or v.get("quality") != OFFERED_QUALITY:
            continue  # can't be installed, or not a quality this app offers
        entry = describe(voice_id, v)
        entry["name"] = str(v.get("name") or entry["name"]).replace("_", " ").title()
        entry["sizeBytes"] = sum(f.get("size_bytes", 0) for name, f in v.get("files", {}).items() if name.endswith((".onnx", ".onnx.json")))
        entry["installed"] = is_installed(voice_id)
        entry["languageNative"] = v.get("language", {}).get("name_native", "")
        entry.update(support(voice_problem(voice_id)))
        out.append(entry)
    return sorted(out, key=sort_key)


# ----- downloads -----
def voice_url(voice_id, ext):
    match = VOICE_PATTERN.match(voice_id)
    if not match:
        raise ValueError(f"not a Piper voice name: {voice_id}")
    parts = match.groupdict()
    parts["lang_code"] = f"{parts['lang_family']}_{parts['lang_region']}"
    # Percent-encoded: names can have non-ASCII letters (pt_PT-tugão-medium), which urllib can't send as they are
    return URL_FORMAT.format(extension=ext, **{k: quote(v, safe="") for k, v in parts.items()})


def fetch_file(url, dest, progress=None, cancelled=None):
    # Download to a .part file with a read timeout, so a stalled connection fails instead of hanging,
    # and a half-written model is never mistaken for a complete one. A failed or cancelled download leaves nothing.
    part = dest.with_name(dest.name + ".part")
    try:
        with urlopen(Request(url, headers={"User-Agent": "ondoku-tts"}), timeout=60) as resp, open(part, "wb") as out:
            while True:
                if cancelled and cancelled():
                    raise DownloadCancelled(dest.name)
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                if progress:
                    progress(len(chunk))
        part.replace(dest)
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def delete_voice_files(voice_id):
    """Delete a voice's files, partial downloads included; True if it had a model or config file."""
    found = False
    for ext in (".onnx", ".onnx.json", ".onnx.part", ".onnx.json.part"):
        try:
            (VOICES_DIR / f"{voice_id}{ext}").unlink()
            found = found or not ext.endswith(".part")
        except FileNotFoundError:
            pass
    return found


def download_voice(state, size_hint=0):
    voice_id = state["voice"]
    reason = voice_problem(voice_id)
    if reason:
        raise ValueError(reason)
    state.update({"status": "downloading", "bytes": 0, "total": size_hint, "error": None, "updated": time.time()})

    def progress(n):
        state["bytes"] += n
        state["updated"] = time.time()

    for ext in (".onnx.json", ".onnx"):
        dest = VOICES_DIR / f"{voice_id}{ext}"
        if not dest.exists():
            fetch_file(voice_url(voice_id, ext), dest, progress, lambda: state.get("cancelled"))
        if ext == ".onnx.json":
            # The small config comes first: a voice this image can't speak is refused before its model is downloaded
            cfg = read_config(dest)
            if cfg is not None:
                _phoneme_types[voice_id] = str(cfg.get("phoneme_type") or "espeak")
            reason = config_problem(cfg) if cfg is not None else DAMAGED
            if reason:
                delete_voice_files(voice_id)
                raise ValueError(reason)
    with _downloads_lock:  # together with remove_voice: a voice removed now is deleted below, never left behind
        if not state.get("cancelled"):
            state.update({"status": "done", "updated": time.time()})
    if state.get("cancelled"):
        raise DownloadCancelled(voice_id)


def size_from_catalog(voice_id):
    try:
        data, _ = load_catalog(allow_network=False)  # only a size hint: never wait for the network over it
        files = data["voices"].get(voice_id, {}).get("files", {})
        return sum(f.get("size_bytes", 0) for name, f in files.items() if name.endswith((".onnx", ".onnx.json")))
    except Exception:  # noqa: BLE001
        return 0


def download_worker():
    while True:
        state = _download_queue.get()
        voice_id = state["voice"]
        try:
            if state.get("cancelled"):
                continue  # removed while it was queued
            if is_installed(voice_id):
                state.update({"status": "done", "updated": time.time()})
                continue
            log.info("Downloading voice %s", voice_id)
            download_voice(state, size_from_catalog(voice_id))
            log.info("Downloaded voice %s", voice_id)
        except Exception as exc:  # noqa: BLE001
            if state.get("cancelled"):
                log.info("Stopped downloading voice %s: it was removed", voice_id)
                delete_voice_files(voice_id)
            else:
                log.error("Could not download voice %s: %s", voice_id, exc)
                # Not worth retrying: a voice this version can't use, or one that doesn't exist upstream
                permanent = isinstance(exc, ValueError) or (isinstance(exc, urllib.error.HTTPError) and exc.code in (403, 404, 410))
                state.update({"status": "error", "error": str(exc), "updated": time.time(), "permanent": permanent})
        finally:
            _download_queue.task_done()


def enqueue_download(voice_id):
    with _downloads_lock:
        current = _downloads.get(voice_id)
        if current and current.get("status") in ("queued", "downloading"):
            return dict(current)
        state = {"voice": voice_id, "status": "queued", "bytes": 0, "total": 0, "error": None, "updated": time.time()}
        _downloads[voice_id] = state
        _download_queue.put(state)
        return dict(state)


def downloads_snapshot():
    # Copies, so a response is never built from entries another thread is changing
    with _downloads_lock:
        return [dict(d) for d in _downloads.values()]


def read_seeded():
    try:
        return set(json.loads(SEEDED_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return set()


def mark_seeded(ids):
    # Default voices that were downloaded once, or removed by an admin, are remembered for good. Written to a
    # temporary file first: a torn file would read as empty and bring back every voice removed earlier.
    ids = {v for v in ids if v in WANTED}
    if not ids:
        return
    with _seed_lock:
        seeded = read_seeded()
        if ids <= seeded:
            return
        tmp = SEEDED_FILE.with_name(SEEDED_FILE.name + ".part")
        tmp.write_text(json.dumps(sorted(seeded | ids)), encoding="utf-8")
        tmp.replace(SEEDED_FILE)


def seed_defaults():
    # Default voices are downloaded once. A voice removed later in the app stays removed, because it is
    # remembered in .seeded.json; a voice newly added to PIPER_VOICES is downloaded on the next start.
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    for stale in VOICES_DIR.glob("*.part"):
        stale.unlink(missing_ok=True)
    pending = seed_pass([v for v in WANTED if v not in read_seeded()])
    # Downloads that failed are retried, with pauses growing to 15 minutes, until they work (e.g. after an outage).
    # Voices that don't exist upstream or can't be used in this version are not retried.
    attempt = 0
    while pending:
        attempt += 1
        time.sleep(min(30 * attempt, 900))
        pending = seed_pass(pending)


def seed_pass(pending):
    """Download the default voices in pending; return the ones worth trying again."""
    _seeding["active"] = True
    try:
        for voice_id in pending:
            if not is_installed(voice_id):
                enqueue_download(voice_id)
        _download_queue.join()
        missing = [v for v in pending if not is_installed(v)]
        seeded = read_seeded()  # read after that check: remove_voice marks a voice before deleting its files
        mark_seeded([v for v in pending if v not in missing])
        return [v for v in missing if v not in seeded and not (_downloads.get(v) or {}).get("permanent")]
    except Exception:  # noqa: BLE001 - e.g. a full disk: try again later
        log.exception("Could not download the default voices")
        return pending
    finally:
        _seeding["active"] = False


def remove_voice(voice_id):
    """Remove a voice, stopping its download if one is queued or running. False if there was nothing to remove."""
    with _downloads_lock:
        state = _downloads.get(voice_id)
        pending = bool(state) and state.get("status") in ("queued", "downloading")
        if pending or any((VOICES_DIR / f"{voice_id}{ext}").exists() for ext in (".onnx", ".onnx.json")):
            # A default voice removed by an admin stays removed. Marked before anything is deleted, so seeding
            # never finds it missing without the mark.
            mark_seeded([voice_id])
        _downloads.pop(voice_id, None)
        if pending:
            state["cancelled"] = True  # the worker skips it, or stops between chunks and deletes what it wrote
    with _load_lock:
        _loaded.pop(voice_id, None)
    return delete_voice_files(voice_id) or pending


# ----- synthesis -----
class VoicePool:
    """Up to MAX_CONCURRENT copies of one voice, each with its own ONNX Runtime session. Every session has a single
    thread pool, so parallel requests on one shared session would just share its threads (measured: no gain); separate
    sessions with the cores split between them made a 4-core CPU about 1.3x faster."""

    def __init__(self, voice_id, model):
        self.voice_id, self.model = voice_id, model
        self.free = []
        self.created = 0
        self.cond = threading.Condition()
        self.first = self._new()  # load errors surface here; also used for the voice's config (speakers)
        self.created = 1
        self.free.append(self.first)

    def _new(self):
        voice = PiperVoice.load(self.model)
        voice.session = make_session(self.model)
        return voice

    @contextmanager
    def lease(self):
        with self.cond:
            while not self.free and self.created >= MAX_CONCURRENT:
                self.cond.wait()
            voice = self.free.pop() if self.free else None
            if voice is None:
                self.created += 1
        if voice is None:
            try:
                voice = self._new()
            except Exception:
                with self.cond:
                    self.created -= 1
                    self.cond.notify()
                raise
        try:
            yield voice
        finally:
            with self.cond:
                self.free.append(voice)
                self.cond.notify()


def make_session(model):
    # Cores are split between the paragraphs spoken at the same time, and idle threads don't busy-wait (measured about
    # 1.3x faster on a 4-core CPU than one paragraph at a time with every core).
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = THREADS
    opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(model), sess_options=opts, providers=["CPUExecutionProvider"])


def get_voice(voice_id):
    """The voice's pool of sessions (cached, least recently used first out)."""
    with _load_lock:
        hit = _loaded.get(voice_id)
        if hit:
            _loaded.move_to_end(voice_id)
            return hit
        model = VOICES_DIR / f"{voice_id}.onnx"
        if not model.exists():
            return None
        log.info("Loading voice %s", voice_id)
        pool = VoicePool(voice_id, model)
        _loaded[voice_id] = pool
        _loaded.move_to_end(voice_id)
        while len(_loaded) > MAX_LOADED:
            _loaded.popitem(last=False)
        return pool


def unload_all():
    with _load_lock:
        _loaded.clear()


def speaker_id(voice, speaker):
    if not speaker:
        return None
    id_map = voice.config.speaker_id_map or {}
    if speaker in id_map:
        return id_map[speaker]
    # Speakers are numbered only in models without names for them ("1" must not mean the second named speaker)
    if not id_map and speaker.isascii() and speaker.isdecimal() and int(speaker) < max(voice.config.num_speakers, 1):
        return int(speaker)
    raise KeyError(speaker)


def synthesize(voice, text, length_scale, speaker=None):
    config = SynthesisConfig(length_scale=length_scale, speaker_id=speaker)
    buf = io.BytesIO()
    rate = voice.config.sample_rate
    pcm = bytearray()
    silence = b""
    for chunk in voice.synthesize(text, syn_config=config):
        rate = chunk.sample_rate
        if not silence:
            silence = bytes(int(rate * SENTENCE_SILENCE) * 2)
        if pcm:
            pcm += silence
        pcm += chunk.audio_int16_bytes
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(bytes(pcm))
    return buf.getvalue()


def answer_errors(handler):
    """Answer with a JSON 500 when a request handler fails, instead of closing the connection without a response."""

    @functools.wraps(handler)
    def wrapper(self):
        try:
            return handler(self)
        except ConnectionError:
            pass  # the client went away
        except Exception as exc:  # noqa: BLE001
            log.exception("%s %s failed", self.command, self.path)
            self._json(500, {"error": str(exc) or type(exc).__name__})

    return wrapper


class Handler(BaseHTTPRequestHandler):
    server_version = "OndokuTTS/2.0"

    def log_message(self, fmt, *args):  # quieter access log
        if os.environ.get("ACCESS_LOG") == "1":
            log.info("%s %s", self.address_string(), fmt % args)

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit):
        length = max(0, int(self.headers.get("Content-Length") or 0))  # a negative length would read until EOF
        if length > limit:
            raise OverflowError("request body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    @answer_errors
    def do_GET(self):  # noqa: N802
        url = urlsplit(self.path)
        if url.path == "/health":
            busy = _seeding["active"] or any(d.get("status") in ("queued", "downloading") for d in downloads_snapshot())
            return self._json(200, {"ok": True, "voices": [v["id"] for v in available_voices()], "downloading": busy})
        if url.path == "/voices":
            voices = available_voices()
            return self._json(200, {"voices": voices, "default": default_voice(voices)})
        if url.path == "/catalog":
            try:
                data, stale = load_catalog(refresh=parse_qs(url.query).get("refresh") == ["1"])
            except Exception as exc:  # noqa: BLE001
                return self._json(503, {"error": f"The voice catalog could not be downloaded: {exc}"})
            return self._json(200, {"voices": catalog_entries(data), "fetchedAt": data["fetchedAt"], "stale": stale})
        if url.path == "/downloads":
            cutoff = time.time() - 600
            return self._json(200, [d for d in downloads_snapshot() if d.get("status") in ("queued", "downloading") or d.get("updated", 0) > cutoff])
        return self._json(404, {"error": "not found"})

    @answer_errors
    def do_DELETE(self):  # noqa: N802
        path = urlsplit(self.path).path
        if not path.startswith("/voices/"):
            return self._json(404, {"error": "not found"})
        voice_id = unquote(path[len("/voices/"):])
        if not ID_RE.match(voice_id):
            return self._json(400, {"error": "invalid voice id"})
        if not remove_voice(voice_id):
            return self._json(404, {"error": "voice is not installed"})
        log.info("Removed voice %s", voice_id)
        return self._json(200, {"ok": True})

    @answer_errors
    def do_POST(self):  # noqa: N802
        path = urlsplit(self.path).path
        try:
            data = self._body(MAX_TEXT * 4 + 1024)
        except OverflowError:
            return self._json(413, {"error": "request is too large"})
        except (ValueError, RecursionError):
            return self._json(400, {"error": "invalid JSON"})
        if not isinstance(data, dict):
            return self._json(400, {"error": "invalid JSON"})
        if path == "/install":
            voice_id = str(data.get("voice") or "")
            if not ID_RE.match(voice_id):
                return self._json(400, {"error": "invalid voice id"})
            try:
                catalog, _ = load_catalog(allow_network=False)  # the copy the library was shown from
            except Exception as exc:  # noqa: BLE001
                return self._json(503, {"error": f"The voice catalog could not be downloaded: {exc}"})
            if voice_id not in catalog["voices"]:
                return self._json(404, {"error": f"{voice_id} is not in the Piper catalog"})
            if catalog["voices"][voice_id].get("quality") != OFFERED_QUALITY:
                return self._json(400, {"error": "Only medium-quality voices are offered"})
            reason = voice_problem(voice_id)
            if reason:
                return self._json(400, {"error": reason})
            return self._json(202, enqueue_download(voice_id))
        if path != "/synthesize":
            return self._json(404, {"error": "not found"})
        text = str(data.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "text is required"})
        if len(text) > MAX_TEXT:
            return self._json(413, {"error": f"text is longer than {MAX_TEXT} characters"})
        key = str(data.get("voice") or default_voice(available_voices()) or "")
        voice_id, _, speaker = key.partition("#")
        reason = voice_problem(voice_id) if ID_RE.match(voice_id) and is_installed(voice_id) else None
        if reason:
            return self._json(400, {"error": reason})
        try:
            pool = get_voice(voice_id) if ID_RE.match(voice_id) else None
        except Exception as exc:  # noqa: BLE001 - e.g. a damaged model file
            log.exception("could not load voice %s", voice_id)
            return self._json(500, {"error": f"voice {voice_id} could not be loaded: {exc}"})
        if pool is None:
            return self._json(404, {"error": f"voice {voice_id} is not installed"})
        try:
            spk = speaker_id(pool.first, speaker)
        except KeyError:
            return self._json(404, {"error": f"voice {voice_id} has no speaker {speaker}"})
        try:
            length_scale = float(data.get("length_scale") or 1.0)
        except (TypeError, ValueError, OverflowError):
            length_scale = 1.0
        length_scale = min(max(length_scale, 0.5), 2.0) if math.isfinite(length_scale) else 1.0
        with _synth_slots:
            try:
                with pool.lease() as voice:
                    audio = synthesize(voice, text, length_scale, spk)
            except Exception as exc:  # noqa: BLE001
                log.exception("synthesis failed")
                return self._json(500, {"error": str(exc)})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    threading.Thread(target=download_worker, daemon=True).start()
    threading.Thread(target=seed_defaults, daemon=True).start()
    log.info("Piper TTS listening on :%d (voices dir %s, %d default voices)", PORT, VOICES_DIR, len(WANTED))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
