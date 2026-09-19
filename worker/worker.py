"""TubePacks, worker : alimente le jeu en vidéos YouTube françaises.

Moissons d'un cycle, de la plus rentable à la plus lente :
  1. tendances FR — des vidéos très vues, donc les cartes rares du jeu ;
  2. recherches par mots-clés, sur plusieurs pages et plusieurs tris ;
  3. flux RSS des chaînes validées — une requête par chaîne, directement chez YouTube ;
  4. vidéos recommandées récoltées au passage, mises en file pour le cycle suivant ;
  5. sources historiques (`sources.txt`, onglet Admin) via yt-dlp.
Puis l'enrichissement (catégorie, j'aime) et le rafraîchissement des vues.

Le volume vient des **listings** : une recherche Piped ou Invidious renvoie déjà titre,
chaîne, vues et date — de quoi créer la carte sans requête supplémentaire. Les appels
« une vidéo » sont réservés aux candidates dont on ignore les vues, et budgétés par cycle :
ces instances sont bénévoles, on ne les inonde pas. yt-dlp reste le filet de secours.
"""
import logging
import os
import random
import signal
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import redis
import requests

log = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

env = os.environ.get
MIN_VIEWS = int(env("MIN_VIEWS", "10000"))
CYCLE_PAUSE = float(env("CYCLE_PAUSE", "60"))
REFRESH_BATCH = int(env("REFRESH_BATCH", "40"))
REFRESH_AGE = int(env("REFRESH_DAYS", "7")) * 86400
MAX_CHANNELS = int(env("MAX_CHANNELS", "5000"))
MAX_RELATED = int(env("MAX_RELATED", "20000"))
DISCOVER = env("DISCOVER", "1") == "1"
MIN_SECONDS = int(env("MIN_SECONDS", "60"))            # écarte les Shorts

# Rythme des API publiques. Ce sont des instances bénévoles : rester modéré.
API_WORKERS = int(env("API_WORKERS", "4"))
API_PAUSE = float(env("API_PAUSE", "0.2"))             # pause entre deux essais d'instance
HTTP_TIMEOUT = float(env("HTTP_TIMEOUT", "12"))
DETAILS_PER_CYCLE = int(env("DETAILS_PER_CYCLE", "120"))  # requêtes « une vidéo » par cycle
ENRICH_PER_CYCLE = int(env("ENRICH_PER_CYCLE", "60"))     # complète catégorie et j'aime

KEYWORDS_PER_CYCLE = int(env("KEYWORDS_PER_CYCLE", "6"))
SEARCH_PAGES = int(env("SEARCH_PAGES", "3"))
CHANNELS_PER_CYCLE = int(env("CHANNELS_PER_CYCLE", "30"))
RELATED_PER_CYCLE = int(env("RELATED_PER_CYCLE", "60"))

# yt-dlp : secours quand aucune instance ne répond, et sources « ytsearch: » historiques.
USE_YTDLP = env("USE_YTDLP", "1") == "1"
PER_SOURCE = int(env("PER_SOURCE", "30"))
PAUSE = float(env("PAUSE", "2"))

# Ces listes vieillissent vite ; l'annuaire officiel Invidious complète au démarrage.
DEFAULT_INVIDIOUS = "https://invidious.f5.si,https://inv.nadeko.net,https://invidious.darkness.services"
DEFAULT_PIPED = ("https://api.piped.private.coffee,https://pipedapi.ducks.party,"
                 "https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de")
INSTANCE_DIRECTORY = env("INVIDIOUS_DIRECTORY", "https://api.invidious.io/instances.json")

r = redis.Redis(host=env("REDIS_HOST", "redis"), port=int(env("REDIS_PORT", "6379")),
                password=env("REDIS_PASSWORD") or None, decode_responses=True)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "TubePacks/2.0 (collectionneur de vidéos FR)"
SESSION.headers["Accept-Language"] = "fr-FR,fr;q=0.9"

