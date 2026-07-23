/* ============================================================
   Insurtech Daily — feed loading + filtering
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

function meta(a, block) {
  const m = el("div", "meta");
  const src = el("span", "src", a.source);
  const time = el("span", "time", timeAgo(a.publishedAt));
  if (block) {
    // lead: inline "Source · time"
    m.append(src, document.createTextNode("  ·  "), time);
  } else {
    m.append(src, time);
  }
  return m;
}

function leadCard(a) {
  const card = el("a", "lead-card");
  card.href = a.link; card.target = "_blank"; card.rel = "noopener noreferrer";
  card.append(el("span", "lead-badge", "Lead story"));
  card.append(el("h2", null, a.title));
  if (a.summary) card.append(el("p", "summary", a.summary));
  card.append(meta(a, true));
  return card;
}

function storyRow(a) {
  const li = el("li");
  const link = el("a", "story");
  link.href = a.link; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.append(el("h3", null, a.title));
  link.append(meta(a, false));
  if (a.summary) link.append(el("p", "summary", a.summary));
  li.append(link);
  return li;
}

/* --- State + rendering --- */
let ALL = [];
const leadEl = document.getElementById("lead");
const feedEl = document.getElementById("feed");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");
const sourceEl = document.getElementById("sourceFilter");
const countEl = document.getElementById("resultCount");

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
  const src = sourceEl.value;
  const list = ALL.filter((a) => {
    if (src && a.source !== src) return false;
    if (q && !(a.title.toLowerCase().includes(q) || (a.summary || "").toLowerCase().includes(q))) return false;
    return true;
  });
  render(list);
}

searchEl.addEventListener("input", applyFilters);
sourceEl.addEventListener("change", applyFilters);

/* --- Load feed --- */
fetch("data/news.json", { cache: "no-cache" })
  .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then((data) => {
    ALL = data.articles || [];
    document.getElementById("loading").remove();

    document.getElementById("statCount").textContent = ALL.length;
    document.getElementById("statSources").textContent = (data.sources || []).length;
    const upd = timeAgo(data.updatedAt);
    document.getElementById("statUpdated").textContent = upd;
    document.getElementById("navUpdated").textContent = upd;

    (data.sources || []).forEach((s) => {
      const o = el("option", null, s);
      o.value = s;
      sourceEl.append(o);
    });

    render(ALL);
  })
  .catch((err) => {
    const l = document.getElementById("loading");
    if (l) l.textContent = "Couldn't load the feed. Please try again shortly.";
    document.getElementById("navUpdated").textContent = "offline";
    console.error(err);
  });
