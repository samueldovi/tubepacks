"""TubePacks — amis, vitrine, explorateur, fiche carte, échanges, duels, signalements.

Stockage Redis
  friends:{name}        set    amis
  freq:in:{name}        zset   demandes reçues (nom -> date)
  freq:out:{name}       zset   demandes envoyées
  seen:{name}           string dernière activité (TTL)
  user:{name}.showcase  champ  cartes en vitrine, séparées par des virgules (6 max)
  trade:{id}            hash   from, to, give, want (JSON vid -> n), coins_give, coins_want, status…
  trades:{name}         zset   échanges d'un joueur (id -> date)
  trades:pending        zset   id -> expiration
  duel:{id}             hash   from, to, stake, status, winner, result (JSON)…
  duels:{name}          zset   duels d'un joueur
  duels:pending         zset   id -> expiration
  report:{vid}          hash   joueur -> JSON {reason, comment, t}
  reports               zset   vid -> nombre de signalements
  blacklist             set    vidéos retirées du jeu (le worker ne les réintègre pas)

Importé à la fin d'app.py : il réutilise son application, sa connexion Redis et ses helpers.
"""
import asyncio
import json
import math
import random
import secrets
import time

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

import lua
from app import (MIN_VIEWS, PERIODIC, TIER_VALUE, TIERS, USERNAME_RE, app, card, cards_for, client_ip,
                 current_user, log, notify, power_of, r, rate_limit, require_admin, require_json,
                 sc_cancel, tier_key)

MAX_FRIENDS = 200
SHOWCASE_MAX = 6
TRADE_TTL = 72 * 3600
TRADE_MAX_ITEMS = 10
DUEL_TTL = 24 * 3600
DUEL_MAX_STAKE = 100_000
PAGE = 48
ONLINE = 300                      # « en ligne » : actif dans les 5 dernières minutes
REASONS = {
    "pas_fr": "Pas en français",
    "choquant": "Contenu choquant ou inapproprié",
    "indispo": "Vidéo supprimée ou privée",
    "spam": "Spam, arnaque ou contenu trompeur",
    "autre": "Autre",
}
rng = random.SystemRandom()

sc_trade = r.register_script(lua.TRADE_EXEC)
sc_trade_close = r.register_script(lua.TRADE_CLOSE)
sc_duel_create = r.register_script(lua.DUEL_CREATE)
sc_duel_resolve = r.register_script(lua.DUEL_RESOLVE)
sc_duel_cancel = r.register_script(lua.DUEL_CANCEL)
sc_remove_card = r.register_script(lua.REMOVE_CARD)


# ---------- Utilitaires ----------
async def exists(name):
    return bool(USERNAME_RE.match(name or "")) and await r.hexists(f"user:{name.lower()}", "pw")


async def friends_of(name):
    return await r.smembers(f"friends:{name}")


async def people(names, viewer=None):
    """Fiches courtes de joueurs : pseudo, avatar, puissance, en ligne, guilde."""
    names = list(dict.fromkeys(names))
    if not names:
        return []
    pipe = r.pipeline()
    for n in names:
        pipe.hmget(f"user:{n}", "display", "avatar", "packs", "guild", "duels_won", "duels_lost")
        pipe.get(f"seen:{n}")
        pipe.hlen(f"coll:{n}")
    res = await pipe.execute()
    gids = {res[3 * i][3] for i in range(len(names)) if res[3 * i][3]}
    tags = {}
    if gids:
        pipe = r.pipeline()
        for g in gids:
            pipe.hget(f"guild:{g}", "tag")
        tags = dict(zip(gids, await pipe.execute()))
    now = time.time()
    out = []
    for i, n in enumerate(names):
        display, avatar, packs, gid, won, lost = res[3 * i]
        seen = int(res[3 * i + 1] or 0)
        out.append({
            "name": n, "username": display or n, "avatar": avatar or "🎴",
            "packs": int(packs or 0), "unique": res[3 * i + 2], "power": await power_of(n),
            "online": now - seen < ONLINE, "seen": seen, "tag": tags.get(gid) if gid else None,
            "won": int(won or 0), "lost": int(lost or 0),
        })
    return out


class NameRef(BaseModel):
    name: str


class VideoRef(BaseModel):
    id: str


# ---------- Amis ----------
@app.get("/api/friends")
async def friends(user=Depends(current_user)):
    incoming = await r.zrevrange(f"freq:in:{user}", 0, 99)
    outgoing = await r.zrevrange(f"freq:out:{user}", 0, 99)
    mates = await people(sorted(await friends_of(user)), user)
    mates.sort(key=lambda p: (not p["online"], -p["power"]))
    return {"friends": mates, "incoming": await people(incoming), "outgoing": await people(outgoing),
            "max": MAX_FRIENDS}