KEYWORDS = [
    "vulgarisation scientifique", "histoire de france", "documentaire français", "clip rap français",
    "chanson française", "sketch humour français", "vlog france", "recette facile", "voyage en france",
    "let's play français", "tuto français", "actualité france", "astronomie expliquée",
    "nouvelle technologie expliquée", "football ligue 1", "podcast français", "interview française",
    "court métrage français", "dessin animé français", "pourquoi expliqué simplement",
    "reportage français", "conférence en français", "analyse film français", "critique jeu vidéo français",
    "cuisine du quotidien", "bricolage maison", "jardinage conseils", "musique électro française",
    "stand up français", "rétrospective années 90", "mythologie expliquée", "économie expliquée",
    "philosophie cours", "géopolitique analyse", "physique expliquée", "biologie animaux",
    "programmation informatique français", "intelligence artificielle expliquée", "espace fusée",
    "histoire de l'art", "médecine expliquée", "psychologie expliquée", "droit expliqué",
    "essai voiture français", "essai moto", "randonnée montagne", "pêche en rivière",
    "jazz manouche", "rock français", "métal français", "reggae français", "variété française",
    "danse hip hop", "tour de magie", "escape game", "défi impossible", "expérience sociale",
    "test produit français", "unboxing français", "récap actu semaine", "débat société",
    "témoignage histoire vraie", "découverte métier", "révisions bac", "cours de maths",
    "entraînement sportif", "conseils musculation", "yoga débutant", "course à pied conseils",
    "visite château", "voyage en train", "aviation avion", "bateau voile", "chasse au trésor",
    "animaux sauvages documentaire", "océan documentaire", "volcan documentaire", "climat expliqué",
]
# Mots-outils très fréquents en français, rares dans les autres langues latines.
FR_WORDS = {
    "le", "la", "les", "des", "une", "un", "est", "pour", "avec", "dans", "qui", "que", "sur", "pas",
    "mon", "ma", "mes", "je", "tu", "il", "elle", "nous", "vous", "ils", "du", "au", "aux", "ce", "cette",
    "c'est", "j'ai", "quand", "comment", "pourquoi", "toujours", "jamais", "aussi", "plus", "moins",
    "très", "tout", "tous", "toute", "faire", "fait", "être", "avoir", "sont", "était", "chez", "sans",
    "mais", "donc", "alors", "après", "avant", "encore", "vraiment", "voilà", "ici", "leur", "notre",
    "on", "se", "ne", "en", "par", "ses", "son", "sa", "quoi", "quel", "quelle", "meilleur", "nouveau",
}
FR_CHARS = "çœèêàùâîôëïÉÈÊÀÇÙ"
CATEGORIES = {
    "Music": "musique", "Gaming": "divertissement", "Entertainment": "divertissement",
    "Film & Animation": "divertissement", "Comedy": "humour", "News & Politics": "actu",
    "Science & Technology": "science", "Education": "science", "Travel & Events": "aventure",
    "Sports": "aventure", "Pets & Animals": "nature", "Autos & Vehicles": "tech",
    "People & Blogs": "autre", "Howto & Style": "autre", "Nonprofits & Activism": "actu",
}

running = True
stats = {}
stats_lock = threading.Lock()
budget = 0
budget_lock = threading.Lock()


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


def bump(key, n=1):
    with stats_lock:
        stats[key] = stats.get(key, 0) + n


def take_budget():
    """Un jeton de requête « une vidéo ». Épuisé, la candidate est remise à plus tard."""
    global budget
    with budget_lock:
        if budget <= 0:
            return False
        budget -= 1
        return True


# ---------- Instances publiques ----------
class Endpoint:
    """Une instance Invidious ou Piped, mise au repos quand elle enchaîne les échecs."""
    def __init__(self, kind, base):
        self.kind = kind
        self.base = base.rstrip("/")
        self.fails = 0
        self.until = 0.0

    def ready(self):
        return self.until < time.time()

    def won(self):
        self.fails = 0

    def lost(self):
        self.fails += 1
        self.until = time.time() + min(1800, 20 * 2 ** min(self.fails, 6))

    def json(self, path, params=None):
        resp = SESSION.get(self.base + path, params=params, timeout=HTTP_TIMEOUT)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}")
        return resp.json()


