#!/usr/bin/env node
/* ============================================================
   Insurtech news fetcher
   Pulls RSS/Atom feeds, normalizes + dedupes, writes data/news.json.
   Dependency-free — runs on plain Node (18+). Fetched server-side
   (in GitHub Actions or locally), so no browser CORS issues.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { buildBriefing } = require("./build-brief");

// Each feed: url + a fallback source label + whether to keyword-filter.
// Google News search feeds are already on-topic; broad feeds get filtered.
const FEEDS = [
  { url: "https://news.google.com/rss/search?q=insurtech&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=%22insurance+technology%22&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=%22digital+insurance%22&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=%22embedded+insurance%22&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=insurtech+funding&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://www.finextra.com/rss/channel.aspx?channel=insurtech", source: "Finextra" },
];

// Relevance gate applied to every item — genuine insurtech coverage
// almost always mentions insurance in some form. Keeps the feed on-topic.
const RELEVANCE = /insur|insurtech|underwrit|reinsur|actuar|policyholder/i;

// Skip non-article URLs (e.g. Finextra webinars/events).
const SKIP_URL = /\/event-info\/|\/events?\/|\/webinar/i;

// ---- Taxonomy ----------------------------------------------------------
// Each article is tagged with every category it matches (title + summary).
// A blend of deal-type, technology, line-of-business and market themes.
// Order here is the order chips appear in the UI.
const TAXONOMY = [
  ["Funding", /(rais(e|es|ed|ing)\b|funding|seed round|series [a-e]\b|pre-seed|venture|valuation|fundrais|secures? \$|lands? \$|closes? \$[\d.]+|bags? \$|\$[\d.]+\s?(m|bn|million|billion)|investment round|capital raise|backed by)/i],
  ["M&A", /(acquir|acquisition|merg(e|es|er|ing)|buyout|takeover|to buy|snaps up|buys )/i],
  ["Partnerships", /(partner|partnership|teams? up|collaborat|joins forces|alliance|tie-?up|taps |selects |integrat|to distribute|distribution deal|powers )/i],
  ["Product & Launches", /(launch|unveil|rolls? out|introduc|debut|releases?|goes live|new (product|platform|tool|app|solution|feature)|expands? (in)?to|now available)/i],
  ["AI & Automation", /(\bAI\b|artificial intelligence|machine learning|\bML\b|gen(erative)?[ -]?ai|\bLLM\b|automat|chatbot|algorithm|predictive|\bGPT\b|agentic|copilot|no-code)/i],
  ["Embedded", /(embedded insurance|embedded finance|insurance as a service|\bAPI\b|api-first|point[- ]of[- ]sale insurance|bancassurance|at checkout)/i],
  ["Cyber", /(cyber|ransomware|data breach|malware|phishing|cyberattack|cyber risk)/i],
  ["Claims & Underwriting", /(claims?\b|underwrit|pricing|risk assessment|loss adjust|actuar|fraud|\bfnol\b|first notice of loss)/i],
  ["Health & Life", /(health ?insur|life insur|health ?tech|healthcare|medicare|medicaid|employee benefits|group health|disability insur|dental|telehealth|wellness)/i],
  ["Auto & Mobility", /(auto insur|motor insur|car insur|telematics|usage-based|\bUBI\b|fleet|\bEV\b|autonomous|mobility|driver|vehicle)/i],
  ["Property & Cat", /(property insur|homeowners?|property.and.casualty|\bP&C\b|catastrophe|\bcat bond\b|reinsur|climate|flood|wildfire|hurricane|natural disaster|parametric|commercial property)/i],
  ["Regulation", /(regulat|complian|lawsuit|\bcourt\b|department of insurance|licens|sanction|fined|penalty|legislat|\bNAIC\b|policyholder protection)/i],
  ["Leadership", /(appoint|names? (new )?(ceo|cfo|cto|coo|chair|president|head|chief)|hires?\b|joins as|steps down|resign|promot|new ceo|board of directors|expands leadership)/i],
];
const FALLBACK_TAG = "Industry";

function tagArticle(text) {
  const tags = TAXONOMY.filter(([, re]) => re.test(text)).map(([name]) => name);
  return tags.length ? tags : [FALLBACK_TAG];
}

// ---- Prominence scoring ------------------------------------------------
// Source tiers: reputable outlets get a lift; press-wire / market-research
// republishers get a penalty so they don't win the lead slot on recency.
const REPUTABLE = new Set([
  "Reuters", "Bloomberg", "Financial Times", "CNBC", "Forbes", "TechCrunch", "The Verge",
  "Insurance Journal", "Finextra", "Insurance Business", "Reinsurance News", "Artemis",
  "Coverager", "FinTech Global", "Digital Insurance", "Insurance Times", "Canadian Underwriter",
  "Life Insurance International", "Insurance Asia", "Beinsure", "The Insurer", "theinsurer.com",
  "Insurance Edge", "Insurance Nerds", "Program Business", "Carrier Management", "Reinsurance News",
]);
const LOW_SIGNAL = new Set([
  "EIN Presswire", "PR Newswire", "Business Wire", "GlobeNewswire", "Globe Newswire", "PRWeb",
  "Yahoo Finance", "Yahoo Finance Singapore", "MSN", "Stock Titan", "Quiver Quantitative",
  "Market Data Forecast", "Fortune Business Insights", "simplywall.st", "TradingView", "Moomoo",
  "Pluang", "marketscreener.com", "Zawya", "EIN News", "Centurion Jewelry Show",
]);

const STOP = new Set(
  "the a an and or for to of in on at with from by is are as it its their new this that has have will its than into over amid insurtech insurance tech technology company companies firm firms report reports says announce announces announced launch launches".split(/\s+/)
);
function keywordSet(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

// Score components (additive): recency (decay), corroboration (distinct
// outlets covering the same story), source tier, and event signal words.
function scoreArticles(articles) {
  const now = Date.now();
  const kw = articles.map((a) => keywordSet(a.title));

  articles.forEach((a, i) => {
    // Corroboration — how many distinct sources cover a near-identical story
    const outlets = new Set([a.source]);
    for (let j = 0; j < articles.length; j++) {
      if (j === i) continue;
      let inter = 0;
      for (const w of kw[i]) if (kw[j].has(w)) inter++;
      const union = kw[i].size + kw[j].size - inter;
      if (inter >= 2 && union > 0 && inter / union >= 0.4) outlets.add(articles[j].source);
    }
    const cluster = outlets.size;

    const ageH = (now - a.timestamp) / 3.6e6;
    const recency = Math.exp(-ageH / 24);          // 1 now → ~0.37 at 24h
    const corrob = Math.min(cluster - 1, 3) / 3;   // 0 unique → 1 at 4+ outlets

    let src = 0;
    if (REPUTABLE.has(a.source)) src = 1;
    else if (LOW_SIGNAL.has(a.source)) src = -1.2;

    const t = a.title;
    let signal = 0;
    if (/\$\s?\d+(\.\d+)?\s?(k|m|bn|million|billion)\b/i.test(t) || /series\s+[b-e]\b/i.test(t)) signal += 0.6;
    if (/acqui|merger|buyout|takeover/i.test(t)) signal += 0.5;
    if (/launch|unveil|partner|raises?\b/i.test(t)) signal += 0.2;
    signal = Math.min(signal, 1);

    a.cluster = cluster;
    a.score = +(2.5 * recency + 1.5 * corrob + src + signal).toFixed(3);
  });
}

const MAX_ITEMS = 140;
const MAX_AGE_DAYS = 45;
const UA = "Mozilla/5.0 (compatible; InsurtechAggregator/1.0)";

/* ---------- tiny XML helpers ---------- */