@app.post("/api/friends/request", dependencies=[Depends(require_json)])
async def friend_request(body: NameRef, request: Request, user=Depends(current_user)):
    await rate_limit(f"rl:friend:{user}", 40, 3600)
    target = body.name.strip().lower()
    if target == user:
        raise HTTPException(400, "On ne peut pas s'ajouter soi-même.")
    if not await exists(target):
        raise HTTPException(404, "Aucun joueur ne porte ce pseudo.")
    if await r.sismember(f"friends:{user}", target):
        raise HTTPException(409, "Vous êtes déjà amis.")
    if await r.scard(f"friends:{user}") >= MAX_FRIENDS:
        raise HTTPException(409, f"Maximum {MAX_FRIENDS} amis.")
    # Il m'avait déjà demandé : on accepte directement.
    if await r.zscore(f"freq:in:{user}", target) is not None:
        return await _accept(user, target)
    if await r.zscore(f"freq:out:{user}", target) is not None:
        raise HTTPException(409, "Demande déjà envoyée.")
    now = int(time.time())
    pipe = r.pipeline()
    pipe.zadd(f"freq:out:{user}", {target: now})
    pipe.zadd(f"freq:in:{target}", {user: now})
    await pipe.execute()
    await notify(target, "friend", f"{user} veut devenir ton ami.")
    return {"status": "sent"}


async def _accept(user, other):
    pipe = r.pipeline()
    pipe.sadd(f"friends:{user}", other)
    pipe.sadd(f"friends:{other}", user)
    for a, b in ((user, other), (other, user)):
        pipe.zrem(f"freq:in:{a}", b)
        pipe.zrem(f"freq:out:{a}", b)
    await pipe.execute()
    await notify(other, "friend", f"{user} a accepté ta demande d'ami.")
    return {"status": "friends"}


class FriendAnswer(BaseModel):
    name: str
    accept: bool


@app.post("/api/friends/respond", dependencies=[Depends(require_json)])
async def friend_respond(body: FriendAnswer, user=Depends(current_user)):
    other = body.name.lower()
    if await r.zscore(f"freq:in:{user}", other) is None:
        raise HTTPException(404, "Aucune demande de ce joueur.")
    if body.accept:
        if await r.scard(f"friends:{user}") >= MAX_FRIENDS:
            raise HTTPException(409, f"Maximum {MAX_FRIENDS} amis.")
        return await _accept(user, other)
    pipe = r.pipeline()
    pipe.zrem(f"freq:in:{user}", other)
    pipe.zrem(f"freq:out:{other}", user)
    await pipe.execute()
    return {"status": "declined"}


@app.post("/api/friends/cancel", dependencies=[Depends(require_json)])
async def friend_cancel(body: NameRef, user=Depends(current_user)):
    other = body.name.lower()
    pipe = r.pipeline()
    pipe.zrem(f"freq:out:{user}", other)
    pipe.zrem(f"freq:in:{other}", user)
    await pipe.execute()
    return {"ok": True}


@app.post("/api/friends/remove", dependencies=[Depends(require_json)])
async def friend_remove(body: NameRef, user=Depends(current_user)):
    other = body.name.lower()
    pipe = r.pipeline()
    pipe.srem(f"friends:{user}", other)
    pipe.srem(f"friends:{other}", user)
    await pipe.execute()
    return {"ok": True}


# ---------- Vitrine ----------
async def showcase_ids(name):
    raw = await r.hget(f"user:{name}", "showcase") or ""
    return [v for v in raw.split(",") if v]


@app.post("/api/showcase/toggle", dependencies=[Depends(require_json)])
async def showcase_toggle(body: VideoRef, user=Depends(current_user)):
    ids = await showcase_ids(user)
    if body.id in ids:
        ids.remove(body.id)
        added = False
    else:
        if not await r.hexists(f"coll:{user}", body.id):
            raise HTTPException(409, "Tu ne possèdes pas cette carte.")
        # On purge au passage les cartes de la vitrine qu'on ne possède plus.
        pipe = r.pipeline()
        for v in ids:
            pipe.hexists(f"coll:{user}", v)
        ids = [v for v, ok in zip(ids, await pipe.execute()) if ok]
        if len(ids) >= SHOWCASE_MAX:
            raise HTTPException(409, f"Ta vitrine est pleine ({SHOWCASE_MAX} cartes). Retires-en une d'abord.")
        ids.append(body.id)
        added = True
    await r.hset(f"user:{user}", "showcase", ",".join(ids))
    return {"showcase": ids, "added": added}


class ShowcaseOrder(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=SHOWCASE_MAX)