def build_pool():
    eps = [Endpoint("invidious", u) for u in env("INVIDIOUS_INSTANCES", DEFAULT_INVIDIOUS).split(",") if u.strip()]
    eps += [Endpoint("piped", u) for u in env("PIPED_INSTANCES", DEFAULT_PIPED).split(",") if u.strip()]
    return eps


POOL = build_pool()


def call(fn, kinds=None, tries=4):
    """Exécute fn(endpoint) sur les instances disponibles jusqu'à obtenir un résultat."""
    usable = [e for e in POOL if kinds is None or e.kind in kinds]
    ready = [e for e in usable if e.ready()] or usable
    # Tirage au sort, mais les instances les plus fiables d'abord : on cesse vite
    # de retomber sur celles qui viennent d'échouer.
    random.shuffle(ready)
    ready.sort(key=lambda e: e.fails)
    for e in ready[:tries]:
        if not running:
            return None
        try:
            out = fn(e)
            e.won()
            if out:
                bump("api_ok")
                return out
        except Exception as exc:
            e.lost()
            bump("api_fail")
            log.debug("%s (%s) : %s", e.base, e.kind, str(exc)[:120])
        time.sleep(API_PAUSE)
    return None


# ---------- Normalisation des réponses ----------
def _int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _piped_id(url):
    return (url or "").rsplit("v=", 1)[-1][:11]


def _piped_ucid(url):
    return (url or "").rsplit("/", 1)[-1]


