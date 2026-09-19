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

let META = {min_views:10000, tiers:[], pack_interval:600, pack_max:12, pack_price:250, fee:5, bid_step:5, avatars:["🎴"], durations:["1h"]};
let ME = null, TIERS = [];
let view = "packs", minLog = 4;
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
const minViews = () => Math.max(META.min_views, Math.round(Math.pow(10, minLog)));
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
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Erreur serveur (" + res.status + ")");
  return data;
}
const fail = e => { if (e.message !== "401") toast(e.message, "bad"); };

/* ---------------- Fenêtre modale ---------------- */
function modal(opts) {
  const dlg = $("#modal");
  $("#modalTitle").textContent = opts.title || "";
  $("#modalBody").innerHTML = opts.body || "";
  $("#modalFoot").innerHTML = "";
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
function cardHTML(v, o) {
  o = o || {};
  const [emo, a, b] = CAT[v.category] || CAT.autre, id = encodeURIComponent(v.id);
  return `<div class="card ${v.tier}">
    ${v.new ? '<span class="newbadge">Nouveau</span>' : ""}
    <div class="thumb" style="background:linear-gradient(135deg,${a},${b})"><span aria-hidden="true">${emo}</span>
      <img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy"></div>
    <div class="cbody">
      <div class="ctitle">${esc(v.title)}</div>
      <div class="cchan">${esc(v.channel)}${v.year ? " (" + esc(v.year) + ")" : ""}</div>
      ${v.likes != null ? `<div class="likes">👍 ${fmt(v.likes)} j'aime</div>` : ""}
      <div class="cfoot"><span class="views">${fmt(v.views)} <small>vues</small></span><span class="tier">${esc(tierName(v.tier))}</span></div>
    </div>
    ${o.noLink ? "" : `<a class="link" href="https://youtu.be/${id}" target="_blank" rel="noopener"><span>Voir « ${esc(v.title)} » sur YouTube</span></a>`}
  </div>`;
}
// Miniature introuvable : on garde le fond coloré (pas de onerror inline, compatible CSP).
document.addEventListener("error", e => {
  if (e.target.tagName === "IMG" && e.target.closest(".thumb, .mini")) e.target.remove();
}, true);

/* ---------------- Barre du haut ---------------- */
function renderWallet() {
  if (!ME) return;
  $("#wCoins").textContent = nf(ME.coins);
  $("#wPacks").textContent = ME.tickets;
  $("#wTimer").textContent = ME.tickets >= META.pack_max ? "· plein" : "· " + clock(ME.next_pack);
  const pc = $("#packClock");
  if (pc) pc.textContent = clock(ME.next_pack);
  $("#bellDot").hidden = !ME.notifs;
  $("#bellDot").textContent = ME.notifs;
  $$("#nav button[data-view='admin']").forEach(b => { b.hidden = !ME.admin; });
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
  if (ME && ME.tickets < META.pack_max) {
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
const LOADERS = {
  packs: () => { renderPackTable(); loadColl(); },
  coll: () => loadColl(),
  market: () => loadMarket(),
  profile: () => loadProfile(),
  admin: () => loadAdmin(),
};
function go(name) {
  view = name;
  $$("#nav button").forEach(b => b.setAttribute("aria-current", String(b.dataset.view === name)));
  ["packs","coll","market","profile","admin"].forEach(v => { $("#view-" + v).hidden = v !== name; });
  try { localStorage.setItem("tp:view", name); } catch (e) {}
  (LOADERS[name] || (() => {}))();
  window.scrollTo({top:0, behavior:"instant"});
}
$$("#nav button").forEach(b => b.onclick = () => go(b.dataset.view));

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
      ? `<p class="hint">Clique sur le pack pour le déchirer.${ME.tickets < META.pack_max
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
    [data] = await Promise.all([api("/api/packs/open", {min_views: minViews()}), new Promise(r => setTimeout(r, 520))]);
  } catch (e) { fail(e); loadMe().then(renderPackTable); return; }

  if (ME) { ME.coins = data.coins; ME.tickets = data.tickets; ME.next_pack = data.next_pack; ME.packs += 1; renderWallet(); }
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
    <p class="hint">+${data.bonus} 🪙 pour cette ouverture.</p>`;
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
    if (ME) { ME.coins = d.coins; ME.tickets = d.tickets; ME.next_pack = d.next_pack; renderWallet(); }
    toast("Pack acheté pour " + nf(META.pack_price) + " pièces.", "good");
    if (view === "packs") renderPackTable();
  } catch (e) { fail(e); }
};

function syncSlider() {
  $("#minViews").value = minLog;
  $("#minOut").textContent = nf(minViews());
}
let collTimer;
$("#minViews").addEventListener("input", e => {
  minLog = parseFloat(e.target.value);
  try { localStorage.setItem("tp:minLog", minLog); } catch (err) {}
  syncSlider();
  clearTimeout(collTimer);
  collTimer = setTimeout(loadColl, 300);
});

/* ================= COLLECTION ================= */
async function loadColl() {
  try {
    coll = await api("/api/collection?min_views=" + minViews());
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
    .map(t => `<button class="chip" data-f="${t.key}" aria-pressed="${collFilter === t.key}">${esc(t.name)} ${nf(t.owned)}/${nf(t.total)}</button>`).join("");
  $$("#collFilters .chip").forEach(c => c.onclick = () => { collFilter = c.dataset.f; collShown = 60; renderColl(); });

  const list = collList();
  $("#cgrid").innerHTML = list.length
    ? list.slice(0, collShown).map(v => `<div class="cell" data-id="${esc(v.id)}">
        ${v.count > 1 ? `<span class="count">×${v.count}</span>` : ""}
        ${cardHTML(v)}
        <div class="tools">
          <button data-act="sell" data-id="${esc(v.id)}">Vendre</button>
          ${v.count > 1 ? `<button data-act="scrap" data-id="${esc(v.id)}">Recycler</button>` : ""}
        </div></div>`).join("")
    : `<p class="empty"><b>Aucune carte ici</b>Ouvre des packs ou chine à l'hôtel des ventes.</p>`;
  $$("#cgrid .tools button").forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const v = coll.cards.find(x => x.id === b.dataset.id);
    if (v) (b.dataset.act === "sell" ? sellDialog : scrapDialog)(v);
  });
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