@app.post("/api/showcase", dependencies=[Depends(require_json)])
async def showcase_set(body: ShowcaseOrder, user=Depends(current_user)):
    ids = list(dict.fromkeys(body.ids))
    pipe = r.pipeline()
    for v in ids:
        pipe.hexists(f"coll:{user}", v)
    ids = [v for v, ok in zip(ids, await pipe.execute()) if ok]
    await r.hset(f"user:{user}", "showcase", ",".join(ids))
    return {"showcase": ids}


# ---------- Explorateur ----------
# Le catalogue complet est gardé en mémoire deux minutes : chercher dans les titres exige
# de tout relire, et Redis n'a pas d'index plein texte dans cette configuration.
_catalog = {"at": 0.0, "rows": []}
_catalog_lock = asyncio.Lock()


def invalidate_catalog():
    _catalog["at"] = 0.0


async def catalog():
    if _catalog["rows"] and time.time() - _catalog["at"] < 120:
        return _catalog["rows"]
    async with _catalog_lock:
        if _catalog["rows"] and time.time() - _catalog["at"] < 120:
            return _catalog["rows"]
        pairs = await r.zrevrange("videos:by_views", 0, -1, withscores=True)
        rows = []
        for i in range(0, len(pairs), 1000):
            chunk = pairs[i:i + 1000]
            pipe = r.pipeline()
            for vid, _ in chunk:
                pipe.hmget(f"video:{vid}", "title", "channel", "category", "year", "likes")
            for (vid, views), (title, channel, cat, year, likes) in zip(chunk, await pipe.execute()):
                rows.append({
                    "id": vid, "title": title or "", "channel": channel or "", "views": int(views),
                    "likes": int(likes) if likes not in (None, "") else None,
                    "category": cat or "autre", "year": year or "", "tier": tier_key(int(views)),
                    "_q": f"{title} {channel}".lower(),
                })
        _catalog.update(at=time.time(), rows=rows)
        return rows


@app.get("/api/explore")
async def explore(tier: str = "all", q: str = "", sort: str = "views", owned: str = "all",
                  page: int = 0, user=Depends(current_user)):
    rows = await catalog()
    mine = await r.hgetall(f"coll:{user}")
    counts = {k: 0 for k in TIER_VALUE}
    have = {k: 0 for k in TIER_VALUE}
    for c in rows:
        counts[c["tier"]] += 1
        if c["id"] in mine:
            have[c["tier"]] += 1
    items = rows
    if tier in TIER_VALUE:
        items = [c for c in items if c["tier"] == tier]
    if q.strip():
        needle = q.strip().lower()
        items = [c for c in items if needle in c["_q"]]
    if owned == "mine":
        items = [c for c in items if c["id"] in mine]
    elif owned == "missing":
        items = [c for c in items if c["id"] not in mine]
    if sort == "views_asc":
        items = list(reversed(items))
    elif sort == "title":
        items = sorted(items, key=lambda c: c["title"].lower())
    elif sort == "channel":
        items = sorted(items, key=lambda c: (c["channel"].lower(), -c["views"]))
    total = len(items)
    pages = max(1, math.ceil(total / PAGE))
    page = max(0, min(page, pages - 1))
    chunk = [{k: v for k, v in c.items() if k != "_q"} | {"count": int(mine.get(c["id"], 0))}
             for c in items[page * PAGE:(page + 1) * PAGE]]
    return {
        "items": chunk, "total": total, "page": page, "pages": pages, "size": PAGE,
        "tiers": [{"key": k, "name": n, "total": counts[k], "owned": have[k]} for k, n, *_ in TIERS],
        "catalog": len(rows), "owned": sum(have.values()),
    }


# ---------- Fiche d'une carte ----------
@app.get("/api/card/{vid}")
async def card_detail(vid: str, user=Depends(current_user)):
    h = await r.hgetall(f"video:{vid}")
    if not h:
        raise HTTPException(404, "Carte inconnue.")
    c = card(vid, h)
    names = sorted(await r.smembers("users"))
    pipe = r.pipeline()
    for n in names:
        pipe.hget(f"coll:{n}", vid)
    counts = dict(zip(names, await pipe.execute()))
    mates = await friends_of(user)
    live = []
    for aid in await r.zrange("auctions:live", 0, 499):
        a = await r.hmget(f"auction:{aid}", "vid", "price", "ends", "seller")
        if a[0] == vid:
            live.append({"id": aid, "price": int(a[1] or 0), "ends": int(a[2] or 0), "seller": a[3]})
    return {
        "card": c, "count": int(counts.get(user) or 0),
        "value": TIER_VALUE[c["tier"]],
        "owners": sum(1 for v in counts.values() if v and int(v) > 0),
        "friends": sorted(n for n in mates if counts.get(n) and int(counts[n]) > 0),
        "showcase": vid in await showcase_ids(user),
        "reported": await r.hexists(f"report:{vid}", user),
        "blacklisted": h.get("bl") == "1",
        "auctions": live,
        "admin": bool(await r.sismember("admins", user)),
    }