function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s = "") {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// First inner text of <tag ...>...</tag>
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeEntities(m[1].trim()) : "";
}

// Extract blocks for a given element name (item or entry)
function blocks(xml, name) {
  const re = new RegExp(`<${name}[\\s>][\\s\\S]*?<\\/${name}>`, "gi");
  return xml.match(re) || [];
}

function extractLink(block) {
  // RSS: <link>URL</link>
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim().startsWith("http")) return decodeEntities(rss[1].trim());
  // Atom: <link href="URL" .../> (prefer rel="alternate")
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return decodeEntities(alt[1]);
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (any) return decodeEntities(any[1]);
  return "";
}

/* ---------- fetch + parse a feed ---------- */

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...blocks(xml, "item"), ...blocks(xml, "entry")];
    const out = [];

    for (const b of items) {
      const rawTitle = tag(b, "title");
      if (!rawTitle) continue;

      const link = extractLink(b);
      if (!link || SKIP_URL.test(link)) continue;

      // Date: RSS pubDate / dc:date, Atom published/updated
      const dateStr = tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated");
      const ts = dateStr ? Date.parse(dateStr) : NaN;
      if (isNaN(ts)) continue;
      // Drop future-dated items (events/webinars masquerading as news)
      if (ts > Date.now() + 864e5) continue;

      // Source: Google News embeds <source url=...>Publisher</source>
      let source = tag(b, "source") || feed.source;
      let title = rawTitle;
      // Google News titles are "Headline - Publisher"; strip the suffix.
      const dash = title.lastIndexOf(" - ");
      if (dash > 20 && source && title.slice(dash + 3).trim() === source) {
        title = title.slice(0, dash).trim();
      } else if (dash > 30) {
        const tail = title.slice(dash + 3).trim();
        if (tail.length < 40 && !/[.!?]$/.test(tail)) {
          if (!source || source === feed.source) source = tail;
          title = title.slice(0, dash).trim();
        }
      }

      let summary = stripTags(
        tag(b, "description") || tag(b, "summary") || tag(b, "content") || tag(b, "content:encoded")
      ).slice(0, 240);

      // Google News descriptions are usually just "Headline Source" — a
      // duplicate of the title. Drop those so cards read like a clean wire.
      const nt = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const ns = summary.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!ns || (ns.startsWith(nt.slice(0, 24)) && summary.length < title.length + source.length + 12)) {
        summary = "";
      }

      if (!RELEVANCE.test(title + " " + summary + " " + source)) continue;

      out.push({
        title: title.trim(),
        link,
        source: (source || "News").trim(),
        summary,
        tags: tagArticle(title + " " + summary),
        publishedAt: new Date(ts).toISOString(),
        timestamp: ts,
      });
    }
    console.log(`  ✓ ${feed.url.slice(0, 60)}… → ${out.length}`);
    return out;
  } catch (err) {
    console.warn(`  ✗ ${feed.url.slice(0, 60)}… → ${err.message}`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/* ---------- main ---------- */

(async () => {
  console.log("Fetching insurtech feeds…");
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let all = results.flat();

  // Drop stale items
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  all = all.filter((a) => a.timestamp >= cutoff);

  // Dedupe by link and by normalized title
  const seen = new Set();
  const deduped = [];
  for (const a of all) {
    const keyLink = a.link.split("?")[0].toLowerCase();
    // Loose key collapses common look-alike glyphs (i/l→1, o→0) so OCR-style
    // near-duplicates like "IH26" vs "1H26" merge into one.
    const keyTitle = a.title.toLowerCase()
      .replace(/[il]/g, "1").replace(/o/g, "0")
      .replace(/[^a-z0-9]+/g, "").trim();
    if (seen.has(keyLink) || seen.has(keyTitle)) continue;
    seen.add(keyLink);
    seen.add(keyTitle);
    deduped.push(a);
  }

  deduped.sort((a, b) => b.timestamp - a.timestamp);
  const articles = deduped.slice(0, MAX_ITEMS);

  // Prominence score (used by the UI to choose the lead story)
  scoreArticles(articles);

  // Taxonomy counts, in canonical order, only for tags actually present.
  const counts = {};
  articles.forEach((a) => a.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const order = [...TAXONOMY.map(([n]) => n), FALLBACK_TAG];
  const taxonomy = order
    .filter((t) => counts[t])
    .map((t) => ({ name: t, count: counts[t] }));

  // Editor's brief — themes + second-order effects for this batch.
  const briefing = buildBriefing(articles, taxonomy);

  const payload = {
    updatedAt: new Date().toISOString(),
    count: articles.length,
    sources: [...new Set(articles.map((a) => a.source))].sort(),
    taxonomy,
    briefing,
    articles,
  };

  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "news.json"), JSON.stringify(payload, null, 2));
  console.log(`\nWrote data/news.json — ${articles.length} articles from ${payload.sources.length} sources.`);
})();
