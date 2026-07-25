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

// `showOutlets` is suppressed when the card carries a thread disclosure —
// that control already states the outlet count, so repeating it here is noise.
function metaEl(a, showOutlets = true) {
  const m = el("div", "meta");
  m.append(sourceEl(a));
  m.append(el("span", "dot", " · "));
  m.append(el("span", "time", timeAgo(a.publishedAt)));
  if (showOutlets && a.cluster > 1) {
    m.append(el("span", "dot", " · "));
    m.append(el("span", "outlets", `${a.cluster} outlets`));
  }
  return m;
}

function headingEl(tag, title) {
  const h = el(tag, null);
  h.append(document.createTextNode(title));
  return h;
}

// Company badges (links) + taxonomy tag pills, in one row below the card body.
// Company badges come first and are visually distinct — they navigate.
function cardTags(a, maxTags) {
  const badges = (a.companies || []).map((c) => {
    const b = el("a", "company-badge", c.name);
    b.href = `/company/${encodeURIComponent(c.slug)}/`;
    return b;
  });
  // "Industry" is the generic catch-all — noise repeated down the wire.
  const tags = (a.tags || []).filter((t) => t !== "Industry").slice(0, maxTags);
  if (!badges.length && !tags.length) return null;
  const wrap = el("div", "card-tags");
  badges.forEach((b) => wrap.append(b));
  tags.forEach((t) => wrap.append(el("span", "tag-pill", t)));
  return wrap;
}

/* ---- Threads: the same event, reported by several outlets ----
   The feed shows one headline per thread and tucks the rest behind a
   disclosure, so repeat coverage stops crowding out distinct stories. */

// Enough to prove corroboration without turning a row into a wall of dupes.
const MAX_THREAD_ITEMS = 6;
let threadSeq = 0;

function threadEl(group) {
  const others = group.others;
  if (!others.length) return null;

  const wrap = el("div", "thread");
  const listId = "thread-" + ++threadSeq;

  // "Outlets" only if the extra coverage really is from distinct outlets —
  // a source running several pieces on one story is "more stories".
  const distinct = new Set(others.map((a) => a.source));
  const n = others.length;
  const noun = distinct.size === n
    ? (n === 1 ? "outlet" : "outlets")
    : (n === 1 ? "story" : "stories");

  const btn = el("button", "thread-toggle");
  btn.type = "button";
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", listId);
  const label = el("span", "thread-label", `+${n} more ${noun}`);
  btn.append(el("span", "thread-chevron"));   // caret is drawn in CSS
  btn.append(label);

  const list = el("ul", "thread-list");
  list.id = listId;
  list.hidden = true;
  others.slice(0, MAX_THREAD_ITEMS).forEach((a) => {
    const li = el("li", "thread-item");
    const link = el("a", "thread-link");
    link.href = a.link; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.append(el("span", "thread-src", a.source));
    link.append(el("span", "thread-dot", " · "));
    link.append(el("span", "thread-time", timeAgo(a.publishedAt)));
    link.append(el("span", "thread-title", a.title));
    li.append(link);
    list.append(li);
  });
  if (n > MAX_THREAD_ITEMS) {
    list.append(el("li", "thread-more", `and ${n - MAX_THREAD_ITEMS} more`));
  }

  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    list.hidden = open;
    label.textContent = open ? `+${n} more ${noun}` : "Hide coverage";
  });

  wrap.append(btn);
  wrap.append(list);
  return wrap;
}

function leadCard(group) {
  const a = group.head;
  const card = el("div", "lead-card");
  const main = el("a", "lead-main");
  main.href = a.link; main.target = "_blank"; main.rel = "noopener noreferrer";
  const badge = el("div", "lead-badge-row");
  badge.append(el("span", "lead-badge", "Lead story"));
  main.append(badge);
  main.append(metaEl(a, !group.others.length));
  main.append(headingEl("h2", a.title));
  if (a.summary) main.append(el("p", "summary", a.summary));
  card.append(main);
  const ct = cardTags(a, 4);
  if (ct) card.append(ct);
  const th = threadEl(group);
  if (th) card.append(th);
  return card;
}