# ---------- Échanges entre amis ----------
class TradeProposal(BaseModel):
    to: str
    give: dict[str, int] = Field(default_factory=dict)
    want: dict[str, int] = Field(default_factory=dict)
    coins_give: int = Field(default=0, ge=0, le=10_000_000)
    coins_want: int = Field(default=0, ge=0, le=10_000_000)
    message: str = ""


def _clean_items(items, label):
    if len(items) > TRADE_MAX_ITEMS:
        raise HTTPException(400, f"{TRADE_MAX_ITEMS} cartes différentes au plus de chaque côté.")
    for vid, n in items.items():
        if len(vid) != 11 or not 1 <= n <= 99:
            raise HTTPException(400, f"Carte invalide dans « {label} ».")
    return items


async def _check_owned(name, items):
    pipe = r.pipeline()
    for vid in items:
        pipe.hget(f"coll:{name}", vid)
    for (vid, n), have in zip(items.items(), await pipe.execute()):
        if int(have or 0) < n:
            return vid
    return None


@app.post("/api/trades/propose", dependencies=[Depends(require_json)])
async def trade_propose(body: TradeProposal, user=Depends(current_user)):
    await rate_limit(f"rl:trade:{user}", 30, 3600)
    to = body.to.lower()
    if to == user:
        raise HTTPException(400, "On n'échange pas avec soi-même.")
    if not await r.sismember(f"friends:{user}", to):
        raise HTTPException(403, "Les échanges se font entre amis.")
    give, want = _clean_items(body.give, "tu donnes"), _clean_items(body.want, "tu demandes")
    if set(give) & set(want):
        raise HTTPException(400, "Une même carte ne peut pas être des deux côtés.")
    if not (give or want or body.coins_give or body.coins_want):
        raise HTTPException(400, "L'échange est vide.")
    if not (give or body.coins_give):
        raise HTTPException(400, "Propose au moins une carte ou des pièces.")
    missing = await _check_owned(user, give)
    if missing:
        raise HTTPException(409, "Tu n'as pas assez d'exemplaires d'une des cartes proposées.")
    missing = await _check_owned(to, want)
    if missing:
        raise HTTPException(409, f"{to} n'a pas une des cartes demandées.")
    if int(await r.hget(f"user:{user}", "coins") or 0) < body.coins_give:
        raise HTTPException(402, "Pièces insuffisantes.")
    pending = [t for t in await r.zrevrange(f"trades:{user}", 0, 99)
               if await r.hget(f"trade:{t}", "status") == "pending"
               and await r.hget(f"trade:{t}", "from") == user]
    if len(pending) >= 20:
        raise HTTPException(409, "Tu as déjà 20 propositions en attente.")
    now = int(time.time())
    tid = f"{now:x}{secrets.token_hex(4)}"
    pipe = r.pipeline()
    pipe.hset(f"trade:{tid}", mapping={
        "id": tid, "from": user, "to": to, "give": json.dumps(give), "want": json.dumps(want),
        "coins_give": body.coins_give, "coins_want": body.coins_want,
        "message": body.message.strip()[:200], "status": "pending",
        "created": now, "expires": now + TRADE_TTL,
    })
    for n in (user, to):
        pipe.zadd(f"trades:{n}", {tid: now})
        pipe.zremrangebyrank(f"trades:{n}", 0, -101)
    pipe.zadd("trades:pending", {tid: now + TRADE_TTL})
    await pipe.execute()
    await notify(to, "trade", f"{user} te propose un échange.")
    return {"id": tid}


async def trade_view(tid, cards_by_id=None):
    t = await r.hgetall(f"trade:{tid}")
    if not t:
        return None
    give, want = json.loads(t.get("give") or "{}"), json.loads(t.get("want") or "{}")
    cards_by_id = cards_by_id or await cards_for(list(give) + list(want))
    side = lambda items: [{"card": cards_by_id.get(v), "id": v, "count": n} for v, n in items.items()]
    return {
        "id": tid, "from": t["from"], "to": t["to"], "status": t["status"],
        "give": side(give), "want": side(want),
        "coins_give": int(t.get("coins_give") or 0), "coins_want": int(t.get("coins_want") or 0),
        "message": t.get("message", ""), "created": int(t.get("created") or 0),
        "expires": int(t.get("expires") or 0), "closed": int(t.get("closed") or 0),
        "reason": t.get("reason", ""),
    }