def _year(ts):
    try:
        return time.strftime("%Y", time.gmtime(int(ts)))
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def entries_from(ep, data):
    """Listing hétérogène -> [{id, title, channel, channel_id, views, description, year, seconds}].

    Assez complet pour créer une carte sans requête supplémentaire.
    """
    if isinstance(data, dict):
        data = data.get("videos") or data.get("items") or data.get("relatedStreams") or []
    out = []
    for e in data or []:
        if not isinstance(e, dict) or e.get("liveNow") or e.get("isUpcoming") or e.get("isShort"):
            continue
        if ep.kind == "invidious":
            vid, chan_id = e.get("videoId"), e.get("authorId")
            title, chan, views = e.get("title"), e.get("author"), e.get("viewCount")
            desc, seconds = e.get("description") or "", _int(e.get("lengthSeconds"))
            year = _year(e.get("published"))
        else:
            vid, chan_id = _piped_id(e.get("url")), _piped_ucid(e.get("uploaderUrl"))
            title, chan, views = e.get("title"), e.get("uploaderName"), e.get("views")
            desc, seconds = e.get("shortDescription") or "", _int(e.get("duration"))
            year = _year(_int(e.get("uploaded")) // 1000) if e.get("uploaded") else ""
        if not vid or len(vid) != 11 or (seconds and seconds < MIN_SECONDS):
            continue
        out.append({"id": vid, "title": title or "", "channel": chan or "", "channel_id": chan_id or "",
                    "views": _int(views), "description": desc[:400], "year": year, "seconds": seconds})
    return out


def detail_from(ep, d):
    """Réponse « une vidéo » -> dictionnaire commun, ou None si inexploitable."""
    if not isinstance(d, dict) or d.get("error") or not d.get("title"):
        return None
    if ep.kind == "invidious":
        caps = [(c.get("languageCode") or c.get("language_code") or "").lower()
                for c in (d.get("captions") or [])]
        return {
            "title": d["title"], "channel": d.get("author") or "", "channel_id": d.get("authorId") or "",
            "views": _int(d.get("viewCount")), "likes": _int(d.get("likeCount")) or None,
            "genre": d.get("genre") or "", "description": (d.get("description") or "")[:400],
            "captions": caps, "year": _year(d.get("published")),
            "live": bool(d.get("liveNow") or d.get("isUpcoming")),
            "seconds": _int(d.get("lengthSeconds")),
            "related": [v.get("videoId") for v in (d.get("recommendedVideos") or [])],
        }
    caps = [(c.get("code") or "").lower() for c in (d.get("subtitles") or [])]
    return {
        "title": d["title"], "channel": d.get("uploader") or "",
        "channel_id": _piped_ucid(d.get("uploaderUrl")), "views": _int(d.get("views")),
        "likes": _int(d.get("likes")) or None, "genre": d.get("category") or "",
        "description": (d.get("description") or "")[:400], "captions": caps,
        "year": (d.get("uploadDate") or "")[:4], "live": bool(d.get("livestream")),
        "seconds": _int(d.get("duration")),
        "related": [_piped_id(v.get("url")) for v in (d.get("relatedStreams") or [])],
    }


# ---------- Appels ----------
def api_trending(region="FR", kind=None):
    def fn(ep):
        params = {"region": region}
        if ep.kind == "invidious":
            if kind:
                params["type"] = kind
            return entries_from(ep, ep.json("/api/v1/trending", params))
        return entries_from(ep, ep.json("/trending", params))
    return call(fn) or []


def api_search(q, page=1, sort="relevance"):
    def fn(ep):
        if ep.kind == "invidious":
            return entries_from(ep, ep.json("/api/v1/search", {
                "q": q, "page": page, "type": "video", "region": "FR", "hl": "fr", "sort_by": sort}))
        if page > 1:          # Piped pagine par jeton : on ne prend que la première page
            return None
        return entries_from(ep, ep.json("/search", {"q": q, "filter": "videos"}))
    return call(fn) or []


def api_channel(ucid):
    def fn(ep):
        if ep.kind == "invidious":
            return entries_from(ep, ep.json(f"/api/v1/channels/{ucid}/videos"))
        return entries_from(ep, ep.json(f"/channel/{ucid}"))
    return call(fn) or []


def api_detail(vid):
    def fn(ep):
        path = f"/api/v1/videos/{vid}" if ep.kind == "invidious" else f"/streams/{vid}"
        return detail_from(ep, ep.json(path))
    return call(fn, tries=3)


RSS_NS = {"a": "http://www.w3.org/2005/Atom",
          "yt": "http://www.youtube.com/xml/schemas/2015",
          "media": "http://search.yahoo.com/mrss/"}


def rss_channel(ucid):
    """Flux RSS officiel d'une chaîne : ses 15 dernières vidéos, sans instance tierce."""
    try:
        resp = SESSION.get("https://www.youtube.com/feeds/videos.xml",
                           params={"channel_id": ucid}, timeout=HTTP_TIMEOUT)
        if resp.status_code != 200:
            return []
        root = ET.fromstring(resp.content)
    except Exception as exc:
        log.debug("RSS %s : %s", ucid, str(exc)[:100])
        return []
    out = []
    for entry in root.findall("a:entry", RSS_NS):
        vid = entry.findtext("yt:videoId", "", RSS_NS)
        if len(vid) != 11:
            continue
        group = entry.find("media:group", RSS_NS)
        stat = entry.find("media:group/media:community/media:statistics", RSS_NS)
        out.append({
            "id": vid,
            "title": entry.findtext("a:title", "", RSS_NS),
            "channel": entry.findtext("a:author/a:name", "", RSS_NS),
            "channel_id": ucid,
            "views": _int(stat.get("views")) if stat is not None else 0,
            "description": (group.findtext("media:description", "", RSS_NS) if group is not None else "")[:400],
            "year": entry.findtext("a:published", "", RSS_NS)[:4],
            "seconds": 0,
        })
    return out


# ---------- Filtres ----------
def looks_french(text):
    """Vrai si le texte porte assez de marqueurs français (mots-outils, lettres propres au français)."""
    if not text:
        return False
    words = {w.strip(".,!?:;()[]\"'«»…-–|").lower() for w in text.split()}
    hits = len(words & FR_WORDS)
    return hits >= 2 or (hits >= 1 and any(c in text for c in FR_CHARS))


def french_score(d):
    """Faisceau d'indices plutôt qu'un test unique : la langue est rarement déclarée."""
    if d.get("lang"):                       # yt-dlp a lu la langue déclarée : elle tranche
        return 9 if d["lang"].startswith("fr") else -9
    score = 0
    caps = d.get("captions") or []
    if any(c.startswith("fr") for c in caps):
        score += 2 if len(caps) <= 6 else 1
    if looks_french(d.get("title", "")):
        score += 2
    if looks_french(d.get("description", "")):
        score += 1
    if looks_french(d.get("channel", "")):
        score += 1
    # Chaîne déjà validée comme francophone : ses autres vidéos le sont presque toujours.
    if d.get("channel_id") and r.zscore("channels", d["channel_id"]) is not None:
        score += 2
    return score


def reject(vid, reason, days):
    r.set(f"rej:{vid}", reason, ex=days * 86400)


def store(vid, d):
    """Écrit la carte. Sans catégorie connue, la vidéo part en file d'enrichissement."""
    views = d["views"]
    genre = d.get("genre") or ""
    now = int(time.time())
    pipe = r.pipeline()
    pipe.hset(f"video:{vid}", mapping={
        "title": d["title"], "channel": d.get("channel") or "Chaîne inconnue", "views": views,
        "likes": d["likes"] if d.get("likes") else "",
        "category": CATEGORIES.get(genre, "autre"),
        "year": d.get("year") or "", "updated": now,
    })
    pipe.zadd("videos:updated", {vid: now})
    if views >= MIN_VIEWS:
        pipe.zadd("videos:by_views", {vid: views})
    else:
        pipe.zrem("videos:by_views", vid)
    if not genre:
        pipe.sadd("queue:enrich", vid)
    pipe.execute()


def remember_channel(ucid):
    """Chaîne d'une vidéo validée : ses prochaines vidéos arriveront toutes seules par RSS."""
    if DISCOVER and ucid.startswith("UC") and len(ucid) == 24:
        if r.zcard("channels") < MAX_CHANNELS and r.zadd("channels", {ucid: 0}, nx=True):
            bump("channels")


def remember_related(ids):
    """Les recommandations voyagent avec le détail : découverte gratuite pour le cycle suivant."""
    ids = [v for v in ids if v and len(v) == 11]
    if ids and DISCOVER and r.scard("queue:related") < MAX_RELATED:
        r.sadd("queue:related", *ids)


# ---------- Ingestion ----------
def unseen(entries):
    """Retire les vidéos déjà connues ou déjà rejetées, en une seule série de requêtes."""
    uniq, seen = [], set()
    for e in entries:
        if e["id"] not in seen:
            seen.add(e["id"])
            uniq.append(e)
    if not uniq:
        return []
    pipe = r.pipeline()
    for e in uniq:
        pipe.exists(f"video:{e['id']}")
        pipe.exists(f"rej:{e['id']}")
    res = pipe.execute()
    return [e for i, e in enumerate(uniq) if not res[2 * i] and not res[2 * i + 1]]


def consider(e, detail=True):
    """Une candidate : filtres, appel de détail seulement si nécessaire et autorisé."""
    if not running:
        return False
    vid = e["id"]
    views = e.get("views", 0)
    if 0 < views < MIN_VIEWS:
        reject(vid, "vues", 14)       # elle repassera : elle peut franchir le seuil plus tard
        bump("low")
        return False

    if views >= MIN_VIEWS and e.get("title"):
        # Le listing suffit : la carte est jouable tout de suite, la catégorie viendra ensuite.
        d = dict(e, likes=None, genre="", captions=[], live=False, related=[])
        bump("from_listing")
    elif not detail:
        # Vues inconnues sur une moisson peu fiable (tendances, recherches) : ce sont presque
        # toujours des directs ou des vidéos indisponibles. On ne gaspille pas une requête.
        bump("ignore")
        return False
    elif not take_budget():
        remember_related([vid])       # budget épuisé : on la reverra au prochain cycle
        bump("reporte")
        return False
    else:
        d = api_detail(vid) or ytdlp_detail(vid)
        if not d:
            reject(vid, "introuvable", 1)
            return False
        if d.get("live"):
            reject(vid, "live", 2)
            return False
        if d.get("seconds") and d["seconds"] < MIN_SECONDS:
            reject(vid, "short", 180)
            return False
        if d["views"] < MIN_VIEWS:
            reject(vid, "vues", 14)
            bump("low")
            return False

    if french_score(d) < 2:
        reject(vid, "pas français", 60)
        bump("foreign")
        return False

    store(vid, d)
    remember_channel(d.get("channel_id") or "")
    remember_related(d.get("related") or [])
    bump("added")
    log.info("+ %s vues  %s (%s)", f"{d['views']:,}".replace(",", " "), d["title"][:60], d.get("channel"))
    return True


def ingest(entries, label, detail=True):
    """Traite un lot de candidates en parallèle et journalise le rendement de la moisson.

    `detail` autorise les requêtes « une vidéo » : réservé aux moissons qui les méritent
    (chaînes validées, recommandations), pas aux listings déjà complets.
    """
    fresh = unseen(entries)
    if not fresh:
        log.info("%s : %d vue(s), rien de neuf", label, len(entries))
        return 0
    with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
        added = sum(pool.map(lambda e: consider(e, detail), fresh))
    log.info("%s : %d vue(s), %d nouvelle(s), %d ajoutée(s)", label, len(entries), len(fresh), added)
    return added


# ---------- yt-dlp : secours et sources historiques ----------
_ydl = None


def ytdlp():
    global _ydl
    if _ydl is None:
        from yt_dlp import YoutubeDL
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "ignoreerrors": False}
        if env("YTDLP_COOKIEFILE"):
            opts["cookiefile"] = env("YTDLP_COOKIEFILE")
        if env("YTDLP_PROXY"):
            opts["proxy"] = env("YTDLP_PROXY")
        _ydl = (YoutubeDL, opts)
    return _ydl


