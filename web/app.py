"""TubePacks, serveur web : comptes, packs, collection, hôtel des ventes, profils, administration.

Stockage Redis
  video:{id}          hash   title, channel, views, likes, category, year
  videos:by_views     zset   id -> vues (index des vidéos jouables, >= MIN_VIEWS)
  user:{name}         hash   pw, display, created, packs, coins, tickets, ticket_at, bio, avatar, banned
  users               set    noms des comptes
  admins              set    noms des administrateurs
  coll:{name}         hash   id -> nombre d'exemplaires
  session:{sha256}    string nom d'utilisateur (TTL)
  settings            hash   réglages modifiables par les admins (voir DEFAULTS)
  auction:{id}        hash   vid, seller, price, start, bidder, nbids, ends, created, status
  auctions:live       zset   id -> fin (enchères en cours)
  auctions:done       zset   id -> clôture (historique, taillé)
  seller:{name}       set    enchères en cours de ce vendeur
  bids:{name}         zset   enchères sur lesquelles ce joueur a misé
  hist:{name}         zset   enchères où le joueur est impliqué (vente, mise, achat)
  notif:{name}        list   notifications JSON (30 dernières)
"""
import asyncio
import hashlib
import unicodedata
import json
import logging
import os
import random
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

import redis.asyncio as aioredis
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import lua

log = logging.getLogger("web")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
REDIS_PASSWORD = os.environ.get("REDIS_PASSWORD") or None
INVITE_CODE = os.environ.get("INVITE_CODE", "")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"
MIN_VIEWS = int(os.environ.get("MIN_VIEWS", "10000"))
ADMIN_USERS = [n.strip().lower() for n in os.environ.get("ADMIN_USERS", "EIRBLAST").split(",") if n.strip()]
SESSION_TTL = 60 * 60 * 24 * 30
PACK_SIZE = 5
COOKIE = "tp_session"
STATIC = Path(__file__).parent / "static"

# Réglages modifiables à chaud par un administrateur (hash Redis « settings »).
DEFAULTS = {
    "pack_interval": 600,   # secondes entre deux tickets de pack offerts
    "pack_max": 12,         # tickets accumulables au maximum
    "pack_price": 250,      # prix d'un pack acheté en pièces
    "pack_bonus": 20,       # pièces offertes à chaque ouverture
    "start_coins": 500,     # pièces à l'inscription
    "start_tickets": 3,     # tickets à l'inscription
    "fee": 5,               # commission de l'hôtel des ventes, en %
    "bid_step": 5,          # surenchère minimale, en % du prix courant
    "anti_snipe": 60,       # une mise dans les N dernières secondes prolonge d'autant
    "max_listings": 10,     # ventes simultanées par joueur
    "signups": 1,           # 0 ferme les inscriptions
    "bot_check": 60,        # packs entre deux vérifications anti-robot (0 désactive)
    "guild_cost": 1000,     # pièces pour fonder une guilde
    "guild_max": 20,        # membres par guilde
    "guild_rate": 10,       # pièces du trésor pour 1 point d'expérience
    "guild_bonus": 3,       # % de pièces en plus par niveau de guilde
}

# (clé, nom, vues min, poids de tirage en %, valeur de recyclage en pièces)
# Une mythique tombe une fois sur mille cartes, soit environ un pack sur deux cents.
TIERS = [
    ("M", "Mythique", 100_000_000, 0.1, 6000),
    ("L", "Légendaire", 10_000_000, 0.9, 1200),
    ("E", "Épique", 1_000_000, 4, 200),
    ("R", "Rare", 100_000, 16, 30),
    ("C", "Commune", 0, 79, 5),
]
TIER_VALUE = {k: v for k, _, _, _, v in TIERS}
DURATIONS = {"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400}
AVATARS = ["🎴", "🍿", "🎬", "🎧", "🕹️", "🚀", "🦊", "🐙", "🐧", "🦉", "🌵", "🍉", "⚡", "🔮", "🎯", "👑"]
EMBLEMS = ["🛡️", "⚔️", "🏆", "🔥", "🌊", "🌙", "☄️", "🐉", "🦅", "🐺", "🍀", "💎", "🎪", "🧭", "⚓", "🎻"]
KOFI = os.environ.get("KOFI_URL", "https://ko-fi.com/eirblast")
GUILD_MAX_LEVEL = 20
GUILD_NAME_RE = re.compile(r"^[\w \-'À-ÿ]{3,24}$", re.UNICODE)
GUILD_TAG_RE = re.compile(r"^[A-Za-z0-9]{2,5}$")


def guild_level(xp):
    """Niveau atteint et expérience du palier suivant (paliers : 25·n·(n+1))."""
    lvl = 0
    while lvl < GUILD_MAX_LEVEL and xp >= 25 * (lvl + 1) * (lvl + 2):
        lvl += 1
    nxt = None if lvl >= GUILD_MAX_LEVEL else 25 * (lvl + 1) * (lvl + 2)
    return lvl, nxt

r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True)
ph = PasswordHasher()
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_-]{3,24}$")

sc_accrue = r.register_script(lua.ACCRUE)
sc_spend = r.register_script(lua.SPEND_TICKET)
sc_buy = r.register_script(lua.BUY_TICKET)
sc_recycle = r.register_script(lua.RECYCLE)
sc_list = r.register_script(lua.LIST_AUCTION)
sc_bid = r.register_script(lua.BID)
sc_settle = r.register_script(lua.SETTLE)
sc_cancel = r.register_script(lua.CANCEL)
sc_adjust = r.register_script(lua.ADJUST)
sc_gcreate = r.register_script(lua.GUILD_CREATE)
sc_gjoin = r.register_script(lua.GUILD_JOIN)
sc_gleave = r.register_script(lua.GUILD_LEAVE)
sc_gdonate = r.register_script(lua.GUILD_DONATE)
sc_ginvest = r.register_script(lua.GUILD_INVEST)
sc_gdisband = r.register_script(lua.GUILD_DISBAND)
sc_gxp = r.register_script(lua.GUILD_XP)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    for name in ADMIN_USERS:
        await r.sadd("admins", name)
    if ADMIN_USERS:
        log.info("Administrateurs par défaut : %s", ", ".join(ADMIN_USERS))
    task = asyncio.create_task(settler_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' https://i.ytimg.com data:; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp


# ---------- Réglages ----------
async def settings() -> dict:
    stored = await r.hgetall("settings")
    out = dict(DEFAULTS)
    for k, v in stored.items():
        if k in DEFAULTS:
            try:
                out[k] = int(v)
            except ValueError:
                pass
    return out


async def invite_code() -> str:
    return await r.hget("settings", "invite") or INVITE_CODE


# ---------- Utilitaires ----------
def tier_bounds(min_views):
    """Paliers jouables pour un seuil : [(clé, nom, bas, haut|None, poids)]."""
    out, upper = [], None
    for k, name, tmin, w, _ in TIERS:
        lo = max(tmin, min_views)
        if upper is None or lo < upper:
            out.append((k, name, lo, upper, w))
        upper = tmin
    return out


TIER_RANGES = tier_bounds(MIN_VIEWS)


def score_range(lo, hi):
    return lo, (f"({hi}" if hi is not None else "+inf")


def tier_key(views):
    return next(k for k, _, tmin, _, _ in TIERS if views >= tmin)


def card(vid, h):
    views = int(h.get("views") or 0)
    likes = h.get("likes")
    return {
        "id": vid, "title": h.get("title", ""), "channel": h.get("channel", ""),
        "views": views, "likes": int(likes) if likes not in (None, "") else None,
        "category": h.get("category") or "autre", "year": h.get("year") or "",
        "tier": tier_key(views),
    }


async def cards_for(ids):
    """{id: carte} pour une liste d'identifiants (les vidéos disparues sont omises)."""
    ids = list(dict.fromkeys(ids))
    if not ids:
        return {}
    pipe = r.pipeline()
    for vid in ids:
        pipe.hgetall(f"video:{vid}")
    return {vid: card(vid, h) for vid, h in zip(ids, await pipe.execute()) if h}


_power: dict[str, tuple[float, int]] = {}


async def power_of(user, fresh=False):
    """Puissance : total des vues des cartes uniques d'une collection (hors liste noire)."""
    hit = _power.get(user)
    if hit and not fresh and time.time() - hit[0] < 60:
        return hit[1]
    ids = await r.hkeys(f"coll:{user}")
    total = 0
    for i in range(0, len(ids), 500):
        scores = await r.zmscore("videos:by_views", ids[i:i + 500])
        total += sum(int(v) for v in scores if v)
    _power[user] = (time.time(), total)
    return total


def client_ip(request: Request):
    # uvicorn tourne avec --proxy-headers : client.host est déjà l'IP réelle derrière le proxy.
    return request.client.host if request.client else "?"


async def rate_limit(key, limit, window):
    n = await r.incr(key)
    if n == 1:
        await r.expire(key, window)
    if n > limit:
        raise HTTPException(429, "Trop de tentatives, réessaie dans quelques minutes.")


def session_key(token):
    return "session:" + hashlib.sha256(token.encode()).hexdigest()


async def start_session(resp: Response, username):
    token = secrets.token_urlsafe(32)
    await r.set(session_key(token), username, ex=SESSION_TTL)
    resp.set_cookie(COOKIE, token, max_age=SESSION_TTL, httponly=True, secure=COOKIE_SECURE, samesite="lax")


async def current_user(request: Request) -> str:
    token = request.cookies.get(COOKIE)
    user = await r.get(session_key(token)) if token else None
    if not user:
        raise HTTPException(401, "Non connecté")
    if await r.hget(f"user:{user}", "banned") == "1":
        raise HTTPException(403, "Ce compte est suspendu.")
    now = time.time()
    if now - _seen.get(user, 0) > 60:          # une écriture par minute et par joueur, pas plus
        _seen[user] = now
        await r.set(f"seen:{user}", int(now), ex=30 * 86400)
    return user


_seen: dict[str, float] = {}


async def optional_user(request: Request):
    try:
        return await current_user(request)
    except HTTPException:
        return None


async def require_admin(user=Depends(current_user)) -> str:
    if not await r.sismember("admins", user):
        raise HTTPException(403, "Réservé aux administrateurs.")
    return user


def require_json(request: Request):
    # Bloque les formulaires cross-site : ils ne peuvent pas envoyer du JSON sans préflight CORS.
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, "JSON attendu")


