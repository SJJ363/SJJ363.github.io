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
const { claudeAvailable, callClaude, parseJsonObject } = require("./claude");
const { tagArticle } = require("./taxonomy");
const { admits } = require("./relevance");

const NEWS = path.join(__dirname, "..", "data", "news.json");
const DB = path.join(__dirname, "..", "data", "companies.json");        // client-facing (derived)
const STORE = path.join(__dirname, "..", "data", "companies-store.json"); // build-only facts

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

/* ---- Canonical aliases ----
   Fold abbreviations / subsidiaries / short forms onto one canonical name,
   so "Willis" and "WTW" never spawn a page separate from "Willis Towers
   Watson". Claude is also told to consolidate; this is the safety net that
   also covers the heuristic fallback. Keyed by slug -> canonical name. */
const CANON_LIST = {
  "Willis Towers Watson": ["Willis", "WTW", "Willis Towers Watson US", "Willis Towers Watson US LLC", "Towers Watson"],
  "Marsh McLennan": ["MMC", "Marsh & McLennan", "Marsh and McLennan"],
  "Aon": ["Aon plc"],
  "Gallagher": ["Arthur J. Gallagher", "AJG"],
  "Munich Re": ["Munich Reinsurance", "Munich Re Group"],
  "Swiss Re": ["Swiss Reinsurance", "Swiss Re Corporate Solutions"],
  "Berkshire Hathaway": ["Berkshire"],
  "Ping An": ["Ping An Insurance"],
  "UnitedHealth": ["UnitedHealth Group", "UnitedHealthcare"],
  // Curated fixes for stubborn long-tail cases Claude keeps garbling.
  "Mulberry": ["Mulberry Insurance Technology Platform"],
  "Singtel": ["Telecommunications Ltd Singtel", "Singapore Telecommunications", "Singapore Telecommunications Ltd"],
  "Wave Claims": ["Wave"],
  "Insurance House": ["House"],
  // Listed by hand, not by an initials rule: "AGI" really is American
  // Growth Insurance here, but the same rule folds IAG (Insurance
  // Australia Group, four stories) into International Airlines Group,
  // which is a different industry. One verified alias beats a heuristic
  // that is right once and wrong once.
  "American Growth Insurance": ["AGI"],
};

/* ---- Curated splits: one name, two companies ----
   The exact inverse of CANON_LIST, and it matters more, because merging
   two real companies is a worse error than splitting one.

   /company/nirvana/ held eight stories about two unrelated firms: Nirvana
   Insurance, the AI commercial-trucking insurtech ($80M Series C, $100M
   Series D), and a health-insurance-verification startup that raised a
   $24.2M Series A. The funding ranking summed all three into "$204.2M
   across 3 rounds" for a company that raised $180M across two, and the
   company page read as one firm with two businesses.

   Keyed by the shared slug. The first pattern to match the ARTICLE TITLE
   renames that mention, so the split is per-story rather than per-name.
   Hand-verified per entry, on the same principle as the alias list two
   blocks up: a heuristic general enough to separate these two would
   eventually separate a company from itself. */
const SPLIT_LIST = {
  nirvana: [[/health insurance verification/i, "Nirvana Health"]],
};

const SPLIT_SLUGS = new Set(
  Object.values(SPLIT_LIST).flat().map(([, into]) => slugify(into))
);

function splitName(name, title) {
  const rules = SPLIT_LIST[slugify(name)];
  if (!rules) return name;
  const hit = rules.find(([re]) => re.test(title || ""));
  return hit ? hit[1] : name;
}

// Non-companies Claude occasionally emits (products / techniques / generic
// terms). Dropped on every rebuild, so no re-extraction is needed to clean.
const JUNK = new Set([
  "survaival", "ipmi", "pension-tools", "tianfu-citizen-cloud-platform", "form-maker", "formmaker",
]);
const CANON = new Map();
for (const [canonical, aliases] of Object.entries(CANON_LIST)) {
  CANON.set(slugify(canonical), canonical);
  for (const a of aliases) CANON.set(slugify(a), canonical);
}

// Resolve any surface form to its canonical display name.
function canonicalName(name) {
  const s = slugify(name);
  if (CANON.has(s)) return CANON.get(s);
  if (KNOWN.has(s)) return KNOWN.get(s);
  return name;
}

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

