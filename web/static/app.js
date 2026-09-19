/* TubePacks — application (packs, collection, enchères, profil, administration). */
(function () {
"use strict";

const CAT = {
  musique:["🎵","#FF5E7E","#7B2FF7"], aventure:["🏔️","#2BC0A9","#1B4F9C"],
  divertissement:["🎮","#FFB23F","#FF4D4D"], humour:["😂","#FFD84D","#FF7A3D"],
  actu:["📰","#5AA9FF","#2B3A8F"], science:["🔬","#3DD6D0","#2656C9"],
  tech:["💻","#62E08A","#1C6B8A"], nature:["🌿","#7EDC6A","#2A6F3E"], autre:["▶️","#FF4D5E","#6B1A3A"],
};
const DOT = {M:"--m", L:"--l", E:"--e", R:"--r", C:"--c"};

let META = {min_views:10000, tiers:[], pack_interval:600, pack_max:12, pack_price:250, fee:5,
  bid_step:5, avatars:["🎴"], emblems:["🛡️"], durations:["1h"], guild_cost:1000, guild_max:20,
  kofi:"https://ko-fi.com/eirblast"};
const packMax = () => (ME && ME.pack_max) || META.pack_max;
let ME = null, TIERS = [];
let view = "packs";
let coll = {cards:[], tiers:[], dupes:0, scrap:0}, collFilter = "all", collShown = 60;
let marketMode = "all", marketTier = "all", marketItems = [], mine = null;
let adminTab = "overview", adminData = {};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nf = n => Number(n || 0).toLocaleString("fr-FR");
const fmt = n => n >= 1e9 ? (n/1e9).toLocaleString("fr-FR",{maximumFractionDigits:1})+" Md"
  : n >= 1e6 ? (n/1e6).toLocaleString("fr-FR",{maximumFractionDigits:1})+" M"
  : n >= 1e3 ? Math.round(n/1e3).toLocaleString("fr-FR")+" k" : String(n || 0);
const tierName = k => (TIERS.find(t => t.key === k) || {}).name || k;
const tierValue = k => (TIERS.find(t => t.key === k) || {}).value || 0;

function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec/86400), h = Math.floor(sec%86400/3600), m = Math.floor(sec%3600/60), s = sec%60;
  if (d) return d + "j " + h + "h";
  if (h) return h + "h " + String(m).padStart(2,"0") + "m";
  if (m) return m + "m " + String(s).padStart(2,"0") + "s";
  return s + "s";
}
function ago(ts) {
  if (!ts) return "—";
  const s = Date.now()/1000 - ts;
  if (s < 60) return "à l'instant";
  if (s < 3600) return "il y a " + Math.round(s/60) + " min";
  if (s < 86400) return "il y a " + Math.round(s/3600) + " h";
  return "il y a " + Math.round(s/86400) + " j";
}
const dateOf = ts => ts ? new Date(ts*1000).toLocaleDateString("fr-FR",{day:"numeric",month:"long",year:"numeric"}) : "—";

function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2800);
}

async function api(path, body) {
  const opts = body === undefined
    ? {credentials:"same-origin"}
    : {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)};
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("401"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(typeof data.detail === "string" ? data.detail : "Erreur serveur (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return data;
}
const fail = e => { if (e.message !== "401") toast(e.message, "bad"); };

/* ---------------- Fenêtre modale ---------------- */
function modal(opts) {
  const dlg = $("#modal");
  $("#modalTitle").textContent = opts.title || "";
  $("#modalBody").innerHTML = opts.body || "";
  $("#modalFoot").innerHTML = "";
  $("#modalFoot").hidden = !(opts.buttons || []).length;
  dlg.classList.toggle("wide", !!opts.wide);
  (opts.buttons || []).forEach(b => {
    const el = document.createElement("button");
    el.className = "btn " + (b.cls || "");
    el.textContent = b.label;
    el.onclick = () => b.onClick ? b.onClick(dlg, el) : dlg.close();
    $("#modalFoot").appendChild(el);
  });
  dlg.showModal();
  if (opts.onOpen) opts.onOpen(dlg);
  return dlg;
}
$("#modalX").onclick = () => $("#modal").close();

/* ---------------- Carte ---------------- */
const CARDS = {};   // dernière version connue de chaque carte affichée, pour la fiche
function cardHTML(v, o) {
  o = o || {};
  CARDS[v.id] = Object.assign(CARDS[v.id] || {}, v);
  const [emo, a, b] = CAT[v.category] || CAT.autre, id = encodeURIComponent(v.id);
  return `<div class="card ${v.tier}" data-vid="${esc(v.id)}">
    ${v.new ? '<span class="newbadge">Nouveau</span>' : ""}
    <div class="thumb" style="background:linear-gradient(135deg,${a},${b})"><span aria-hidden="true">${emo}</span>
      <img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy"></div>
    <div class="cbody">
      <div class="ctitle">${esc(v.title)}</div>
      <div class="cchan">${esc(v.channel)}${v.year ? " (" + esc(v.year) + ")" : ""}</div>
      ${v.likes != null ? `<div class="likes">👍 ${fmt(v.likes)} j'aime</div>` : ""}
      <div class="cfoot"><span class="views">${fmt(v.views)} <small>vues</small></span><span class="tier">${esc(tierName(v.tier))}</span></div>
    </div>
  </div>`;
}
// Miniature introuvable : on garde le fond coloré (pas de onerror inline, compatible CSP).
document.addEventListener("error", e => {
  if (e.target.tagName === "IMG" && e.target.closest(".thumb, .mini, .mthumb")) e.target.remove();
}, true);

/* ---------------- Barre du haut ---------------- */
function renderWallet() {
  if (!ME) return;
  $("#wCoins").textContent = nf(ME.coins);
  $("#wPacks").textContent = ME.tickets;
  $("#wTimer").textContent = ME.tickets >= packMax() ? "· plein" : "· " + clock(ME.next_pack);
  const pc = $("#packClock");
  if (pc) pc.textContent = clock(ME.next_pack);
  $("#bellDot").hidden = !ME.notifs;
  $("#bellDot").textContent = ME.notifs;
  $$("[data-group='admin'], #adminMenu").forEach(b => { b.hidden = !ME.admin; });
}

async function loadMe() {
  try {
    ME = await api("/api/me");
    renderWallet();
    $("#sPacks").textContent = nf(ME.packs);
    $("#sOwned").textContent = nf(ME.unique);
  } catch (e) { fail(e); }
}

// Décompte local : on ne recontacte le serveur qu'au moment où un pack devient disponible.
setInterval(() => {
  if (ME && ME.tickets < packMax()) {
    ME.next_pack -= 1;
    if (ME.next_pack <= 0) { loadMe().then(() => { if (view === "packs") renderPackTable(); }); }
    else renderWallet();
  }
  tickCountdowns();
}, 1000);

function tickCountdowns() {
  const now = Date.now()/1000;
  $$("[data-ends]").forEach(el => {
    const left = Number(el.dataset.ends) - now;
    el.textContent = left > 0 ? clock(left) : "terminée";
    el.classList.toggle("soon", left > 0 && left < 120);
  });
}

$("#themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("tp:theme", next); } catch (e) {}
};
try { const t = localStorage.getItem("tp:theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

$("#logout").onclick = async () => { try { await api("/api/logout", {}); } catch (e) {} location.href = "/login"; };

$("#bell").onclick = async () => {
  let items = [];
  try { items = (await api("/api/notifications")).items; } catch (e) { return fail(e); }
  modal({
    title: "Notifications",
    body: items.length
      ? `<div class="notiflist">${items.map(n => `<div class="notif">${esc(n.text)}<time>${ago(n.t)}</time></div>`).join("")}</div>`
      : `<p class="empty" style="padding:24px 0"><b>Rien de neuf</b>Tes ventes et tes enchères s'afficheront ici.</p>`,
    buttons: items.length
      ? [{label:"Tout effacer", onClick: async dlg => { await api("/api/notifications/clear", {}); dlg.close(); loadMe(); }},
         {label:"Fermer", cls:"primary", onClick: dlg => dlg.close()}]
      : [{label:"Fermer", cls:"primary", onClick: dlg => dlg.close()}],
  });
};

/* ---------------- Routeur ---------------- */
// Cinq sections (six pour les admins), chacune regroupant une ou plusieurs vues.
const GROUPS = {
  packs: [["packs", "Packs"]],
  cards: [["coll", "Ma collection"], ["explore", "Explorateur"]],
  market: [["market", "Enchères"]],
  social: [["friends", "Amis"], ["trades", "Échanges"], ["duels", "Duels"], ["guild", "Guilde"]],
  profile: [["profile", "Profil"]],
  admin: [["admin", "Admin"]],
};
const groupOf = v => Object.keys(GROUPS).find(g => GROUPS[g].some(([id]) => id === v)) || "packs";
const lastInGroup = {};
const LOADERS = {
  packs: () => { renderPackTable(); loadColl(); },
  coll: () => loadColl(),
  explore: () => loadExplore(),
  market: () => loadMarket(),
  friends: () => loadFriends(),
  trades: () => loadTrades(),
  duels: () => loadDuels(),
  guild: () => loadGuild(),
  profile: () => loadProfile(profileName),
  admin: () => loadAdmin(),
};
function go(name) {
  if (!LOADERS[name]) name = "packs";
  view = name;
  const group = groupOf(name);
  lastInGroup[group] = name;
  $$("[data-group]").forEach(b => b.setAttribute("aria-current", String(b.dataset.group === group)));
  const tabs = GROUPS[group];
  $("#subnav").hidden = tabs.length < 2;
  $("#subnav").innerHTML = tabs.length < 2 ? "" : tabs.map(([id, label]) =>
    `<button data-sub="${id}" aria-current="${id === name}">${label}<i class="ndot" data-dot="${id}" hidden></i></button>`).join("");
  $$("#subnav [data-sub]").forEach(b => b.onclick = () => go(b.dataset.sub));
  Object.keys(LOADERS).forEach(v => { $("#view-" + v).hidden = v !== name; });
  try { localStorage.setItem("tp:view", name); } catch (e) {}
  closeMenu();
  LOADERS[name]();
  paintDots();
  window.scrollTo({top:0, behavior:"instant"});
}
$$("[data-group]").forEach(b => b.onclick = () => go(lastInGroup[b.dataset.group] || GROUPS[b.dataset.group][0][0]));