function storyRow(group) {
  const a = group.head;
  const li = el("li", "story");
  const main = el("a", "story-main");
  main.href = a.link; main.target = "_blank"; main.rel = "noopener noreferrer";
  main.append(metaEl(a, !group.others.length));
  main.append(headingEl("h3", a.title));
  if (a.summary) main.append(el("p", "summary", a.summary));
  li.append(main);
  const ct = cardTags(a, 3);
  if (ct) li.append(ct);
  const th = threadEl(group);
  if (th) li.append(th);
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
// Lead = highest prominence score, but only among genuinely fresh stories.
// A stale-but-heavily-corroborated piece shouldn't headline the page, so we
// score inside a 24h window first and only widen (48h, then 72h) when that
// window is empty. If nothing at all is recent, fall back to the whole list.
// (List stays recency-ordered for the wire below.)
const LEAD_WINDOWS_H = [24, 48, 72];
function pickLead(list) {
  const now = Date.now();
  let pool = list;
  for (const hours of LEAD_WINDOWS_H) {
    const fresh = list.filter((a) => a.timestamp && now - a.timestamp <= hours * 3.6e6);
    if (fresh.length) { pool = fresh; break; }
  }
  let best = pool[0];
  for (const a of pool) if ((a.score || 0) > (best.score || 0)) best = a;
  return best;
}

/* Fold a (already filtered) list into threads.

   Grouping runs on the filtered list rather than once up front, so a search
   or topic filter that matches only part of a thread shows exactly what it
   matched — the disclosure never promises coverage the filter excluded.

   A thread keeps the wire position of its most recent member (the feed is
   recency-ordered) but fronts its highest-scoring one, so a fresh press-wire
   dupe can't bury the better-sourced write-up of the same event. */
function groupThreads(list) {
  const byId = new Map();
  const groups = [];
  list.forEach((a) => {
    // No clusterId (older cached payload) → the article stands alone.
    if (!a.clusterId) { groups.push({ members: [a] }); return; }
    let g = byId.get(a.clusterId);
    if (!g) { g = { members: [] }; byId.set(a.clusterId, g); groups.push(g); }
    g.members.push(a);
  });
  groups.forEach((g) => {
    let head = g.members[0];
    for (const m of g.members) if ((m.score || 0) > (head.score || 0)) head = m;
    g.head = head;
    g.others = g.members.filter((m) => m !== head);
  });
  return groups;
}

function render(list) {
  leadEl.innerHTML = "";
  feedEl.innerHTML = "";
  emptyEl.hidden = list.length > 0;
  if (list.length === 0) { countEl.textContent = "0 shown"; return; }

  const groups = groupThreads(list);
  const folded = list.length - groups.length;
  countEl.textContent = folded > 0
    ? `${groups.length} shown · ${folded} folded in`
    : `${list.length} shown`;

  // The lead is chosen by prominence within a freshness window, so it may not
  // be its thread's own head — pin it as head so the card shows the story we
  // promoted, with the rest of that thread behind its disclosure.
  const lead = pickLead(list);
  const leadGroup = groups.find((g) => g.members.includes(lead));
  if (leadGroup) {
    leadGroup.head = lead;
    leadGroup.others = leadGroup.members.filter((m) => m !== lead);
  }
  leadEl.append(leadCard(leadGroup || { members: [lead], head: lead, others: [] }));

  const frag = document.createDocumentFragment();
  groups.filter((g) => g !== leadGroup).forEach((g) => frag.append(storyRow(g)));
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
   Editor's brief — render, expand/collapse
   ============================================================ */
const briefEl = document.getElementById("brief");
const briefToggle = document.getElementById("briefToggle");

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
  const author = brief.by === "claude" ? "Written" : "Generated";
  foot.textContent = `${author} from this batch's themes${gen ? " · " + gen : ""}. A read of the wire, not investment advice.`;

  briefEl.hidden = false;
}

/* Expand / collapse */
const briefCueLabel = document.getElementById("briefCueLabel");
function setBriefOpen(open) {
  briefEl.dataset.open = open ? "true" : "false";
  briefToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (briefCueLabel) briefCueLabel.textContent = open ? "Hide" : "Read the brief";
}
if (briefToggle) {
  briefToggle.addEventListener("click", () => {
    setBriefOpen(briefEl.dataset.open !== "true");
  });
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

      renderBrief(data.briefing);
      buildChips(data.taxonomy || []);

      // Honour a ?q= deep link (matches the site's SearchAction schema).
      const q = new URLSearchParams(location.search).get("q");
      if (q) { searchEl.value = q; applyFilters(); } else render(ALL);
    })
    .catch((err) => {
      console.error(err);
      showError(err.name === "AbortError" ? "Loading timed out." : "Couldn't load the feed.");
    })
    .finally(() => clearTimeout(timer));
}

searchEl.addEventListener("input", applyFilters);
loadFeed();