async def notify(user, kind, text):
    pipe = r.pipeline()
    pipe.lpush(f"notif:{user}", json.dumps({"t": int(time.time()), "kind": kind, "text": text}))
    pipe.ltrim(f"notif:{user}", 0, 29)
    await pipe.execute()


async def guild_perks(user, cfg=None):
    """(id de guilde, niveau, % de pièces en plus, réserve de packs en plus)."""
    gid = await r.hget(f"user:{user}", "guild")
    if not gid:
        return None, 0, 0, 0
    xp = await r.hget(f"guild:{gid}", "xp")
    if xp is None:                      # guilde dissoute entre-temps
        await r.hdel(f"user:{user}", "guild")
        return None, 0, 0, 0
    cfg = cfg or await settings()
    level, _ = guild_level(int(xp or 0))
    return gid, level, level * cfg["guild_bonus"], level // 4


async def wallet(user, cfg=None):
    """Crédite les tickets dus et renvoie (pièces, tickets, secondes avant le prochain, réserve)."""
    cfg = cfg or await settings()
    _, _, _, extra = await guild_perks(user, cfg)
    cap = cfg["pack_max"] + extra
    tickets, at = await sc_accrue(keys=[f"user:{user}"], args=[int(time.time()), cfg["pack_interval"], cap])
    tickets, at = int(tickets), int(at)
    left = 0 if tickets >= cap else max(0, int(at) + cfg["pack_interval"] - int(time.time()))
    coins = int(await r.hget(f"user:{user}", "coins") or 0)
    return coins, tickets, left, cap


# ---------- Clôture automatique des enchères ----------
async def settle_due():
    now = int(time.time())
    due = await r.zrangebyscore("auctions:live", "-inf", now, start=0, num=50)
    if not due:
        return
    cfg = await settings()
    for aid in due:
        res = await sc_settle(keys=[f"auction:{aid}", "auctions:live"], args=[aid, cfg["fee"], now])
        state = res[0]
        if state == "SKIP":
            continue
        _, winner, price, net, seller, vid = res
        cards = await cards_for([vid])
        title = cards.get(vid, {}).get("title", "une carte")
        if state == "SOLD":
            await notify(winner, "win", f"Enchère remportée : « {title} » pour {price} pièces.")
            await notify(seller, "sale", f"Vendu : « {title} » à {winner} — {net} pièces créditées.")
            log.info("Enchère %s vendue %s pièces à %s (vendeur %s)", aid, price, winner, seller)
        else:
            await notify(seller, "back", f"Enchère terminée sans preneur : « {title} » revient dans ta collection.")
    await trim_history()


async def trim_history():
    n = await r.zcard("auctions:done")
    if n > 1200:
        old = await r.zrange("auctions:done", 0, n - 1001)
        if old:
            pipe = r.pipeline()
            for aid in old:
                pipe.delete(f"auction:{aid}")
            pipe.zrem("auctions:done", *old)
            await pipe.execute()


PERIODIC = []          # tâches ajoutées par les autres modules (expiration des échanges, duels…)


async def settler_loop():
    while True:
        try:
            if await r.set("lock:settler", 1, ex=20, nx=True):
                await settle_due()
                for task in PERIODIC:
                    await task()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # la boucle ne doit jamais mourir
            log.warning("Clôture des enchères en échec : %s", e)
        await asyncio.sleep(5)


# ---------- Vérification anti-robot ----------
# Un ralentisseur, pas un captcha : de quoi décourager un script qui ouvrirait des comptes
# ou des packs en boucle, sans imposer un service tiers aux joueurs.
WORDS = ["carte", "pack", "vidéo", "chaîne", "enchère", "guilde", "pièce", "rareté"]


def fold(text):
    """Minuscules sans accent : « É » et « e » valent la même réponse, et compare_digest
    refuse de toute façon les chaînes non ASCII."""
    stripped = unicodedata.normalize("NFD", text.strip().lower())
    return "".join(c for c in stripped if not unicodedata.combining(c))


def new_challenge():
    kind = random.choice(("somme", "lettre", "compte"))
    if kind == "somme":
        a, b = random.randint(2, 9), random.randint(2, 9)
        return f"Combien font {a} + {b} ? (en chiffres)", str(a + b)
    if kind == "lettre":
        w = random.choice(WORDS)
        i = random.randint(1, min(4, len(w)))
        rank = {1: "1re", 2: "2e", 3: "3e", 4: "4e"}[i]
        return f"Quelle est la {rank} lettre du mot « {w} » ?", w[i - 1]
    w = random.choice(WORDS)
    letter = random.choice(sorted(set(w)))
    return f"Combien de fois la lettre « {letter} » apparaît-elle dans « {w} » ?", str(w.count(letter))


@app.get("/api/challenge")
async def challenge(request: Request):
    await rate_limit(f"rl:chal:{client_ip(request)}", 60, 600)
    question, answer = new_challenge()
    cid = secrets.token_urlsafe(12)
    await r.set(f"chal:{cid}", fold(answer), ex=600)
    return {"id": cid, "question": question}