/* ============================================================
   Claude extraction (batched) — the primary extractor
   ============================================================ */
const CHUNK = 45;
// Bump when the extraction prompt changes so cached Claude results re-extract.
const PROMPT_VERSION = 2;

function buildExtractPrompt(items, known) {
  const lines = items.map((it) => `${it.id}: ${JSON.stringify(it.title)}`).join("\n");
  const knownStr = known.length ? known.slice(0, 250).join(", ") : "none yet";
  return `You identify the companies involved in insurance / insurtech news headlines.

For each headline, list the real companies that are ACTORS in the story — insurers, insurtechs, brokers, reinsurers, MGAs, technology vendors, and any named investors, acquirers or partners.

Do NOT include:
- the news outlet or publisher reporting the story
- generic or industry terms, even when capitalised ("insurtech", "the market", "AI", "iPMI", "MGA", a country or region)
- a product, platform, service, fund, tool, award, methodology or column — name the COMPANY behind it instead (e.g. a "FormMaker" tool or a "Pension Tools" launch → the company that makes it, not the tool)
- government bodies unless a specific named organisation is acting as a party

Write each company under its full, real name as commonly written — never a truncation or a description turned into a name. For example: "Insurance House" (not "House"); "Singtel" (not "Telecommunications Ltd Singtel"); "Mulberry" (not "Mulberry Insurance Technology Platform"); "Wave Claims" (not "Wave").

Consolidate every reference to the same entity under ONE canonical name:
- use the full, commonly-used corporate name (e.g. "Willis Towers Watson", never "Willis" or "WTW")
- fold abbreviations, subsidiaries and stylised forms into the parent company (e.g. "Zhibao Technology Inc." and "Zhibao" are the same company — pick one)
- if the entity already appears in KNOWN COMPANIES, reuse that exact spelling.

KNOWN COMPANIES (reuse these exact names when the same entity appears):
${knownStr}

HEADLINES:
${lines}

Respond with ONLY a JSON object mapping each id to an array of canonical company names (use [] when none apply). No commentary. Example:
{"a1": ["Willis Towers Watson", "Kayna", "Kwant"], "a2": []}`;
}

function sanitizeNames(arr, exclude) {
  if (!Array.isArray(arr)) return [];
  const out = [], seen = new Set();
  for (let n of arr) {
    if (typeof n !== "string") continue;
    n = canonicalName(n.replace(/\s+/g, " ").trim());
    const slug = slugify(n);
    if (!n || n.length > 60 || !slug || JUNK.has(slug) || exclude.has(slug) || seen.has(slug)) continue;
    // Drop anything that is entirely generic / function / geographic words.
    const toks = n.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    if (!toks.length || toks.every((t) => DENY.has(t) || BREAK.has(t))) continue;
    seen.add(slug); out.push(n);
  }
  return out;
}

// Returns { link: [names] } for chunks Claude handled, or null if all failed.
function extractWithClaude(need, known, exclude) {
  const byLink = {};
  let anyOK = false;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK).map((a, k) => ({ id: `a${i + k}`, title: a.title, link: a.link }));
    const parsed = parseJsonObject(callClaude(buildExtractPrompt(chunk, known)));
    if (!parsed) { console.warn(`  ✗ extraction chunk @${i} unparseable — will fall back`); continue; }
    anyOK = true;
    for (const it of chunk) if (it.id in parsed) byLink[it.link] = sanitizeNames(parsed[it.id], exclude);
  }
  return anyOK ? byLink : null;
}

// Fold "<Name> Technology/Group/Solutions/…" into the bare "<Name>" record
// when both exist (Claude occasionally emits a fuller and a shorter form of
// the same entity). Returns a map of merged-away slug -> canonical slug.
function mergePrefixes(byslug) {
  const mergeMap = {};
  for (const s of Object.keys(byslug)) {
    if (!byslug[s]) continue;
    /* A curated split must survive this pass. "Nirvana Health" is
       nirvana + a word that happens to sit in COMPANY_TYPE, so the rule
       below would fold it straight back into the company SPLIT_LIST just
       separated it from — undoing a hand-verified decision with a
       heuristic, which is the wrong way round. */
    if (SPLIT_SLUGS.has(s)) continue;
    const parts = s.split("-");
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const root = parts.slice(0, cut).join("-");
      const rest = parts.slice(cut);
      if (byslug[root] && root !== s && rest.every((t) => COMPANY_TYPE.has(t))) {
        const from = byslug[s], into = byslug[root];
        for (const ar of from.articles) {
          if (!into.links.has(ar.link)) { into.links.add(ar.link); into.articles.push(ar); }
        }
        mergeMap[s] = root;
        delete byslug[s];
        break;
      }
    }
  }
  return mergeMap;
}