def ytdlp_detail(vid):
    """Secours quand aucune instance publique ne répond."""
    if not USE_YTDLP:
        return None
    try:
        YoutubeDL, opts = ytdlp()
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False) or {}
    except Exception as exc:
        log.debug("yt-dlp %s : %s", vid, str(exc)[:120])
        return None
    finally:
        time.sleep(PAUSE)
    cats = info.get("categories") or []
    return {
        "title": info.get("title") or "", "channel": info.get("channel") or info.get("uploader") or "",
        "channel_id": info.get("channel_id") or "", "views": _int(info.get("view_count")),
        "likes": info.get("like_count"), "genre": cats[0] if cats else "",
        "description": (info.get("description") or "")[:400],
        "captions": list(info.get("subtitles") or {}),
        "lang": (info.get("language") or "").lower(),
        "year": (info.get("upload_date") or "")[:4],
        "live": info.get("live_status") in ("is_live", "is_upcoming"),
        "seconds": _int(info.get("duration")),
        "related": [],
    }


def ytdlp_list(url, limit):
    YoutubeDL, opts = ytdlp()
    with YoutubeDL({**opts, "extract_flat": "in_playlist", "playlistend": limit}) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    out = []
    for e in (info.get("entries") or [])[:limit]:
        if e and len(e.get("id") or "") == 11:
            out.append({"id": e["id"], "title": e.get("title") or "", "channel": e.get("channel") or "",
                        "channel_id": e.get("channel_id") or "", "views": _int(e.get("view_count")),
                        "description": "", "year": "", "seconds": _int(e.get("duration"))})
    return out


