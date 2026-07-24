/* ============================================================
   Funding math — shared by the brief writers
   ------------------------------------------------------------
   Sums genuinely-disclosed insurtech funding rounds from a batch.
   Deliberately conservative (the brief says "at least $X"), so it
   would rather undercount than repeat a market-forecast or a
   regional aggregate as if it were a single raise.
   ============================================================ */

// Headlines that quote a dollar figure but are NOT a company raise:
// market-size forecasts, research reports, and period/regional roundups.
const MARKET_NOISE = new RegExp(
  [
    "market (size|share|report|research|value|outlook|forecast)",
    "to (reach|exceed|hit|surpass|touch|cross) \\$",
    "\\bforecast(ed)?\\b", "\\bcagr\\b", "projected", "estimated to",
    "expected to (reach|grow|hit|exceed|rise)", "anticipated to",
    "by 20\\d\\d",                     // "... $X billion by 2035"
    "halv(e|ed|es|ing)", "rebound", "\\bdrop(ped|s)?\\b", "\\bfell\\b", "\\brose\\b",
    "\\b[1-4]H\\d\\d\\b", "\\b[1-4]Q\\d\\d\\b", "\\bH[12]\\b", "\\bQ[1-4]\\b", // period stats
    "full[- ]year", "year[- ]on[- ]year", "quarterly", "annual(ly)?",
  ].join("|"),
  "i"
);

// A single disclosed insurtech round is realistically well under this.
// Anything larger is almost certainly a market-size or aggregate figure.
const CAP_M = 2000;

// Generic funding vocabulary — ignored when deciding whether two headlines
// describe the SAME raise, so only distinctive tokens (company names) count.
const GENERIC = new Set(
  ("insurtech insurance fintech funding fund raises raise raised round rounds series " +
   "million billion invest investment investor capital startup startups secures secured " +
   "lands bags closes closed announces announced announce venture preseed seed extends " +
   "extension backs backed valuation firm company").split(/\s+/)
);

// First dollar figure in a headline → millions (best-effort).
function amountM(text) {
  const m = text.match(/\$\s?([\d,.]+)\s?(k|m|mn|bn|b|million|billion|thousand)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(n)) return 0;
  const u = (m[2] || "").toLowerCase();
  if (u === "bn" || u === "b" || u === "billion") return n * 1000;
  if (u === "k" || u === "thousand") return n / 1000;
  return n; // m / mn / million / bare
}

function distinctiveWords(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !GENERIC.has(w))
  );
}

// Sum disclosed round sizes across genuine raises, de-duplicating the same
// raise reported by multiple outlets. Returns { total (in $M), count }.
function fundingStats(articles) {
  const tagged = (articles || []).filter((a) => (a.tags || []).includes("Funding"));
  const kept = [];
  for (const a of tagged) {
    if (MARKET_NOISE.test(a.title)) continue;      // forecast / aggregate — skip
    const v = amountM(a.title);
    if (v <= 0 || v > CAP_M) continue;             // no figure, or implausibly large
    const words = distinctiveWords(a.title);
    // Same raise if the amount matches and the headlines share ≥2 distinctive tokens.
    const dup = kept.find(
      (k) => Math.round(k.v) === Math.round(v) &&
             [...words].filter((w) => k.words.has(w)).length >= 2
    );
    if (dup) continue;
    kept.push({ v, words, title: a.title });
  }
  return {
    total: kept.reduce((s, k) => s + k.v, 0),
    count: kept.length,
    deals: kept.map((k) => ({ title: k.title, amountM: k.v })),
  };
}

module.exports = { amountM, fundingStats };