/* ============================================================
   Investors are not companies on this site
   ------------------------------------------------------------
   The extraction prompt asks for every actor in a story, investors
   included — which is right for the wire's badges but wrong for the
   company index: a VC that led one round was on the other side of it,
   and giving it a page files it among the insurtechs it funded.

   Role is decided from POSITION IN THE HEADLINE, not from the name.
   The obvious name-suffix heuristic (Ventures|Capital|Partners) fails
   in both directions on real data here: it misses BlueOrchard, an
   investment manager with no telltale suffix, and it flags Pelagos
   Insurance Capital, which is not a VC. Position is evidence; a suffix
   is a guess.

   An entity is demoted only when EVERY mention of it across the whole
   archive sits in an investor slot. One appearance as the party doing
   something — raising, launching, partnering — and it stays a company,
   which is what keeps Munich Re from vanishing the day it backs a
   startup. Because the index is rebuilt from the store each run, a
   demoted entity returns by itself the first time it acts.
   ============================================================ */
const MONEY = /[$€£₹]\s?[\d.,]+|\b\d+(?:\.\d+)?\s?(?:m|mn|bn|million|billion|crore|cr)\b/i;

// Connectives after which the named party is putting money in.
const INVESTOR_LEAD =
  /\b(?:led by|backed by|funded by|investment from|funding from|participation from|investors?:?)\s+/gi;

/* Character offsets in `title` where an investor's name would begin. */
function investorPositions(title) {
  const out = [];
  let m;
  INVESTOR_LEAD.lastIndex = 0;
  while ((m = INVESTOR_LEAD.exec(title))) out.push(m.index + m[0].length);

  // On a funding story that names a figure, money arrives FROM someone and
  // the party named after WITH is a co-investor rather than the raiser.
  // Both are gated on a preceding money figure, because bare "from"/"with"
  // are the commonest words in a partnership headline.
  if (tagArticle(title).includes("Funding") && MONEY.test(title)) {
    for (const kw of [/\bfrom\s+/gi, /\bwith\s+/gi]) {
      let x;
      while ((x = kw.exec(title))) {
        if (MONEY.test(title.slice(0, x.index))) out.push(x.index + x[0].length);
      }
    }
  }
  return out;
}

/* slug -> true for entities seen only ever in an investor slot. Takes the
   already-admitted articles, so a rejected story can't cast a vote. */
function investorSlugs(entries) {
  const tally = new Map(); // slug -> { inv, other }
  for (const { meta, names } of entries) {
    const pos = investorPositions(meta.title);
    for (const n of names) {
      const slug = slugify(n);
      if (!slug) continue;
      const at = meta.title.toLowerCase().indexOf(n.toLowerCase());
      const rec = tally.get(slug) || { inv: 0, other: 0 };
      // Not present in the headline at all (Claude read it out of the
      // summary) — no positional evidence either way, so it counts as
      // "other" and protects the entity from demotion.
      if (at >= 0 && pos.some((p) => Math.abs(p - at) <= 2)) rec.inv++;
      else rec.other++;
      tally.set(slug, rec);
    }
  }
  const out = new Set();
  for (const [slug, r] of tally) if (r.inv > 0 && r.other === 0) out.add(slug);
  return out;
}

