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

function metaEl(a, inline) {
  const m = el("div", "meta");
  const src = el("span", "src", a.source);
  const time = el("span", "time", timeAgo(a.publishedAt));
  if (inline) m.append(src, document.createTextNode("  ·  "), time);
  else m.append(src, time);
  return m;
}

function tagsEl(tags, max) {
  const wrap = el("div", "tags");
  tags.slice(0, max).forEach((t) => wrap.append(el("span", "tag-pill", t)));
  return wrap;
}

function leadCard(a) {
  const card = el("a", "lead-card");
  card.href = a.link; card.target = "_blank"; card.rel = "noopener noreferrer";
  card.append(el("span", "lead-badge", "Lead story"));
  card.append(el("h2", null, a.title));
  if (a.summary) card.append(el("p", "summary", a.summary));
  card.append(metaEl(a, true));
  if (a.tags && a.tags.length) card.append(tagsEl(a.tags, 4));
  return card;
}

function storyRow(a) {
  const li = el("li");
  const link = el("a", "story");
  link.href = a.link; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.append(el("h3", null, a.title));
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
function render(list) {
  leadEl.innerHTML = "";
  feedEl.innerHTML = "";
  emptyEl.hidden = list.length > 0;
  countEl.textContent = `${list.length} shown`;
  if (list.length === 0) return;

  const [lead, ...rest] = list;
  leadEl.append(leadCard(lead));

  const frag = document.createDocumentFragment();
  rest.forEach((a) => frag.append(storyRow(a)));
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