@app.get("/api/trades")
async def trades(user=Depends(current_user)):
    out = {"incoming": [], "outgoing": [], "history": []}
    for tid in await r.zrevrange(f"trades:{user}", 0, 59):
        t = await trade_view(tid)
        if not t:
            continue
        if t["status"] == "pending":
            out["incoming" if t["to"] == user else "outgoing"].append(t)
        elif len(out["history"]) < 30:
            out["history"].append(t)
    return out


def _trade_args(t, raw):
    give, want = json.loads(raw["give"] or "{}"), json.loads(raw["want"] or "{}")
    args = [raw["from"], raw["to"], int(raw["coins_give"] or 0), int(raw["coins_want"] or 0),
            t, int(time.time()), len(give)]
    for vid, n in give.items():
        args += [vid, n]
    args.append(len(want))
    for vid, n in want.items():
        args += [vid, n]
    return args


async def _close_trade(tid, status, reason=""):
    res = await sc_trade_close(keys=[f"trade:{tid}"], args=[status, int(time.time()), tid])
    if reason and res[0] == "OK":
        await r.hset(f"trade:{tid}", "reason", reason)
    return res[0] == "OK"


class TradeRef(BaseModel):
    id: str


@app.post("/api/trades/accept", dependencies=[Depends(require_json)])
async def trade_accept(body: TradeRef, user=Depends(current_user)):
    raw = await r.hgetall(f"trade:{body.id}")
    if not raw or raw["to"] != user:
        raise HTTPException(404, "Échange introuvable.")
    if raw["status"] != "pending":
        raise HTTPException(409, "Cet échange n'est plus en attente.")
    res = await sc_trade(args=_trade_args(body.id, raw))
    code = res[0]
    if code == "OK":
        await notify(raw["from"], "trade", f"{user} a accepté ton échange.")
        return {"ok": True}
    if code == "CLOSED":
        raise HTTPException(409, "Cet échange n'est plus en attente.")
    # Les conditions ne sont plus réunies : l'échange échoue pour de bon, on prévient.
    why = {
        "MISSING_GIVE": f"{raw['from']} n'a plus toutes les cartes proposées.",
        "MISSING_WANT": "Tu n'as plus toutes les cartes demandées.",
        "FUNDS_GIVE": f"{raw['from']} n'a plus assez de pièces.",
        "FUNDS_WANT": "Tu n'as pas assez de pièces.",
    }.get(code, "Échange impossible.")
    if code in ("MISSING_GIVE", "FUNDS_GIVE"):
        await _close_trade(body.id, "failed", why)
        await notify(raw["from"], "trade", f"Ton échange avec {user} a échoué : {why}")
    raise HTTPException(409, why)


@app.post("/api/trades/decline", dependencies=[Depends(require_json)])
async def trade_decline(body: TradeRef, user=Depends(current_user)):
    raw = await r.hgetall(f"trade:{body.id}")
    if not raw or raw["to"] != user:
        raise HTTPException(404, "Échange introuvable.")
    if not await _close_trade(body.id, "declined"):
        raise HTTPException(409, "Cet échange n'est plus en attente.")
    await notify(raw["from"], "trade", f"{user} a refusé ton échange.")
    return {"ok": True}


@app.post("/api/trades/cancel", dependencies=[Depends(require_json)])
async def trade_cancel(body: TradeRef, user=Depends(current_user)):
    raw = await r.hgetall(f"trade:{body.id}")
    if not raw or raw["from"] != user:
        raise HTTPException(404, "Échange introuvable.")
    if not await _close_trade(body.id, "cancelled"):
        raise HTTPException(409, "Cet échange n'est plus en attente.")
    return {"ok": True}


# ---------- Duels ----------
# La puissance est la somme des vues des cartes uniques d'une collection. Un duel se joue
# en trois manches maximum ; à chaque manche, la jauge est partagée selon la racine carrée
# des puissances et un tirage désigne le vainqueur. La racine laisse sa chance au plus
# faible : 10 fois moins puissant, on gagne encore une manche sur quatre.
def round_odds(pa, pb):
    if pa <= 0 and pb <= 0:
        return 0.5
    a, b = math.sqrt(max(pa, 0)), math.sqrt(max(pb, 0))
    return a / (a + b)


def match_odds(p):
    return p * p * (3 - 2 * p)          # probabilité de gagner deux manches avant l'autre


def play(pa, pb):
    p = round_odds(pa, pb)
    rounds, a, b = [], 0, 0
    while a < 2 and b < 2:
        roll = rng.random()
        if roll < p:
            a += 1
        else:
            b += 1
        rounds.append(round(roll, 4))
    return {"pa": pa, "pb": pb, "p": round(p, 4), "rounds": rounds, "score": [a, b]}, a == 2


class DuelChallenge(BaseModel):
    to: str
    stake: int = Field(default=0, ge=0, le=DUEL_MAX_STAKE)


