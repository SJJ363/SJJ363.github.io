/* ============================================================
   Insurtech Daily — feed loading, taxonomy filter, search
   ============================================================ */

document.getElementById("year").textContent = new Date().getFullYear();

/* --- Helpers --- */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function sourceEl(a) {
  const src = el("span", "src");
  src.append(document.createTextNode(a.source));
  return src;
}

function metaEl(a, inline) {
  const m = el("div", "meta");
  const time = el("span", "time", timeAgo(a.publishedAt));
  if (inline) m.append(sourceEl(a), document.createTextNode("  ·  "), time);
  else m.append(sourceEl(a), time);
  if (a.cluster > 1) m.append(el("span", "outlets", `${a.cluster} outlets`));
  return m;
}

function tagsEl(tags, max) {
  const wrap = el("div", "tags");
  // "Industry" is the generic catch-all — informative as a filter, but noise
  // repeated down the wire, so leave it off the row tags.
  tags.filter((t) => t !== "Industry").slice(0, max).forEach((t) => wrap.append(el("span", "tag-pill", t)));
  return wrap;
}

function headingEl(tag, title) {
  const h = el(tag, null);
  h.append(document.createTextNode(title));
  return h;
}

function leadCard(a) {
  const card = el("a", "lead-card");
  card.href = a.link; card.target = "_blank"; card.rel = "noopener noreferrer";
  const badge = el("div", "lead-badge-row");
  badge.append(el("span", "lead-badge", "Lead story"));
  if (a.cluster > 1) badge.append(el("span", "lead-note", `Covered by ${a.cluster} outlets`));
  card.append(badge);
  card.append(headingEl("h2", a.title));
  if (a.summary) card.append(el("p", "summary", a.summary));
  card.append(metaEl(a, true));
  if (a.tags && a.tags.length) card.append(tagsEl(a.tags, 4));
  return card;
}

function storyRow(a) {
  const li = el("li");
  const link = el("a", "story");
  link.href = a.link; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.append(headingEl("h3", a.title));
  if (a.tags && a.tags.length) link.append(tagsEl(a.tags, 3));
  link.append(metaEl(a, false));
  if (a.summary) link.append(el("p", "summary", a.summary));
  li.append(link);
  return li;
}

/* --- State --- */
let ALL = [];
const activeTags = new Set();

const leadEl = document.getElementById("lead");
const feedEl = document.getElementById("feed");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");
const filterBar = document.getElementById("filterBar");
const countEl = document.getElementById("resultCount");
const loadingEl = document.getElementById("loading");

/* --- Rendering --- */
// Lead = highest prominence score in the currently-shown list.
// (List stays recency-ordered for the wire below.)
function pickLead(list) {
  let best = list[0];
  for (const a of list) if ((a.score || 0) > (best.score || 0)) best = a;
  return best;
}

function render(list) {
  leadEl.innerHTML = "";
  feedEl.innerHTML = "";
  emptyEl.hidden = list.length > 0;
  countEl.textContent = `${list.length} shown`;
  if (list.length === 0) return;

  const lead = pickLead(list);
  leadEl.append(leadCard(lead));

  const frag = document.createDocumentFragment();
  list.filter((a) => a !== lead).forEach((a) => frag.append(storyRow(a)));
  feedEl.append(frag);
}

function applyFilters() {
  const q = searchEl.value.trim().toLowerCase();
  const list = ALL.filter((a) => {
    if (activeTags.size && !a.tags.some((t) => activeTags.has(t))) return false;
    if (q && !(a.title.toLowerCase().includes(q) || (a.summary || "").toLowerCase().includes(q))) return false;
    return true;
  });
  render(list);
}

/* --- Taxonomy chips --- */
function buildChips(taxonomy) {
  filterBar.innerHTML = "";

  const allChip = el("button", "chip chip-all active", "All");
  allChip.type = "button";
  allChip.addEventListener("click", () => {
    activeTags.clear();
    syncChips();
    applyFilters();
  });
  filterBar.append(allChip);

  taxonomy.forEach(({ name, count }) => {
    const chip = el("button", "chip");
    chip.type = "button";
    chip.dataset.tag = name;
    chip.append(el("span", null, name));
    chip.append(el("span", "cnt", String(count)));
    chip.addEventListener("click", () => {
      if (activeTags.has(name)) activeTags.delete(name);
      else activeTags.add(name);
      syncChips();
      applyFilters();
    });
    filterBar.append(chip);
  });
}

function syncChips() {
  filterBar.querySelectorAll(".chip[data-tag]").forEach((chip) => {
    chip.classList.toggle("active", activeTags.has(chip.dataset.tag));
  });
  filterBar.querySelector(".chip-all")?.classList.toggle("active", activeTags.size === 0);
}

/* ============================================================
   Editor's brief — render, expand/collapse, and read-aloud
   ============================================================ */
