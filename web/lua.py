"""Scripts Lua : toutes les opérations qui touchent aux pièces ou aux cartes.

Redis exécute un script d'un bloc : impossible qu'une enchère double-débite, qu'une
carte soit vendue deux fois ou qu'un remboursement se perde entre deux requêtes.
"""

# Crédite les tickets accumulés depuis la dernière visite. -> {tickets, ticket_at}
ACCRUE = """
local u, now = KEYS[1], tonumber(ARGV[1])
local interval, maxt = tonumber(ARGV[2]), tonumber(ARGV[3])
local t = tonumber(redis.call('HGET', u, 'tickets') or '0')
local at = tonumber(redis.call('HGET', u, 'ticket_at') or '0')
if at == 0 or at > now then at = now end
if t >= maxt then
  at = now
else
  local gained = math.floor((now - at) / interval)
  if gained > 0 then
    t = math.min(maxt, t + gained)
    at = at + gained * interval
    if t >= maxt then at = now end
  end
end
redis.call('HSET', u, 'tickets', t, 'ticket_at', at)
return {t, at}
"""

# Consomme un ticket et crédite le bonus d'ouverture. -> {'OK', tickets} | {'EMPTY'}
SPEND_TICKET = """
local u = KEYS[1]
local t = tonumber(redis.call('HGET', u, 'tickets') or '0')
if t < 1 then return {'EMPTY'} end
redis.call('HINCRBY', u, 'tickets', -1)
redis.call('HINCRBY', u, 'packs', 1)
redis.call('HINCRBY', u, 'coins', tonumber(ARGV[1]))
return {'OK', t - 1}
"""

# Achète un ticket supplémentaire. -> {'OK', tickets} | {'FUNDS'}
BUY_TICKET = """
local u, price = KEYS[1], tonumber(ARGV[1])
local coins = tonumber(redis.call('HGET', u, 'coins') or '0')
if coins < price then return {'FUNDS'} end
redis.call('HINCRBY', u, 'coins', -price)
local t = redis.call('HINCRBY', u, 'tickets', 1)
if t == 1 then redis.call('HSET', u, 'ticket_at', ARGV[2]) end
return {'OK', t}
"""

# Recycle des doublons (garde toujours un exemplaire). -> {'OK', reste, coins} | {'NONE'}
RECYCLE = """
local coll, u = KEYS[1], KEYS[2]
local vid, n, gain = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local have = tonumber(redis.call('HGET', coll, vid) or '0')
if n < 1 or have - n < 1 then return {'NONE'} end
redis.call('HINCRBY', coll, vid, -n)
local coins = redis.call('HINCRBY', u, 'coins', gain)
return {'OK', have - n, coins}
"""

# Met une carte en vente : la carte quitte la collection (mise sous séquestre).
# -> {'OK'} | {'NONE'} | {'TOOMANY'}
LIST_AUCTION = """
local coll, auc, live = KEYS[1], KEYS[2], KEYS[3]
local vid, id, seller = ARGV[1], ARGV[2], ARGV[3]
local price, ends, now, maxlive = ARGV[4], ARGV[5], ARGV[6], tonumber(ARGV[7])
if redis.call('SCARD', 'seller:' .. seller) >= maxlive then return {'TOOMANY'} end
local have = tonumber(redis.call('HGET', coll, vid) or '0')
if have < 1 then return {'NONE'} end
if have <= 1 then redis.call('HDEL', coll, vid) else redis.call('HINCRBY', coll, vid, -1) end
redis.call('HSET', auc, 'id', id, 'vid', vid, 'seller', seller, 'price', price, 'start', price,
           'bidder', '', 'nbids', 0, 'ends', ends, 'created', now, 'status', 'live')
redis.call('ZADD', live, ends, id)
redis.call('SADD', 'seller:' .. seller, id)
redis.call('ZADD', 'hist:' .. seller, now, id)
redis.call('ZREMRANGEBYRANK', 'hist:' .. seller, 0, -201)
return {'OK'}
"""