@app.get("/api/duels/odds/{name}")
async def duel_odds(name: str, user=Depends(current_user)):
    other = name.lower()
    if not await exists(other):
        raise HTTPException(404, "Joueur inconnu.")
    pa, pb = await power_of(user), await power_of(other)
    p = round_odds(pa, pb)
    return {"me": pa, "them": pb, "round": p, "match": match_odds(p)}


@app.post("/api/duels/challenge", dependencies=[Depends(require_json)])
async def duel_challenge(body: DuelChallenge, user=Depends(current_user)):
    await rate_limit(f"rl:duel:{user}", 40, 3600)
    to = body.to.strip().lower()
    if to == user:
        raise HTTPException(400, "On ne se défie pas soi-même.")
    if not await exists(to):
        raise HTTPException(404, "Joueur inconnu.")
    mine = await r.zrevrange(f"duels:{user}", 0, 99)
    pending = 0
    for d in mine:
        h = await r.hmget(f"duel:{d}", "status", "from", "to")
        if h[0] != "pending":
            continue
        if {h[1], h[2]} == {user, to}:
            raise HTTPException(409, "Un défi est déjà en cours entre vous deux.")
        pending += h[1] == user
    if pending >= 10:
        raise HTTPException(409, "Tu as déjà 10 défis en attente.")
    now = int(time.time())
    did = f"{now:x}{secrets.token_hex(4)}"
    res = await sc_duel_create(keys=[f"user:{user}", f"duel:{did}"],
                               args=[body.stake, did, user, to, now, now + DUEL_TTL])
    if res[0] == "FUNDS":
        raise HTTPException(402, "Tu n'as pas assez de pièces pour cette mise.")
    pipe = r.pipeline()
    for n in (user, to):
        pipe.zadd(f"duels:{n}", {did: now})
        pipe.zremrangebyrank(f"duels:{n}", 0, -101)
    await pipe.execute()
    stake = f" (mise : {body.stake} pièces)" if body.stake else ""
    await notify(to, "duel", f"{user} te défie en duel{stake}.")
    return {"id": did}


async def duel_view(did, viewer):
    d = await r.hgetall(f"duel:{did}")
    if not d:
        return None
    out = {
        "id": did, "from": d["from"], "to": d["to"], "stake": int(d.get("stake") or 0),
        "status": d["status"], "created": int(d.get("created") or 0),
        "expires": int(d.get("expires") or 0), "winner": d.get("winner"),
        "result": json.loads(d["result"]) if d.get("result") else None,
    }
    if d["status"] == "pending":
        pa, pb = await power_of(d["from"]), await power_of(d["to"])
        p = round_odds(pa, pb)
        out["live"] = {"pa": pa, "pb": pb, "p": p, "match": match_odds(p)}
    return out


@app.get("/api/duels")
async def duels(user=Depends(current_user)):
    out = {"incoming": [], "outgoing": [], "history": []}
    for did in await r.zrevrange(f"duels:{user}", 0, 59):
        d = await duel_view(did, user)
        if not d:
            continue
        if d["status"] == "pending":
            out["incoming" if d["to"] == user else "outgoing"].append(d)
        elif len(out["history"]) < 30:
            out["history"].append(d)
    u = await r.hmget(f"user:{user}", "duels_won", "duels_lost")
    out["me"] = {"power": await power_of(user), "won": int(u[0] or 0), "lost": int(u[1] or 0)}
    return out


class DuelRef(BaseModel):
    id: str


@app.post("/api/duels/accept", dependencies=[Depends(require_json)])
async def duel_accept(body: DuelRef, user=Depends(current_user)):
    d = await r.hgetall(f"duel:{body.id}")
    if not d or d["to"] != user:
        raise HTTPException(404, "Défi introuvable.")
    if d["status"] != "pending":
        raise HTTPException(409, "Ce défi n'est plus en attente.")
    pa = await power_of(d["from"], fresh=True)
    pb = await power_of(user, fresh=True)
    result, from_wins = play(pa, pb)
    winner = d["from"] if from_wins else user
    res = await sc_duel_resolve(keys=[f"duel:{body.id}"], args=[winner, json.dumps(result), int(time.time())])
    if res[0] == "FUNDS":
        raise HTTPException(402, "Tu n'as pas assez de pièces pour suivre la mise.")
    if res[0] == "CLOSED":
        raise HTTPException(409, "Ce défi n'est plus en attente.")
    stake = int(d.get("stake") or 0)
    gain = f" et remporte {2 * stake} pièces" if stake else ""
    loser = user if from_wins else d["from"]
    await notify(winner, "duel", f"Victoire contre {loser} ({result['score'][0]}-{result['score'][1]}){gain} !")
    await notify(loser, "duel", f"Défaite contre {winner} ({result['score'][0]}-{result['score'][1]}).")
    return await duel_view(body.id, user)