async def solve(cid: str, answer: str) -> bool:
    if not cid or not answer:
        return False
    expected = await r.get(f"chal:{cid}")
    if expected is None:
        return False
    await r.delete(f"chal:{cid}")          # à usage unique
    return secrets.compare_digest(expected, fold(answer))


class ChallengeAnswer(BaseModel):
    id: str = ""
    answer: str = ""


@app.post("/api/verify", dependencies=[Depends(require_json)])
async def verify(body: ChallengeAnswer, request: Request, user=Depends(current_user)):
    await rate_limit(f"rl:verify:{client_ip(request)}", 30, 600)
    if not await solve(body.id, body.answer):
        raise HTTPException(400, "Mauvaise réponse, réessaie.")
    packs = int(await r.hget(f"user:{user}", "packs") or 0)
    await r.hset(f"user:{user}", "checked", packs)
    return {"ok": True}


async def bot_check_due(user, cfg) -> bool:
    """Vrai s'il faut revérifier avant d'ouvrir un pack."""
    if not cfg["bot_check"]:
        return False
    u = await r.hmget(f"user:{user}", "packs", "checked")
    return int(u[0] or 0) - int(u[1] or 0) >= cfg["bot_check"]


# ---------- Pages ----------
@app.get("/")
async def index(user=Depends(optional_user)):
    if not user:
        return RedirectResponse("/login", 303)
    return FileResponse(STATIC / "index.html")


@app.get("/login")
async def login_page(user=Depends(optional_user)):
    if user:
        return RedirectResponse("/", 303)
    return FileResponse(STATIC / "login.html")