# Enchérit : débite l'enchérisseur, rembourse le précédent, prolonge si fin imminente.
# -> {'OK', montant, fin, precedent} | {'LOW', minimum} | {'FUNDS', minimum} | {code}
BID = """
local auc, live = KEYS[1], KEYS[2]
local id, bidder = ARGV[1], ARGV[2]
local amount, now = tonumber(ARGV[3]), tonumber(ARGV[4])
local extend, step_pct = tonumber(ARGV[5]), tonumber(ARGV[6])
if redis.call('EXISTS', auc) == 0 then return {'GONE'} end
if redis.call('HGET', auc, 'status') ~= 'live' then return {'CLOSED'} end
local ends = tonumber(redis.call('HGET', auc, 'ends'))
if now >= ends then return {'CLOSED'} end
if redis.call('HGET', auc, 'seller') == bidder then return {'SELLER'} end
local price = tonumber(redis.call('HGET', auc, 'price'))
local top = redis.call('HGET', auc, 'bidder')
local need = price
if top and top ~= '' then need = price + math.max(1, math.floor(price * step_pct / 100)) end
if amount < need then return {'LOW', need} end
local ukey = 'user:' .. bidder
if tonumber(redis.call('HGET', ukey, 'coins') or '0') < amount then return {'FUNDS', need} end
redis.call('HINCRBY', ukey, 'coins', -amount)
if top and top ~= '' then redis.call('HINCRBY', 'user:' .. top, 'coins', price) end
redis.call('HSET', auc, 'price', amount, 'bidder', bidder)
redis.call('HINCRBY', auc, 'nbids', 1)
if ends - now < extend then
  ends = now + extend
  redis.call('HSET', auc, 'ends', ends)
  redis.call('ZADD', live, ends, id)
end
redis.call('ZADD', 'hist:' .. bidder, now, id)
redis.call('ZADD', 'bids:' .. bidder, now, id)
redis.call('ZREMRANGEBYRANK', 'bids:' .. bidder, 0, -101)
redis.call('ZREMRANGEBYRANK', 'hist:' .. bidder, 0, -201)
return {'OK', amount, ends, top or ''}
"""

# Clôture une enchère arrivée à terme. -> {'SOLD'|'EXPIRED', gagnant, prix, net, vendeur, vid} | {'SKIP'}
SETTLE = """
local auc, live = KEYS[1], KEYS[2]
local id, fee, now = ARGV[1], tonumber(ARGV[2]), ARGV[3]
if redis.call('HGET', auc, 'status') ~= 'live' then
  redis.call('ZREM', live, id)
  return {'SKIP'}
end
local seller = redis.call('HGET', auc, 'seller')
local vid = redis.call('HGET', auc, 'vid')
local top = redis.call('HGET', auc, 'bidder')
local price = tonumber(redis.call('HGET', auc, 'price'))
redis.call('ZREM', live, id)
redis.call('SREM', 'seller:' .. seller, id)
redis.call('ZADD', 'auctions:done', now, id)
if top and top ~= '' then
  redis.call('HINCRBY', 'coll:' .. top, vid, 1)
  local net = price - math.floor(price * fee / 100)
  redis.call('HINCRBY', 'user:' .. seller, 'coins', net)
  redis.call('HSET', auc, 'status', 'sold', 'closed', now, 'net', net)
  redis.call('ZADD', 'hist:' .. top, now, id)
  return {'SOLD', top, price, net, seller, vid}
end
redis.call('HINCRBY', 'coll:' .. seller, vid, 1)
redis.call('HSET', auc, 'status', 'expired', 'closed', now)
return {'EXPIRED', '', price, 0, seller, vid}
"""

# Annule une enchère : carte rendue, enchérisseur remboursé.
# 'user' refuse l'annulation dès qu'il y a une mise ; 'admin' rembourse et annule.
# -> {'OK', precedent, prix} | {'BIDS'} | {'CLOSED'}
CANCEL = """
local auc, live = KEYS[1], KEYS[2]
local id, who, now = ARGV[1], ARGV[2], ARGV[3]
if redis.call('HGET', auc, 'status') ~= 'live' then return {'CLOSED'} end
local top = redis.call('HGET', auc, 'bidder')
local price = tonumber(redis.call('HGET', auc, 'price'))
if who == 'user' and top and top ~= '' then return {'BIDS'} end
local seller = redis.call('HGET', auc, 'seller')
local vid = redis.call('HGET', auc, 'vid')
redis.call('ZREM', live, id)
redis.call('SREM', 'seller:' .. seller, id)
redis.call('ZADD', 'auctions:done', now, id)
if top and top ~= '' then redis.call('HINCRBY', 'user:' .. top, 'coins', price) end
redis.call('HINCRBY', 'coll:' .. seller, vid, 1)
redis.call('HSET', auc, 'status', 'cancelled', 'closed', now)
return {'OK', top or '', price}
"""

# Crédit / débit administrateur, sans jamais passer sous zéro. -> {solde}
ADJUST = """
local u, field, delta = KEYS[1], ARGV[1], tonumber(ARGV[2])
local cur = tonumber(redis.call('HGET', u, field) or '0')
local new = cur + delta
if new < 0 then new = 0 end
redis.call('HSET', u, field, new)
return {new}
"""
