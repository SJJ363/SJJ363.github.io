#!/usr/bin/env node
/* ============================================================
   Company extraction + persistent company index
   ------------------------------------------------------------
   Runs after fetch-news.js. For each article it identifies the
   companies involved (heuristic, precision-first NER over the
   headline), writes them onto the article (for the home-page
   badges), and upserts them into data/companies.json — a store
   that ACCUMULATES across batches so every company keeps a full,
   date-ordered history of the articles that mentioned it.

   Dependency-free and deterministic. Extraction is cached per
   article link so a headline is only parsed once, however many
   refreshes it survives.
   ============================================================ */

const fs = require("fs");
const path = require("path");

const NEWS = path.join(__dirname, "..", "data", "news.json");
const DB = path.join(__dirname, "..", "data", "companies.json");

/* ---- Known companies (canonical display names) ----
   A bonus layer for precision/recall on well-known names and the
   lowercase brands (bolttech, wefox…) that heuristics would miss. */
const KNOWN_LIST = [
  "Lemonade", "Root", "Hippo", "Next Insurance", "Coalition", "Corvus", "Cover Genius",
  "bolttech", "wefox", "Alan", "Ping An", "ZhongAn", "Policybazaar", "Acko", "Digit",
  "Shift Technology", "Tractable", "Cytora", "Planck", "Akur8", "hyperexponential",
  "Gradient AI", "Clearcover", "Kin", "Openly", "Pie Insurance", "At-Bay", "Counterpart",
  "Vouch", "Embroker", "Newfront", "Marsh", "Aon", "Willis Towers Watson", "Gallagher",
  "Howden", "Munich Re", "Swiss Re", "Hannover Re", "SCOR", "Lloyd's", "AXA", "Allianz",
  "Zurich", "Chubb", "AIG", "Generali", "Aviva", "Prudential", "MetLife", "Manulife",
  "Sun Life", "Progressive", "GEICO", "State Farm", "Allstate", "Travelers", "Nationwide",
  "Liberty Mutual", "Berkshire Hathaway", "Tokio Marine", "Sompo", "QBE", "Beazley",
  "Hiscox", "Markel", "Arch", "Everest", "RenaissanceRe", "Guidewire", "Duck Creek",
  "Sapiens", "Ebix", "Verisk", "CCC", "Socotra", "Majesco", "Insurity", "Sure", "Boost",
  "Zego", "Descartes Underwriting", "Kayna", "Kwant", "Joyn", "PolicyStreet", "Klaimee",
  "Coverwatch", "Panora", "Cover Whale", "Marshmma", "Instabase", "Qover", "Wakam",
  "Trov", "Tint", "hyperexponential", "Ledgebrook", "Nirvana", "Kettle", "Sixfold",
];

/* ---- Vocabulary ---- */
// Generic words that are never a company by themselves (used to reject
// all-generic spans and to trim leading noise like "Insurtech <Name>").
const DENY = new Set(
  ("insurance insurer insurers insurtech insurtechs reinsurance reinsurer reinsurers fintech insuretech " +
   "technology tech technologies digital ai ml platform platforms group holdings holding market markets " +
   "report reports research series update updates news daily business industry sector solution solutions " +
   "company companies startup startups firm firms ceo cfo cto coo chief star million billion trillion crore " +
   "funding fund deal deals round rounds valuation investment investors embedded cyber claims underwriting " +
   "health life auto motor property casualty launch partnership partnerships venture ventures capital finance " +
   "financial services service data software systems labs app apps program programme profitability capabilities " +
   "acquisition mou os subsidiary").split(/\s+/)
);