const briefEl = document.getElementById("brief");
const briefToggle = document.getElementById("briefToggle");
const briefListen = document.getElementById("briefListen");

let currentBrief = null;

function renderBrief(brief) {
  if (!brief || !brief.whatsHappening) {
    if (briefEl) briefEl.hidden = true;
    return;
  }
  currentBrief = brief;
  document.getElementById("briefHeadline").textContent = brief.headline || "The Brief";
  document.getElementById("briefTeaser").textContent = brief.teaser || "";
  document.getElementById("briefWhat").textContent = brief.whatsHappening;
  document.getElementById("briefWhy").textContent = brief.whyItMatters;

  const foot = document.getElementById("briefFoot");
  const gen = brief.generatedAt ? timeAgo(brief.generatedAt) : "";
  const author = brief.by === "claude" ? "Written by Claude" : "Auto-generated";
  foot.textContent = `${author} from this batch's themes${gen ? " · " + gen : ""}. A read of the wire, not investment advice.`;

  briefEl.hidden = false;
}

/* Expand / collapse */
function setBriefOpen(open) {
  briefEl.dataset.open = open ? "true" : "false";
  briefToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
if (briefToggle) {
  briefToggle.addEventListener("click", (e) => {
    // Let the Listen control handle its own clicks without toggling.
    if (e.target.closest("#briefListen")) return;
    setBriefOpen(briefEl.dataset.open !== "true");
  });
}

/* --- Read aloud (Web Speech API) --- */
const synth = window.speechSynthesis;

function pickVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const pool = en.length ? en : voices;
  // Prefer known natural-sounding voices, then any local en-US voice.
  const preferred = [
    "Google US English", "Samantha", "Microsoft Aria", "Microsoft Jenny",
    "Microsoft Guy", "Google UK English Female", "Daniel", "Karen", "Alex",
  ];
  for (const name of preferred) {
    const hit = pool.find((v) => v.name === name || v.name.includes(name));
    if (hit) return hit;
  }
  return pool.find((v) => /en-US/i.test(v.lang)) || pool[0];
}
// Voices populate asynchronously in some browsers.
if (synth && typeof synth.onvoiceschanged !== "undefined") {
  synth.onvoiceschanged = pickVoice;
}

let speaking = false;
function setSpeaking(on) {
  speaking = on;
  briefListen.classList.toggle("playing", on);
  briefListen.querySelector(".brief-listen-label").textContent = on ? "Stop" : "Listen";
  briefListen.setAttribute("aria-label", on ? "Stop reading the brief" : "Listen to the brief");
}

function toggleSpeak() {
  if (!synth) { alert("Your browser doesn't support read-aloud."); return; }
  if (speaking || synth.speaking) { synth.cancel(); setSpeaking(false); return; }
  if (!currentBrief) return;

  const text = currentBrief.spoken ||
    `${currentBrief.headline}. ${currentBrief.whatsHappening} Why it matters. ${currentBrief.whyItMatters}`;
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = 0.98;
  u.pitch = 1.0;
  u.onend = () => setSpeaking(false);
  u.onerror = () => setSpeaking(false);
  synth.cancel();          // clear any queued speech first
  synth.speak(u);
  setSpeaking(true);
  setBriefOpen(true);      // open the panel so the reader can follow along
}

if (briefListen) {
  briefListen.addEventListener("click", (e) => { e.stopPropagation(); toggleSpeak(); });
  briefListen.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleSpeak(); }
  });
}
// Stop narration if the user navigates away.
window.addEventListener("beforeunload", () => { if (synth) synth.cancel(); });

/* --- Load feed (timeout + retry) --- */
function showError(msg) {
  document.getElementById("navUpdated").textContent = "offline";
  if (!loadingEl) return;
  loadingEl.hidden = false;
  loadingEl.textContent = msg + " ";
  const btn = el("button", "retry-btn", "Retry");
  btn.type = "button";
  btn.addEventListener("click", loadFeed);
  loadingEl.append(btn);
}

function loadFeed() {
  if (loadingEl) { loadingEl.hidden = false; loadingEl.textContent = "Loading the latest insurtech news…"; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  fetch("data/news.json?ts=" + Date.now(), { cache: "no-store", signal: ctrl.signal })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((data) => {
      ALL = data.articles || [];
      if (loadingEl) loadingEl.hidden = true;

      document.getElementById("statCount").textContent = ALL.length;
      document.getElementById("statSources").textContent = (data.sources || []).length;
      const upd = timeAgo(data.updatedAt);
      document.getElementById("statUpdated").textContent = upd;
      document.getElementById("navUpdated").textContent = upd;

      renderBrief(data.briefing);
      buildChips(data.taxonomy || []);
      render(ALL);
    })
    .catch((err) => {
      console.error(err);
      showError(err.name === "AbortError" ? "Loading timed out." : "Couldn't load the feed.");
    })
    .finally(() => clearTimeout(timer));
}

searchEl.addEventListener("input", applyFilters);
loadFeed();