def seed_sources():
    f = Path(__file__).with_name("sources.txt")
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                r.zadd("sources", {line: 0}, nx=True)
    log.info("%d source(s), %d chaîne(s) suivie(s), %d recommandation(s) en file",
             r.zcard("sources"), r.zcard("channels"), r.scard("queue:related"))


# ---------- Moissons ----------
def harvest_trending():
    entries = []
    for kind in (None, "Music", "Gaming"):
        entries += api_trending("FR", kind)
        if not running:
            break
    return ingest(entries, "Tendances FR", detail=False) if entries else 0


def harvest_search():
    added = 0
    for q in random.sample(KEYWORDS, min(KEYWORDS_PER_CYCLE, len(KEYWORDS))):
        if not running:
            break
        entries = []
        for page in range(1, SEARCH_PAGES + 1):
            entries += api_search(q, page, random.choice(["relevance", "upload_date", "view_count"]))
        if entries:
            added += ingest(entries, f"Recherche « {q} »", detail=False)
    return added


def harvest_channels():
    """Flux RSS des chaînes validées : la moisson la moins chère en requêtes."""
    ucids = r.zrange("channels", 0, CHANNELS_PER_CYCLE - 1)
    if not ucids:
        return 0
    r.zadd("channels", {u: time.time() for u in ucids})
    entries = []
    with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
        for got in pool.map(rss_channel, ucids):
            entries += got
    if not entries:                     # flux muets : on tente l'API sur quelques chaînes
        for ucid in ucids[:3]:
            entries += api_channel(ucid)
    return ingest(entries, f"{len(ucids)} chaîne(s) suivie(s)") if entries else 0