/* ================= PROFIL ================= */
let leaderTab = "cards";
async function loadProfile(name) {
  try {
    const [p, lb] = await Promise.all([
      api(name ? "/api/profile/" + encodeURIComponent(name) : "/api/profile"),
      api("/api/leaderboard"),
    ]);
    renderProfile(p, lb);
  } catch (e) { fail(e); }
}
function renderProfile(p, lb) {
  const self = ME && p.name === ME.name;
  const pct = p.pool ? Math.round(p.unique/p.pool*100) : 0;
  const maxTier = Math.max(1, ...p.tiers.map(t => t.owned));
  $("#profileBody").innerHTML = `
    <div class="panel">
      <div class="profhead">
        <div class="avatar">${esc(p.avatar)}</div>
        <div style="flex:1;min-width:220px">
          <h1 style="font-size:1.9rem">${esc(p.username)} ${p.admin ? '<span class="tag ok">admin</span>' : ""}</h1>
          <p class="sub" style="margin:4px 0 0">Inscrit le ${dateOf(p.created)} · ${p.listings} vente(s) en cours</p>
          ${p.bio ? `<p style="margin:8px 0 0">${esc(p.bio)}</p>` : `<p class="sub" style="margin:8px 0 0">${self ? "Pas encore de bio." : ""}</p>`}
        </div>
        ${self ? `<div class="row" style="gap:8px"><button class="btn" id="editProfile">Modifier</button>
          <button class="btn" id="editPw">Mot de passe</button></div>` : `<button class="btn" id="backMe">Mon profil</button>`}
      </div>
      <div class="stats" style="margin-top:16px">
        <div class="stat"><b>${nf(p.unique)}</b><span>cartes uniques</span></div>
        <div class="stat"><b>${nf(p.copies)}</b><span>exemplaires</span></div>
        <div class="stat"><b>${nf(p.packs)}</b><span>packs ouverts</span></div>
        <div class="stat"><b>${pct} %</b><span>du deck (${nf(p.pool)})</span></div>
        ${p.coins != null ? `<div class="stat"><b style="color:var(--gold)">${nf(p.coins)}</b><span>pièces</span></div>` : ""}
      </div>
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
        <div class="row" style="margin-bottom:10px"><h2 style="flex:1">Classement</h2>
          <div class="segmented" id="lbTabs">
            <button data-l="cards" aria-pressed="${leaderTab==="cards"}">Cartes</button>
            <button data-l="coins" aria-pressed="${leaderTab==="coins"}">Pièces</button>
            <button data-l="packs" aria-pressed="${leaderTab==="packs"}">Packs</button>
          </div></div>
        <div class="tablewrap"><table><tbody id="lbBody"></tbody></table></div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <h2>Plus belles cartes</h2><p class="sub">Les vidéos les plus vues de la collection.</p>
      ${p.best.length ? `<div class="cgrid">${p.best.map(v => `<div class="cell">${v.count > 1 ? `<span class="count">×${v.count}</span>` : ""}${cardHTML(v)}</div>`).join("")}</div>`
        : `<p class="empty"><b>Collection vide</b>${self ? "Ouvre ton premier pack !" : ""}</p>`}
    </div>`;

  const renderLb = () => {
    const rows = lb[leaderTab] || [];
    const val = r => leaderTab === "cards" ? r.unique : leaderTab === "coins" ? r.coins : r.packs;
    $("#lbBody").innerHTML = rows.map((r, i) => `
      <tr><td class="rank ${i < 3 ? "top" : ""}">${i+1}</td>
        <td><button class="btn small" data-prof="${esc(r.name)}" style="border:0;background:none;padding:0;font-weight:700">
          <span class="avatar xs" style="display:inline-grid;vertical-align:middle">${esc(r.avatar)}</span> ${esc(r.username)}</button></td>
        <td class="num">${nf(val(r))}</td></tr>`).join("")
      || `<tr><td class="empty">Pas encore de joueurs classés.</td></tr>`;
    $$("#lbBody [data-prof]").forEach(b => b.onclick = () => loadProfile(b.dataset.prof));
  };
  renderLb();
  $$("#lbTabs button").forEach(b => b.onclick = () => {
    leaderTab = b.dataset.l;
    $$("#lbTabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    renderLb();
  });
  if ($("#backMe")) $("#backMe").onclick = () => loadProfile();
  if ($("#editProfile")) $("#editProfile").onclick = () => editProfileDialog(p);
  if ($("#editPw")) $("#editPw").onclick = passwordDialog;
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
        <div class="stat"><b>${nf(o.sources)}</b><span>sources du worker</span></div>
      </div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="panel">
        <h2>Worker</h2>
        <p class="sub">Dernier passage : <b>${o.heartbeat ? ago(Number(o.heartbeat)) : "jamais"}</b><br>
          État : <b>${esc(o.worker_status || "inconnu")}</b></p>
        <p class="note">Le worker explore les sources en continu ; une pause anti-blocage apparaît ici
          quand YouTube refuse les requêtes.</p>
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

/* ================= Démarrage ================= */
async function loadMeta() {
  try {
    META = await api("/api/meta");
    TIERS = META.tiers;
    syncSlider();
    $("#heroInterval").textContent = clock(META.pack_interval);
    $("#heroMax").textContent = META.pack_max;
    $("#packPrice").textContent = nf(META.pack_price);
    $("#poolInfo").textContent = nf(META.videos) + " vidéos au total · " + nf(META.players) + " joueurs";
    $("#crawlInfo").textContent = META.last_crawl
      ? "Dernière recherche de vidéos par le worker : " + ago(Number(META.last_crawl))
      : "Première recherche de vidéos en cours…";
    const w = TIERS.reduce((s, t) => s + t.weight, 0);
    $("#odds").innerHTML = TIERS.slice().reverse().map(t =>
      `<span style="--dot:var(${DOT[t.key]})">${esc(t.name)} (${fmt(Math.max(t.min, META.min_views))}+) :
        ${(t.weight/w*100).toLocaleString("fr-FR",{maximumFractionDigits:1})} % · recyclage ${nf(t.value)} 🪙</span>`).join("");
  } catch (e) { fail(e); }
}

(async function start() {
  try { const v = parseFloat(localStorage.getItem("tp:minLog")); if (v >= 4 && v <= 8.5) minLog = v; } catch (e) {}
  syncSlider();
  await loadMeta();
  await loadMe();
  let start = "packs";
  try { const v = localStorage.getItem("tp:view"); if (v && LOADERS[v] && (v !== "admin" || (ME && ME.admin))) start = v; } catch (e) {}
  go(start);
  setInterval(loadMeta, 60000);
  setInterval(() => { loadMe(); if (view === "market") loadMarket(); }, 30000);
})();
})();
