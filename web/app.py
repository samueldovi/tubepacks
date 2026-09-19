"""TubePacks, serveur web : portail de connexion, ouverture de packs, collection.

Stockage Redis
  video:{id}          hash   title, channel, views, likes, category, year
  videos:by_views     zset   id -> vues (index des vidéos jouables, >= MIN_VIEWS)
  user:{name}         hash   pw, created, packs
  coll:{name}         hash   id -> nombre d'exemplaires
  session:{sha256}    string nom d'utilisateur (TTL)
"""
import hashlib
import os
import random
import re
import secrets
import time
from pathlib import Path

import redis.asyncio as aioredis
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
REDIS_PASSWORD = os.environ.get("REDIS_PASSWORD") or None
INVITE_CODE = os.environ.get("INVITE_CODE", "")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"
MIN_VIEWS = int(os.environ.get("MIN_VIEWS", "10000"))
SESSION_TTL = 60 * 60 * 24 * 30
PACK_SIZE = 5
COOKIE = "tp_session"
STATIC = Path(__file__).parent / "static"

# (clé, nom, vues min, poids de tirage) ; chaque palier va jusqu'au min du palier au-dessus.
TIERS = [
    ("M", "Mythique", 100_000_000, 1.5),
    ("L", "Légendaire", 10_000_000, 5),
    ("E", "Épique", 1_000_000, 12),
    ("R", "Rare", 100_000, 24),
    ("C", "Commune", 0, 57.5),
]

r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True)
ph = PasswordHasher()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_-]{3,24}$")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' https://i.ytimg.com data:; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
        "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp


# ---------- Utilitaires ----------
def tier_bounds(min_views):
    """Paliers disponibles pour un seuil : [(clé, nom, bas, haut|None, poids)]."""
    out, upper = [], None
    for k, name, tmin, w in TIERS:
        lo = max(tmin, min_views)
        if upper is None or lo < upper:
            out.append((k, name, lo, upper, w))
        upper = tmin
    return out


def score_range(lo, hi):
    return lo, (f"({hi}" if hi is not None else "+inf")


def tier_key(views):
    return next(k for k, _, tmin, _ in TIERS if views >= tmin)


def card(vid, h):
    views = int(h.get("views") or 0)
    likes = h.get("likes")
    return {
        "id": vid, "title": h.get("title", ""), "channel": h.get("channel", ""),
        "views": views, "likes": int(likes) if likes not in (None, "") else None,
        "category": h.get("category") or "autre", "year": h.get("year") or "",
        "tier": tier_key(views),
    }


def client_ip(request: Request):
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
    return user


async def optional_user(request: Request):
    try:
        return await current_user(request)
    except HTTPException:
        return None


def require_json(request: Request):
    # Bloque les formulaires cross-site : ils ne peuvent pas envoyer du JSON sans préflight CORS.
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, "JSON attendu")


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


@app.get("/healthz")
async def healthz():
    await r.ping()
    return {"ok": True}


# ---------- Authentification ----------
class Credentials(BaseModel):
    username: str
    password: str
    invite: str = ""


@app.post("/api/register", dependencies=[Depends(require_json)])
async def register(body: Credentials, request: Request, response: Response):
    await rate_limit(f"rl:register:{client_ip(request)}", 5, 3600)
    if INVITE_CODE and not secrets.compare_digest(body.invite, INVITE_CODE):
        raise HTTPException(403, "Code d'invitation incorrect.")
    if not USERNAME_RE.match(body.username):
        raise HTTPException(400, "Pseudo : 3 à 24 caractères, lettres, chiffres, _ ou -.")
    if not 8 <= len(body.password) <= 200:
        raise HTTPException(400, "Mot de passe : 8 caractères minimum.")
    name = body.username.lower()
    created = await r.hsetnx(f"user:{name}", "pw", ph.hash(body.password))
    if not created:
        raise HTTPException(409, "Ce pseudo est déjà pris.")
    await r.hset(f"user:{name}", mapping={"display": body.username, "created": int(time.time()), "packs": 0})
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
    if ph.check_needs_rehash(pw):
        await r.hset(f"user:{name}", "pw", ph.hash(body.password))
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


# ---------- Jeu ----------
@app.get("/api/meta")
async def meta():
    """Public : sert aussi à la page de connexion (code d'invitation requis ou non)."""
    return {
        "invite_required": bool(INVITE_CODE),
        "min_views": MIN_VIEWS,
        "videos": await r.zcard("videos:by_views"),
        "last_crawl": await r.get("worker:heartbeat"),
        "tiers": [{"key": k, "name": n, "min": m, "weight": w} for k, n, m, w in TIERS],
    }


@app.get("/api/me")
async def me(user=Depends(current_user)):
    u = await r.hgetall(f"user:{user}")
    return {"username": u.get("display", user), "packs": int(u.get("packs", 0)),
            "unique": await r.hlen(f"coll:{user}")}


class PackRequest(BaseModel):
    min_views: int = MIN_VIEWS


@app.post("/api/packs/open", dependencies=[Depends(require_json)])
async def open_pack(body: PackRequest, user=Depends(current_user)):
    if not await r.set(f"rl:pack:{user}", 1, px=700, nx=True):
        raise HTTPException(429, "Doucement, un pack à la fois.")
    min_views = max(MIN_VIEWS, body.min_views)

    avail = []
    for k, name, lo, hi, w in tier_bounds(min_views):
        n = await r.zcount("videos:by_views", *score_range(lo, hi))
        if n:
            avail.append((k, lo, hi, w, n))
    if not avail:
        raise HTTPException(404, "Aucune vidéo ne correspond à ce seuil pour l'instant.")

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
    pipe.hincrby(f"user:{user}", "packs", 1)
    await pipe.execute()
    cards.sort(key=lambda c: c["views"])
    return {"cards": cards}


@app.get("/api/collection")
async def collection(min_views: int = MIN_VIEWS, user=Depends(current_user)):
    min_views = max(MIN_VIEWS, min_views)
    owned = await r.hgetall(f"coll:{user}")
    pipe = r.pipeline()
    for vid in owned:
        pipe.hgetall(f"video:{vid}")
    hashes = await pipe.execute() if owned else []

    cards = []
    for (vid, count), h in zip(owned.items(), hashes):
        if h and int(h.get("views") or 0) >= min_views:
            c = card(vid, h)
            c["count"] = int(count)
            cards.append(c)
    cards.sort(key=lambda c: c["views"], reverse=True)

    tiers = []
    for k, name, lo, hi, w in tier_bounds(min_views):
        total = await r.zcount("videos:by_views", *score_range(lo, hi))
        tiers.append({"key": k, "name": name, "total": total, "owned": sum(c["tier"] == k for c in cards)})
    return {"cards": cards, "tiers": tiers}
