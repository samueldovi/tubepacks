/* TubePacks — portail de connexion. */
(function () {
"use strict";

let mode = "login", meta = {invite_required:false, signups:true, bot_check:1}, challenge = null;
const f = document.getElementById("f"), err = document.getElementById("err"), go = document.getElementById("go");
const nf = n => Number(n || 0).toLocaleString("fr-FR");

try { const t = localStorage.getItem("tp:theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

// Service worker : la page de connexion suffit à proposer l'installation de l'app.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

async function newChallenge() {
  const row = document.getElementById("botRow");
  if (!meta.bot_check) { row.hidden = true; challenge = null; return; }
  try {
    challenge = await (await fetch("/api/challenge")).json();
    document.getElementById("botQ").textContent = challenge.question;
    f.answer.value = "";
    row.hidden = mode !== "register";
  } catch (e) { row.hidden = true; challenge = null; }
}

fetch("/api/meta").then(r => r.json()).then(m => {
  meta = m;
  if (m.kofi) document.getElementById("kofi").href = m.kofi;
  setMode(mode);
  document.getElementById("facts").innerHTML =
    `<span><b>${nf(m.videos)}</b> vidéos en jeu</span>` +
    `<span><b>${nf(m.players)}</b> joueurs</span>` +
    `<span>un pack offert toutes les <b>${Math.round(m.pack_interval/60)} min</b></span>`;
}).catch(() => {});

function setMode(m) {
  mode = m;
  document.querySelectorAll(".switch button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
  go.textContent = m === "login" ? "Se connecter" : "Créer mon compte";
  f.password.autocomplete = m === "login" ? "current-password" : "new-password";
  document.getElementById("pwHint").hidden = m === "login";
  document.getElementById("inviteRow").hidden = !(m === "register" && meta.invite_required);
  if (m === "register") newChallenge();
  else document.getElementById("botRow").hidden = true;
  err.textContent = m === "register" && !meta.signups ? "Les inscriptions sont fermées pour le moment." : "";
}
document.querySelectorAll(".switch button").forEach(b => b.onclick = () => setMode(b.dataset.mode));

f.onsubmit = async e => {
  e.preventDefault();
  err.textContent = "";
  const body = {username:f.username.value.trim(), password:f.password.value, invite:f.invite.value.trim(),
                challenge: challenge ? challenge.id : "", answer: f.answer.value.trim()};
  if (!body.username || !body.password) { err.textContent = "Renseigne ton pseudo et ton mot de passe."; return; }
  go.disabled = true;
  try {
    const r = await fetch(mode === "login" ? "/api/login" : "/api/register", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Pseudo ou mot de passe invalide.");
    location.href = "/";
  } catch (e2) {
    err.textContent = e2.message;
    if (mode === "register") newChallenge();   // la question est à usage unique
  } finally {
    go.disabled = false;
  }
};
})();