// Tokens that BREAK a name span even when capitalized (Title Case headlines):
// function words, action verbs, and non-company modifiers/geographies.
const FUNCTION = "to for with and or in on at of by as from into over under after before amid via vs than then but so up out off down through across against about who what which where when why how the a an this that these those its it their his her more most amid despite following also now over".split(/\s+/);
const VERBS = "raises raise raised raising secures secure secured securing lands land landed bags bag bagged closes close closed closing nabs snags launches launch launched launching unveils unveil unveiled debuts debut introduces introduce introduced acquires acquire acquired acquiring buys buy bought buying partners partner partnered teams team taps tap tapped selects select selected names name named naming appoints appoint appointed hires hire hired expands expand expanded picks pick picked onboards integrates integrate wins win won adds add added deploys deploy signs sign signed inks ink scores score rolls backs back backed powers power completes complete completed providing provides provide signals signal attracts attract extends extend extended announces announce announced announcing joins join joined wants plans eyes sets set eyeing offering offers offer offered enters enter helping helps help brings bring targeting targets".split(/\s+/);
const GEO = "us usa uk eu europe european asia asian africa african america americas american latin latam apac emea mena uae india indian china chinese japan japanese singapore australia australian canada canadian germany german france french spain spanish italy italian brazil brazilian mexico mexican pakistan pakistani malaysia malaysian indonesia indonesian philippines nigeria nigerian kenya saudi gulf gcc korea korean vietnam thailand thai north south east west".split(/\s+/);
const MODIFIER = "global digital new top best leading major exclusive breaking latest first heres more sector market industry inside meet introducing amid".split(/\s+/);
// Acronyms that are industry/jargon, not companies.
const ACRONYM_DENY = new Set(
  "roi llm ltl mga aog tdi naaia efgh llc mou api saas kyc kyb esg ipo faq usd eur gbp gdp evs suv ceo cfo cto coo it hr pr ev ai ml os ui ux crm erp gwp nps arr".split(/\s+/)
);
const BREAK = new Set([...FUNCTION, ...VERBS, ...GEO, ...MODIFIER]);

// Words allowed INSIDE a company name (line-of-business / corporate-type
// words). Every other generic word also breaks a span.
const COMPANY_TYPE = new Set(
  ("insurance insurtech insurtechs insurer insurers reinsurance reinsurer fintech insuretech technology " +
   "technologies tech solutions systems ventures partners capital group holdings holding labs financial " +
   "services software platform platforms data health life re").split(/\s+/)
);
for (const w of DENY) if (!COMPANY_TYPE.has(w)) BREAK.add(w);

// Verbs whose SUBJECT (noun just before) is a company; and connectors after
// which the following noun is a company (object position).
const SUBJ_VERBS = new Set(VERBS);
const OBJ_AFTER = new Set("with acquires acquire buys buy taps selects backs by joins".split(/\s+/));

// Legal / corporate suffixes → strong company signal on acceptance.
const SUFFIX = new Set(
  "inc incorporated llc ltd limited corp corporation plc co gmbh nv sa se ag re group holdings holding technologies technology solutions systems ventures partners capital labs".split(/\s+/)
);
// Suffixes stripped from the slug so "Lemonade" and "Lemonade Inc" merge.
const SLUG_STRIP = new Set("inc incorporated llc ltd limited corp corporation plc co gmbh nv sa se ag".split(/\s+/));

// Adjective endings that mark a token as a modifier, not a name.
const ADJ_SUFFIX = /-(based|driven|led|backed|focused|owned|founded|native|first)$/i;

/* ---- helpers ---- */
function stripEdgePunct(s) { return s.replace(/^[^A-Za-z0-9&]+/, "").replace(/[^A-Za-z0-9&.]+$/, ""); }

function slugify(name) {
  let toks = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  while (toks.length > 1 && SLUG_STRIP.has(toks[toks.length - 1])) toks.pop();
  return toks.join("-");
}

const KNOWN = new Map(KNOWN_LIST.map((n) => [slugify(n), n]));