async def _cancel_duel(did, status):
    return (await sc_duel_cancel(keys=[f"duel:{did}"], args=[status, int(time.time())]))[0] == "OK"


@app.post("/api/duels/decline", dependencies=[Depends(require_json)])
async def duel_decline(body: DuelRef, user=Depends(current_user)):
    d = await r.hgetall(f"duel:{body.id}")
    if not d or d["to"] != user:
        raise HTTPException(404, "Défi introuvable.")
    if not await _cancel_duel(body.id, "declined"):
        raise HTTPException(409, "Ce défi n'est plus en attente.")
    await notify(d["from"], "duel", f"{user} a refusé ton défi. Ta mise t'est rendue.")
    return {"ok": True}


@app.post("/api/duels/cancel", dependencies=[Depends(require_json)])
async def duel_cancel(body: DuelRef, user=Depends(current_user)):
    d = await r.hgetall(f"duel:{body.id}")
    if not d or d["from"] != user:
        raise HTTPException(404, "Défi introuvable.")
    if not await _cancel_duel(body.id, "cancelled"):
        raise HTTPException(409, "Ce défi n'est plus en attente.")
    return {"ok": True}


# ---------- Expirations (appelé par la boucle de fond d'app.py) ----------
async def expire_social():
    now = int(time.time())
    for tid in await r.zrangebyscore("trades:pending", "-inf", now, start=0, num=50):
        frm = await r.hget(f"trade:{tid}", "from")
        if await _close_trade(tid, "expired") and frm:
            await notify(frm, "trade", "Une de tes propositions d'échange a expiré sans réponse.")
        await r.zrem("trades:pending", tid)
    for did in await r.zrangebyscore("duels:pending", "-inf", now, start=0, num=50):
        frm = await r.hget(f"duel:{did}", "from")
        if await _cancel_duel(did, "expired") and frm:
            await notify(frm, "duel", "Un de tes défis a expiré sans réponse. Ta mise t'est rendue.")
        await r.zrem("duels:pending", did)

PERIODIC.append(expire_social)


# ---------- Signalements ----------
class Report(BaseModel):
    id: str
    reason: str
    comment: str = ""


@app.post("/api/report", dependencies=[Depends(require_json)])
async def report(body: Report, user=Depends(current_user)):
    await rate_limit(f"rl:report:{user}", 20, 3600)
    if body.reason not in REASONS:
        raise HTTPException(400, "Motif inconnu.")
    if not await r.exists(f"video:{body.id}"):
        raise HTTPException(404, "Carte inconnue.")
    entry = json.dumps({"reason": body.reason, "comment": body.comment.strip()[:300], "t": int(time.time())})
    if not await r.hsetnx(f"report:{body.id}", user, entry):
        raise HTTPException(409, "Tu as déjà signalé cette vidéo. Merci !")
    await r.zincrby("reports", 1, body.id)
    return {"ok": True}


@app.get("/api/admin/reports")
async def admin_reports(user=Depends(require_admin)):
    rows = await r.zrevrange("reports", 0, 99, withscores=True)
    cards_by_id = await cards_for([v for v, _ in rows])
    out = []
    for vid, n in rows:
        entries = []
        for who, raw in (await r.hgetall(f"report:{vid}")).items():
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            entries.append({"user": who, **e, "label": REASONS.get(e.get("reason"), "Autre")})
        entries.sort(key=lambda e: -e.get("t", 0))
        reasons = {}
        for e in entries:
            reasons[e["label"]] = reasons.get(e["label"], 0) + 1
        out.append({"id": vid, "count": int(n), "card": cards_by_id.get(vid),
                    "reasons": reasons, "entries": entries[:8]})
    return {"items": out, "reasons": REASONS}


@app.post("/api/admin/reports/dismiss", dependencies=[Depends(require_json)])
async def admin_dismiss(body: VideoRef, admin=Depends(require_admin)):
    pipe = r.pipeline()
    pipe.zrem("reports", body.id)
    pipe.delete(f"report:{body.id}")
    await pipe.execute()
    log.info("Admin %s : signalements de %s classés sans suite", admin, body.id)
    return {"ok": True}


class BlacklistRequest(BaseModel):
    id: str
    reason: str = ""