def harvest_related():
    """Vide une part de la file des recommandations, dans la limite du budget de requêtes."""
    ids = []
    for _ in range(min(RELATED_PER_CYCLE, max(0, budget))):
        got = r.spop("queue:related")
        if not got:
            break
        ids.append(got)
    if not ids:
        return 0
    return ingest([{"id": v, "views": 0, "title": "", "channel_id": ""} for v in ids],
                  f"{len(ids)} recommandation(s)")


def harvest_source():
    """Une source historique du fichier ou de l'onglet Admin (chaîne, playlist, `ytsearch:`)."""
    if not USE_YTDLP:
        return 0
    got = r.zrange("sources", 0, 0)
    if not got:
        return 0
    url = got[0]
    r.zadd("sources", {url: time.time()})
    try:
        entries = ytdlp_list(url, PER_SOURCE)
    except Exception as exc:
        log.warning("Source en échec %s : %s", url, str(exc)[:140])
        return 0
    return ingest(entries, f"Source {url}") if entries else 0


def enrich():
    """Complète catégorie et j'aime des vidéos entrées par un simple listing."""
    vids = [v for v in (r.spop("queue:enrich") for _ in range(ENRICH_PER_CYCLE)) if v]
    if not vids:
        return 0

    def one(vid):
        if not running or not take_budget():
            r.sadd("queue:enrich", vid)
            return 0
        d = api_detail(vid)
        if not d:
            return 0
        # Contrôle qualité différé : ce qu'un listing ne disait pas encore.
        if d.get("live") or (d.get("seconds") and d["seconds"] < MIN_SECONDS):
            r.zrem("videos:by_views", vid)
            r.zrem("videos:updated", vid)
            r.delete(f"video:{vid}")
            reject(vid, "live/short", 180)
            return 0
        if not d.get("genre"):
            return 0
        store(vid, d)
        remember_related(d.get("related") or [])
        return 1

    with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
        done = sum(pool.map(one, vids))
    log.info("Enrichissement : %d/%d vidéo(s) complétée(s)", done, len(vids))
    return done


def refresh_stale():
    """Remet à jour vues et j'aime : les cartes des joueurs évoluent sans qu'ils fassent rien."""
    vids = r.zrangebyscore("videos:updated", "-inf", time.time() - REFRESH_AGE, start=0, num=REFRESH_BATCH)
    if not vids:
        return 0

    def one(vid):
        if not running:
            return 0
        d = api_detail(vid) or ytdlp_detail(vid)
        if not d:
            # Vidéo supprimée ou privée : retirée du tirage, conservée dans les collections.
            r.zrem("videos:by_views", vid)
            r.zrem("videos:updated", vid)
            log.info("- %s retirée (indisponible)", vid)
            return 0
        store(vid, d)
        return 1

    with ThreadPoolExecutor(max_workers=API_WORKERS) as pool:
        done = sum(pool.map(one, vids))
    log.info("Rafraîchissement : %d/%d vidéo(s)", done, len(vids))
    return done