function looksNamey(tok) {
  const c = stripEdgePunct(tok);
  if (!c) return false;
  if (/^[A-Z][A-Za-z0-9.'&-]*$/.test(c)) return true;   // Capitalized / CamelCase
  if (/[a-z][A-Z]/.test(c)) return true;                // internal caps (PolicyStreet)
  if (/^[A-Z0-9&.]{2,}$/.test(c)) return true;          // acronym (AXA, VEON, TPL)
  return false;
}
// A token can sit INSIDE a company span: namey, but not a breaker word,
// a long gerund ("Providing"), a version number, or an adjective ("London-based").
function inSpan(tok) {
  const c = stripEdgePunct(tok);
  const low = c.toLowerCase();
  if (!looksNamey(tok)) return false;
  if (BREAK.has(low)) return false;
  if (low.length >= 7 && low.endsWith("ing")) return false;
  if (ADJ_SUFFIX.test(c)) return false;
  if (/^v?\d[\d.]*$/.test(c)) return false;             // 2.0, v3, 5
  return true;
}
const hasCamel = (tok) => /[a-z][A-Z]/.test(stripEdgePunct(tok));

// A span is fully generic if every token is denylisted.
function allDeny(tokens) {
  return tokens.every((t) => DENY.has(stripEdgePunct(t).toLowerCase()));
}

// Trim leading generic tokens ("Insurtech Klaimee" -> "Klaimee").
function trimLead(tokens) {
  const out = tokens.slice();
  while (out.length > 1 && DENY.has(stripEdgePunct(out[0]).toLowerCase())) out.shift();
  return out;
}
// Trim trailing money figures ("Cover Genius 100M") and parenthetical
// alias acronyms ("Willis Towers Watson WTW").
function trimTrail(tokens) {
  const out = tokens.slice();
  while (out.length > 1) {
    const last = stripEdgePunct(out[out.length - 1]);
    if (last === "&" || last.toLowerCase() === "and") { out.pop(); continue; }
    if (/^\$?\d[\d.,]*[kmbn%]?$/i.test(last)) { out.pop(); continue; }
    if (out.length >= 3 && /^[A-Z]{2,6}$/.test(last)) { out.pop(); continue; }
    break;
  }
  return out;
}

/* Extract company display-names from one headline. */
function extractCompanies(title, exclude) {
  // Normalize: strip possessives and quotes so tokens are clean.
  const clean = title.replace(/[’']s\b/g, "").replace(/[“”"()\[\]]/g, " ").replace(/\s+/g, " ").trim();
  const toks = clean.split(" ");
  const lower = toks.map((t) => stripEdgePunct(t).toLowerCase());

  // Build spans of consecutive in-span tokens (allowing a single & between),
  // capped at 5 tokens so a run-on Title Case headline can't form a mega-name.
  const spans = [];
  for (let i = 0; i < toks.length; i++) {
    if (!inSpan(toks[i])) continue;
    let j = i;
    while (j + 1 < toks.length && j - i < 4 && !/[,;:—–]$/.test(toks[j])) {
      if (inSpan(toks[j + 1])) { j++; continue; }
      if (toks[j + 1] === "&" && j + 2 < toks.length && inSpan(toks[j + 2])) { j += 2; continue; }
      break;
    }
    spans.push({ s: i, e: j });
    i = j;
  }

  const found = new Map(); // slug -> display name
  const add = (rawTokens) => {
    let t = trimTrail(trimLead(rawTokens.map(stripEdgePunct).filter(Boolean)));
    if (!t.length || allDeny(t)) return;
    const name = t.join(" ").replace(/\s+&\s+/g, " & ").trim();
    const slug = slugify(name);
    if (!slug || exclude.has(slug)) return;
    if (KNOWN.has(slug)) { found.set(slug, KNOWN.get(slug)); return; }
    found.set(slug, name);
  };
  const spanTokens = (sp) => toks.slice(sp.s, sp.e + 1);

  for (const sp of spans) {
    const tks = spanTokens(sp);
    const core = trimLead(tks.map(stripEdgePunct).filter(Boolean));
    if (!core.length || allDeny(core)) continue;
    const slug = slugify(core.join(" "));

    const known = KNOWN.has(slug);
    const camel = tks.some(hasCamel);
    const suffix = SUFFIX.has(core[core.length - 1].toLowerCase()) && core.length >= 2;
    const acronym = core.length === 1 && /^[A-Z]{3,6}$/.test(core[0]) &&
      !ACRONYM_DENY.has(core[0].toLowerCase()) && !DENY.has(core[0].toLowerCase());

    // Verb anchoring: subject just before the following verb, or a coordinated
    // subject ("X and Y raise"); object right after with/acquires/taps/etc.
    const after = lower[sp.e + 1];
    const before = lower[sp.s - 1];
    const subjAnchor = SUBJ_VERBS.has(after) ||
      ((after === "and" || after === "&") && SUBJ_VERBS.has(lower[sp.e + 2]));
    const objAnchor = OBJ_AFTER.has(before) ||
      ((before === "and" || before === "&") && OBJ_AFTER.has(lower[sp.s - 2]));

    if (known || camel || suffix || acronym || subjAnchor || objAnchor) add(tks);
  }
  return [...found.values()];
}

/* ============================================================ */
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

(function main() {
  const news = loadJSON(NEWS, null);
  if (!news || !Array.isArray(news.articles)) { console.error("No news.json to process."); process.exit(0); }

  const db = loadJSON(DB, {});
  db.extracted = db.extracted || {};          // link -> [names]  (cache)
  const store = {};                            // slug -> company record (rebuilt from history)
  // Seed store from existing companies.json history.
  for (const c of (db.companies || [])) store[c.slug] = { slug: c.slug, name: c.name, articles: c.articles || [] };

  // Outlets are not companies-in-the-story — exclude source + publisher names.
  const exclude = new Set();
  for (const s of (news.sources || [])) exclude.add(slugify(s));
  exclude.add(slugify(news.source || ""));

  const freshExtracted = {};
  let mentions = 0;

  for (const a of news.articles) {
    let names = db.extracted[a.link];
    if (!names) names = extractCompanies(a.title, new Set([...exclude, slugify(a.source)]));
    freshExtracted[a.link] = names;

    const slugs = names.map(slugify);
    a.companies = names.map((n, i) => ({ name: n, slug: slugs[i] }));
    mentions += names.length;

    names.forEach((name, i) => {
      const slug = slugs[i];
      const co = slugs.filter((s2, k) => k !== i);
      const rec = store[slug] || (store[slug] = { slug, name, articles: [] });
      if (KNOWN.has(slug)) rec.name = KNOWN.get(slug);
      if (!rec.articles.some((ar) => ar.link === a.link)) {
        rec.articles.push({
          title: a.title, link: a.link, source: a.source,
          publishedAt: a.publishedAt, tags: a.tags || [], co,
        });
      }
    });
  }

  // Build the client-facing, aggregated company list.
  const companies = Object.values(store).map((c) => {
    const articles = c.articles.slice().sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
    const topicCount = {}, sourceSet = new Set(), relCount = {};
    for (const ar of articles) {
      (ar.tags || []).filter((t) => t !== "Industry").forEach((t) => (topicCount[t] = (topicCount[t] || 0) + 1));
      sourceSet.add(ar.source);
      (ar.co || []).forEach((s2) => (relCount[s2] = (relCount[s2] || 0) + 1));
    }
    const topics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
    const related = Object.entries(relCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([slug, count]) => ({ slug, name: (store[slug] || {}).name || slug, count }));
    return {
      slug: c.slug, name: c.name, count: articles.length,
      firstSeen: articles.length ? articles[articles.length - 1].publishedAt : null,
      lastSeen: articles.length ? articles[0].publishedAt : null,
      topics, sources: [...sourceSet], related, articles,
    };
  }).filter((c) => c.count > 0)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  // Prune the extraction cache to the current batch (bounded), keep history.
  const out = { updatedAt: new Date().toISOString(), count: companies.length, extracted: freshExtracted, companies };

  fs.writeFileSync(NEWS, JSON.stringify(news, null, 2));
  fs.writeFileSync(DB, JSON.stringify(out, null, 2));
  console.log(`Companies: ${companies.length} tracked · ${mentions} mentions across ${news.articles.length} articles.`);
})();