/* ============================================================ */
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function main() {
  const news = loadJSON(NEWS, null);
  if (!news || !Array.isArray(news.articles)) { console.error("No news.json to process."); process.exit(0); }

  // Persistent facts (build-only): article metadata + extraction, by link.
  const store = loadJSON(STORE, {});
  store.seen = store.seen || {};
  store.extracted = store.extracted || {};
  store.funding = store.funding || {};   // funding-extract.js's; read here only to preserve it
  // Previous canonical names — fed to Claude so it reuses them.
  const knownNames = (loadJSON(DB, {}).companies || []).map((c) => c.name);

  // Outlets are never the actor company.
  const exclude = new Set();
  for (const s of (news.sources || [])) exclude.add(slugify(s));

  const runAt = new Date().toISOString();
  for (const a of news.articles) {
    const prior = store.seen[a.link];
    // summary carries the publisher's own sentence about the story — kept
    // so company pages can render it. Absent for items that only reached
    // us via Google News, and for anything stored before it was tracked.
    store.seen[a.link] = {
      title: a.title,
      source: a.source,
      publishedAt: a.publishedAt,
      tags: a.tags || [],
      summary: a.summary || "",
      // When this story first reached the wire — not its publish date, which
      // feeds re-serve and re-date. brief-window.js measures the briefing
      // window off it, so it is written once, on the run that first carried
      // the link, and never rewritten. A link already in the store from
      // before this field existed deliberately gets *nothing*: stamping it
      // now would date a three-week-old story to today and drop the entire
      // archive into the next briefing's window. The window falls back to the
      // publish date for those, which is also why backfill.js — inserting
      // articles months after the fact — never writes this field either.
      ...(prior ? (prior.firstSeen ? { firstSeen: prior.firstSeen } : {}) : { firstSeen: runAt }),
      // Came from a feed confined to insurtech. seo.js needs it to know
      // whether a story may qualify on technology wording alone.
      ...(a.native ? { native: true } : {}),
    };
  }

  // Extract the uncached — and re-extract heuristic-cached ones once Claude is
  // available, so an earlier deterministic base upgrades to Claude quality.
  const claudeOn = claudeAvailable();
  const isStale = (e) => !e || e.by !== "claude" || e.pv !== PROMPT_VERSION;
  const curLinks = new Set(news.articles.map((a) => a.link));
  const need = [];
  for (const a of news.articles) {
    const e = store.extracted[a.link];
    if (!e || (claudeOn && isStale(e))) need.push({ title: a.title, link: a.link, source: a.source });
  }
  // Also heal any historical article still stale once Claude is on, so the
  // whole index converges to current Claude quality.
  if (claudeOn) {
    for (const [link, e] of Object.entries(store.extracted)) {
      if (curLinks.has(link) || !isStale(e)) continue;
      const m = store.seen[link];
      if (m) need.push({ title: m.title, link, source: m.source });
    }
  }
  console.log(`Extraction: ${need.length} article(s) need parsing (claude ${claudeOn ? "on" : "off"}).`);

  let claudeRes = null;
  if (need.length && claudeOn) claudeRes = extractWithClaude(need, knownNames, exclude);

  for (const a of need) {
    let names = claudeRes && claudeRes[a.link];
    const entry = { names, by: "claude", pv: PROMPT_VERSION };
    if (!names) { entry.names = extractCompanies(a.title, new Set([...exclude, slugify(a.source)])).map(canonicalName); entry.by = "heuristic"; delete entry.pv; }
    store.extracted[a.link] = entry;
  }

  // Rebuild every company from the full fact store (history across batches).
  // Because this derives purely from `extracted`, re-extraction cleanly drops
  // any company that no longer has a mention (junk self-heals).
  //
  // Two filters run on the way out, both re-applied every build so a rule
  // change reaches the whole archive rather than only what arrives next:
  //   1. the relevance gate, so the index can't publish a company page built
  //      from an article the topic hubs and the funding tracker reject;
  //   2. investor demotion, decided across all admitted mentions at once —
  //      hence the pass below before anything is accumulated.
  const admitted = [];
  let rejected = 0;
  for (const [link, ex] of Object.entries(store.extracted)) {
    const meta = store.seen[link];
    if (!meta || !ex.names || !ex.names.length) continue;
    if (!admits(meta)) { rejected++; continue; }
    admitted.push({
      link,
      meta,
      names: [...new Set(ex.names.map((n) => splitName(canonicalName(n), meta.title)))]
        .filter((n) => !JUNK.has(slugify(n))),
    });
  }
  const investors = investorSlugs(admitted);

  const byslug = {};
  for (const { link, meta, names: allNames } of admitted) {
    const names = allNames.filter((n) => !investors.has(slugify(n)));
    const slugs = names.map(slugify);
    names.forEach((name, i) => {
      const slug = slugs[i]; if (!slug) return;
      const rec = byslug[slug] || (byslug[slug] = { slug, name, links: new Set(), articles: [] });
      if (KNOWN.has(slug)) rec.name = KNOWN.get(slug);
      if (!rec.links.has(link)) {
        rec.links.add(link);
        // Re-tag rather than reuse meta.tags: stored tags are frozen at
        // fetch time, so a taxonomy fix would show on the topic hubs (which
        // re-tag) but not on company pages, which render these.
        rec.articles.push({ title: meta.title, link, source: meta.source, publishedAt: meta.publishedAt, tags: tagArticle(meta.title + " " + (meta.summary || "")), summary: meta.summary || "", co: slugs.filter((s2, k) => k !== i) });
      }
    });
  }

  const mergeMap = mergePrefixes(byslug);

  /* Attach companies to current articles (the wire's badges).

     Resolved against the finished index rather than the raw extraction,
     because a badge is a link to /company/<slug>/ and seo.js prunes every
     directory without a company record. The raw names skip canonicalisation,
     JUNK and mergePrefixes, so trusting them put six dead links on the wire:
     "Wave" (canonical: Wave Claims), "Telecommunications Ltd Singtel"
     (Singtel), "Mulberry Insurance Technology Platform" (Mulberry),
     "Liberty Mutual Re" (merged into Liberty Mutual) and two JUNK entries.
     Demoted investors drop out here for the same reason. */
  for (const a of news.articles) {
    const names = (store.extracted[a.link] && store.extracted[a.link].names) || [];
    const seenSlug = new Set();
    a.companies = names
      .map((n) => {
        const s0 = slugify(splitName(canonicalName(n), a.title));
        const slug = mergeMap[s0] || s0;
        return byslug[slug] ? { name: byslug[slug].name, slug } : null;
      })
      .filter((c) => c && !seenSlug.has(c.slug) && seenSlug.add(c.slug));
  }

  const companies = Object.values(byslug).map((c) => {
    const articles = c.articles.slice().sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
    const topicCount = {}, sourceSet = new Set(), relCount = {};
    for (const ar of articles) {
      (ar.tags || []).filter((t) => t !== "Industry").forEach((t) => (topicCount[t] = (topicCount[t] || 0) + 1));
      sourceSet.add(ar.source);
      (ar.co || []).forEach((s2) => {
        const cs = mergeMap[s2] || s2;
        if (cs !== c.slug) relCount[cs] = (relCount[cs] || 0) + 1;
      });
    }
    const topics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
    const related = Object.entries(relCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([slug, count]) => ({ slug, name: (byslug[slug] || {}).name || slug, count }));
    return {
      slug: c.slug, name: c.name, count: articles.length,
      firstSeen: articles.length ? articles[articles.length - 1].publishedAt : null,
      lastSeen: articles.length ? articles[0].publishedAt : null,
      topics, sources: [...sourceSet], related, articles,
    };
  }).filter((c) => c.count > 0)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  const byCount = { claude: 0, heuristic: 0 };
  for (const e of Object.values(store.extracted)) if (e.by) byCount[e.by] = (byCount[e.by] || 0) + 1;

  fs.writeFileSync(NEWS, JSON.stringify(news, null, 2));
  /* `funding` belongs to funding-extract.js and `profiles` to
     profile.js, both of which run after this and write the same file.
     Carry them through untouched — a write that names only its own keys
     silently truncates the other script's cache, and the symptom is a
     funding tracker (or a set of company profiles) that quietly
     re-extracts its whole archive on every run. */
  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted,
    funding: store.funding || {},
    profiles: store.profiles || {},
    topics: store.topics || {},
  }, null, 2));
  fs.writeFileSync(DB, JSON.stringify({ updatedAt: new Date().toISOString(), count: companies.length, companies }, null, 2));
  console.log(`Companies: ${companies.length} tracked · extraction cache ${byCount.claude} claude / ${byCount.heuristic} heuristic.`);
  console.log(
    `  ↳ ${rejected} stored article(s) failed the relevance gate; ` +
      `${investors.size} entit${investors.size === 1 ? "y" : "ies"} demoted to investor` +
      (investors.size ? ` (${[...investors].join(", ")})` : "")
  );
}

if (require.main === module) main();

module.exports = { extractCompanies, canonicalName, sanitizeNames, buildExtractPrompt, slugify, extractWithClaude, PROMPT_VERSION };
