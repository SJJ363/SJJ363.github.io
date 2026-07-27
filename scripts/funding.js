/* ============================================================
   Funding math — shared by the brief writers and the tracker
   ------------------------------------------------------------
   Turns headlines into genuinely-disclosed insurtech rounds.
   Deliberately conservative (the brief says "at least $X"), so it
   would rather undercount than repeat a market-forecast or a
   regional aggregate as if it were a single raise.

   `fundingDeals()` is the one extractor; `fundingStats()` is the
   batch summary the briefs already used, kept as a thin wrapper so
   the wire and /funding/ can never disagree about what a round is.

   Nothing here is persisted. Deals are re-derived from the store on
   every build, exactly as tags are re-derived in taxonomy.js — so a
   fix to these regexes reaches the whole archive, not just the
   articles that arrive after it.
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

/* Round stage, in priority order — first match wins, so the specific
   patterns ("pre-seed", "seed extension") come before the general one.
   Unmatched is left blank rather than guessed: an empty cell in the
   tracker is honest, "Seed" on a growth round is not. */
const STAGES = [
  ["Pre-seed", /pre[- ]?seed/i],
  ["Seed", /\bseed\b/i],
  ["Series A", /series[- ]a\b/i],
  ["Series B", /series[- ]b\b/i],
  ["Series C", /series[- ]c\b/i],
  ["Series D", /series[- ]d\b/i],
  ["Series E+", /series[- ][e-z]\b/i],
  ["Venture debt", /venture debt|debt (facility|financing|round)|credit facility/i],
  ["Growth", /growth (round|equity|capital|financing|investment)|late[- ]stage/i],
  ["Strategic", /strategic (investment|round|funding|stake)/i],
];

function stageOf(text) {
  const hit = STAGES.find(([, re]) => re.test(text));
  return hit ? hit[0] : "";
}

/* Lead investor — only from an explicit "led by", and only while the
   words stay Title Case. Anything looser ("backed by", "from") drags in
   sentence fragments and the raiser's own name, and a wrong investor is
   worse in a tracker than a blank. Trailing connectives are trimmed so
   "led by Foo Ventures and Bar" yields "Foo Ventures". */
function leadInvestor(text) {
  // "led by" is matched case-insensitively (headlines title-case it as
  // "Funding Led By"), but the name that follows is matched case-SENSITIVELY
  // — the Title Case run is the only thing marking where the name ends.
  const at = text.search(/\bled by\b/i);
  if (at < 0) return "";
  const rest = text.slice(at).replace(/^led by\s+/i, "");
  const m = rest.match(
    /^(?:[A-Z0-9][\w&.'’-]*)(?:\s+(?:[A-Z0-9][\w&.'’-]*|of|de|van|del|und|för))*/
  );
  if (!m) return "";
  return m[0].replace(/[\s,;:.]+$/, "").replace(/\s+(?:and|with|to|in|for|as|at)$/i, "").trim();
}

/* ISO-week-ish window for treating two headlines as the same raise. The
   token test alone is amount-plus-vocabulary, which is fine inside one
   batch (every article is hours old) but wrong across an archive: a
   company that raises $10M twice a year would have the second round
   silently swallowed by the first. */
const SAME_RAISE_DAYS = 45;

const daysApart = (a, b) => {
  const x = new Date(a), y = new Date(b);
  if (isNaN(x) || isNaN(y)) return 0; // undated — fall back to the token test alone
  return Math.abs(x - y) / 86400000;
};

/* Every genuine, disclosed round in `articles`, newest first, with the
   same raise reported by five outlets collapsed to one row. Each row
   keeps the article it came from so the tracker can cite a source. */
function fundingDeals(articles) {
  const tagged = (articles || [])
    .filter((a) => (a.tags || []).includes("Funding"))
    .slice()
    .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));

  const kept = [];
  for (const a of tagged) {
    if (MARKET_NOISE.test(a.title)) continue;      // forecast / aggregate — skip
    const v = amountM(a.title);
    if (v <= 0 || v > CAP_M) continue;             // no figure, or implausibly large
    const words = distinctiveWords(a.title);

    // Same raise if the amount matches, the headlines share ≥2 distinctive
    // tokens, and they were published close enough together to be one event.
    const dup = kept.find(
      (k) =>
        Math.round(k.v) === Math.round(v) &&
        [...words].filter((w) => k.words.has(w)).length >= 2 &&
        daysApart(k.publishedAt, a.publishedAt) <= SAME_RAISE_DAYS
    );
    if (dup) {
      // The duplicate is still evidence: keep the outlet, and let a later
      // headline fill in a stage or lead the first one didn't name.
      if (a.source && !dup.alsoReportedBy.includes(a.source)) dup.alsoReportedBy.push(a.source);
      if (!dup.stage) dup.stage = stageOf(a.title);
      if (!dup.lead) dup.lead = leadInvestor(a.title);
      continue;
    }

    kept.push({
      v,
      words,
      title: a.title,
      link: a.link || "",
      source: a.source || "",
      publishedAt: a.publishedAt || "",
      stage: stageOf(a.title),
      lead: leadInvestor(a.title),
      alsoReportedBy: [],
    });
  }

  return kept.map((k) => ({
    title: k.title,
    amountM: k.v,
    link: k.link,
    source: k.source,
    publishedAt: k.publishedAt,
    stage: k.stage,
    lead: k.lead,
    alsoReportedBy: k.alsoReportedBy,
  }));
}

// Sum disclosed round sizes across genuine raises, de-duplicating the same
// raise reported by multiple outlets. Returns { total (in $M), count }.
function fundingStats(articles) {
  const deals = fundingDeals(articles);
  return {
    total: deals.reduce((s, d) => s + d.amountM, 0),
    count: deals.length,
    deals: deals.map((d) => ({ title: d.title, amountM: d.amountM })),
  };
}

module.exports = { amountM, fundingStats, fundingDeals, stageOf, leadInvestor };