@app.get("/sw.js")
async def service_worker():
    # Servi depuis la racine : un service worker ne pilote que son propre dossier et
    # ceux du dessous. Depuis /static/ il ne verrait jamais les pages de l'app.
    return FileResponse(STATIC / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/healthz")
async def healthz():
    await r.ping()
    return {"ok": True}


# ---------- Authentification ----------
class Credentials(BaseModel):
    username: str
    password: str
    invite: str = ""
    challenge: str = ""
    answer: str = ""


@app.post("/api/register", dependencies=[Depends(require_json)])
async def register(body: Credentials, request: Request, response: Response):
    await rate_limit(f"rl:register:{client_ip(request)}", 5, 3600)
    cfg = await settings()
    if not cfg["signups"]:
        raise HTTPException(403, "Les inscriptions sont fermées pour le moment.")
    if cfg["bot_check"] and not await solve(body.challenge, body.answer):
        raise HTTPException(400, "Vérification anti-robot incorrecte.")
    code = await invite_code()
    if code and not secrets.compare_digest(body.invite, code):
        raise HTTPException(403, "Code d'invitation incorrect.")
    if not USERNAME_RE.match(body.username):
        raise HTTPException(400, "Pseudo : 3 à 24 caractères, lettres, chiffres, _ ou -.")
    if not 8 <= len(body.password) <= 200:
        raise HTTPException(400, "Mot de passe : 8 caractères minimum.")
    name = body.username.lower()
    created = await r.hsetnx(f"user:{name}", "pw", ph.hash(body.password))
    if not created:
        raise HTTPException(409, "Ce pseudo est déjà pris.")
    now = int(time.time())
    await r.hset(f"user:{name}", mapping={
        "display": body.username, "created": now, "packs": 0,
        "coins": cfg["start_coins"], "tickets": cfg["start_tickets"], "ticket_at": now,
        "avatar": random.choice(AVATARS), "bio": "", "checked": 0,
    })
    await r.sadd("users", name)
    await notify(name, "hello", f"Bienvenue ! {cfg['start_coins']} pièces et {cfg['start_tickets']} packs pour démarrer.")
    await start_session(response, name)
    return {"ok": True}


@app.post("/api/login", dependencies=[Depends(require_json)])
async def login(body: Credentials, request: Request, response: Response):
    name = body.username.lower()
    await rate_limit(f"rl:login:ip:{client_ip(request)}", 20, 900)
    await rate_limit(f"rl:login:user:{name}", 10, 900)
    pw = await r.hget(f"user:{name}", "pw") if USERNAME_RE.match(body.username) else None
    try:
        if not pw:
            raise VerifyMismatchError
        ph.verify(pw, body.password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        raise HTTPException(401, "Pseudo ou mot de passe incorrect.")
    if await r.hget(f"user:{name}", "banned") == "1":
        raise HTTPException(403, "Ce compte est suspendu.")
    if ph.check_needs_rehash(pw):
        await r.hset(f"user:{name}", "pw", ph.hash(body.password))
    await r.sadd("users", name)
    await r.delete(f"rl:login:user:{name}")
    await start_session(response, name)
    return {"ok": True}


@app.post("/api/logout", dependencies=[Depends(require_json)])
async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        await r.delete(session_key(token))
    response.delete_cookie(COOKIE)
    return {"ok": True}


class PasswordChange(BaseModel):
    current: str
    new: str


@app.post("/api/password", dependencies=[Depends(require_json)])
async def change_password(body: PasswordChange, user=Depends(current_user)):
    pw = await r.hget(f"user:{user}", "pw")
    try:
        ph.verify(pw, body.current)
    except Exception:
        raise HTTPException(401, "Mot de passe actuel incorrect.")
    if not 8 <= len(body.new) <= 200:
        raise HTTPException(400, "Nouveau mot de passe : 8 caractères minimum.")
    await r.hset(f"user:{user}", "pw", ph.hash(body.new))
    return {"ok": True}


# ---------- Métadonnées ----------
@app.get("/api/meta")
async def meta():
    """Public : sert aussi à la page de connexion (code d'invitation requis ou non)."""
    cfg = await settings()
    return {
        "invite_required": bool(await invite_code()),
        "signups": bool(cfg["signups"]),
        "min_views": MIN_VIEWS,
        "videos": await r.zcard("videos:by_views"),
        "players": await r.scard("users"),
        "last_crawl": await r.get("worker:heartbeat"),
        "pack_interval": cfg["pack_interval"], "pack_max": cfg["pack_max"],
        "pack_price": cfg["pack_price"], "pack_bonus": cfg["pack_bonus"],
        "fee": cfg["fee"], "bid_step": cfg["bid_step"], "anti_snipe": cfg["anti_snipe"],
        "max_listings": cfg["max_listings"], "bot_check": cfg["bot_check"],
        "guild_cost": cfg["guild_cost"], "guild_max": cfg["guild_max"],
        "guild_rate": cfg["guild_rate"], "guild_bonus": cfg["guild_bonus"],
        "guild_max_level": GUILD_MAX_LEVEL, "kofi": KOFI,
        "durations": list(DURATIONS),
        "avatars": AVATARS, "emblems": EMBLEMS,
        "tiers": [{"key": k, "name": n, "min": m, "weight": w, "value": v} for k, n, m, w, v in TIERS],
    }


@app.get("/api/me")
async def me(user=Depends(current_user)):
    cfg = await settings()
    u = await r.hgetall(f"user:{user}")
    coins, tickets, left, cap = await wallet(user, cfg)
    gid, level, pct, _ = await guild_perks(user, cfg)
    guild = None
    if gid:
        g = await r.hmget(f"guild:{gid}", "name", "tag", "emblem")
        guild = {"id": gid, "name": g[0], "tag": g[1], "emblem": g[2], "level": level, "bonus": pct}
    return {
        "name": user, "username": u.get("display", user), "avatar": u.get("avatar") or "🎴",
        "bio": u.get("bio", ""), "created": int(u.get("created", 0) or 0),
        "packs": int(u.get("packs", 0) or 0), "unique": await r.hlen(f"coll:{user}"),
        "coins": coins, "tickets": tickets, "next_pack": left, "pack_max": cap, "guild": guild,
        "admin": bool(await r.sismember("admins", user)),
        "listings": await r.scard(f"seller:{user}"),
        "notifs": await r.llen(f"notif:{user}"),
    }


# ---------- Packs ----------
@app.post("/api/packs/open", dependencies=[Depends(require_json)])
async def open_pack(user=Depends(current_user)):
    if not await r.set(f"rl:pack:{user}", 1, px=700, nx=True):
        raise HTTPException(429, "Doucement, un pack à la fois.")
    cfg = await settings()
    if await bot_check_due(user, cfg):
        raise HTTPException(428, "Petite vérification avant de continuer.")

    avail = []
    for k, name, lo, hi, w in TIER_RANGES:
        n = await r.zcount("videos:by_views", *score_range(lo, hi))
        if n:
            avail.append((k, lo, hi, w, n))
    if not avail:
        raise HTTPException(404, "Aucune vidéo ne correspond à ce seuil pour l'instant.")

    gid, level, pct, _ = await guild_perks(user, cfg)
    bonus = round(cfg["pack_bonus"] * (1 + pct / 100))
    spent = await sc_spend(keys=[f"user:{user}"], args=[bonus])
    if spent[0] == "EMPTY":
        raise HTTPException(409, "Plus de pack disponible : attends le prochain ou achète-en un.")

    ids = []
    for _ in range(PACK_SIZE):
        k, lo, hi, w, n = random.choices(avail, weights=[a[3] for a in avail])[0]
        mn, mx = score_range(lo, hi)
        got = await r.zrange("videos:by_views", mn, mx, byscore=True, offset=random.randrange(n), num=1)
        if got:
            ids.append(got[0])

    pipe = r.pipeline()
    for vid in ids:
        pipe.hgetall(f"video:{vid}")
        pipe.hexists(f"coll:{user}", vid)
    res = await pipe.execute()

    cards, seen_now = [], set()
    pipe = r.pipeline()
    for i, vid in enumerate(ids):
        h, owned = res[2 * i], res[2 * i + 1]
        if not h:
            continue
        c = card(vid, h)
        c["new"] = not owned and vid not in seen_now
        seen_now.add(vid)
        cards.append(c)
        pipe.hincrby(f"coll:{user}", vid, 1)
    await pipe.execute()
    if gid:
        await sc_gxp(keys=[f"guild:{gid}"], args=[gid, 1])
    cards.sort(key=lambda c: c["views"])
    coins, tickets, left, cap = await wallet(user, cfg)
    return {"cards": cards, "coins": coins, "tickets": tickets, "next_pack": left,
            "pack_max": cap, "bonus": bonus, "guild_bonus": pct}


@app.post("/api/packs/buy", dependencies=[Depends(require_json)])
async def buy_pack(user=Depends(current_user)):
    cfg = await settings()
    res = await sc_buy(keys=[f"user:{user}"], args=[cfg["pack_price"], int(time.time())])
    if res[0] == "FUNDS":
        raise HTTPException(402, f"Il te faut {cfg['pack_price']} pièces pour acheter un pack.")
    coins, tickets, left, cap = await wallet(user, cfg)
    return {"coins": coins, "tickets": tickets, "next_pack": left, "pack_max": cap}


# ---------- Collection ----------
@app.get("/api/collection")
async def collection(user=Depends(current_user)):
    owned = await r.hgetall(f"coll:{user}")
    cards_by_id = await cards_for(list(owned))

    cards = []
    for vid, count in owned.items():
        c = cards_by_id.get(vid)
        if c:
            cards.append(dict(c, count=int(count), value=TIER_VALUE[c["tier"]]))
    cards.sort(key=lambda c: c["views"], reverse=True)

    tiers = []
    for k, name, lo, hi, w in TIER_RANGES:
        total = await r.zcount("videos:by_views", *score_range(lo, hi))
        tiers.append({"key": k, "name": name, "total": total, "owned": sum(c["tier"] == k for c in cards)})
    dupes = sum(c["count"] - 1 for c in cards)
    scrap = sum((c["count"] - 1) * c["value"] for c in cards)
    return {"cards": cards, "tiers": tiers, "dupes": dupes, "scrap": scrap}


class RecycleRequest(BaseModel):
    id: str
    count: int = Field(default=1, ge=1, le=99)


@app.post("/api/collection/recycle", dependencies=[Depends(require_json)])
async def recycle(body: RecycleRequest, user=Depends(current_user)):
    h = await r.hgetall(f"video:{body.id}")
    if not h:
        raise HTTPException(404, "Carte inconnue.")
    gain = TIER_VALUE[tier_key(int(h.get("views") or 0))] * body.count
    res = await sc_recycle(keys=[f"coll:{user}", f"user:{user}"], args=[body.id, body.count, gain])
    if res[0] == "NONE":
        raise HTTPException(409, "Tu dois garder au moins un exemplaire de chaque carte.")
    return {"left": int(res[1]), "coins": int(res[2]), "gain": gain}


# ---------- Hôtel des ventes ----------
async def auction_view(aid, h, cards_by_id, me=None):
    price = int(h.get("price") or 0)
    bidder = h.get("bidder") or ""
    cfg_step = int(h.get("_step", 0))
    return {
        "id": aid, "status": h.get("status", ""), "seller": h.get("seller", ""),
        "price": price, "start": int(h.get("start") or 0), "bids": int(h.get("nbids") or 0),
        "ends": int(h.get("ends") or 0), "created": int(h.get("created") or 0),
        "net": int(h["net"]) if h.get("net") else None,
        "bidder": bidder, "mine": me is not None and h.get("seller") == me,
        "leading": me is not None and bidder == me,
        "card": cards_by_id.get(h.get("vid", "")),
        "min_bid": price if not bidder else price + max(1, price * cfg_step // 100),
    }


async def load_auctions(ids, me, cfg):
    ids = [a for a in ids if a]
    if not ids:
        return []
    pipe = r.pipeline()
    for aid in ids:
        pipe.hgetall(f"auction:{aid}")
    raw = await pipe.execute()
    pairs = [(aid, h) for aid, h in zip(ids, raw) if h]
    cards_by_id = await cards_for([h.get("vid", "") for _, h in pairs])
    out = []
    for aid, h in pairs:
        h["_step"] = cfg["bid_step"]
        out.append(await auction_view(aid, h, cards_by_id, me))
    return out


@app.get("/api/market")
async def market(sort: str = "ending", tier: str = "all", q: str = "", limit: int = 60,
                 user=Depends(current_user)):
    cfg = await settings()
    ids = await r.zrange("auctions:live", 0, 499)
    items = await load_auctions(ids, user, cfg)
    items = [a for a in items if a["card"]]
    if tier in TIER_VALUE:
        items = [a for a in items if a["card"]["tier"] == tier]
    if q:
        needle = q.lower()
        items = [a for a in items if needle in a["card"]["title"].lower() or needle in a["card"]["channel"].lower()]
    keys = {
        "ending": lambda a: a["ends"],
        "recent": lambda a: -a["created"],
        "cheap": lambda a: a["price"],
        "rich": lambda a: -a["price"],
        "views": lambda a: -a["card"]["views"],
    }
    items.sort(key=keys.get(sort, keys["ending"]))
    return {"items": items[:max(1, min(limit, 200))], "total": len(items), "fee": cfg["fee"]}


@app.get("/api/market/mine")
async def market_mine(user=Depends(current_user)):
    cfg = await settings()
    selling = await load_auctions(await r.smembers(f"seller:{user}"), user, cfg)
    selling.sort(key=lambda a: a["ends"])
    bidding = await load_auctions(await r.zrevrange(f"bids:{user}", 0, 29), user, cfg)
    bidding = [a for a in bidding if a["status"] == "live"]
    history = await load_auctions(await r.zrevrange(f"hist:{user}", 0, 29), user, cfg)
    history = [a for a in history if a["status"] != "live"]
    return {"selling": selling, "bidding": bidding, "history": history}


class ListingRequest(BaseModel):
    id: str
    price: int = Field(ge=1, le=10_000_000)
    duration: str = "1h"


@app.post("/api/market/list", dependencies=[Depends(require_json)])
async def create_listing(body: ListingRequest, user=Depends(current_user)):
    cfg = await settings()
    if body.duration not in DURATIONS:
        raise HTTPException(400, "Durée invalide.")
    if not await r.exists(f"video:{body.id}"):
        raise HTTPException(404, "Carte inconnue.")
    now = int(time.time())
    aid = f"{now:x}{secrets.token_hex(4)}"
    ends = now + DURATIONS[body.duration]
    res = await sc_list(keys=[f"coll:{user}", f"auction:{aid}", "auctions:live"],
                        args=[body.id, aid, user, body.price, ends, now, cfg["max_listings"]])
    if res[0] == "TOOMANY":
        raise HTTPException(409, f"Maximum {cfg['max_listings']} ventes en cours.")
    if res[0] == "NONE":
        raise HTTPException(409, "Tu ne possèdes pas cette carte.")
    return {"id": aid, "ends": ends}


class BidRequest(BaseModel):
    id: str
    amount: int = Field(ge=1, le=100_000_000)


@app.post("/api/market/bid", dependencies=[Depends(require_json)])
async def place_bid(body: BidRequest, user=Depends(current_user)):
    cfg = await settings()
    res = await sc_bid(keys=[f"auction:{body.id}", "auctions:live"],
                       args=[body.id, user, body.amount, int(time.time()), cfg["anti_snipe"], cfg["bid_step"]])
    code = res[0]
    if code == "LOW":
        raise HTTPException(409, f"Mise trop faible : {int(res[1])} pièces minimum.")
    if code == "FUNDS":
        raise HTTPException(402, "Pièces insuffisantes.")
    if code == "SELLER":
        raise HTTPException(409, "On n'enchérit pas sur sa propre vente.")
    if code in ("CLOSED", "GONE"):
        raise HTTPException(409, "Cette enchère est terminée.")
    _, amount, ends, outbid = res
    if outbid:
        h = await r.hgetall(f"auction:{body.id}")
        titles = await cards_for([h.get("vid", "")])
        title = titles.get(h.get("vid", ""), {}).get("title", "une carte")
        await notify(outbid, "outbid", f"Surenchéri sur « {title} » : {int(amount)} pièces. Tu as été remboursé.")
    coins = int(await r.hget(f"user:{user}", "coins") or 0)
    return {"price": int(amount), "ends": int(ends), "coins": coins}


class AuctionRef(BaseModel):
    id: str


@app.post("/api/market/cancel", dependencies=[Depends(require_json)])
async def cancel_listing(body: AuctionRef, user=Depends(current_user)):
    if await r.hget(f"auction:{body.id}", "seller") != user:
        raise HTTPException(403, "Ce n'est pas ta vente.")
    res = await sc_cancel(keys=[f"auction:{body.id}", "auctions:live"], args=[body.id, "user", int(time.time())])
    if res[0] == "BIDS":
        raise HTTPException(409, "Impossible d'annuler : une mise a déjà été placée.")
    if res[0] == "CLOSED":
        raise HTTPException(409, "Cette enchère est déjà terminée.")
    return {"ok": True}


# ---------- Profils, classement, notifications ----------
async def profile_of(name, viewer=None):
    u = await r.hgetall(f"user:{name}")
    if not u or "pw" not in u:
        raise HTTPException(404, "Joueur inconnu.")
    owned = await r.hgetall(f"coll:{name}")
    cards_by_id = await cards_for(list(owned))
    cards = [dict(c, count=int(owned[vid])) for vid, c in cards_by_id.items()]
    cards.sort(key=lambda c: c["views"], reverse=True)
    counts = {k: 0 for k, *_ in TIERS}
    for c in cards:
        counts[c["tier"]] += 1
    total = await r.zcard("videos:by_views")
    by_id = {c["id"]: c for c in cards}
    showcase = [by_id[v] for v in (u.get("showcase") or "").split(",") if v in by_id]
    relation = "self"
    if viewer and viewer != name:
        if await r.sismember(f"friends:{viewer}", name):
            relation = "friend"
        elif await r.zscore(f"freq:out:{viewer}", name) is not None:
            relation = "sent"
        elif await r.zscore(f"freq:in:{viewer}", name) is not None:
            relation = "received"
        else:
            relation = "none"
    gid = u.get("guild")
    guild = None
    if gid:
        g = await r.hmget(f"guild:{gid}", "name", "tag", "emblem")
        if g[0]:
            guild = {"id": gid, "name": g[0], "tag": g[1], "emblem": g[2]}
    seen = int(await r.get(f"seen:{name}") or 0)
    return {
        "name": name, "username": u.get("display", name), "avatar": u.get("avatar") or "🎴",
        "showcase": showcase, "power": await power_of(name), "relation": relation, "guild": guild,
        "won": int(u.get("duels_won", 0) or 0), "lost": int(u.get("duels_lost", 0) or 0),
        "friends": await r.scard(f"friends:{name}"), "online": time.time() - seen < 300,
        "bio": u.get("bio", ""), "created": int(u.get("created", 0) or 0),
        "packs": int(u.get("packs", 0) or 0), "unique": len(cards),
        "copies": sum(c["count"] for c in cards), "pool": total,
        "admin": bool(await r.sismember("admins", name)),
        "coins": int(u.get("coins", 0) or 0) if viewer == name else None,
        "tiers": [{"key": k, "name": n, "owned": counts[k]} for k, n, _, _, _ in TIERS],
        "best": cards[:8],
        "listings": await r.scard(f"seller:{name}"),
    }


@app.get("/api/profile")
async def my_profile(user=Depends(current_user)):
    return await profile_of(user, user)


@app.get("/api/profile/{name}")
async def public_profile(name: str, user=Depends(current_user)):
    if not USERNAME_RE.match(name):
        raise HTTPException(404, "Joueur inconnu.")
    return await profile_of(name.lower(), user)


class ProfileUpdate(BaseModel):
    bio: str = ""
    avatar: str = "🎴"


@app.post("/api/profile", dependencies=[Depends(require_json)])
async def update_profile(body: ProfileUpdate, user=Depends(current_user)):
    bio = body.bio.strip()[:200]
    avatar = body.avatar if body.avatar in AVATARS else "🎴"
    await r.hset(f"user:{user}", mapping={"bio": bio, "avatar": avatar})
    return {"bio": bio, "avatar": avatar}


_lb_cache = {"at": 0, "data": None}


@app.get("/api/leaderboard")
async def leaderboard(user=Depends(current_user)):
    if _lb_cache["data"] and time.time() - _lb_cache["at"] < 30:
        return _lb_cache["data"]
    names = sorted(await r.smembers("users"))
    pipe = r.pipeline()
    for n in names:
        pipe.hmget(f"user:{n}", "display", "avatar", "packs", "coins", "duels_won")
        pipe.hlen(f"coll:{n}")
    res = await pipe.execute()
    rows = []
    for i, n in enumerate(names):
        display, avatar, packs, coins, won = res[2 * i]
        rows.append({"name": n, "username": display or n, "avatar": avatar or "🎴",
                     "packs": int(packs or 0), "coins": int(coins or 0), "unique": res[2 * i + 1],
                     "power": await power_of(n), "won": int(won or 0)})
    data = {
        "power": sorted(rows, key=lambda x: -x["power"])[:20],
        "duels": sorted(rows, key=lambda x: -x["won"])[:20],
        "cards": sorted(rows, key=lambda x: -x["unique"])[:20],
        "coins": sorted(rows, key=lambda x: -x["coins"])[:20],
        "packs": sorted(rows, key=lambda x: -x["packs"])[:20],
    }
    _lb_cache.update(at=time.time(), data=data)
    return data


@app.get("/api/notifications")
async def notifications(user=Depends(current_user)):
    raw = await r.lrange(f"notif:{user}", 0, 29)
    items = []
    for s in raw:
        try:
            items.append(json.loads(s))
        except ValueError:
            pass
    return {"items": items}


@app.post("/api/notifications/clear", dependencies=[Depends(require_json)])
async def clear_notifications(user=Depends(current_user)):
    await r.delete(f"notif:{user}")
    return {"ok": True}


# ---------- Guildes ----------
ROLES = ("chef", "officier", "membre")


async def guild_view(gid, viewer=None):
    g = await r.hgetall(f"guild:{gid}")
    if not g:
        raise HTTPException(404, "Guilde inconnue.")
    cfg = await settings()
    roles = await r.hgetall(f"guild:{gid}:members")
    joined = await r.hgetall(f"guild:{gid}:joined")
    given = await r.hgetall(f"guild:{gid}:given")
    names = sorted(roles, key=lambda n: (ROLES.index(roles[n]) if roles[n] in ROLES else 9, n))
    pipe = r.pipeline()
    for n in names:
        pipe.hmget(f"user:{n}", "display", "avatar", "packs")
        pipe.hlen(f"coll:{n}")
    res = await pipe.execute()
    members = []
    for i, n in enumerate(names):
        display, avatar, packs = res[2 * i]
        members.append({"name": n, "username": display or n, "avatar": avatar or "🎴",
                        "role": roles[n], "joined": int(joined.get(n, 0) or 0),
                        "given": int(given.get(n, 0) or 0), "packs": int(packs or 0),
                        "unique": res[2 * i + 1]})
    xp = int(g.get("xp", 0) or 0)
    level, nxt = guild_level(xp)
    mine = next((m for m in members if m["name"] == viewer), None)
    return {
        "id": gid, "name": g.get("name", ""), "tag": g.get("tag", ""),
        "emblem": g.get("emblem") or "🛡️", "motd": g.get("motd", ""),
        "open": g.get("open") == "1", "owner": g.get("owner", ""),
        "created": int(g.get("created", 0) or 0), "coins": int(g.get("coins", 0) or 0),
        "xp": xp, "level": level, "next_xp": nxt, "prev_xp": 25 * level * (level + 1),
        "members": members, "count": len(members), "max": cfg["guild_max"],
        "coin_bonus": level * cfg["guild_bonus"], "ticket_bonus": level // 4,
        "rate": cfg["guild_rate"], "my_role": mine["role"] if mine else None,
    }


async def my_guild_id(user):
    gid = await r.hget(f"user:{user}", "guild")
    if not gid:
        return None
    if not await r.exists(f"guild:{gid}"):
        await r.hdel(f"user:{user}", "guild")   # guilde dissoute
        return None
    return gid


async def require_role(user, *allowed):
    """Renvoie (id de guilde, rôle) si le joueur a l'un des rôles demandés."""
    gid = await my_guild_id(user)
    if not gid:
        raise HTTPException(404, "Tu n'es dans aucune guilde.")
    role = await r.hget(f"guild:{gid}:members", user)
    if role not in allowed:
        raise HTTPException(403, "Ton rôle ne permet pas cette action.")
    return gid, role


@app.get("/api/guilds")
async def guilds(q: str = "", user=Depends(current_user)):
    ids = await r.zrevrange("guilds", 0, 199)
    mine = await my_guild_id(user)
    if not ids:
        return {"items": [], "mine": mine}
    pipe = r.pipeline()
    for gid in ids:
        pipe.hmget(f"guild:{gid}", "name", "tag", "emblem", "xp", "open", "motd")
        pipe.hlen(f"guild:{gid}:members")
    res = await pipe.execute()
    cfg = await settings()
    items = []
    for i, gid in enumerate(ids):
        name, tag, emblem, xp, is_open, motd = res[2 * i]
        if not name:
            continue
        if q and q.lower() not in name.lower() and q.lower() not in (tag or "").lower():
            continue
        level, _ = guild_level(int(xp or 0))
        items.append({"id": gid, "name": name, "tag": tag or "", "emblem": emblem or "🛡️",
                      "xp": int(xp or 0), "level": level, "open": is_open == "1",
                      "motd": motd or "", "count": res[2 * i + 1], "max": cfg["guild_max"]})
    return {"items": items, "mine": mine}


@app.get("/api/guild")
async def my_guild(user=Depends(current_user)):
    gid = await my_guild_id(user)
    return {"guild": await guild_view(gid, user) if gid else None}


@app.get("/api/guild/{gid}")
async def one_guild(gid: str, user=Depends(current_user)):
    return {"guild": await guild_view(gid, user)}


class GuildCreate(BaseModel):
    name: str
    tag: str
    emblem: str = "🛡️"


@app.post("/api/guild/create", dependencies=[Depends(require_json)])
async def guild_create(body: GuildCreate, user=Depends(current_user)):
    cfg = await settings()
    name = " ".join(body.name.split())
    tag = body.tag.strip().upper()
    if not GUILD_NAME_RE.match(name):
        raise HTTPException(400, "Nom : 3 à 24 caractères, lettres, chiffres, espaces ou tirets.")
    if not GUILD_TAG_RE.match(tag):
        raise HTTPException(400, "Tag : 2 à 5 lettres ou chiffres, sans accent.")
    emblem = body.emblem if body.emblem in EMBLEMS else "🛡️"
    gid = secrets.token_hex(6)
    res = await sc_gcreate(keys=[f"user:{user}", f"guild:{gid}", f"guild:{gid}:members"],
                           args=[gid, name, name.lower(), tag, cfg["guild_cost"], user,
                                 int(time.time()), emblem])
    code = res[0]
    if code == "ALREADY":
        raise HTTPException(409, "Quitte ta guilde avant d'en fonder une autre.")
    if code == "TAKEN":
        raise HTTPException(409, "Ce nom de guilde est déjà pris.")
    if code == "FUNDS":
        raise HTTPException(402, f"Fonder une guilde coûte {cfg['guild_cost']} pièces.")
    return {"id": gid}


class GuildRef(BaseModel):
    id: str


@app.post("/api/guild/join", dependencies=[Depends(require_json)])
async def guild_join(body: GuildRef, user=Depends(current_user)):
    cfg = await settings()
    res = await sc_gjoin(keys=[f"user:{user}", f"guild:{body.id}", f"guild:{body.id}:members"],
                         args=[body.id, user, int(time.time()), cfg["guild_max"]])
    code = res[0]
    if code == "ALREADY":
        raise HTTPException(409, "Tu es déjà dans une guilde.")
    if code == "GONE":
        raise HTTPException(404, "Cette guilde n'existe plus.")
    if code == "CLOSED":
        raise HTTPException(403, "Cette guilde est fermée aux nouvelles recrues.")
    if code == "FULL":
        raise HTTPException(409, "Cette guilde est complète.")
    name = await r.hget(f"guild:{body.id}", "name")
    for m in await r.hkeys(f"guild:{body.id}:members"):
        if m != user:
            await notify(m, "guild", f"{user} rejoint la guilde {name}.")
    return {"ok": True}


@app.post("/api/guild/leave", dependencies=[Depends(require_json)])
async def guild_leave(user=Depends(current_user)):
    gid = await my_guild_id(user)
    if not gid:
        raise HTTPException(404, "Tu n'es dans aucune guilde.")
    res = await sc_gleave(keys=[f"user:{user}", f"guild:{gid}", f"guild:{gid}:members"], args=[user])
    if res[0] == "OWNER":
        raise HTTPException(409, "Passe d'abord le rôle de chef à quelqu'un, ou dissous la guilde.")
    return {"ok": True}


class GuildMember(BaseModel):
    name: str


@app.post("/api/guild/kick", dependencies=[Depends(require_json)])
async def guild_kick(body: GuildMember, user=Depends(current_user)):
    gid, role = await require_role(user, "chef", "officier")
    target = body.name.lower()
    if target == user:
        raise HTTPException(409, "Utilise « Quitter la guilde ».")
    trole = await r.hget(f"guild:{gid}:members", target)
    if not trole:
        raise HTTPException(404, "Ce joueur n'est pas dans la guilde.")
    if role == "officier" and trole != "membre":
        raise HTTPException(403, "Un officier ne peut exclure que des membres.")
    res = await sc_gleave(keys=[f"user:{target}", f"guild:{gid}", f"guild:{gid}:members"], args=[target])
    if res[0] == "OWNER":
        raise HTTPException(409, "On n'exclut pas le chef.")
    name = await r.hget(f"guild:{gid}", "name")
    await notify(target, "guild", f"Tu as été exclu de la guilde {name}.")
    return {"ok": True}


class GuildRole(BaseModel):
    name: str
    role: str


@app.post("/api/guild/role", dependencies=[Depends(require_json)])
async def guild_role(body: GuildRole, user=Depends(current_user)):
    gid, _ = await require_role(user, "chef")
    target = body.name.lower()
    if body.role not in ROLES:
        raise HTTPException(400, "Rôle inconnu.")
    if not await r.hexists(f"guild:{gid}:members", target):
        raise HTTPException(404, "Ce joueur n'est pas dans la guilde.")
    if body.role == "chef":
        # Passation : il n'y a qu'un chef, l'ancien redevient officier.
        pipe = r.pipeline()
        pipe.hset(f"guild:{gid}:members", target, "chef")
        pipe.hset(f"guild:{gid}:members", user, "officier")
        pipe.hset(f"guild:{gid}", "owner", target)
        await pipe.execute()
        await notify(target, "guild", "Tu es désormais chef de la guilde.")
    elif target == user:
        raise HTTPException(409, "Passe d'abord le rôle de chef à quelqu'un d'autre.")
    else:
        await r.hset(f"guild:{gid}:members", target, body.role)
        await notify(target, "guild", f"Ton rôle dans la guilde est maintenant : {body.role}.")
    return {"ok": True}


class GuildAmount(BaseModel):
    amount: int = Field(ge=1, le=10_000_000)


@app.post("/api/guild/donate", dependencies=[Depends(require_json)])
async def guild_donate(body: GuildAmount, user=Depends(current_user)):
    gid = await my_guild_id(user)
    if not gid:
        raise HTTPException(404, "Tu n'es dans aucune guilde.")
    res = await sc_gdonate(keys=[f"user:{user}", f"guild:{gid}", f"guild:{gid}:members"],
                           args=[user, body.amount])
    if res[0] == "FUNDS":
        raise HTTPException(402, "Pièces insuffisantes.")
    if res[0] == "NONE":
        raise HTTPException(404, "Tu n'es pas membre de cette guilde.")
    return {"treasury": int(res[1]), "coins": int(res[2])}


@app.post("/api/guild/invest", dependencies=[Depends(require_json)])
async def guild_invest(body: GuildAmount, user=Depends(current_user)):
    gid, _ = await require_role(user, "chef", "officier")
    cfg = await settings()
    if body.amount < cfg["guild_rate"]:
        raise HTTPException(400, f"Minimum {cfg['guild_rate']} pièces.")
    res = await sc_ginvest(keys=[f"guild:{gid}"], args=[body.amount, cfg["guild_rate"]])
    if res[0] == "FUNDS":
        raise HTTPException(402, "Le trésor ne suffit pas.")
    return {"treasury": int(res[1]), "xp": int(res[2])}


class GuildSettings(BaseModel):
    motd: str = ""
    emblem: str = "🛡️"
    open: bool = True


@app.post("/api/guild/settings", dependencies=[Depends(require_json)])
async def guild_settings(body: GuildSettings, user=Depends(current_user)):
    gid, _ = await require_role(user, "chef", "officier")
    await r.hset(f"guild:{gid}", mapping={
        "motd": body.motd.strip()[:200],
        "emblem": body.emblem if body.emblem in EMBLEMS else "🛡️",
        "open": "1" if body.open else "0",
    })
    return {"ok": True}


@app.post("/api/guild/disband", dependencies=[Depends(require_json)])
async def guild_disband(user=Depends(current_user)):
    gid, _ = await require_role(user, "chef")
    name = await r.hget(f"guild:{gid}", "name")
    members = await r.hkeys(f"guild:{gid}:members")
    await sc_gdisband(keys=[f"guild:{gid}", f"guild:{gid}:members"], args=[gid])
    for m in members:
        if m != user:
            await notify(m, "guild", f"La guilde {name} a été dissoute par son chef.")
    return {"ok": True}


# ---------- Administration ----------
@app.get("/api/admin/overview", dependencies=[Depends(require_admin)])
async def admin_overview():
    names = await r.smembers("users")
    pipe = r.pipeline()
    for n in names:
        pipe.hmget(f"user:{n}", "coins", "packs")
    res = await pipe.execute()
    coins = sum(int(c or 0) for c, _ in res)
    packs = sum(int(p or 0) for _, p in res)
    live = await r.zrange("auctions:live", 0, -1)
    pipe = r.pipeline()
    for aid in live:
        pipe.hget(f"auction:{aid}", "price")
    escrow = sum(int(p or 0) for p in (await pipe.execute()))
    return {
        "users": len(names), "admins": sorted(await r.smembers("admins")),
        "videos": await r.zcard("videos:by_views"), "known": await r.zcard("videos:updated"),
        "sources": await r.zcard("sources"), "packs": packs, "coins": coins,
        "live_auctions": len(live), "escrow": escrow, "done_auctions": await r.zcard("auctions:done"),
        "guilds": await r.zcard("guilds"),
        "reports": await r.zcard("reports"), "blacklisted": await r.scard("blacklist"),
        "heartbeat": await r.get("worker:heartbeat"), "worker_status": await r.get("worker:status"),
        "worker_stats": await r.hgetall("worker:stats"),
        "channels": await r.zcard("channels"), "queued": await r.scard("queue:related"),
        "settings": await settings(), "invite": await invite_code(),
    }


@app.get("/api/admin/users", dependencies=[Depends(require_admin)])
async def admin_users(q: str = "", limit: int = 100):
    names = sorted(n for n in await r.smembers("users") if q.lower() in n)
    names = names[:max(1, min(limit, 500))]
    pipe = r.pipeline()
    for n in names:
        pipe.hgetall(f"user:{n}")
        pipe.hlen(f"coll:{n}")
        pipe.sismember("admins", n)
        pipe.scard(f"seller:{n}")
    res = await pipe.execute()
    out = []
    for i, n in enumerate(names):
        u = res[4 * i]
        out.append({
            "name": n, "username": u.get("display", n), "avatar": u.get("avatar") or "🎴",
            "created": int(u.get("created", 0) or 0), "packs": int(u.get("packs", 0) or 0),
            "coins": int(u.get("coins", 0) or 0), "tickets": int(u.get("tickets", 0) or 0),
            "unique": res[4 * i + 1], "admin": bool(res[4 * i + 2]), "listings": res[4 * i + 3],
            "banned": u.get("banned") == "1",
        })
    return {"users": out}


class AdminUserAction(BaseModel):
    name: str
    action: str
    amount: int = 0
    password: str = ""


@app.post("/api/admin/user", dependencies=[Depends(require_json)])
async def admin_user(body: AdminUserAction, admin=Depends(require_admin)):
    name = body.name.lower()
    if not await r.exists(f"user:{name}"):
        raise HTTPException(404, "Joueur inconnu.")
    a = body.action
    if a in ("grant", "revoke", "ban", "unban") and name in ADMIN_USERS and a in ("revoke", "ban"):
        raise HTTPException(403, "Cet administrateur est défini par la configuration du serveur.")
    if a == "grant":
        await r.sadd("admins", name)
        await notify(name, "admin", "Tu es désormais administrateur.")
    elif a == "revoke":
        if name == admin:
            raise HTTPException(409, "Retire-toi les droits depuis un autre compte admin.")
        await r.srem("admins", name)
    elif a == "ban":
        if name == admin:
            raise HTTPException(409, "Tu ne peux pas te suspendre toi-même.")
        await r.hset(f"user:{name}", "banned", "1")
    elif a == "unban":
        await r.hdel(f"user:{name}", "banned")
    elif a in ("coins", "tickets"):
        if not -1_000_000 <= body.amount <= 1_000_000:
            raise HTTPException(400, "Montant hors limites.")
        await sc_adjust(keys=[f"user:{name}"], args=[a, body.amount])
        if body.amount:
            label = "pièces" if a == "coins" else "packs"
            verb = "crédité" if body.amount > 0 else "retiré"
            await notify(name, "admin", f"Un administrateur t'a {verb} {abs(body.amount)} {label}.")
    elif a == "password":
        if not 8 <= len(body.password) <= 200:
            raise HTTPException(400, "Mot de passe : 8 caractères minimum.")
        await r.hset(f"user:{name}", "pw", ph.hash(body.password))
    else:
        raise HTTPException(400, "Action inconnue.")
    log.info("Admin %s : %s sur %s (%s)", admin, a, name, body.amount)
    return {"ok": True}


@app.get("/api/admin/sources", dependencies=[Depends(require_admin)])
async def admin_sources():
    rows = await r.zrange("sources", 0, -1, withscores=True)
    return {"sources": [{"url": u, "last": int(s)} for u, s in rows]}


class SourceAction(BaseModel):
    url: str
    action: str = "add"


@app.post("/api/admin/source", dependencies=[Depends(require_json)])
async def admin_source(body: SourceAction, admin=Depends(require_admin)):
    url = body.url.strip()
    if not url or len(url) > 300:
        raise HTTPException(400, "Source invalide.")
    if body.action == "add":
        if not (url.startswith("https://www.youtube.com/") or url.startswith("ytsearch")):
            raise HTTPException(400, "Attendu : une URL youtube.com ou une requête ytsearchN:mots.")
        await r.zadd("sources", {url: 0})
    elif body.action == "remove":
        await r.zrem("sources", url)
    elif body.action == "bump":
        await r.zadd("sources", {url: 0}, xx=True)
    else:
        raise HTTPException(400, "Action inconnue.")
    log.info("Admin %s : source %s %s", admin, body.action, url)
    return {"ok": True}


class SettingsUpdate(BaseModel):
    values: dict
    invite: str | None = None


@app.post("/api/admin/settings", dependencies=[Depends(require_json)])
async def admin_settings(body: SettingsUpdate, admin=Depends(require_admin)):
    limits = {
        "pack_interval": (30, 86400), "pack_max": (1, 500), "pack_price": (0, 1_000_000),
        "pack_bonus": (0, 100_000), "start_coins": (0, 1_000_000), "start_tickets": (0, 500),
        "fee": (0, 50), "bid_step": (1, 100), "anti_snipe": (0, 3600),
        "max_listings": (1, 200), "signups": (0, 1), "bot_check": (0, 100000),
        "guild_cost": (0, 1_000_000), "guild_max": (2, 200),
        "guild_rate": (1, 10000), "guild_bonus": (0, 50),
    }
    update = {}
    for k, v in body.values.items():
        if k not in limits:
            continue
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise HTTPException(400, f"Valeur invalide pour {k}.")
        lo, hi = limits[k]
        if not lo <= n <= hi:
            raise HTTPException(400, f"{k} doit être entre {lo} et {hi}.")
        update[k] = n
    if update:
        await r.hset("settings", mapping=update)
    if body.invite is not None:
        await r.hset("settings", "invite", body.invite.strip())
    log.info("Admin %s : réglages %s", admin, update)
    return {"settings": await settings(), "invite": await invite_code()}


@app.get("/api/admin/auctions")
async def admin_auctions(user=Depends(require_admin)):
    cfg = await settings()
    live = await load_auctions(await r.zrange("auctions:live", 0, 199), user, cfg)
    live.sort(key=lambda a: a["ends"])
    return {"items": live}


@app.post("/api/admin/auction/cancel", dependencies=[Depends(require_json)])
async def admin_cancel(body: AuctionRef, admin=Depends(require_admin)):
    h = await r.hgetall(f"auction:{body.id}")
    if not h:
        raise HTTPException(404, "Enchère inconnue.")
    res = await sc_cancel(keys=[f"auction:{body.id}", "auctions:live"], args=[body.id, "admin", int(time.time())])
    if res[0] == "CLOSED":
        raise HTTPException(409, "Cette enchère est déjà terminée.")
    await notify(h["seller"], "admin", "Une de tes ventes a été annulée par un administrateur : carte rendue.")
    if res[1]:
        await notify(res[1], "admin", f"Enchère annulée par un administrateur : {int(res[2])} pièces remboursées.")
    log.info("Admin %s : annulation de l'enchère %s", admin, body.id)
    return {"ok": True}


@app.get("/api/admin/guilds")
async def admin_guilds(user=Depends(require_admin)):
    ids = await r.zrevrange("guilds", 0, 199)
    pipe = r.pipeline()
    for gid in ids:
        pipe.hmget(f"guild:{gid}", "name", "tag", "emblem", "owner", "xp", "coins", "created")
        pipe.hlen(f"guild:{gid}:members")
    res = await pipe.execute()
    out = []
    for i, gid in enumerate(ids):
        name, tag, emblem, owner, xp, coins, created = res[2 * i]
        if not name:
            continue
        level, _ = guild_level(int(xp or 0))
        out.append({"id": gid, "name": name, "tag": tag or "", "emblem": emblem or "🛡️",
                    "owner": owner or "", "xp": int(xp or 0), "level": level,
                    "coins": int(coins or 0), "created": int(created or 0),
                    "count": res[2 * i + 1]})
    return {"guilds": out}


@app.post("/api/admin/guild/disband", dependencies=[Depends(require_json)])
async def admin_guild_disband(body: GuildRef, admin=Depends(require_admin)):
    name = await r.hget(f"guild:{body.id}", "name")
    if not name:
        raise HTTPException(404, "Guilde inconnue.")
    members = await r.hkeys(f"guild:{body.id}:members")
    await sc_gdisband(keys=[f"guild:{body.id}", f"guild:{body.id}:members"], args=[body.id])
    for m in members:
        await notify(m, "admin", f"La guilde {name} a été dissoute par un administrateur.")
    log.info("Admin %s : dissolution de la guilde %s (%s)", admin, body.id, name)
    return {"ok": True}


class BroadcastRequest(BaseModel):
    text: str


@app.post("/api/admin/broadcast", dependencies=[Depends(require_json)])
async def admin_broadcast(body: BroadcastRequest, admin=Depends(require_admin)):
    text = body.text.strip()[:200]
    if not text:
        raise HTTPException(400, "Message vide.")
    for name in await r.smembers("users"):
        await notify(name, "admin", text)
    log.info("Admin %s : annonce « %s »", admin, text)
    return {"ok": True}


# Amis, vitrine, explorateur, échanges, duels, signalements : voir social.py.
import social  # noqa: E402,F401