/* ---------------- Menu ---------------- */
function closeMenu() { $("#menu").hidden = true; $("#menuBtn").setAttribute("aria-expanded", "false"); }
$("#menuBtn").onclick = e => {
  e.stopPropagation();
  const m = $("#menu");
  if (!m.hidden) return closeMenu();
  const r = $("#menuBtn").getBoundingClientRect();
  m.style.top = (r.bottom + 8) + "px";
  m.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  m.hidden = false;
  $("#menuBtn").setAttribute("aria-expanded", "true");
};
document.addEventListener("click", e => { if (!e.target.closest("#menu")) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
$("#adminMenu").onclick = () => go("admin");

/* ---------------- Pastilles : ce qui attend une réponse ---------------- */
let COUNTS = {friends: 0, trades: 0, duels: 0, reports: 0};
async function loadCounts() {
  try { COUNTS = Object.assign({reports: 0}, await api("/api/social/counts")); paintDots(); } catch (e) {}
}
function paintDots() {
  const social = COUNTS.friends + COUNTS.trades + COUNTS.duels;
  $$("[data-group='social'] .ndot").forEach(d => { d.hidden = !social; });
  $$("[data-group='admin'] .ndot, #reportsDot").forEach(d => { d.hidden = !COUNTS.reports; });
  $$("#subnav [data-dot]").forEach(d => { d.hidden = !COUNTS[d.dataset.dot]; });
}

/* ================= PACKS ================= */
function renderPackTable() {
  const ready = ME && ME.tickets > 0;
  $("#table").innerHTML = `
    <div class="packwrap">
      ${ME && ME.tickets ? `<span class="badge">×${ME.tickets}</span>` : ""}
      <button class="pack" id="packBtn" ${ready ? "" : "disabled"} aria-label="Ouvrir un pack de 5 cartes">
        <span class="play"><i></i></span><span class="pname">TubePack</span><span class="psub">5 vidéos · FR</span>
      </button>
    </div>
    ${ready
      ? `<p class="hint">Clique sur le pack pour le déchirer.${ME.tickets < packMax()
          ? ` Prochain pack offert dans <span class="countdown" id="packClock">${clock(ME.next_pack)}</span>.` : " Ta réserve est pleine."}</p>`
      : `<p class="hint">Réserve vide. Prochain pack dans <span class="countdown" id="packClock">${clock(ME ? ME.next_pack : 0)}</span>,
          ou achète-en un pour ${nf(META.pack_price)} 🪙.</p>`}`;
  const btn = $("#packBtn");
  if (btn && ready) btn.onclick = openPack;
}

async function openPack() {
  const btn = $("#packBtn");
  btn.disabled = true; btn.classList.add("tearing");
  let data;
  try {
    [data] = await Promise.all([api("/api/packs/open", {}), new Promise(r => setTimeout(r, 520))]);
  } catch (e) {
    loadMe().then(renderPackTable);
    if (e.status === 428) botCheck(() => { go("packs"); openPack(); });
    else fail(e);
    return;
  }

  if (ME) {
    ME.coins = data.coins; ME.tickets = data.tickets; ME.next_pack = data.next_pack;
    ME.pack_max = data.pack_max; ME.packs += 1; renderWallet();
  }
  const hand = data.cards;
  $("#table").innerHTML = `
    <div class="hand">${hand.map((v, i) => `
      <div class="slot" role="button" tabindex="0" style="animation-delay:${i*80}ms" aria-label="Retourner la carte ${i+1}">
        <div class="inner"><div class="face back"><span><i></i></span></div>
        <div class="face front">${cardHTML(v)}</div></div>
      </div>`).join("")}</div>
    <div class="row" style="justify-content:center">
      <button class="btn" id="flipAll">Tout retourner</button>
      <button class="btn primary" id="again">${ME && ME.tickets > 0 ? "Ouvrir un autre pack (" + ME.tickets + ")" : "Retour"}</button>
    </div>
    <p class="hint">+${data.bonus} 🪙 pour cette ouverture${data.guild_bonus
      ? ` (dont +${data.guild_bonus} % grâce à ta guilde)` : ""}.</p>`;
  const slots = $$(".slot");
  slots.forEach((s, i) => {
    const flip = e => {
      if (s.classList.contains("flipped")) return;
      if (e) e.preventDefault();
      s.classList.add("flipped");
      s.setAttribute("aria-label", hand[i].title);
      s.removeAttribute("role"); s.removeAttribute("tabindex");
    };
    s.addEventListener("click", flip);
    s.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") flip(e); });
  });
  $("#flipAll").onclick = () => slots.forEach((s, i) => setTimeout(() => { if (!s.classList.contains("flipped")) s.click(); }, i*140));
  $("#again").onclick = renderPackTable;
  const best = hand[hand.length-1];
  if (best && (best.tier === "M" || best.tier === "L")) toast("Carte " + tierName(best.tier).toLowerCase() + " dans ce pack !", "good");
  loadMe(); loadColl();
}

$("#buyPack").onclick = async () => {
  try {
    const d = await api("/api/packs/buy", {});
    if (ME) { ME.coins = d.coins; ME.tickets = d.tickets; ME.next_pack = d.next_pack; ME.pack_max = d.pack_max; renderWallet(); }
    toast("Pack acheté pour " + nf(META.pack_price) + " pièces.", "good");
    if (view === "packs") renderPackTable();
  } catch (e) { fail(e); }
};

/* ================= COLLECTION ================= */
async function loadColl() {
  try {
    coll = await api("/api/collection");
    renderColl();
  } catch (e) { fail(e); }
}
function collList() {
  let list = collFilter === "all" ? coll.cards : coll.cards.filter(v => v.tier === collFilter);
  const q = ($("#collSearch").value || "").trim().toLowerCase();
  if (q) list = list.filter(v => v.title.toLowerCase().includes(q) || v.channel.toLowerCase().includes(q));
  if ($("#onlyDupes").checked) list = list.filter(v => v.count > 1);
  const sort = $("#collSort").value;
  const cmp = {
    views: (a,b) => b.views - a.views,
    viewsAsc: (a,b) => a.views - b.views,
    title: (a,b) => a.title.localeCompare(b.title, "fr"),
    count: (a,b) => b.count - a.count || b.views - a.views,
  }[sort] || ((a,b) => b.views - a.views);
  return list.slice().sort(cmp);
}
function renderColl() {
  const total = coll.tiers.reduce((s,t) => s + t.total, 0);
  $("#sPct").textContent = (total ? Math.round(coll.cards.length/total*100) : 0) + " %";
  if ($("#view-coll").hidden) return;
  $("#collSummary").innerHTML = `${nf(coll.cards.length)} cartes uniques sur ${nf(total)} · ${nf(coll.dupes)} doublons
    recyclables pour <b>${nf(coll.scrap)} 🪙</b>`;
  $("#collFilters").innerHTML = [{key:"all", name:"Toutes", owned:coll.cards.length, total}, ...coll.tiers]
    .map(t => `<button class="chip" data-f="${t.key}" aria-pressed="${collFilter === t.key}">${esc(t.name)}<small>${nf(t.owned)}/${nf(t.total)}</small></button>`).join("");
  $$("#collFilters .chip").forEach(c => c.onclick = () => { collFilter = c.dataset.f; collShown = 60; renderColl(); });

  const list = collList();
  $("#cgrid").innerHTML = list.length
    ? list.slice(0, collShown).map(cellHTML).join("")
    : `<p class="empty" style="grid-column:1/-1"><b>Aucune carte ici</b>Ouvre des packs ou chine à l'hôtel des ventes.</p>`;
  $("#more").innerHTML = list.length > collShown ? `<button class="btn" id="moreBtn">Afficher plus (${list.length - collShown} restantes)</button>` : "";
  if ($("#moreBtn")) $("#moreBtn").onclick = () => { collShown += 60; renderColl(); };
}
["collSearch","collSort"].forEach(id => $("#" + id).addEventListener("input", () => { collShown = 60; renderColl(); }));
$("#onlyDupes").addEventListener("change", () => { collShown = 60; renderColl(); });

function sellDialog(v) {
  const suggested = Math.max(1, tierValue(v.tier) * 2);
  modal({
    title: "Mettre en vente",
    body: `
      <div class="row" style="gap:10px;flex-wrap:nowrap">
        <div style="width:96px;flex:none;height:140px;position:relative">${cardHTML(v, {noLink:true})}</div>
        <div style="min-width:0">
          <div style="font-weight:700">${esc(v.title)}</div>
          <div class="note">${esc(v.channel)} · ${fmt(v.views)} vues · ${esc(tierName(v.tier))}</div>
          <div class="note" style="margin-top:6px">Tu en possèdes ${v.count}. La carte quitte ta collection
            le temps de la vente${v.count === 1 ? " — c'est ton seul exemplaire." : "."}</div>
        </div>
      </div>
      <label class="field">Prix de départ (pièces)
        <input type="number" id="mPrice" min="1" max="10000000" value="${suggested}">
        <span class="hint">Recyclage : ${nf(tierValue(v.tier))} 🪙 · commission de vente : ${META.fee} %</span></label>
      <label class="field">Durée
        <select id="mDur">${META.durations.map(d => `<option value="${d}"${d === "1h" ? " selected" : ""}>${d}</option>`).join("")}</select></label>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Mettre en vente", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/market/list", {id:v.id, price:Number($("#mPrice").value), duration:$("#mDur").value});
          d.close(); toast("Carte mise en vente.", "good"); loadColl(); loadMe();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

function scrapDialog(v) {
  const max = v.count - 1, unit = tierValue(v.tier);
  modal({
    title: "Recycler des doublons",
    body: `<p class="note">« ${esc(v.title)} » — ${v.count} exemplaires. Un exemplaire reste toujours dans ta collection.</p>
      <label class="field">Nombre à recycler
        <input type="number" id="mN" min="1" max="${max}" value="${max}">
        <span class="hint">${nf(unit)} 🪙 par exemplaire (${esc(tierName(v.tier))}).</span></label>
      <p class="note" id="mTotal">Total : ${nf(unit*max)} 🪙</p>`,
    onOpen: () => {
      $("#mN").oninput = () => {
        const n = Math.max(1, Math.min(max, Number($("#mN").value) || 1));
        $("#mTotal").textContent = "Total : " + nf(unit*n) + " 🪙";
      };
    },
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Recycler", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          const res = await api("/api/collection/recycle", {id:v.id, count:Math.max(1, Math.min(max, Number($("#mN").value) || 1))});
          d.close(); toast("+" + nf(res.gain) + " pièces.", "good"); loadColl(); loadMe();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

/* ================= ENCHÈRES ================= */
$$("#marketTabs button").forEach(b => b.onclick = () => {
  marketMode = b.dataset.m;
  $$("#marketTabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("#marketFilters").hidden = marketMode !== "all";
  loadMarket();
});
$("#marketSearch").addEventListener("input", debounce(loadMarket, 300));
$("#marketSort").addEventListener("change", loadMarket);
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

async function loadMarket() {
  try {
    if (marketMode === "all") {
      const q = encodeURIComponent($("#marketSearch").value.trim());
      const d = await api(`/api/market?sort=${$("#marketSort").value}&tier=${marketTier}&q=${q}`);
      marketItems = d.items;
      $("#marketSub").innerHTML = `${nf(d.total)} vente(s) en cours · commission ${d.fee} % · surenchère minimale +${META.bid_step} %
        · une mise dans les ${META.anti_snipe} dernières secondes prolonge l'enchère`;
      renderTierChips();
    } else {
      mine = await api("/api/market/mine");
      marketItems = mine[marketMode] || [];
    }
    renderMarket();
  } catch (e) { fail(e); }
}
function renderTierChips() {
  $("#marketTiers").innerHTML = [{key:"all", name:"Toutes"}, ...TIERS]
    .map(t => `<button class="chip" data-t="${t.key}" aria-pressed="${marketTier === t.key}">${esc(t.name)}</button>`).join("");
  $$("#marketTiers .chip").forEach(c => c.onclick = () => { marketTier = c.dataset.t; loadMarket(); });
}
const STATUS = {sold:["Vendue","ok"], expired:["Sans preneur",""], cancelled:["Annulée","no"], live:["En cours","ok"]};

function auctionHTML(a) {
  const v = a.card, [emo, c1, c2] = CAT[(v && v.category) || "autre"] || CAT.autre;
  if (!v) return "";
  const done = a.status !== "live";
  const [label, cls] = STATUS[a.status] || ["", ""];
  return `<article class="auction ${a.leading ? "lead" : ""} ${a.mine ? "own" : ""}" data-id="${esc(a.id)}">
    <div class="top">
      <div class="mini" style="background:linear-gradient(135deg,${c1},${c2})">
        <img src="https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg" alt="" loading="lazy"></div>
      <div style="min-width:0;flex:1">
        <div class="t">${esc(v.title)}</div>
        <div class="who">${esc(v.channel)} · <span class="tier" style="--t:var(${DOT[v.tier]})">${esc(tierName(v.tier))}</span></div>
      </div>
    </div>
    <div class="money">
      <div><b>${nf(a.price)}</b> 🪙<div class="who">${a.bids ? a.bids + " mise(s)" : "prix de départ"}</div></div>
      <div style="text-align:right">
        ${done ? `<span class="tag ${cls}">${label}</span>` : `<span class="left" data-ends="${a.ends}">${clock(a.ends - Date.now()/1000)}</span>`}
        <div class="who">${a.mine ? "ta vente" : "par " + esc(a.seller)}</div>
      </div>
    </div>
    <div class="row" style="gap:7px">
      ${a.leading ? '<span class="tag ok">Tu mènes</span>' : ""}
      ${done && a.net != null ? `<span class="tag">net ${nf(a.net)} 🪙</span>` : ""}
      <span class="spacer"></span>
      ${!done && a.mine ? `<button class="btn small danger" data-act="cancel" data-id="${esc(a.id)}" ${a.bids ? "disabled" : ""}>Annuler</button>` : ""}
      ${!done && !a.mine ? `<button class="btn small primary" data-act="bid" data-id="${esc(a.id)}">Enchérir · ${nf(a.min_bid)} 🪙</button>` : ""}
      <a class="btn small" href="https://youtu.be/${encodeURIComponent(v.id)}" target="_blank" rel="noopener">Voir</a>
    </div>
  </article>`;
}

const EMPTY_MARKET = {
  all: ["Aucune vente en cours", "Sois le premier : mets un doublon aux enchères depuis ta collection."],
  selling: ["Tu ne vends rien", "Ouvre ta collection et clique sur « Vendre » sur une carte."],
  bidding: ["Aucune mise en cours", "Tes enchères actives apparaîtront ici."],
  history: ["Historique vide", "Tes ventes et achats terminés s'afficheront ici."],
};
function renderMarket() {
  if (!marketItems.length) {
    const [a, b] = EMPTY_MARKET[marketMode];
    $("#agrid").innerHTML = `<p class="empty" style="grid-column:1/-1"><b>${a}</b>${b}</p>`;
    return;
  }
  $("#agrid").innerHTML = marketItems.map(auctionHTML).join("");
  $$("#agrid button[data-act]").forEach(b => b.onclick = () => {
    const a = marketItems.find(x => x.id === b.dataset.id);
    if (!a) return;
    if (b.dataset.act === "bid") bidDialog(a); else cancelListing(a);
  });
  tickCountdowns();
}

function bidDialog(a) {
  const v = a.card;
  modal({
    title: "Enchérir",
    body: `
      <div class="row" style="gap:10px;flex-wrap:nowrap">
        <div style="width:96px;flex:none;height:140px;position:relative">${cardHTML(v, {noLink:true})}</div>
        <div style="min-width:0">
          <div style="font-weight:700">${esc(v.title)}</div>
          <div class="note">${esc(v.channel)} · ${fmt(v.views)} vues</div>
          <div class="note" style="margin-top:6px">Vendeur : ${esc(a.seller)} · ${a.bids} mise(s)<br>
            Fin dans <span class="countdown" data-ends="${a.ends}"></span></div>
        </div>
      </div>
      <label class="field">Ta mise (pièces)
        <input type="number" id="mBid" min="${a.min_bid}" value="${a.min_bid}">
        <span class="hint">Minimum ${nf(a.min_bid)} 🪙 · tu disposes de ${nf(ME ? ME.coins : 0)} 🪙.
          Les pièces sont bloquées et rendues si quelqu'un surenchérit.</span></label>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Placer la mise", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          const res = await api("/api/market/bid", {id:a.id, amount:Number($("#mBid").value)});
          if (ME) { ME.coins = res.coins; renderWallet(); }
          d.close(); toast("Mise de " + nf(res.price) + " pièces enregistrée.", "good"); loadMarket();
        } catch (e) { btn.disabled = false; fail(e); loadMarket(); }
      }},
    ],
    onOpen: tickCountdowns,
  });
}

async function cancelListing(a) {
  try {
    await api("/api/market/cancel", {id:a.id});
    toast("Vente annulée, carte rendue.", "good");
    loadMarket(); loadColl(); loadMe();
  } catch (e) { fail(e); }
}

/* ================= APPLICATION INSTALLABLE ================= */
// Service worker : démarrage instantané et écran « hors ligne » propre.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let installEvent = null;

function installDismissed() {
  try { return localStorage.getItem("tp:install") === "non"; } catch (e) { return false; }
}
function showInstall(force) {
  if (standalone() || (!force && installDismissed())) return;
  const b = $("#installBanner");
  if (iOS && !installEvent) {
    $("#installHow").textContent = "Sur iPhone : bouton Partager, puis « Sur l'écran d'accueil ».";
    $("#installGo").textContent = "J'ai compris";
  }
  b.hidden = false;
}
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installEvent = e;
  $("#installMenu").hidden = false;
  showInstall(false);
});
// Le menu garde une porte d'entrée même après « Plus tard » sur le bandeau.
if (iOS && !standalone()) $("#installMenu").hidden = false;
$("#installMenu").onclick = () => { closeMenu(); showInstall(true); };
window.addEventListener("appinstalled", () => {
  $("#installBanner").hidden = true;
  toast("TubePacks est installé. À bientôt !", "good");
});
$("#installLater").onclick = () => {
  $("#installBanner").hidden = true;
  try { localStorage.setItem("tp:install", "non"); } catch (e) {}
};
$("#installGo").onclick = async () => {
  $("#installBanner").hidden = true;
  if (!installEvent) return;                       // iOS : la marche à suivre était affichée
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice.catch(() => ({outcome: "dismissed"}));
  if (outcome !== "accepted") { try { localStorage.setItem("tp:install", "non"); } catch (e) {} }
  installEvent = null;
};
// Ni beforeinstallprompt ni iOS (Firefox, Safari bureau) : on propose quand même, une fois.
setTimeout(() => { if (!installEvent && !standalone() && iOS) showInstall(false); }, 8000);

/* ================= VÉRIFICATION ANTI-ROBOT ================= */
// Le serveur renvoie 428 quand il veut revoir un humain. On repropose l'action ensuite.
function botCheck(retry) {
  modal({
    title: "Petite vérification",
    body: `<p class="note">Une question au hasard, le temps de s'assurer que tu n'es pas un script.</p>
      <div class="challenge">
        <div class="q loading" id="cQ">Chargement…</div>
        <label class="field">Ta réponse<input type="text" id="cA" autocomplete="off" inputmode="text"></label>
      </div>`,
    onOpen: async () => {
      try {
        const c = await api("/api/challenge");
        $("#cQ").textContent = c.question;
        $("#cQ").classList.remove("loading");
        $("#cQ").dataset.id = c.id;
        $("#cA").focus();
        $("#cA").onkeydown = e => { if (e.key === "Enter") $$("#modalFoot .btn.primary")[0].click(); };
      } catch (e) { $("#cQ").textContent = "Impossible de charger la question."; }
    },
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Valider", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/verify", {id: $("#cQ").dataset.id, answer: $("#cA").value});
          d.close();
          toast("Merci !", "good");
          if (retry) retry();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

/* ================= GUILDE ================= */
let guildList = null, guildBrowse = false;

async function loadGuild() {
  try {
    const d = await api("/api/guild");
    if (d.guild && !guildBrowse) { renderGuild(d.guild); return; }
    guildList = await api("/api/guilds");
    renderGuildList(d.guild);
  } catch (e) { fail(e); }
}

function guildCardHTML(g, mine) {
  return `<article class="gcard ${g.id === mine ? "mine" : ""}">
    <div class="emblem sm">${esc(g.emblem)}</div>
    <div class="gi">
      <div class="gn"><span class="lvl">${g.level}</span> ${esc(g.name)} <span class="gtag">[${esc(g.tag)}]</span></div>
      <div class="gm">${g.count}/${g.max} membres · ${nf(g.xp)} XP${g.motd ? " · " + esc(g.motd) : ""}</div>
    </div>
    ${g.id === mine ? '<span class="tag ok">ta guilde</span>'
      : g.open && g.count < g.max ? `<button class="btn small primary" data-join="${esc(g.id)}">Rejoindre</button>`
      : `<span class="tag">${g.count >= g.max ? "complète" : "fermée"}</span>`}
  </article>`;
}

function renderGuildList(mine) {
  const items = guildList.items;
  $("#guildBody").innerHTML = `
    <div class="hero">
      <div><h1>Guildes</h1><p>Rejoins une guilde : chaque pack ouvert par un membre la fait monter de niveau,
        et chaque niveau rapporte des pièces en plus à tout le monde.</p></div>
    </div>
    ${mine ? `<div class="row" style="margin-bottom:14px"><button class="btn" id="backGuild">← Revenir à ma guilde</button></div>` : ""}
    <div class="panel row" style="margin-bottom:16px">
      <input type="search" id="gSearch" placeholder="Chercher une guilde…" style="width:min(260px,60vw)">
      <span class="spacer"></span>
      ${mine ? "" : `<button class="btn primary" id="newGuild">Fonder une guilde · ${nf(META.guild_cost)} 🪙</button>`}
    </div>
    <div class="glist" id="glist">${items.length ? items.map(g => guildCardHTML(g, mine)).join("")
      : `<p class="empty" style="grid-column:1/-1"><b>Aucune guilde</b>Sois le premier à en fonder une.</p>`}</div>`;
  $("#gSearch").oninput = debounce(async () => {
    guildList = await api("/api/guilds?q=" + encodeURIComponent($("#gSearch").value.trim()));
    $("#glist").innerHTML = guildList.items.length
      ? guildList.items.map(g => guildCardHTML(g, mine)).join("")
      : `<p class="empty" style="grid-column:1/-1"><b>Aucun résultat</b></p>`;
    bindJoin();
  }, 300);
  if ($("#newGuild")) $("#newGuild").onclick = createGuildDialog;
  if ($("#backGuild")) $("#backGuild").onclick = () => { guildBrowse = false; loadGuild(); };
  bindJoin();
}
function bindJoin() {
  $$("#glist [data-join]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      await api("/api/guild/join", {id: b.dataset.join});
      toast("Bienvenue dans la guilde !", "good");
      guildBrowse = false; loadGuild(); loadMe();
    } catch (e) { b.disabled = false; fail(e); }
  });
}

function createGuildDialog() {
  let emblem = META.emblems[0];
  modal({
    title: "Fonder une guilde",
    body: `<p class="note">Coût : ${nf(META.guild_cost)} 🪙. Tu en seras le chef, et tu pourras
        recruter jusqu'à ${META.guild_max} membres.</p>
      <label class="field">Nom<input type="text" id="gName" maxlength="24" placeholder="Les Collectionneurs">
        <span class="hint">3 à 24 caractères.</span></label>
      <label class="field">Tag<input type="text" id="gTag" maxlength="5" placeholder="COLL">
        <span class="hint">2 à 5 lettres ou chiffres, sans accent.</span></label>
      <label class="field">Emblème
        <div class="avatars" id="gEm">${META.emblems.map((e, i) =>
          `<button type="button" data-e="${esc(e)}" aria-pressed="${i === 0}">${esc(e)}</button>`).join("")}</div></label>`,
    onOpen: () => $$("#gEm button").forEach(b => b.onclick = () => {
      emblem = b.dataset.e;
      $$("#gEm button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    }),
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Fonder", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/guild/create", {name:$("#gName").value, tag:$("#gTag").value, emblem});
          d.close(); toast("Guilde fondée !", "good");
          guildBrowse = false; loadGuild(); loadMe();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

function renderGuild(g) {
  const me = ME ? ME.name : "";
  const chief = g.my_role === "chef", staff = chief || g.my_role === "officier";
  const span = g.next_xp ? g.next_xp - g.prev_xp : 1;
  const pct = g.next_xp ? Math.min(100, Math.round((g.xp - g.prev_xp) / span * 100)) : 100;
  $("#guildBody").innerHTML = `
    <div class="panel">
      <div class="ghead">
        <div class="emblem">${esc(g.emblem)}</div>
        <div style="flex:1;min-width:220px">
          <h1 style="font-size:1.8rem">${esc(g.name)} <span class="gtag">[${esc(g.tag)}]</span></h1>
          <p class="sub" style="margin:4px 0 0">Niveau ${g.level} · ${nf(g.xp)} XP ·
            ${g.count}/${g.max} membres · ${g.open ? "ouverte" : "sur invitation"}</p>
          <div class="xpbar"><i style="width:${pct}%"></i></div>
          <p class="note" style="margin-top:5px">${g.next_xp
            ? `${nf(g.next_xp - g.xp)} XP avant le niveau ${g.level + 1}` : "Niveau maximum atteint."}</p>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn" id="browseGuilds">Autres guildes</button>
          ${staff ? `<button class="btn" id="gSettings">Réglages</button>` : ""}
          ${chief ? `<button class="btn danger" id="gDisband">Dissoudre</button>`
                  : `<button class="btn danger" id="gLeave">Quitter</button>`}
        </div>
      </div>
      ${g.motd ? `<p style="margin:14px 0 0">${esc(g.motd)}</p>` : ""}
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="panel">
        <h2>Avantages</h2><p class="sub">Acquis à tous les membres, et perdus en quittant la guilde.</p>
        <div class="perks">
          <div class="perk"><b>+${g.coin_bonus} %</b>pièces à chaque pack ouvert</div>
          <div class="perk"><b>+${g.ticket_bonus}</b>packs de réserve en plus</div>
          <div class="perk"><b>+1 XP</b>par pack ouvert par un membre</div>
        </div>
      </div>
      <div class="panel">
        <h2>Trésor</h2><p class="sub">${nf(g.rate)} 🪙 versées = 1 XP quand un gradé investit.</p>
        <div class="stats" style="margin-bottom:12px">
          <div class="stat"><b style="color:var(--gold)">${nf(g.coins)}</b><span>pièces au trésor</span></div>
          <div class="stat"><b>${nf(Math.floor(g.coins / g.rate))}</b><span>XP finançables</span></div>
        </div>
        <div class="row" style="flex-wrap:nowrap">
          <input type="number" id="gAmount" min="1" value="100" step="50">
          <button class="btn primary" id="gDonate">Verser</button>
          ${staff ? `<button class="btn" id="gInvest">Investir</button>` : ""}
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <h2>Membres (${g.count})</h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Joueur</th><th>Rôle</th><th class="num">Versé</th><th class="num">Packs</th>
          <th class="num">Cartes</th><th>Depuis</th>${staff ? "<th></th>" : ""}</tr></thead>
        <tbody>${g.members.map(m => `<tr>
          <td><span class="avatar xs" style="display:inline-grid;vertical-align:middle">${esc(m.avatar)}</span>
            <b>${esc(m.username)}</b></td>
          <td><span class="role ${esc(m.role)}">${esc(m.role)}</span></td>
          <td class="num">${nf(m.given)} 🪙</td><td class="num">${nf(m.packs)}</td>
          <td class="num">${nf(m.unique)}</td><td>${dateOf(m.joined)}</td>
          ${staff ? `<td>${m.name === me ? "" : `
            ${chief ? `<button class="btn small" data-role="${esc(m.name)}">Rôle</button>` : ""}
            ${m.role !== "chef" ? `<button class="btn small danger" data-kick="${esc(m.name)}">Exclure</button>` : ""}`}</td>` : ""}
        </tr>`).join("")}</tbody></table></div>
    </div>`;

  $("#browseGuilds").onclick = () => { guildBrowse = true; loadGuild(); };
  const amount = () => Math.max(1, Number($("#gAmount").value) || 0);
  $("#gDonate").onclick = async () => {
    try {
      const d = await api("/api/guild/donate", {amount: amount()});
      if (ME) { ME.coins = d.coins; renderWallet(); }
      toast("Merci pour la guilde !", "good"); loadGuild();
    } catch (e) { fail(e); }
  };
  if ($("#gInvest")) $("#gInvest").onclick = async () => {
    try { await api("/api/guild/invest", {amount: amount()}); toast("Trésor investi.", "good"); loadGuild(); }
    catch (e) { fail(e); }
  };
  if ($("#gLeave")) $("#gLeave").onclick = () => confirmDialog(
    "Quitter la guilde", "Tu perdras ses avantages. Les pièces versées ne sont pas rendues.",
    async () => { await api("/api/guild/leave", {}); toast("Tu as quitté la guilde.", "good"); loadGuild(); loadMe(); });
  if ($("#gDisband")) $("#gDisband").onclick = () => confirmDialog(
    "Dissoudre la guilde", `« ${g.name} » disparaîtra pour ses ${g.count} membres, trésor compris. C'est définitif.`,
    async () => { await api("/api/guild/disband", {}); toast("Guilde dissoute.", "good"); loadGuild(); loadMe(); });
  if ($("#gSettings")) $("#gSettings").onclick = () => guildSettingsDialog(g);
  $$("#guildBody [data-kick]").forEach(b => b.onclick = () => confirmDialog(
    "Exclure " + b.dataset.kick, "Ce joueur quittera la guilde immédiatement.",
    async () => { await api("/api/guild/kick", {name: b.dataset.kick}); toast("Membre exclu."); loadGuild(); }));
  $$("#guildBody [data-role]").forEach(b => b.onclick = () => roleDialog(b.dataset.role));
}

function guildSettingsDialog(g) {
  let emblem = g.emblem;
  modal({
    title: "Réglages de la guilde",
    body: `<label class="field">Message aux membres
        <textarea id="gMotd" maxlength="200" placeholder="On vise le niveau 5 ce mois-ci !">${esc(g.motd)}</textarea></label>
      <label class="field">Emblème
        <div class="avatars" id="gEm2">${META.emblems.map(e =>
          `<button type="button" data-e="${esc(e)}" aria-pressed="${e === g.emblem}">${esc(e)}</button>`).join("")}</div></label>
      <label class="chip" style="display:flex;align-items:center;gap:8px;cursor:pointer;width:fit-content">
        <input type="checkbox" id="gOpen" style="width:auto" ${g.open ? "checked" : ""}> Ouverte à tous
      </label>
      <p class="note">Fermée, la guilde n'apparaît plus avec un bouton « Rejoindre ».</p>`,
    onOpen: () => $$("#gEm2 button").forEach(b => b.onclick = () => {
      emblem = b.dataset.e;
      $$("#gEm2 button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    }),
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Enregistrer", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/guild/settings", {motd:$("#gMotd").value, emblem, open:$("#gOpen").checked});
          d.close(); toast("Réglages enregistrés.", "good"); loadGuild();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

function roleDialog(name) {
  modal({
    title: "Rôle de " + name,
    body: `<label class="field">Nouveau rôle
        <select id="gRole"><option value="membre">Membre</option><option value="officier">Officier</option>
          <option value="chef">Chef (passation)</option></select>
        <span class="hint">Un officier peut recruter, exclure des membres et investir le trésor.
          Nommer un chef te fait redevenir officier.</span></label>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Appliquer", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/guild/role", {name, role:$("#gRole").value});
          d.close(); toast("Rôle mis à jour.", "good"); loadGuild();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

function confirmDialog(title, text, action) {
  modal({
    title, body: `<p class="note">${esc(text)}</p>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Confirmer", cls:"primary danger", onClick: async (d, btn) => {
        btn.disabled = true;
        try { await action(); d.close(); } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

/* ================= CARTES : cellule, miniature, fiche ================= */
function cellHTML(v) {
  const missing = v.count === 0;
  return `<div class="cell${missing ? " missing" : ""}" tabindex="0" aria-label="${esc(v.title)}">
    ${v.count > 1 ? `<span class="count">×${v.count}</span>` : ""}${cardHTML(v)}</div>`;
}
function miniHTML(v, qty, label) {
  if (!v) return `<div class="minicard"><div class="mthumb">❔</div><b>—</b><span class="mt">Carte retirée</span></div>`;
  CARDS[v.id] = Object.assign(CARDS[v.id] || {}, v);
  const [emo, a, b] = CAT[v.category] || CAT.autre;
  return `<button type="button" class="minicard ${v.tier}" data-vid="${esc(v.id)}" title="${esc(v.title)}">
    <div class="mthumb" style="background:linear-gradient(135deg,${a},${b})">${emo}
      <img src="https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg" alt="" loading="lazy"></div>
    <b>${fmt(v.views)}</b><span class="mt">${esc(v.title)}</span>
    ${label ? `<span class="qty">${label}</span>` : qty > 1 ? `<span class="qty">×${qty}</span>` : ""}</button>`;
}

// Toucher une carte (n'importe où, sauf dans une fenêtre ou un sélecteur) ouvre sa fiche.
document.addEventListener("click", e => {
  const el = e.target.closest("[data-vid]");
  if (!el || el.closest("dialog") || el.closest(".picker")) return;
  const slot = el.closest(".slot");
  if (slot && !slot.classList.contains("flipped")) return;      // d'abord retourner la carte
  e.preventDefault();
  openCard(el.dataset.vid);
});
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("cell")) {
    const c = e.target.querySelector("[data-vid]");
    if (c) { e.preventDefault(); openCard(c.dataset.vid); }
  }
});

const REASONS = {
  pas_fr: "Pas en français", choquant: "Contenu choquant ou inapproprié",
  indispo: "Vidéo supprimée ou privée", spam: "Spam, arnaque ou contenu trompeur", autre: "Autre",
};

async function openCard(vid) {
  let d;
  try { d = await api("/api/card/" + encodeURIComponent(vid)); } catch (e) { return fail(e); }
  const v = d.card, own = d.count;
  modal({
    title: "Carte " + tierName(v.tier).toLowerCase(),
    body: `<div class="cardsheet">
        <div class="big">${cardHTML(v)}</div>
        <div style="min-width:0">
          <h4>${esc(v.title)}</h4>
          <div class="note">${esc(v.channel)}</div>
          <dl class="facts">
            <dt>Vues</dt><dd>${nf(v.views)}</dd>
            ${v.likes != null ? `<dt>J'aime</dt><dd>${nf(v.likes)}</dd>` : ""}
            ${v.year ? `<dt>Année</dt><dd>${esc(v.year)}</dd>` : ""}
            <dt>Tu en as</dt><dd>${own ? "×" + own : "aucune"}</dd>
            <dt>Joueurs</dt><dd>${nf(d.owners)}</dd>
            <dt>Recyclage</dt><dd>${nf(d.value)} 🪙</dd>
          </dl>
        </div>
      </div>
      ${d.blacklisted ? `<p class="callout bad">Cette vidéo a été retirée du jeu par un administrateur.</p>` : ""}
      ${d.friends.length ? `<p class="callout">🤝 Chez tes amis : <b>${d.friends.map(esc).join(", ")}</b></p>` : ""}
      ${d.auctions.length ? `<p class="callout">⚖️ En vente : ${d.auctions.map(a =>
          `${nf(a.price)} 🪙 par ${esc(a.seller)}`).join(" · ")}</p>` : ""}
      <div class="cactions">
        <a class="btn primary wide" href="https://youtu.be/${encodeURIComponent(vid)}" target="_blank" rel="noopener">▶ Voir sur YouTube</a>
        ${own ? `<button class="btn" data-a="sell">⚖️ Vendre</button>` : ""}
        ${own > 1 ? `<button class="btn" data-a="scrap">♻️ Recycler ×${own - 1}</button>` : ""}
        ${own ? `<button class="btn" data-a="show">${d.showcase ? "✖ Retirer de la vitrine" : "⭐ Mettre en vitrine"}</button>` : ""}
        ${own ? `<button class="btn" data-a="trade">🤝 Échanger</button>` : ""}
        ${!own && d.friends.length ? `<button class="btn" data-a="ask">🤝 Demander à un ami</button>` : ""}
        <button class="btn" data-a="report" ${d.reported ? "disabled" : ""}>🚩 ${d.reported ? "Déjà signalée" : "Signaler"}</button>
        ${d.admin ? `<button class="btn danger" data-a="bl">${d.blacklisted ? "↩ Réintégrer" : "⛔ Liste noire"}</button>` : ""}
      </div>`,
    onOpen: () => $$("#modalBody [data-a]").forEach(b => b.onclick = () => cardAction(b.dataset.a, v, d)),
  });
}

async function cardAction(act, v, d) {
  const withCount = Object.assign({}, v, {count: d.count});
  if (act === "sell") return sellDialog(withCount);
  if (act === "scrap") return scrapDialog(withCount);
  if (act === "report") return reportDialog(v);
  if (act === "trade") return tradeBuilder({give: {[v.id]: 1}});
  if (act === "ask") return tradeBuilder({to: d.friends[0], want: {[v.id]: 1}});
  if (act === "bl") return d.blacklisted ? unblacklist(v.id, () => $("#modal").close()) : blacklistDialog(v);
  if (act === "show") {
    try {
      const r = await api("/api/showcase/toggle", {id: v.id});
      toast(r.added ? "Ajoutée à ta vitrine." : "Retirée de ta vitrine.", "good");
      $("#modal").close();
      if (view === "profile") loadProfile(profileName);
    } catch (e) { fail(e); }
  }
}

function reportDialog(v) {
  modal({
    title: "Signaler cette vidéo",
    body: `<p class="note">« ${esc(v.title)} » — un administrateur examinera le signalement.</p>
      <label class="field">Motif
        <select id="rReason">${Object.entries(REASONS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
      <label class="field">Précisions (facultatif)
        <textarea id="rComment" maxlength="300" placeholder="Ce qui ne va pas avec cette vidéo…"></textarea></label>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Signaler", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/report", {id: v.id, reason: $("#rReason").value, comment: $("#rComment").value});
          d.close(); toast("Merci, le signalement est transmis.", "good");
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

function blacklistDialog(v, after) {
  modal({
    title: "Mettre en liste noire",
    body: `<p class="note">« ${esc(v.title)} » sera retirée du jeu : plus aucun tirage, ventes en cours annulées,
        et chaque exemplaire possédé est retiré des collections puis remboursé à sa valeur de recyclage.
        Le worker ne la réintégrera pas.</p>
      <label class="field">Raison (visible des admins)<input type="text" id="blReason" maxlength="200" placeholder="Pas en français"></label>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Retirer du jeu", cls:"primary danger", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          const r = await api("/api/admin/blacklist", {id: v.id, reason: $("#blReason").value});
          d.close();
          toast(`Retirée : ${r.copies} exemplaire(s) chez ${r.players} joueur(s), ${nf(r.refund)} 🪙 remboursées.`, "good");
          loadCounts();
          if (after) after();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}
async function unblacklist(vid, after) {
  try { await api("/api/admin/unblacklist", {id: vid}); toast("Vidéo réintégrée au jeu.", "good"); if (after) after(); }
  catch (e) { fail(e); }
}

/* ================= EXPLORATEUR ================= */
let ex = {tier: "all", page: 0};
async function loadExplore() {
  const q = encodeURIComponent($("#exSearch").value.trim());
  try {
    const d = await api(`/api/explore?tier=${ex.tier}&q=${q}&sort=${$("#exSort").value}&owned=${$("#exOwned").value}&page=${ex.page}`);
    ex.page = d.page;
    const pct = d.catalog ? Math.round(d.owned / d.catalog * 100) : 0;
    $("#exSummary").innerHTML = `${nf(d.catalog)} cartes dans le jeu · tu en possèdes <b>${nf(d.owned)}</b> (${pct} %)`;
    $("#exTiers").innerHTML = [{key: "all", name: "Toutes", owned: d.owned, total: d.catalog}, ...d.tiers].map(t =>
      `<button class="chip" data-t="${t.key}" aria-pressed="${ex.tier === t.key}">${esc(t.name)}<small>${nf(t.owned)}/${nf(t.total)}</small></button>`).join("");
    $$("#exTiers .chip").forEach(c => c.onclick = () => { ex.tier = c.dataset.t; ex.page = 0; loadExplore(); });
    $("#exGrid").innerHTML = d.items.length ? d.items.map(cellHTML).join("")
      : `<p class="empty" style="grid-column:1/-1"><b>Aucune carte</b>Essaie un autre filtre.</p>`;
    $("#exPager").innerHTML = d.pages > 1 ? `
      <button class="btn small" id="exPrev" ${d.page ? "" : "disabled"}>← Précédente</button>
      <span class="note">Page ${d.page + 1} / ${d.pages} · ${nf(d.total)} cartes</span>
      <button class="btn small" id="exNext" ${d.page < d.pages - 1 ? "" : "disabled"}>Suivante →</button>`
      : `<span class="note">${nf(d.total)} carte(s)</span>`;
    if ($("#exPrev")) $("#exPrev").onclick = () => { ex.page--; loadExplore(); window.scrollTo({top: 0}); };
    if ($("#exNext")) $("#exNext").onclick = () => { ex.page++; loadExplore(); window.scrollTo({top: 0}); };
  } catch (e) { fail(e); }
}
$("#exSearch").addEventListener("input", debounce(() => { ex.page = 0; loadExplore(); }, 300));
["exSort", "exOwned"].forEach(id => $("#" + id).addEventListener("change", () => { ex.page = 0; loadExplore(); }));

/* ================= AMIS ================= */
let FRIENDS = [];
let profileName = null;
function openProfile(name) { profileName = name || null; go("profile"); }
$$("[data-group='profile']").forEach(b => b.addEventListener("click", () => { profileName = null; }, true));

function personHTML(p, actions) {
  const status = p.online ? "en ligne" : p.seen ? "vu " + ago(p.seen) : "jamais vu";
  return `<div class="person">
    <div class="avwrap"><div class="avatar sm">${esc(p.avatar)}</div>${p.online ? '<i class="online"></i>' : ""}</div>
    <div class="pi">
      <div class="pn"><button class="linkish" data-prof="${esc(p.name)}">${esc(p.username)}</button>
        ${p.tag ? `<span class="gtag">[${esc(p.tag)}]</span>` : ""}</div>
      <div class="pm"><span class="power">⚡ ${fmt(p.power)}</span> · ${nf(p.unique)} cartes · ${status}</div>
    </div>
    <div class="pa">${actions}</div>
  </div>`;
}
function bindPeople(root) {
  $$(root + " [data-prof]").forEach(b => b.onclick = () => openProfile(b.dataset.prof));
}

async function loadFriends() {
  let d;
  try { d = await api("/api/friends"); } catch (e) { return fail(e); }
  FRIENDS = d.friends;
  $("#friendsBody").innerHTML = `
    <div class="phead"><h1>Amis</h1><p>Échange des cartes avec tes amis et défie-les en duel.</p></div>
    <form class="addfriend" id="addFriend">
      <input type="text" id="friendName" placeholder="Pseudo d'un joueur" maxlength="24" autocomplete="off" aria-label="Pseudo">
      <button class="btn primary">Ajouter</button>
    </form>
    ${d.incoming.length ? `<div class="sectitle"><h2>Demandes reçues (${d.incoming.length})</h2></div>
      <div class="plist">${d.incoming.map(p => personHTML(p, `
        <button class="btn small primary" data-acc="${esc(p.name)}">Accepter</button>
        <button class="btn small" data-dec="${esc(p.name)}">Refuser</button>`)).join("")}</div>` : ""}
    <div class="sectitle"><h2>Mes amis (${d.friends.length})</h2></div>
    ${d.friends.length ? `<div class="plist">${d.friends.map(p => personHTML(p, `
        <button class="btn small" data-trade="${esc(p.name)}">🤝 Échanger</button>
        <button class="btn small" data-duel="${esc(p.name)}">⚔️ Défier</button>
        <button class="btn small danger" data-rm="${esc(p.name)}" aria-label="Retirer ${esc(p.username)}">✕</button>`)).join("")}</div>`
      : `<p class="empty"><b>Pas encore d'amis</b>Ajoute un joueur par son pseudo, ou depuis le classement de ton profil.</p>`}
    ${d.outgoing.length ? `<div class="sectitle"><h2>Demandes envoyées</h2></div>
      <div class="plist">${d.outgoing.map(p => personHTML(p,
        `<button class="btn small" data-cancel="${esc(p.name)}">Annuler</button>`)).join("")}</div>` : ""}`;
  bindPeople("#friendsBody");
  $("#addFriend").onsubmit = async e => {
    e.preventDefault();
    const name = $("#friendName").value.trim();
    if (!name) return;
    try {
      const r = await api("/api/friends/request", {name});
      toast(r.status === "friends" ? "Vous êtes maintenant amis !" : "Demande envoyée.", "good");
      loadFriends();
    } catch (err) { fail(err); }
  };
  const act = (sel, fn) => $$("#friendsBody " + sel).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await fn(b); loadFriends(); loadCounts(); } catch (e) { b.disabled = false; fail(e); }
  });
  act("[data-acc]", b => api("/api/friends/respond", {name: b.dataset.acc, accept: true}));
  act("[data-dec]", b => api("/api/friends/respond", {name: b.dataset.dec, accept: false}));
  act("[data-cancel]", b => api("/api/friends/cancel", {name: b.dataset.cancel}));
  $$("#friendsBody [data-rm]").forEach(b => b.onclick = () => confirmDialog(
    "Retirer " + b.dataset.rm, "Vous ne serez plus amis ; les échanges en cours restent visibles.",
    async () => { await api("/api/friends/remove", {name: b.dataset.rm}); loadFriends(); }));
  $$("#friendsBody [data-trade]").forEach(b => b.onclick = () => tradeBuilder({to: b.dataset.trade}));
  $$("#friendsBody [data-duel]").forEach(b => b.onclick = () => duelDialog(b.dataset.duel));
}

async function ensureFriends() {
  if (!FRIENDS.length) { try { FRIENDS = (await api("/api/friends")).friends; } catch (e) {} }
  return FRIENDS;
}

/* ================= ÉCHANGES ================= */
const T_STATUS = {pending: ["En attente", ""], accepted: ["Accepté", "ok"], declined: ["Refusé", "no"],
  cancelled: ["Annulé", "no"], expired: ["Expiré", ""], failed: ["Échoué", "no"]};

function tradeHTML(t) {
  const me = ME ? ME.name : "", mine = t.from === me, other = mine ? t.to : t.from;
  const [label, cls] = T_STATUS[t.status] || ["", ""];
  const side = (title, items, coins) => `<div class="tside"><h4>${title}</h4>
    <div class="titems">${items.map(i => miniHTML(i.card, i.count)).join("") || '<span class="note">Aucune carte</span>'}</div>
    ${coins ? `<div class="tcoins">+ ${nf(coins)} 🪙</div>` : ""}</div>`;
  // Présenté du point de vue du joueur : ce qu'il donne, ce qu'il reçoit.
  const giveSide = mine ? side("Tu donnes", t.give, t.coins_give) : side("Tu reçois", t.give, t.coins_give);
  const wantSide = mine ? side("Tu reçois", t.want, t.coins_want) : side("Tu donnes", t.want, t.coins_want);
  return `<article class="trade">
    <div class="thead">${mine ? "Proposé à" : "Proposé par"} <b>${esc(other)}</b>
      <span class="tag ${cls}">${label}</span><span class="spacer"></span>
      ${t.status === "pending" ? `<span class="note">expire dans <span data-ends="${t.expires}"></span></span>` : `<span class="note">${ago(t.closed || t.created)}</span>`}</div>
    <div class="tsides">${mine ? giveSide : wantSide}<div class="tarrow">⇄</div>${mine ? wantSide : giveSide}</div>
    ${t.message ? `<div class="tmsg">« ${esc(t.message)} »</div>` : ""}
    ${t.reason ? `<div class="callout bad">${esc(t.reason)}</div>` : ""}
    ${t.status === "pending" ? `<div class="tfoot">${mine
      ? `<button class="btn small danger" data-tc="${esc(t.id)}">Annuler</button>`
      : `<button class="btn small" data-td="${esc(t.id)}">Refuser</button><button class="btn small primary" data-ta="${esc(t.id)}">Accepter</button>`}</div>` : ""}
  </article>`;
}

async function loadTrades() {
  let d;
  try { d = await api("/api/trades"); } catch (e) { return fail(e); }
  $("#tradesBody").innerHTML = `
    <div class="phead"><h1>Échanges</h1><p>Entre amis uniquement. Rien n'est bloqué pendant l'attente :
      tout est revérifié au moment où l'échange est accepté.</p></div>
    <button class="btn primary" id="newTrade">🤝 Proposer un échange</button>
    ${d.incoming.length ? `<div class="sectitle"><h2>Reçus (${d.incoming.length})</h2></div>${d.incoming.map(tradeHTML).join("")}` : ""}
    ${d.outgoing.length ? `<div class="sectitle"><h2>Envoyés (${d.outgoing.length})</h2></div>${d.outgoing.map(tradeHTML).join("")}` : ""}
    ${!d.incoming.length && !d.outgoing.length ? `<p class="empty"><b>Aucun échange en cours</b>Propose un échange à un ami, ou depuis la fiche d'une carte.</p>` : ""}
    ${d.history.length ? `<div class="sectitle"><h2>Historique</h2></div>${d.history.map(tradeHTML).join("")}` : ""}`;
  $("#newTrade").onclick = () => tradeBuilder({});
  const act = (sel, path, msg) => $$("#tradesBody " + sel).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await api(path, {id: b.dataset[Object.keys(b.dataset)[0]]}); toast(msg, "good"); loadTrades(); loadCounts(); loadMe(); }
    catch (e) { b.disabled = false; fail(e); loadTrades(); }
  });
  act("[data-ta]", "/api/trades/accept", "Échange conclu !");
  act("[data-td]", "/api/trades/decline", "Échange refusé.");
  act("[data-tc]", "/api/trades/cancel", "Proposition annulée.");
  tickCountdowns();
}

// Constructeur : toucher une carte ajoute un exemplaire ; au-delà du maximum, elle est retirée.
async function tradeBuilder(init) {
  const friends = await ensureFriends();
  if (!friends.length) { toast("Ajoute d'abord un ami pour échanger.", "bad"); return go("friends"); }
  if (!coll.cards.length) await loadColl();
  const st = {to: init.to || friends[0].name, give: init.give || {}, want: init.want || {}, theirs: []};
  const loadTheirs = async () => {
    try { st.theirs = (await api("/api/collection/" + encodeURIComponent(st.to))).cards; } catch (e) { st.theirs = []; fail(e); }
  };
  await loadTheirs();
  const pickHTML = (cards, sel, q) => {
    const list = cards.filter(c => !q || (c.title + " " + c.channel).toLowerCase().includes(q)).slice(0, 120);
    return list.length ? list.map(c => {
      const n = sel[c.id] || 0;
      return miniHTML(c, 0, n ? `${n}/${c.count}` : c.count > 1 ? "×" + c.count : "").replace('class="minicard', `class="minicard${n ? " sel" : ""}`);
    }).join("") : `<div class="pick-empty">Aucune carte.</div>`;
  };
  const summary = () => {
    const n = o => Object.values(o).reduce((a, b) => a + b, 0);
    return `Tu donnes <b>${n(st.give)}</b> carte(s)${Number($("#tcGive").value) ? ` + ${nf($("#tcGive").value)} 🪙` : ""},
      tu demandes <b>${n(st.want)}</b> carte(s)${Number($("#tcWant").value) ? ` + ${nf($("#tcWant").value)} 🪙` : ""}.`;
  };
  const draw = () => {
    $("#pkGive").innerHTML = pickHTML(coll.cards, st.give, ($("#qGive").value || "").toLowerCase());
    $("#pkWant").innerHTML = pickHTML(st.theirs, st.want, ($("#qWant").value || "").toLowerCase());
    $("#tSum").innerHTML = summary();
  };
  const bump = (sel, cards, vid) => {
    const c = cards.find(x => x.id === vid);
    if (!c) return;
    const n = (sel[vid] || 0) + 1;
    if (n > c.count) delete sel[vid]; else sel[vid] = n;
    draw();
  };
  modal({
    title: "Proposer un échange",
    wide: true,
    body: `<label class="field">Avec
        <select id="tTo">${friends.map(f => `<option value="${esc(f.name)}" ${f.name === st.to ? "selected" : ""}>${esc(f.username)}</option>`).join("")}</select></label>
      <p class="note">Touche une carte pour ajouter un exemplaire ; au-delà du maximum, elle est retirée.</p>
      <div class="builder">
        <div><h4>Tu donnes</h4>
          <input type="search" id="qGive" placeholder="Filtrer ma collection…">
          <div class="picker" id="pkGive" style="margin-top:8px"></div>
          <label class="field" style="margin-top:8px">Pièces en plus<input type="number" id="tcGive" min="0" value="0"></label></div>
        <div><h4>Tu demandes</h4>
          <input type="search" id="qWant" placeholder="Filtrer sa collection…">
          <div class="picker" id="pkWant" style="margin-top:8px"></div>
          <label class="field" style="margin-top:8px">Pièces demandées<input type="number" id="tcWant" min="0" value="0"></label></div>
      </div>
      <label class="field">Message (facultatif)<input type="text" id="tMsg" maxlength="200" placeholder="Ta Mythique contre mes deux Légendaires ?"></label>
      <div class="tsummary" id="tSum"></div>`,
    onOpen: () => {
      draw();
      $("#pkGive").onclick = e => { const m = e.target.closest("[data-vid]"); if (m) bump(st.give, coll.cards, m.dataset.vid); };
      $("#pkWant").onclick = e => { const m = e.target.closest("[data-vid]"); if (m) bump(st.want, st.theirs, m.dataset.vid); };
      ["qGive", "qWant", "tcGive", "tcWant"].forEach(id => $("#" + id).oninput = draw);
      $("#tTo").onchange = async () => { st.to = $("#tTo").value; st.want = {}; await loadTheirs(); draw(); };
    },
    buttons: [
      {label: "Annuler", onClick: d => d.close()},
      {label: "Envoyer la proposition", cls: "primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/trades/propose", {to: st.to, give: st.give, want: st.want,
            coins_give: Number($("#tcGive").value) || 0, coins_want: Number($("#tcWant").value) || 0, message: $("#tMsg").value});
          d.close(); toast("Proposition envoyée à " + st.to + ".", "good");
          go("trades");
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

/* ================= DUELS ================= */
const D_STATUS = {declined: "Refusé", cancelled: "Annulé", expired: "Expiré"};
const pctf = p => Math.round(p * 100) + " %";

function gaugesHTML(res, left, right) {
  // La jauge est partagée selon les chances de la manche ; le curseur montre le tirage.
  return `<div class="odds-line"><span>${esc(left)} · ${pctf(res.p)}</span><span>${pctf(1 - res.p)} · ${esc(right)}</span></div>
    <div class="rounds">${res.rounds.map((roll, i) => `
      <div class="round"><span class="rl">${roll < res.p ? "✔ manche " + (i + 1) : ""}</span>
        <div class="gauge"><i style="width:${res.p * 100}%"></i><span class="mark" style="left:${roll * 100}%;animation-delay:${i * .5}s"></span></div>
        <span class="rr">${roll >= res.p ? "manche " + (i + 1) + " ✔" : ""}</span></div>`).join("")}</div>`;
}

function duelHTML(d) {
  const me = ME ? ME.name : "", mine = d.from === me, other = mine ? d.to : d.from;
  const done = d.status === "done";
  const won = done && d.winner === me;
  const r = d.result, live = d.live;
  const pa = r ? r.pa : live ? live.pa : 0, pb = r ? r.pb : live ? live.pb : 0;
  const myChance = live ? (mine ? live.match : 1 - live.match) : null;
  return `<article class="duel">
    <div class="thead">${mine ? "Défi lancé à" : "Défi de"} <b>${esc(other)}</b>
      ${d.stake ? `<span class="tag">mise ${nf(d.stake)} 🪙</span>` : ""}
      ${done ? `<span class="tag ${won ? "ok" : "no"}">${won ? "Victoire" : "Défaite"}</span>`
             : d.status !== "pending" ? `<span class="tag">${D_STATUS[d.status] || d.status}</span>` : ""}
      <span class="spacer"></span>
      ${d.status === "pending" ? `<span class="note">expire dans <span data-ends="${d.expires}"></span></span>` : ""}</div>
    <div class="vs">
      <div class="side"><b>${esc(d.from)}</b><span class="power">⚡ ${fmt(pa)}</span></div>
      <div class="${done ? "scoreline" : "vsx"}">${done ? r.score.join(" – ") : "VS"}</div>
      <div class="side"><b>${esc(d.to)}</b><span class="power">⚡ ${fmt(pb)}</span></div>
    </div>
    ${done ? gaugesHTML(r, d.from, d.to) : ""}
    ${myChance != null ? `<p class="note center" style="margin:0">Tes chances de gagner : <b>${pctf(myChance)}</b></p>` : ""}
    ${d.status === "pending" ? `<div class="tfoot">${mine
      ? `<button class="btn small danger" data-dc="${esc(d.id)}">Annuler</button>`
      : `<button class="btn small" data-dd="${esc(d.id)}">Refuser</button><button class="btn small primary" data-da="${esc(d.id)}">⚔️ Accepter${d.stake ? " (" + nf(d.stake) + " 🪙)" : ""}</button>`}</div>` : ""}
  </article>`;
}

async function loadDuels() {
  let d;
  try { d = await api("/api/duels"); } catch (e) { return fail(e); }
  const total = d.me.won + d.me.lost;
  $("#duelsBody").innerHTML = `
    <div class="phead"><h1>Duels</h1><p>Ta <b>puissance</b> est le total des vues de tes cartes uniques.
      Un duel se joue au meilleur des trois manches : la jauge de chaque manche est partagée selon vos
      puissances, et un tirage désigne le vainqueur. Le plus fort est favori, pas certain de gagner.</p></div>
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><b class="power">⚡ ${fmt(d.me.power)}</b><span>ta puissance</span></div>
      <div class="stat"><b class="win">${nf(d.me.won)}</b><span>victoires</span></div>
      <div class="stat"><b class="lose">${nf(d.me.lost)}</b><span>défaites</span></div>
      <div class="stat"><b>${total ? Math.round(d.me.won / total * 100) + " %" : "—"}</b><span>de réussite</span></div>
    </div>
    <button class="btn primary" id="newDuel">⚔️ Lancer un défi</button>
    ${d.incoming.length ? `<div class="sectitle"><h2>Défis reçus (${d.incoming.length})</h2></div>${d.incoming.map(duelHTML).join("")}` : ""}
    ${d.outgoing.length ? `<div class="sectitle"><h2>Défis envoyés</h2></div>${d.outgoing.map(duelHTML).join("")}` : ""}
    ${d.history.length ? `<div class="sectitle"><h2>Derniers duels</h2></div>${d.history.map(duelHTML).join("")}`
      : !d.incoming.length && !d.outgoing.length ? `<p class="empty"><b>Aucun duel pour l'instant</b>Défie un ami, ou n'importe quel joueur depuis son profil.</p>` : ""}`;
  $("#newDuel").onclick = () => duelDialog("");
  $$("#duelsBody [data-da]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const r = await api("/api/duels/accept", {id: b.dataset.da}); duelResult(r); loadDuels(); loadMe(); loadCounts(); }
    catch (e) { b.disabled = false; fail(e); }
  });
  const act = (sel, path, msg) => $$("#duelsBody " + sel).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await api(path, {id: b.dataset[Object.keys(b.dataset)[0]]}); toast(msg, "good"); loadDuels(); loadMe(); loadCounts(); }
    catch (e) { b.disabled = false; fail(e); }
  });
  act("[data-dd]", "/api/duels/decline", "Défi refusé.");
  act("[data-dc]", "/api/duels/cancel", "Défi annulé, mise rendue.");
  tickCountdowns();
}

function duelResult(d) {
  const me = ME ? ME.name : "", won = d.winner === me;
  modal({
    title: won ? "🏆 Victoire !" : "Défaite…",
    body: `<div class="duel" style="box-shadow:none;border:0;padding:0">
      <div class="vs">
        <div class="side"><b>${esc(d.from)}</b><span class="power">⚡ ${fmt(d.result.pa)}</span></div>
        <div class="scoreline">${d.result.score.join(" – ")}</div>
        <div class="side"><b>${esc(d.to)}</b><span class="power">⚡ ${fmt(d.result.pb)}</span></div>
      </div>
      ${gaugesHTML(d.result, d.from, d.to)}
      ${d.stake ? `<p class="callout center">${won ? `+${nf(2 * d.stake)} 🪙 remportées` : `${nf(d.stake)} 🪙 perdues`}</p>` : ""}</div>`,
    buttons: [{label: "Fermer", cls: "primary", onClick: dl => dl.close()}],
  });
}

async function duelDialog(name) {
  const friends = await ensureFriends();
  modal({
    title: "Lancer un défi",
    body: `<label class="field">Adversaire
        <input type="text" id="dTo" list="dFriends" maxlength="24" value="${esc(name)}" placeholder="Pseudo du joueur" autocomplete="off">
        <datalist id="dFriends">${friends.map(f => `<option value="${esc(f.name)}">`).join("")}</datalist></label>
      <label class="field">Mise (facultative)
        <input type="number" id="dStake" min="0" max="100000" value="0" step="50">
        <span class="hint">Chacun mise la même somme ; le vainqueur empoche le tout. Ta mise est bloquée jusqu'à la réponse (24 h max).</span></label>
      <div class="callout" id="dOdds">Choisis un adversaire pour voir vos chances.</div>`,
    onOpen: () => {
      const odds = debounce(async () => {
        const n = $("#dTo").value.trim();
        if (!n) return;
        try {
          const o = await api("/api/duels/odds/" + encodeURIComponent(n));
          $("#dOdds").innerHTML = `Ta puissance <b class="power">⚡ ${fmt(o.me)}</b> contre <b class="power">⚡ ${fmt(o.them)}</b> :
            <b>${pctf(o.match)}</b> de chances de gagner le duel (${pctf(o.round)} par manche).`;
        } catch (e) { $("#dOdds").textContent = e.message; }
      }, 300);
      $("#dTo").oninput = odds;
      if (name) odds();
    },
    buttons: [
      {label: "Annuler", onClick: d => d.close()},
      {label: "⚔️ Défier", cls: "primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/duels/challenge", {to: $("#dTo").value.trim(), stake: Number($("#dStake").value) || 0});
          d.close(); toast("Défi envoyé !", "good"); loadMe(); go("duels");
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

/* ================= ADMIN : signalements et liste noire ================= */
function adminReports() {
  const items = adminData.r.items;
  $("#adminBody").innerHTML = items.length ? `
    <p class="note" style="margin-bottom:12px">${items.length} vidéo(s) signalée(s), les plus signalées d'abord.
      « Liste noire » retire la carte du jeu et rembourse les joueurs ; « Classer » efface les signalements.</p>
    ${items.map(it => {
      const v = it.card;
      return `<article class="report">
        <div class="rcard">${v ? cardHTML(v) : ""}</div>
        <div style="min-width:0">
          <div class="thead"><b>${esc(v ? v.title : it.id)}</b></div>
          <div class="note">${v ? esc(v.channel) + " · " + fmt(v.views) + " vues" : "vidéo inconnue"}</div>
          <div class="pbadges"><span class="tag no">${it.count} signalement(s)</span>
            ${Object.entries(it.reasons).map(([k, n]) => `<span class="tag">${esc(k)} ×${n}</span>`).join("")}</div>
          ${it.entries.filter(e => e.comment).map(e => `<p class="quote"><b>${esc(e.user)}</b> : ${esc(e.comment)}</p>`).join("")}
          <div class="tfoot" style="margin-top:10px;justify-content:flex-start">
            <a class="btn small" href="https://youtu.be/${encodeURIComponent(it.id)}" target="_blank" rel="noopener">▶ Voir</a>
            <button class="btn small" data-dismiss="${esc(it.id)}">Classer sans suite</button>
            <button class="btn small danger" data-bl="${esc(it.id)}">⛔ Liste noire</button>
          </div>
        </div>
      </article>`;
    }).join("")}`
    : `<p class="empty"><b>Aucun signalement</b>Les vidéos signalées par les joueurs apparaîtront ici.</p>`;
  $$("#adminBody [data-dismiss]").forEach(b => b.onclick = async () => {
    try { await api("/api/admin/reports/dismiss", {id: b.dataset.dismiss}); toast("Classé sans suite."); loadAdmin(); loadCounts(); }
    catch (e) { fail(e); }
  });
  $$("#adminBody [data-bl]").forEach(b => b.onclick = () => {
    const it = items.find(x => x.id === b.dataset.bl);
    blacklistDialog(it.card || {id: it.id, title: it.id}, loadAdmin);
  });
}

function adminBlacklist() {
  const rows = adminData.b.items;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <h2>Liste noire (${rows.length})</h2>
      <p class="sub">Vidéos retirées du jeu. Les réintégrer les remet dans les tirages ; les exemplaires
        retirés des collections (et remboursés) ne sont pas rendus.</p>
      <div class="tablewrap"><table>
        <thead><tr><th>Vidéo</th><th class="num">Vues</th><th>Raison</th><th>Par</th><th>Le</th><th></th></tr></thead>
        <tbody>${rows.map(v => `<tr>
          <td style="white-space:normal"><b>${esc(v.title)}</b><div class="note">${esc(v.channel)}</div></td>
          <td class="num">${fmt(v.views)}</td><td style="white-space:normal">${esc(v.reason || "—")}</td>
          <td>${esc(v.by)}</td><td>${dateOf(v.at)}</td>
          <td><button class="btn small" data-unbl="${esc(v.id)}">Réintégrer</button></td></tr>`).join("")
          || `<tr><td colspan="6" class="empty">Aucune vidéo en liste noire.</td></tr>`}</tbody></table></div>
    </div>`;
  $$("#adminBody [data-unbl]").forEach(b => b.onclick = () => unblacklist(b.dataset.unbl, loadAdmin));
}

/* ================= PROFIL ================= */
let leaderTab = "power";
async function loadProfile(name) {
  try {
    const [p, lb] = await Promise.all([
      api(name ? "/api/profile/" + encodeURIComponent(name) : "/api/profile"),
      api("/api/leaderboard"),
    ]);
    renderProfile(p, lb);
  } catch (e) { fail(e); }
}
const LB = {
  power: ["Puissance", r => "⚡ " + fmt(r.power)], cards: ["Cartes", r => nf(r.unique)],
  duels: ["Duels", r => nf(r.won) + " V"], coins: ["Pièces", r => nf(r.coins)], packs: ["Packs", r => nf(r.packs)],
};
function renderProfile(p, lb) {
  const self = ME && p.name === ME.name;
  profileName = self ? null : p.name;
  const pct = p.pool ? Math.round(p.unique/p.pool*100) : 0;
  const maxTier = Math.max(1, ...p.tiers.map(t => t.owned));
  const total = p.won + p.lost;
  const rel = {
    friend: `<span class="tag ok">✓ Ami</span><button class="btn small" id="pTrade">🤝 Échanger</button>`,
    sent: `<span class="tag">Demande envoyée</span>`,
    received: `<button class="btn small primary" id="pAccept">Accepter sa demande d'ami</button>`,
    none: `<button class="btn small primary" id="pAdd">➕ Ajouter en ami</button>`,
  }[p.relation] || "";
  $("#profileBody").innerHTML = `
    <div class="panel">
      <div class="profhead">
        <div class="avwrap"><div class="avatar">${esc(p.avatar)}</div>${p.online && !self ? '<i class="online"></i>' : ""}</div>
        <div style="flex:1;min-width:200px">
          <h1 style="font-size:1.8rem">${esc(p.username)}</h1>
          <div class="pbadges">
            <span class="tag power">⚡ ${fmt(p.power)}</span>
            ${p.guild ? `<span class="tag">${esc(p.guild.emblem || "🛡️")} ${esc(p.guild.name)} [${esc(p.guild.tag)}]</span>` : ""}
            ${p.admin ? '<span class="tag ok">admin</span>' : ""}
            ${!self ? `<span class="tag">${p.online ? "en ligne" : "hors ligne"}</span>` : ""}
          </div>
          ${p.bio ? `<p style="margin:10px 0 0">${esc(p.bio)}</p>` : self ? `<p class="sub" style="margin:10px 0 0">Pas encore de bio.</p>` : ""}
        </div>
      </div>
      <div class="relbar" style="margin-top:14px">
        ${self ? `<button class="btn small" id="editProfile">✏️ Modifier</button>
          <button class="btn small" id="editPw">🔑 Mot de passe</button>
          ${ME.admin ? `<button class="btn small" id="pAdmin">🛠️ Administration</button>` : ""}`
          : `${rel}<button class="btn small" id="pDuel">⚔️ Défier</button><button class="btn small" id="backMe">← Mon profil</button>`}
      </div>
      <div class="stats" style="margin-top:14px">
        <div class="stat"><b>${nf(p.unique)}</b><span>cartes uniques</span></div>
        <div class="stat"><b>${pct} %</b><span>du catalogue</span></div>
        <div class="stat"><b>${nf(p.packs)}</b><span>packs ouverts</span></div>
        <div class="stat"><b>${nf(p.won)}–${nf(p.lost)}</b><span>duels ${total ? "(" + Math.round(p.won / total * 100) + " %)" : ""}</span></div>
        <div class="stat"><b>${nf(p.friends)}</b><span>amis</span></div>
        ${p.coins != null ? `<div class="stat"><b style="color:var(--gold)">${nf(p.coins)}</b><span>pièces</span></div>` : ""}
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <h2>⭐ Vitrine</h2>
      <p class="sub">${self ? "Jusqu'à 6 cartes de ton choix. Ouvre une carte et touche « Mettre en vitrine »."
        : "Les cartes que " + esc(p.username) + " a choisi de montrer."}</p>
      ${p.showcase.length ? `<div class="showcase">${p.showcase.map(cellHTML).join("")}</div>`
        : `<p class="empty" style="padding:18px 0"><b>Vitrine vide</b>${self ? "Choisis tes plus belles cartes." : ""}</p>`}
    </div>

    <div class="panel" style="margin-top:16px">
      <h2>💎 Les plus rares</h2><p class="sub">Les vidéos les plus vues de la collection.</p>
      ${p.best.length ? `<div class="showcase">${p.best.map(cellHTML).join("")}</div>`
        : `<p class="empty"><b>Collection vide</b>${self ? "Ouvre ton premier pack !" : ""}</p>`}
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="panel">
        <h2>Par rareté</h2><p class="sub">Cartes uniques possédées.</p>
        <div class="progress">${p.tiers.map(t => `
          <div class="line"><span class="name">${esc(t.name)}</span>
            <span class="bar" style="--t:var(${DOT[t.key]})"><i style="width:${Math.round(t.owned/maxTier*100)}%"></i></span>
            <span class="num">${nf(t.owned)}</span></div>`).join("")}</div>
      </div>
      <div class="panel">
        <h2>Classement</h2>
        <div class="segmented scroll" id="lbTabs" style="margin-top:8px">${Object.entries(LB).map(([k, [label]]) =>
          `<button data-l="${k}" aria-pressed="${leaderTab === k}">${label}</button>`).join("")}</div>
        <div class="tablewrap"><table style="min-width:0"><tbody id="lbBody"></tbody></table></div>
      </div>
    </div>`;

  const renderLb = () => {
    const rows = lb[leaderTab] || [];
    const val = LB[leaderTab][1];
    $("#lbBody").innerHTML = rows.map((r, i) => `
      <tr><td class="rank ${i < 3 ? "top" : ""}">${i+1}</td>
        <td><button class="linkish" data-prof="${esc(r.name)}" style="background:none;border:0;padding:0;font-weight:700;color:var(--ink)">
          <span class="avatar xs" style="display:inline-grid;vertical-align:middle">${esc(r.avatar)}</span> ${esc(r.username)}</button></td>
        <td class="num">${val(r)}</td></tr>`).join("")
      || `<tr><td class="empty">Pas encore de joueurs classés.</td></tr>`;
    $$("#lbBody [data-prof]").forEach(b => b.onclick = () => loadProfile(b.dataset.prof));
  };
  renderLb();
  $$("#lbTabs button").forEach(b => b.onclick = () => {
    leaderTab = b.dataset.l;
    $$("#lbTabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    renderLb();
  });
  const on = (id, fn) => { if ($(id)) $(id).onclick = fn; };
  on("#backMe", () => loadProfile());
  on("#editProfile", () => editProfileDialog(p));
  on("#editPw", passwordDialog);
  on("#pAdmin", () => go("admin"));
  on("#pDuel", () => duelDialog(p.name));
  on("#pTrade", () => tradeBuilder({to: p.name}));
  on("#pAdd", async () => {
    try { await api("/api/friends/request", {name: p.name}); toast("Demande d'ami envoyée.", "good"); loadProfile(p.name); }
    catch (e) { fail(e); }
  });
  on("#pAccept", async () => {
    try {
      await api("/api/friends/respond", {name: p.name, accept: true});
      toast("Vous êtes maintenant amis !", "good"); FRIENDS = []; loadProfile(p.name); loadCounts();
    } catch (e) { fail(e); }
  });
  window.scrollTo({top: 0});
}

function editProfileDialog(p) {
  let avatar = p.avatar;
  modal({
    title: "Modifier mon profil",
    body: `<label class="field">Avatar
        <div class="avatars" id="mAv">${META.avatars.map(a => `<button type="button" data-a="${esc(a)}" aria-pressed="${a === p.avatar}">${esc(a)}</button>`).join("")}</div></label>
      <label class="field">Bio<textarea id="mBio" maxlength="200" placeholder="Deux mots sur toi…">${esc(p.bio)}</textarea>
        <span class="hint">200 caractères maximum.</span></label>`,
    onOpen: () => $$("#mAv button").forEach(b => b.onclick = () => {
      avatar = b.dataset.a;
      $$("#mAv button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    }),
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Enregistrer", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/profile", {bio:$("#mBio").value, avatar});
          d.close(); toast("Profil mis à jour.", "good"); loadMe(); loadProfile();
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

function passwordDialog() {
  modal({
    title: "Changer de mot de passe",
    body: `<label class="field">Mot de passe actuel<input type="password" id="mOld" autocomplete="current-password"></label>
      <label class="field">Nouveau mot de passe<input type="password" id="mNew" autocomplete="new-password">
        <span class="hint">8 caractères minimum.</span></label>`,
    buttons: [
      {label:"Annuler", onClick: d => d.close()},
      {label:"Changer", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try {
          await api("/api/password", {current:$("#mOld").value, new:$("#mNew").value});
          d.close(); toast("Mot de passe changé.", "good");
        } catch (e) { btn.disabled = false; fail(e); }
      }},
    ],
  });
}

/* ================= ADMINISTRATION ================= */
$$("#adminTabs button").forEach(b => b.onclick = () => {
  adminTab = b.dataset.a;
  $$("#adminTabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  loadAdmin();
});

async function loadAdmin() {
  if (!ME || !ME.admin) { $("#adminBody").innerHTML = `<p class="empty"><b>Accès refusé</b>Cette section est réservée aux administrateurs.</p>`; return; }
  try {
    if (adminTab === "overview") { adminData.o = await api("/api/admin/overview"); adminOverview(); }
    else if (adminTab === "users") { adminData.u = await api("/api/admin/users"); adminUsers(); }
    else if (adminTab === "settings") { adminData.o = await api("/api/admin/overview"); adminSettings(); }
    else if (adminTab === "sources") { adminData.s = await api("/api/admin/sources"); adminSources(); }
    else if (adminTab === "auctions") { adminData.a = await api("/api/admin/auctions"); adminAuctions(); }
    else if (adminTab === "guilds") { adminData.g = await api("/api/admin/guilds"); adminGuilds(); }
    else if (adminTab === "reports") { adminData.r = await api("/api/admin/reports"); adminReports(); }
    else if (adminTab === "blacklist") { adminData.b = await api("/api/admin/blacklist"); adminBlacklist(); }
  } catch (e) { fail(e); }
}

function adminOverview() {
  const o = adminData.o;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <h2>Le jeu en chiffres</h2><p class="sub">Mis à jour à chaque ouverture de cet onglet.</p>
      <div class="stats">
        <div class="stat"><b>${nf(o.users)}</b><span>joueurs</span></div>
        <div class="stat"><b>${nf(o.videos)}</b><span>vidéos jouables</span></div>
        <div class="stat"><b>${nf(o.known)}</b><span>vidéos connues</span></div>
        <div class="stat"><b>${nf(o.packs)}</b><span>packs ouverts</span></div>
        <div class="stat"><b style="color:var(--gold)">${nf(o.coins)}</b><span>pièces en circulation</span></div>
        <div class="stat"><b>${nf(o.escrow)}</b><span>pièces bloquées</span></div>
        <div class="stat"><b>${nf(o.live_auctions)}</b><span>enchères en cours</span></div>
        <div class="stat"><b>${nf(o.guilds)}</b><span>guildes</span></div>
        <div class="stat"><b style="color:var(--bad)">${nf(o.reports)}</b><span>vidéos signalées</span></div>
        <div class="stat"><b>${nf(o.blacklisted)}</b><span>en liste noire</span></div>
        <div class="stat"><b>${nf(o.channels)}</b><span>chaînes suivies</span></div>
      </div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="panel">
        <h2>Worker</h2>
        <p class="sub">Dernier passage : <b>${o.heartbeat ? ago(Number(o.heartbeat)) : "jamais"}</b> ·
          état : <b>${esc(o.worker_status || "inconnu")}</b></p>
        ${workerStatsHTML(o)}
        <p class="note" style="margin-top:10px">Le worker moissonne les tendances, les recherches et les flux RSS
          des chaînes validées. « À enrichir » sont des cartes déjà jouables dont la catégorie et les j'aime
          arrivent au fil des cycles ; la file se vide d'elle-même.</p>
      </div>
      <div class="panel">
        <h2>Administrateurs</h2>
        <p class="sub">${o.admins.map(a => `<span class="tag ok">${esc(a)}</span>`).join(" ")}</p>
        <p class="note">Ajoute ou retire des droits dans l'onglet <b>Joueurs</b>. Les comptes listés dans la variable
          d'environnement <code>ADMIN_USERS</code> sont recréés administrateurs à chaque démarrage et ne peuvent pas être rétrogradés ici.</p>
        <div class="row" style="margin-top:12px"><button class="btn" id="bcast">Envoyer une annonce</button></div>
      </div>
    </div>`;
  $("#bcast").onclick = () => modal({
    title: "Annonce à tous les joueurs",
    body: `<label class="field">Message<textarea id="mMsg" maxlength="200" placeholder="Maintenance à 20 h…"></textarea>
      <span class="hint">Apparaît dans les notifications de chaque joueur.</span></label>`,
    buttons: [{label:"Annuler", onClick:d => d.close()},
      {label:"Envoyer", cls:"primary", onClick: async (d, btn) => {
        btn.disabled = true;
        try { await api("/api/admin/broadcast", {text:$("#mMsg").value}); d.close(); toast("Annonce envoyée.", "good"); }
        catch (e) { btn.disabled = false; fail(e); }
      }}],
  });
}

function workerStatsHTML(o) {
  const w = o.worker_stats || {};
  if (!w.cycle) return `<p class="note">Aucun cycle terminé pour l'instant.</p>`;
  const rows = [
    ["Cycle", nf(w.cycle)], ["Ajoutées au dernier cycle", nf(w.added)],
    ["Durée du cycle", (w.seconds || 0) + " s"], ["Instances disponibles", nf(w.instances)],
    ["Chaînes suivies", nf(w.channels)], ["Recommandations en file", nf(o.queued)],
    ["Cartes à enrichir", nf(w.to_enrich)], ["Écartées : trop peu vues", nf(w.low_views)],
    ["Écartées : pas en français", nf(w.foreign)],
    ["Requêtes API réussies / échouées", nf(w.api_ok) + " / " + nf(w.api_fail)],
  ];
  return `<div class="stats">${rows.map(([k, v]) =>
    `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("")}</div>`;
}

function adminUsers() {
  const rows = adminData.u.users;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <h2 style="flex:1">Joueurs (${rows.length})</h2>
        <input type="search" id="aq" placeholder="Filtrer par pseudo…" style="width:min(240px,55vw)">
      </div>
      <div class="tablewrap"><table>
        <thead><tr><th>Joueur</th><th class="num">Pièces</th><th class="num">Packs dispo.</th><th class="num">Cartes</th>
          <th class="num">Ouverts</th><th>Inscrit</th><th>Statut</th><th>Actions</th></tr></thead>
        <tbody id="aub"></tbody></table></div>
    </div>`;
  const draw = () => {
    const q = $("#aq").value.trim().toLowerCase();
    const list = rows.filter(u => !q || u.name.includes(q));
    $("#aub").innerHTML = list.map(u => `
      <tr><td><span class="avatar xs" style="display:inline-grid;vertical-align:middle">${esc(u.avatar)}</span>
          <b>${esc(u.username)}</b></td>
        <td class="num">${nf(u.coins)}</td><td class="num">${u.tickets}</td><td class="num">${nf(u.unique)}</td>
        <td class="num">${nf(u.packs)}</td><td>${dateOf(u.created)}</td>
        <td>${u.admin ? '<span class="tag ok">admin</span> ' : ""}${u.banned ? '<span class="tag no">suspendu</span>' : ""}</td>
        <td><button class="btn small" data-u="${esc(u.name)}">Gérer</button></td></tr>`).join("")
      || `<tr><td colspan="8" class="empty">Aucun joueur.</td></tr>`;
    $$("#aub [data-u]").forEach(b => b.onclick = () => manageUser(rows.find(u => u.name === b.dataset.u)));
  };
  $("#aq").addEventListener("input", draw);
  draw();
}

async function adminAct(payload, done) {
  try { await api("/api/admin/user", payload); toast("C'est fait.", "good"); if (done) done(); loadAdmin(); }
  catch (e) { fail(e); }
}

function manageUser(u) {
  modal({
    title: "Gérer " + u.username,
    body: `
      <div class="stats">
        <div class="stat"><b>${nf(u.coins)}</b><span>pièces</span></div>
        <div class="stat"><b>${u.tickets}</b><span>packs</span></div>
        <div class="stat"><b>${nf(u.unique)}</b><span>cartes</span></div>
        <div class="stat"><b>${u.listings}</b><span>ventes</span></div>
      </div>
      <label class="field">Créditer / débiter des pièces
        <div class="row" style="flex-wrap:nowrap"><input type="number" id="mCoins" value="100" step="50">
          <button class="btn small" id="doCoins">Appliquer</button></div>
        <span class="hint">Un nombre négatif retire des pièces (le solde ne passe jamais sous zéro).</span></label>
      <label class="field">Créditer / débiter des packs
        <div class="row" style="flex-wrap:nowrap"><input type="number" id="mTick" value="1">
          <button class="btn small" id="doTick">Appliquer</button></div></label>
      <label class="field">Réinitialiser le mot de passe
        <div class="row" style="flex-wrap:nowrap"><input type="text" id="mPw" placeholder="nouveau mot de passe">
          <button class="btn small" id="doPw">Changer</button></div></label>
      <div class="row">
        <button class="btn" id="doAdmin">${u.admin ? "Retirer les droits admin" : "Nommer administrateur"}</button>
        <button class="btn ${u.banned ? "" : "danger"}" id="doBan">${u.banned ? "Réactiver le compte" : "Suspendre le compte"}</button>
      </div>`,
    onOpen: d => {
      $("#doCoins").onclick = () => adminAct({name:u.name, action:"coins", amount:Number($("#mCoins").value) || 0}, () => d.close());
      $("#doTick").onclick = () => adminAct({name:u.name, action:"tickets", amount:Number($("#mTick").value) || 0}, () => d.close());
      $("#doPw").onclick = () => adminAct({name:u.name, action:"password", password:$("#mPw").value}, () => d.close());
      $("#doAdmin").onclick = () => adminAct({name:u.name, action:u.admin ? "revoke" : "grant"}, () => d.close());
      $("#doBan").onclick = () => adminAct({name:u.name, action:u.banned ? "unban" : "ban"}, () => d.close());
    },
    buttons: [{label:"Fermer", cls:"primary", onClick: d => d.close()}],
  });
}

const SETTING_LABELS = {
  pack_interval: ["Intervalle entre deux packs offerts", "secondes (600 = 10 minutes)"],
  pack_max: ["Packs accumulables au maximum", "au-delà, le compteur s'arrête"],
  pack_price: ["Prix d'un pack acheté", "pièces"],
  pack_bonus: ["Pièces offertes par ouverture", "pièces"],
  start_coins: ["Pièces à l'inscription", "pièces"],
  start_tickets: ["Packs à l'inscription", "packs"],
  fee: ["Commission de l'hôtel des ventes", "% prélevés au vendeur"],
  bid_step: ["Surenchère minimale", "% du prix courant"],
  anti_snipe: ["Prolongation anti-snipe", "secondes"],
  max_listings: ["Ventes simultanées par joueur", "ventes"],
  signups: ["Inscriptions ouvertes", "1 = oui, 0 = non"],
  bot_check: ["Vérification anti-robot", "packs entre deux contrôles, 0 désactive"],
  guild_cost: ["Coût de fondation d'une guilde", "pièces"],
  guild_max: ["Membres par guilde", "membres"],
  guild_rate: ["Pièces du trésor pour 1 XP", "pièces"],
  guild_bonus: ["Bonus de pièces par niveau de guilde", "% par niveau"],
};
function adminSettings() {
  const s = adminData.o.settings;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <h2>Réglages du jeu</h2><p class="sub">Appliqués immédiatement, sans redéploiement.</p>
      <div class="grid-2">${Object.keys(SETTING_LABELS).map(k => `
        <label class="field">${SETTING_LABELS[k][0]}
          <input type="number" data-s="${k}" value="${s[k]}">
          <span class="hint">${SETTING_LABELS[k][1]}</span></label>`).join("")}
        <label class="field">Code d'invitation
          <input type="text" id="sInvite" value="${esc(adminData.o.invite || "")}" placeholder="vide = inscription libre">
          <span class="hint">Remplace la variable d'environnement <code>INVITE_CODE</code>.</span></label>
      </div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="saveSettings">Enregistrer</button>
        <span class="note">Les vues minimum (<code>MIN_VIEWS</code>) et le rythme du worker restent des variables d'environnement.</span></div>
    </div>`;
  $("#saveSettings").onclick = async () => {
    const values = {};
    $$("#adminBody [data-s]").forEach(i => { values[i.dataset.s] = Number(i.value); });
    try {
      await api("/api/admin/settings", {values, invite:$("#sInvite").value});
      toast("Réglages enregistrés.", "good");
      META = await api("/api/meta");
      $("#packPrice").textContent = nf(META.pack_price);
      loadAdmin(); loadMe();
    } catch (e) { fail(e); }
  };
}

function adminSources() {
  const rows = adminData.s.sources;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <h2>Sources explorées (${rows.length})</h2>
      <p class="sub">Onglet vidéos d'une chaîne, playlist, ou recherche <code>ytsearch40:mots clés</code>.
        Le worker traite toujours la source la plus ancienne ; « Relancer » la remet en tête de file.</p>
      <div class="row" style="flex-wrap:nowrap;margin-bottom:14px">
        <input type="text" id="newSrc" placeholder="https://www.youtube.com/@Chaine/videos">
        <button class="btn primary" id="addSrc">Ajouter</button>
      </div>
      <div class="tablewrap"><table>
        <thead><tr><th>Source</th><th>Dernier passage</th><th>Actions</th></tr></thead>
        <tbody>${rows.map(s => `<tr>
          <td style="white-space:normal;word-break:break-all">${esc(s.url)}</td>
          <td>${s.last ? ago(s.last) : "jamais"}</td>
          <td><button class="btn small" data-bump="${esc(s.url)}">Relancer</button>
              <button class="btn small danger" data-del="${esc(s.url)}">Retirer</button></td></tr>`).join("")
          || `<tr><td colspan="3" class="empty">Aucune source.</td></tr>`}</tbody></table></div>
    </div>`;
  const act = async (url, action) => {
    try { await api("/api/admin/source", {url, action}); toast("C'est fait.", "good"); loadAdmin(); }
    catch (e) { fail(e); }
  };
  $("#addSrc").onclick = () => { const v = $("#newSrc").value.trim(); if (v) act(v, "add"); };
  $$("#adminBody [data-bump]").forEach(b => b.onclick = () => act(b.dataset.bump, "bump"));
  $$("#adminBody [data-del]").forEach(b => b.onclick = () => act(b.dataset.del, "remove"));
}

function adminAuctions() {
  const rows = adminData.a.items;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <h2>Enchères en cours (${rows.length})</h2>
      <p class="sub">Annuler rembourse l'enchérisseur et rend la carte au vendeur.</p>
      <div class="tablewrap"><table>
        <thead><tr><th>Carte</th><th>Vendeur</th><th class="num">Prix</th><th class="num">Mises</th>
          <th>Meneur</th><th>Fin</th><th></th></tr></thead>
        <tbody>${rows.map(a => `<tr>
          <td style="white-space:normal">${esc(a.card ? a.card.title : "(vidéo disparue)")}</td>
          <td>${esc(a.seller)}</td><td class="num">${nf(a.price)} 🪙</td><td class="num">${a.bids}</td>
          <td>${esc(a.bidder || "—")}</td><td class="left" data-ends="${a.ends}"></td>
          <td><button class="btn small danger" data-ac="${esc(a.id)}">Annuler</button></td></tr>`).join("")
          || `<tr><td colspan="7" class="empty">Aucune enchère en cours.</td></tr>`}</tbody></table></div>
    </div>`;
  $$("#adminBody [data-ac]").forEach(b => b.onclick = async () => {
    try { await api("/api/admin/auction/cancel", {id:b.dataset.ac}); toast("Enchère annulée.", "good"); loadAdmin(); }
    catch (e) { fail(e); }
  });
  tickCountdowns();
}

function adminGuilds() {
  const rows = adminData.g.guilds;
  $("#adminBody").innerHTML = `
    <div class="panel">
      <h2>Guildes (${rows.length})</h2>
      <p class="sub">Dissoudre libère tous les membres et efface le trésor. Le nom redevient disponible.</p>
      <div class="tablewrap"><table>
        <thead><tr><th>Guilde</th><th>Chef</th><th class="num">Niveau</th><th class="num">XP</th>
          <th class="num">Membres</th><th class="num">Trésor</th><th>Fondée</th><th></th></tr></thead>
        <tbody>${rows.map(g => `<tr>
          <td><span class="emblem sm" style="display:inline-grid;vertical-align:middle;width:26px;height:26px;font-size:.9rem">${esc(g.emblem)}</span>
            <b>${esc(g.name)}</b> <span class="gtag">[${esc(g.tag)}]</span></td>
          <td>${esc(g.owner)}</td><td class="num">${g.level}</td><td class="num">${nf(g.xp)}</td>
          <td class="num">${g.count}</td><td class="num">${nf(g.coins)} 🪙</td><td>${dateOf(g.created)}</td>
          <td><button class="btn small danger" data-gd="${esc(g.id)}">Dissoudre</button></td></tr>`).join("")
          || `<tr><td colspan="8" class="empty">Aucune guilde.</td></tr>`}</tbody></table></div>
    </div>`;
  $$("#adminBody [data-gd]").forEach(b => b.onclick = () => confirmDialog(
    "Dissoudre la guilde", "Action définitive : les membres sont libérés et le trésor disparaît.",
    async () => { await api("/api/admin/guild/disband", {id: b.dataset.gd}); toast("Guilde dissoute."); loadAdmin(); }));
}

/* ================= Démarrage ================= */
async function loadMeta() {
  try {
    META = await api("/api/meta");
    TIERS = META.tiers;
    const iv = META.pack_interval;
    $("#heroInterval").textContent = iv % 60 === 0 ? (iv / 60) + (iv === 60 ? " minute" : " minutes") : clock(iv);
    $("#heroMax").textContent = META.pack_max;
    $("#packPrice").textContent = nf(META.pack_price);
    if (META.kofi) $$("a[href*='ko-fi.com']").forEach(a => { a.href = META.kofi; });
    $("#poolInfo").textContent = nf(META.videos) + " vidéos au total · " + nf(META.players) + " joueurs";
    $("#crawlInfo").textContent = META.last_crawl
      ? "Dernière recherche de vidéos par le worker : " + ago(Number(META.last_crawl))
      : "Première recherche de vidéos en cours…";
    const w = TIERS.reduce((s, t) => s + t.weight, 0);
    $("#odds").innerHTML = TIERS.slice().reverse().map(t =>
      `<span style="--dot:var(${DOT[t.key]})">${esc(t.name)} (${fmt(Math.max(t.min, META.min_views))}+) :
        ${(t.weight/w*100).toLocaleString("fr-FR",{maximumFractionDigits:2})} % · recyclage ${nf(t.value)} 🪙</span>`).join("");
  } catch (e) { fail(e); }
}

(async function start() {
  await loadMeta();
  await loadMe();
  let start = "packs";
  const asked = new URLSearchParams(location.search).get("vue");   // raccourcis de l'app installée
  if (asked && LOADERS[asked]) start = asked;
  else { try { const v = localStorage.getItem("tp:view"); if (v && LOADERS[v] && (v !== "admin" || (ME && ME.admin))) start = v; } catch (e) {} }
  go(start);
  setInterval(loadMeta, 60000);
  loadCounts();
  setInterval(() => { loadMe(); loadCounts(); if (view === "market") loadMarket(); }, 30000);
})();
})();
