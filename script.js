/* ============================================================
   Insurtech Daily — feed loading + interactions
   ============================================================ */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.getElementById("year").textContent = new Date().getFullYear();

/* --- Cursor spotlight --- */
if (!reduceMotion && window.matchMedia("(pointer: fine)").matches) {
  const root = document.documentElement;
  let tx = 50, ty = 15, raf = null;
  window.addEventListener("mousemove", (e) => {
    tx = (e.clientX / window.innerWidth) * 100;
    ty = (e.clientY / window.innerHeight) * 100;
    if (!raf) raf = requestAnimationFrame(() => {
      root.style.setProperty("--mx", tx + "%");
      root.style.setProperty("--my", ty + "%");
      raf = null;
    });
  });
}

/* --- Nav solidify on scroll --- */
const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 24);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* --- Reveal observer (for dynamically added cards) --- */
const io = !reduceMotion && "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" })
  : null;

function observe(el) {
  if (io) io.observe(el);
  else el.classList.add("in");
}

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

const ARROW = '<svg class="card-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M9 7h8v8"/></svg>';

function foot(article) {
  const f = el("div", "card-foot");
  const src = el("span", "src", article.source);
  const sep = el("span", "sep", "·");
  const time = el("span", "time", timeAgo(article.publishedAt));
  f.append(src, sep, time);
  f.insertAdjacentHTML("beforeend", ARROW);
  return f;
}

function leadCard(a) {
  const card = el("a", "lead-card reveal");
  card.href = a.link; card.target = "_blank"; card.rel = "noopener noreferrer";
  card.append(el("span", "lead-badge", "Lead story"));
  card.append(el("h2", null, a.title));
  if (a.summary) card.append(el("p", "card-summary", a.summary));
  card.append(foot(a));
  return card;
}

function storyCard(a) {
  const card = el("a", "story reveal");
  card.href = a.link; card.target = "_blank"; card.rel = "noopener noreferrer";
  card.append(el("h3", null, a.title));
  if (a.summary) card.append(el("p", "card-summary", a.summary));
  card.append(foot(a));
  return card;
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

  if (list.length === 0) { countEl.textContent = "0 shown"; return; }

  const [lead, ...rest] = list;
  const lc = leadCard(lead);
  leadEl.append(lc);
  observe(lc);

  const frag = document.createDocumentFragment();
  rest.forEach((a) => {
    const c = storyCard(a);
    frag.append(c);
  });
  feedEl.append(frag);
  feedEl.querySelectorAll(".story").forEach(observe);

  countEl.textContent = `${list.length} shown`;
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

    // Stats
    document.getElementById("statCount").textContent = ALL.length;
    document.getElementById("statSources").textContent = (data.sources || []).length;
    const upd = timeAgo(data.updatedAt);
    document.getElementById("statUpdated").textContent = upd;
    document.getElementById("navUpdated").textContent = "updated " + upd;

    // Source dropdown
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
