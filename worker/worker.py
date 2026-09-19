"""TubePacks, worker : cherche en continu de nouvelles vidéos YouTube FR et les ajoute dans Redis.

Boucle :
  1. explore la source la moins récemment visitée (chaîne ou recherche) ;
  2. lance une recherche « plus récentes d'abord » sur un mot-clé FR tiré au hasard ;
  3. rafraîchit les vues et likes des vidéos les plus anciennement mises à jour.
Les chaînes françaises trouvées via les recherches sont ajoutées aux sources (découverte automatique).
Les vues et likes affichés dans l'app se mettent donc à jour tout seuls, sans action des joueurs.
"""
import logging
import os
import random
import signal
import time
from pathlib import Path

import redis
from yt_dlp import YoutubeDL

log = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

env = os.environ.get
MIN_VIEWS = int(env("MIN_VIEWS", "10000"))
PER_SOURCE = int(env("PER_SOURCE", "30"))          # vidéos examinées par source et par passage
PAUSE = float(env("PAUSE", "2"))                   # secondes entre deux vidéos
CYCLE_PAUSE = float(env("CYCLE_PAUSE", "60"))      # secondes entre deux cycles
REFRESH_BATCH = int(env("REFRESH_BATCH", "20"))    # vidéos rafraîchies par cycle
REFRESH_AGE = int(env("REFRESH_DAYS", "7")) * 86400
MAX_SOURCES = int(env("MAX_SOURCES", "500"))
DISCOVER = env("DISCOVER", "1") == "1"

r = redis.Redis(host=env("REDIS_HOST", "redis"), port=int(env("REDIS_PORT", "6379")),
                password=env("REDIS_PASSWORD") or None, decode_responses=True)

KEYWORDS = [
    "vulgarisation scientifique", "histoire de france", "documentaire en français", "clip rap français",
    "chanson française", "sketch humour français", "vlog en france", "recette facile", "voyage en france",
    "let's play français", "tuto en français", "actualité france", "astronomie expliquée",
    "nouvelle technologie expliquée", "football ligue 1", "podcast français", "interview française",
    "court métrage français", "dessin animé français", "pourquoi expliqué simplement",
]
FR_WORDS = {"le", "la", "les", "des", "une", "est", "pour", "avec", "dans", "qui", "sur", "pas", "mon",
            "je", "tu", "nous", "vous", "du", "au", "aux", "ce", "c'est", "j'ai", "quand", "comment", "pourquoi"}
CATEGORIES = {
    "Music": "musique", "Gaming": "divertissement", "Entertainment": "divertissement",
    "Film & Animation": "divertissement", "Comedy": "humour", "News & Politics": "actu",
    "Science & Technology": "science", "Education": "science", "Travel & Events": "aventure",
    "Sports": "aventure", "Pets & Animals": "nature", "Autos & Vehicles": "tech",
}

BASE_OPTS = {"quiet": True, "no_warnings": True, "skip_download": True, "ignoreerrors": False}
if env("YTDLP_COOKIEFILE"):
    BASE_OPTS["cookiefile"] = env("YTDLP_COOKIEFILE")
if env("YTDLP_PROXY"):
    BASE_OPTS["proxy"] = env("YTDLP_PROXY")

running = True


def stop(*_):
    global running
    running = False
    log.info("Arrêt demandé, fin du traitement en cours…")


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def sleep(sec):
    end = time.time() + sec
    while running and time.time() < end:
        time.sleep(min(1, end - time.time()))


class Backoff:
    """Pause croissante quand YouTube refuse en série (blocage IP, contrôle anti-bot)."""
    def __init__(self):
        self.fails = 0

    def ok(self):
        self.fails = 0

    def fail(self, err):
        self.fails += 1
        msg = str(err)
        if "confirm you" in msg or "429" in msg or self.fails >= 5:
            wait = min(3600, 60 * 2 ** min(self.fails, 6))
            log.warning("Échecs en série (%s), pause %d s : %s", self.fails, wait, msg[:160])
            r.set("worker:status", f"pause anti-blocage ({msg[:80]})", ex=wait + 60)
            sleep(wait)


backoff = Backoff()


# ---------- Sources ----------
def seed_sources():
    f = Path(__file__).with_name("sources.txt")
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                r.zadd("sources", {line: 0}, nx=True)
    log.info("%d sources en base", r.zcard("sources"))


def next_source():
    got = r.zrange("sources", 0, 0)
    return got[0] if got else None


# ---------- Extraction ----------
def list_entries(url, limit):
    opts = {**BASE_OPTS, "extract_flat": "in_playlist", "playlistend": limit}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    for e in (info.get("entries") or [])[:limit]:
        if e and len(e.get("id") or "") == 11:
            yield e


def fetch(vid):
    with YoutubeDL(BASE_OPTS) as ydl:
        return ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False) or {}


