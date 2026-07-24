/* ============================================================
   Companies index — searchable list of every tracked company
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
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let ALL = [];
const listEl = document.getElementById("coList");
const emptyEl = document.getElementById("coEmpty");
const loadingEl = document.getElementById("coLoading");
const searchEl = document.getElementById("coSearch");
const resultEl = document.getElementById("coResult");

function row(c) {
  const li = el("li", "co-row");
  const a = el("a", "co-link");
  a.href = `/company/${encodeURIComponent(c.slug)}/`;
  a.append(el("span", "co-name", c.name));
  const meta = el("span", "co-meta");
  meta.append(el("span", "co-count", `${c.count} ${c.count === 1 ? "story" : "stories"}`));
  if (c.lastSeen) {
    meta.append(el("span", "dot", " · "));
    meta.append(el("span", "co-latest", `latest ${timeAgo(c.lastSeen)}`));
  }
  a.append(meta);
  li.append(a);
  return li;
}

function render(list) {
  listEl.innerHTML = "";
  emptyEl.hidden = list.length > 0;
  resultEl.textContent = `${list.length} shown`;
  const frag = document.createDocumentFragment();
  list.forEach((c) => frag.append(row(c)));
  listEl.append(frag);
}

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  render(q ? ALL.filter((c) => c.name.toLowerCase().includes(q)) : ALL);
}

fetch("data/companies.json?ts=" + Date.now(), { cache: "no-store" })
  .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then((data) => {
    ALL = (data.companies || []).slice().sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    loadingEl.hidden = true;
    document.getElementById("coCount").textContent = ALL.length;
    render(ALL);
  })
  .catch(() => { loadingEl.textContent = "Couldn't load companies."; });

searchEl.addEventListener("input", applyFilter);