# ---------- Instances ----------
def refresh_directory():
    """Complète la liste via l'annuaire officiel Invidious : les instances vont et viennent."""
    if not INSTANCE_DIRECTORY or env("INVIDIOUS_INSTANCES"):
        return
    try:
        listing = SESSION.get(INSTANCE_DIRECTORY, timeout=HTTP_TIMEOUT).json()
    except Exception as exc:
        log.info("Annuaire injoignable (%s), on garde la liste par défaut", str(exc)[:80])
        return
    known = {e.base for e in POOL}
    found = 0
    for item in listing or []:
        try:
            info = item[1]
        except (TypeError, IndexError):
            continue
        # On ne retient que le HTTPS dont l'API publique est réellement ouverte.
        if isinstance(info, dict) and info.get("type") == "https" and info.get("api") and info.get("uri"):
            base = info["uri"].rstrip("/")
            if base not in known:
                POOL.append(Endpoint("invidious", base))
                known.add(base)
                found += 1
    if found:
        log.info("Annuaire : %d instance(s) Invidious ajoutée(s)", found)


def probe():
    """Sonde chaque instance sur un vrai endpoint de données : beaucoup répondent encore
    sur /stats tout en ayant fermé leur API (401/403)."""
    def test(e):
        try:
            path = "/api/v1/trending?region=FR" if e.kind == "invidious" else "/trending?region=FR"
            if not e.json(path):
                raise RuntimeError("réponse vide")
            e.won()
            return e
        except Exception:
            e.lost()
            return None

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(POOL)))) as pool:
        alive = [e.base for e in pool.map(test, list(POOL)) if e]
    if alive:
        log.info("%d/%d instance(s) exploitables : %s", len(alive), len(POOL), ", ".join(alive))
    else:
        log.warning("Aucune instance Invidious/Piped exploitable : repli sur yt-dlp, bien plus lent. "
                    "Renseigne INVIDIOUS_INSTANCES / PIPED_INSTANCES avec des instances à jour.")
    return alive


def main():
    global budget
    r.ping()
    seed_sources()
    refresh_directory()
    probe()
    cycle = 0
    while running:
        started = time.time()
        cycle += 1
        with stats_lock:
            stats.clear()
        with budget_lock:
            budget = DETAILS_PER_CYCLE

        added = 0
        for step in (harvest_trending, harvest_search, harvest_channels, harvest_related, harvest_source):
            if not running:
                break
            added += step()
        if running:
            enrich()
        if running:
            refresh_stale()
        if cycle % 60 == 0:             # les instances vont et viennent : on refait le point
            refresh_directory()
            probe()

        playable = r.zcard("videos:by_views")
        with stats_lock:
            snapshot = dict(stats)
        alive = sum(1 for e in POOL if e.ready())
        r.set("worker:heartbeat", int(time.time()))
        r.set("worker:status", "ok" if snapshot.get("api_ok") or added else "aucune source ne répond")
        r.hset("worker:stats", mapping={
            "cycle": cycle, "added": added, "playable": playable,
            "channels": r.zcard("channels"), "queued": r.scard("queue:related"),
            "to_enrich": r.scard("queue:enrich"), "seconds": int(time.time() - started),
            "low_views": snapshot.get("low", 0), "foreign": snapshot.get("foreign", 0),
            "api_ok": snapshot.get("api_ok", 0), "api_fail": snapshot.get("api_fail", 0),
            "instances": alive,
        })
        log.info("Cycle %d en %.0f s : +%d vidéo(s), %d jouables, %d chaîne(s), %d en file, %d instance(s)",
                 cycle, time.time() - started, added, playable, r.zcard("channels"),
                 r.scard("queue:related"), alive)
        sleep(CYCLE_PAUSE)


if __name__ == "__main__":
    main()
