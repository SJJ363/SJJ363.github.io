/* ============================================================
   Company page — full coverage history for one company
   ============================================================ */
document.getElementById("year").textContent = new Date().getFullYear();

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fullDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const slug = new URLSearchParams(location.search).get("c");
const loadingEl = document.getElementById("coLoading");
const emptyEl = document.getElementById("coEmpty");

function articleRow(a) {
  const li = el("li", "story");
  const main = el("a", "story-main");
  main.href = a.link; main.target = "_blank"; main.rel = "noopener noreferrer";

  const meta = el("div", "meta");
  meta.append(el("span", "src", a.source));
  meta.append(el("span", "dot", " · "));
  meta.append(el("span", "time", fullDate(a.publishedAt)));
  main.append(meta);

  const h3 = el("h3"); h3.append(document.createTextNode(a.title));
  main.append(h3);
  li.append(main);

  const tags = (a.tags || []).filter((t) => t !== "Industry");
  if (tags.length) {
    const wrap = el("div", "card-tags");
    tags.slice(0, 4).forEach((t) => wrap.append(el("span", "tag-pill", t)));
    li.append(wrap);
  }
  return li;
}

function renderCompany(c) {
  document.title = `${c.name} — Insurtech Daily`;
  document.getElementById("coName").textContent = c.name;

  const bits = [`${c.count} ${c.count === 1 ? "story" : "stories"}`];
  if (c.firstSeen) bits.push(`tracked since ${fullDate(c.firstSeen)}`);
  if (c.lastSeen) bits.push(`last seen ${timeAgo(c.lastSeen)}`);
  document.getElementById("coStats").textContent = bits.join("  ·  ");

  // Facts: topics, related companies, sources
  const facts = document.getElementById("coFacts");
  const topicsWrap = document.getElementById("coTopicsWrap");
  const relatedWrap = document.getElementById("coRelatedWrap");
  const sourcesWrap = document.getElementById("coSourcesWrap");

  if (c.topics && c.topics.length) {
    const t = document.getElementById("coTopics");
    c.topics.forEach((tp) => t.append(el("span", "tag-pill", tp.name)));
  } else topicsWrap.hidden = true;

  if (c.related && c.related.length) {
    const r = document.getElementById("coRelated");
    c.related.forEach((rc) => {
      const a = el("a", "company-badge", rc.name);
      a.href = `company.html?c=${encodeURIComponent(rc.slug)}`;
      r.append(a);
    });
  } else relatedWrap.hidden = true;

  if (c.sources && c.sources.length) {
    document.getElementById("coSources").textContent = c.sources.join(", ");
  } else sourcesWrap.hidden = true;

  if (!topicsWrap.hidden || !relatedWrap.hidden || !sourcesWrap.hidden) facts.hidden = false;

  // Coverage list (already newest-first from the build)
  document.getElementById("coCoverageLabel").hidden = false;
  const feed = document.getElementById("coArticles");
  const frag = document.createDocumentFragment();
  (c.articles || []).forEach((a) => frag.append(articleRow(a)));
  feed.append(frag);
}

function notFound() {
  emptyEl.hidden = false;
  document.getElementById("coName").textContent = "Company not found";
  document.querySelector(".co-kicker").textContent = "";
}

if (!slug) {
  loadingEl.hidden = true;
  notFound();
} else {
  fetch("data/companies.json?ts=" + Date.now(), { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((data) => {
      loadingEl.hidden = true;
      const c = (data.companies || []).find((x) => x.slug === slug);
      if (c) renderCompany(c); else notFound();
    })
    .catch(() => { loadingEl.textContent = "Couldn't load this company."; });
}