def store(vid, info):
    views = info.get("view_count") or 0
    cats = info.get("categories") or []
    data = {
        "title": info.get("title") or "",
        "channel": info.get("channel") or info.get("uploader") or "Chaîne inconnue",
        "views": views,
        "likes": info.get("like_count") if info.get("like_count") is not None else "",
        "category": CATEGORIES.get(cats[0], "autre") if cats else "autre",
        "year": (info.get("upload_date") or "")[:4],
        "updated": int(time.time()),
    }
    pipe = r.pipeline()
    pipe.hset(f"video:{vid}", mapping=data)
    pipe.zadd("videos:updated", {vid: data["updated"]})
    if views >= MIN_VIEWS:
        pipe.zadd("videos:by_views", {vid: views})
    else:
        pipe.zrem("videos:by_views", vid)
    pipe.execute()


def looks_french(text):
    """Heuristique pour les vidéos sans langue déclarée : mots-outils ou accents français."""
    words = {w.strip(".,!?:;()[]\"'«»").lower() for w in text.split()}
    return len(words & FR_WORDS) >= 2 or any(c in text for c in "éèêàçùœ")


def reject(vid, reason, days):
    r.set(f"rej:{vid}", reason, ex=days * 86400)


def examine(vid, flat_views, from_search):
    """Retourne True si la vidéo a été ajoutée."""
    if r.exists(f"video:{vid}") or r.exists(f"rej:{vid}"):
        return False
    if flat_views is not None and flat_views < MIN_VIEWS:
        reject(vid, "vues", 14)   # on repassera : elle peut dépasser le seuil plus tard
        return False
    try:
        info = fetch(vid)
        backoff.ok()
    except Exception as e:
        backoff.fail(e)
        reject(vid, "erreur", 1)
        return False
    finally:
        sleep(PAUSE)

    if info.get("live_status") in ("is_live", "is_upcoming"):
        reject(vid, "live", 2)
        return False
    lang = (info.get("language") or "").lower()
    if lang and not lang.startswith("fr"):
        reject(vid, "langue", 180)
        return False
    if (info.get("view_count") or 0) < MIN_VIEWS:
        reject(vid, "vues", 14)
        return False
    if from_search and not lang and not looks_french(f"{info.get('title', '')} {(info.get('description') or '')[:300]}"):
        # Recherche sans langue déclarée et texte qui ne ressemble pas à du français.
        reject(vid, "langue inconnue", 60)
        return False

    store(vid, info)
    log.info("+ %s vues  %s (%s)", f"{info.get('view_count'):,}", info.get("title", "")[:60], info.get("channel"))
    if DISCOVER and from_search and lang.startswith("fr") and info.get("channel_url"):
        if r.zcard("sources") < MAX_SOURCES:
            if r.zadd("sources", {info["channel_url"].rstrip("/") + "/videos": 0}, nx=True):
                log.info("  nouvelle chaîne découverte : %s", info.get("channel"))
    return True


def crawl(url, from_search=False):
    added = 0
    try:
        entries = list(list_entries(url, PER_SOURCE))
        backoff.ok()
    except Exception as e:
        log.warning("Source en échec %s : %s", url, str(e)[:160])
        backoff.fail(e)
        return 0
    for e in entries:
        if not running:
            break
        added += examine(e["id"], e.get("view_count"), from_search)
    return added


def refresh_stale():
    cutoff = time.time() - REFRESH_AGE
    for vid in r.zrangebyscore("videos:updated", "-inf", cutoff, start=0, num=REFRESH_BATCH):
        if not running:
            return
        try:
            info = fetch(vid)
            backoff.ok()
            store(vid, info)
        except Exception as e:
            msg = str(e)
            if "unavailable" in msg.lower() or "private" in msg.lower() or "removed" in msg.lower():
                # Vidéo supprimée : retirée du tirage, gardée dans les collections existantes.
                r.zrem("videos:by_views", vid)
                r.zrem("videos:updated", vid)
                log.info("- %s retirée (indisponible)", vid)
            else:
                backoff.fail(e)
                r.zadd("videos:updated", {vid: time.time() - REFRESH_AGE + 86400})  # réessai demain
        sleep(PAUSE)


def main():
    r.ping()
    seed_sources()
    while running:
        started = time.time()
        src = next_source()
        if src:
            r.zadd("sources", {src: time.time()})
            n = crawl(src, from_search=src.startswith("ytsearch"))
            log.info("Source %s : %d ajoutée(s)", src, n)
        if running:
            q = f"ytsearchdate{PER_SOURCE}:{random.choice(KEYWORDS)}"
            n = crawl(q, from_search=True)
            log.info("Recherche %s : %d ajoutée(s)", q, n)
        if running:
            refresh_stale()
        r.set("worker:heartbeat", int(time.time()))
        r.set("worker:status", "ok")
        log.info("Cycle terminé en %.0f s, %d vidéos jouables", time.time() - started, r.zcard("videos:by_views"))
        sleep(CYCLE_PAUSE)


if __name__ == "__main__":
    main()