@app.post("/api/admin/blacklist", dependencies=[Depends(require_json)])
async def admin_blacklist(body: BlacklistRequest, admin=Depends(require_admin)):
    vid = body.id
    h = await r.hgetall(f"video:{vid}")
    if not h:
        raise HTTPException(404, "Vidéo inconnue.")
    title = h.get("title", vid)
    value = TIER_VALUE[tier_key(int(h.get("views") or 0))]
    # 1. Hors du jeu : plus de tirage, plus de rafraîchissement, le worker ne la reprendra pas.
    pipe = r.pipeline()
    pipe.hset(f"video:{vid}", mapping={"bl": "1", "bl_reason": body.reason.strip()[:200],
                                       "bl_at": int(time.time()), "bl_by": admin})
    pipe.sadd("blacklist", vid)
    pipe.zrem("videos:by_views", vid)
    pipe.zrem("videos:updated", vid)
    pipe.srem("queue:enrich", vid)
    pipe.zrem("reports", vid)
    pipe.delete(f"report:{vid}")
    await pipe.execute()
    # 2. Ventes en cours : annulées, carte rendue au vendeur (retirée à l'étape 3), mise remboursée.
    for aid in await r.zrange("auctions:live", 0, -1):
        if await r.hget(f"auction:{aid}", "vid") == vid:
            await sc_cancel(keys=[f"auction:{aid}", "auctions:live"], args=[aid, "admin", int(time.time())])
    # 3. Collections : chaque exemplaire est remboursé à sa valeur de recyclage.
    players, copies = 0, 0
    for name in await r.smembers("users"):
        n = int((await sc_remove_card(keys=[f"coll:{name}", f"user:{name}"], args=[vid, value]))[0])
        if n:
            players += 1
            copies += n
            await notify(name, "admin", f"« {title} » a été retirée du jeu. "
                                        f"{n} exemplaire(s) remboursé(s) : +{n * value} pièces.")
    invalidate_catalog()
    log.info("Admin %s : %s mise en liste noire (%d joueurs, %d exemplaires)", admin, vid, players, copies)
    return {"players": players, "copies": copies, "refund": copies * value}


@app.get("/api/admin/blacklist")
async def admin_blacklist_list(user=Depends(require_admin)):
    out = []
    for vid in await r.smembers("blacklist"):
        h = await r.hgetall(f"video:{vid}")
        out.append({"id": vid, "title": h.get("title", ""), "channel": h.get("channel", ""),
                    "views": int(h.get("views") or 0), "reason": h.get("bl_reason", ""),
                    "at": int(h.get("bl_at") or 0), "by": h.get("bl_by", "")})
    out.sort(key=lambda x: -x["at"])
    return {"items": out}


@app.post("/api/admin/unblacklist", dependencies=[Depends(require_json)])
async def admin_unblacklist(body: VideoRef, admin=Depends(require_admin)):
    h = await r.hgetall(f"video:{body.id}")
    if not h or not await r.sismember("blacklist", body.id):
        raise HTTPException(404, "Cette vidéo n'est pas en liste noire.")
    views = int(h.get("views") or 0)
    pipe = r.pipeline()
    pipe.srem("blacklist", body.id)
    pipe.hdel(f"video:{body.id}", "bl", "bl_reason", "bl_at", "bl_by")
    if views >= MIN_VIEWS:
        pipe.zadd("videos:by_views", {body.id: views})
    pipe.zadd("videos:updated", {body.id: int(time.time())})
    await pipe.execute()
    invalidate_catalog()
    log.info("Admin %s : %s retirée de la liste noire", admin, body.id)
    return {"ok": True}


# ---------- Pastilles de la navigation ----------
@app.get("/api/social/counts")
async def social_counts(user=Depends(current_user)):
    """Ce qui attend une réponse du joueur : de quoi allumer les pastilles de l'app."""
    trades_in = duels_in = 0
    for tid in await r.zrevrange(f"trades:{user}", 0, 49):
        h = await r.hmget(f"trade:{tid}", "status", "to")
        trades_in += h[0] == "pending" and h[1] == user
    for did in await r.zrevrange(f"duels:{user}", 0, 49):
        h = await r.hmget(f"duel:{did}", "status", "to")
        duels_in += h[0] == "pending" and h[1] == user
    out = {"friends": await r.zcard(f"freq:in:{user}"), "trades": trades_in, "duels": duels_in}
    if await r.sismember("admins", user):
        out["reports"] = await r.zcard("reports")
    return out


@app.get("/api/collection/{name}")
async def friend_collection(name: str, user=Depends(current_user)):
    """Collection complète d'un ami : de quoi choisir les cartes à lui demander."""
    other = name.lower()
    if other != user and not await r.sismember(f"friends:{user}", other):
        raise HTTPException(403, "Seule la collection de tes amis est consultable.")
    owned = await r.hgetall(f"coll:{other}")
    by_id = await cards_for(list(owned))
    cards = [dict(c, count=int(owned[v])) for v, c in by_id.items()]
    cards.sort(key=lambda c: -c["views"])
    return {"name": other, "cards": cards}
