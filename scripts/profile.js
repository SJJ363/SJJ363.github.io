#!/usr/bin/env node
/* ============================================================
   Company profiles — the one original sentence on a company page
   ------------------------------------------------------------
   Runs LAST of the Claude steps in news.yml (after companies.js and
   funding-extract.js), reads the archive, and writes a short factual
   profile per company into companies-store.json under `profiles`,
   keyed by slug. seo.js renders it above the funding block and uses
   it as the page's meta description.

   WHY THIS EXISTS

   Company pages are ~86% of everything a crawler can reach here
   (354 indexable of 1,299 built at the time of writing), and until
   this file existed not one of them contained a sentence anybody
   wrote. A page was a name, a story count, a themes list, a sources
   list, borrowed headlines, and — for the funded ~108 — the round
   table. That is the site's ceiling, and it is concentrated almost
   entirely in one page type.

   A profile is the same argument that justified /funding/companies/,
   applied one level down: a synthesis *across* two years of coverage
   is information that exists in no single source, including the
   sources being aggregated. What a small insurtech does, where it is,
   and which side of the market it sits on is behind a paywall at
   Crunchbase and PitchBook and nowhere else.

   WHAT THE MODEL MAY AND MAY NOT SAY

   The split is the whole design, because a wrong sentence in our own
   voice is worse than a thin page — a borrowed headline is at least
   someone else's claim, attributed and linked.

     · Description comes from the coverage AND the model's own
       knowledge of the company. Forbidding outside knowledge sounds
       safer and isn't: most companies here appear once, a lone
       headline often doesn't say what the company does, and a rule
       that produces `known: false` for 900 pages defeats the point.
     · Numbers, dates and named customers come from NEITHER. Funding,
       valuation, headcount, launch dates, client names: the tracker
       owns those, it derives them from cited sources on every build
       (rule 3c-i), and they sit on the same page a few centimetres
       below. A model-recalled figure there would contradict a sourced
       table, which is the one failure this site cannot absorb.
     · `known: false` is a first-class answer, not a failure. A
       company the model doesn't recognise, described by one vague
       headline, gets no block — the page falls back to exactly what
       it rendered before this file existed.

   WHAT IS CACHED, AND WHEN IT IS REWRITTEN

   Keyed by slug, stamped with PROMPT_VERSION exactly as companies.js
   stamps `extracted` and funding-extract.js stamps `funding`, plus
   `seen` — the lastSeen date of the coverage the profile was written
   from. A profile is rewritten when the prompt version changes or
   when the company has coverage newer than `seen`, so a company
   whose story count grows from one to six gets a profile written from
   six stories rather than keeping the thin one forever.

   That refresh rule is why this is affordable. Measured over the live
   period: ~15 distinct companies appear in a day's stories, which is
   one CHUNK — so steady state is one CLI call per day whether we
   refresh on new coverage or never refresh at all. The real cost is
   a PROMPT_VERSION bump, which rewrites all ~1,300. Iterate the
   prompt behind `--limit` before bumping it.

   FAILURE IS ORDINARY

   No credentials, a rate limit, an unparseable reply: the slug gets
   no entry, no block renders, and the page is what it was. It is the
   last of the four Claude steps for that reason — the brief is prose
   nobody else wrote, the company index feeds every page, the funding
   extractor has a regex fallback, and this one degrades to the
   previous build's output. It also self-gates: a company with no
   profile is simply a company with no profile.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { claudeAvailable, callClaude, parseJsonObject } = require("./claude");

const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "data", "companies-store.json");
const DB = path.join(ROOT, "data", "companies.json");

// Bump when the prompt changes so cached profiles are rewritten.
// A bump re-runs the whole archive (~1,300 companies, ~67 calls) —
// iterate with --limit first.
const PROMPT_VERSION = 1;

/* Twelve companies per call. Smaller than funding-extract.js's 30
   because each answer here carries prose rather than six scalar
   fields, and each question carries up to EVIDENCE_MAX headlines
   rather than one. An over-long reply is one that gets truncated and
   thrown away whole, taking the other eleven with it. */
const CHUNK = 12;

/* Headlines shown per company, newest first. The median company has
   one story and the busiest has 35; past a dozen, more headlines
   describe the company's news rather than the company, and the
   marginal ones are what push a chunk over the length where replies
   start getting truncated. */
const EVIDENCE_MAX = 12;

const MAX_SUMMARY = 320;
const MAX_PLACE = 40;

/* The first sentence does double duty: it leads the page AND becomes the
   page's meta description (descFromProfile in seo.js). A description is
   cut at ~158 characters in a result, and a sentence that stops
   mid-clause on an ellipsis is both worse to read and likelier to be
   replaced by a snippet Google chooses itself. So the prompt asks for a
   first sentence that stands alone inside the budget, and any extra
   detail in a second sentence. */
const FIRST_SENTENCE_MAX = 155;

/* A deliberately small vocabulary, because the value of this field is
   that it is the same word across every page — it labels which side
   of the market a company sits on, which is the distinction the wire
   itself is organised around (an insurtech raising, an insurer
   partnering, a VC leading). Free text here would give ~1,300
   ungroupable one-off phrases. "Other" is honest and available. */
const KINDS = new Set([
  "Insurtech",
  "Insurer",
  "Reinsurer",
  "Broker",
  "MGA",
  "Technology vendor",
  "Investor",
  "Industry body",
  "Other",
]);

function buildPrompt(items) {
  const blocks = items
    .map((it) => {
      const lines = it.evidence.map((e) => `  - ${e}`).join("\n");
      return `${it.id}: ${JSON.stringify(it.name)}\n${lines}`;
    })
    .join("\n\n");

  return `You write one-paragraph factual profiles of companies that appear in insurance / insurtech news.

For each company below you are given its name and the headlines we hold about it, newest first. Write a profile a reader can use to answer "what is this company and what does it do".

Answer for each id with:
  "known": true or false — see below
  "summary": 1-2 plain sentences, at most ${MAX_SUMMARY} characters total. Present tense, third person.
      The FIRST sentence must start with the company name, say what the company does, and stand on its own in at most ${FIRST_SENTENCE_MAX} characters — it is used by itself as the page's search-result description, so it has to be complete and not run over. Put any further detail in a second sentence.
  "kind": exactly one of ${[...KINDS].join(", ")}
  "place": headquarters as "City, Country" or just the country; "" if you are not confident

WHAT YOU MAY USE

Use the headlines AND your own knowledge of the company to say what it does — what it sells, to whom, in which market, on which side of the insurance business. If you recognise the company, say what you know about its business, even where the headlines don't mention it.

WHAT YOU MUST NOT STATE — this is the important rule

Never state a number, a date, or a named customer, in the summary or anywhere else:
- no funding amounts, round names, valuations or investor names
- no revenue, premium volume, headcount, customer or policy counts
- no founding year, launch date or any other date
- no named clients, partners or acquirers

These are not stylistic preferences. Every one of them is a dated, sourced claim that this site derives from cited reporting and renders on the same page, a few lines below your sentence. A figure you recall from memory would sit next to a figure with a link under it, and if they disagree the page is worse than if your sentence were not there at all. Describe the business; the page supplies the facts.

So: "Alan is a French health insurance company that sells group medical cover to employers and runs its own digital care and prevention platform." — good. "Alan, founded in 2016, has raised over $800M and covers 700,000 members." — every clause forbidden.

WHEN TO ANSWER known: false

Answer {"known": false} when you cannot describe the business without guessing — you do not recognise the company AND the headlines do not say what it does. This is a normal, expected answer and a good one. Cases that call for it:
- the headlines only report that the company did something generic ("X appoints new CFO", "X wins 5-star tech award") and you do not recognise the name
- the name is ambiguous between real companies and the headlines do not disambiguate which one this is
- the "company" looks like a descriptor, a product, a job title or a place rather than an organisation
- you would have to hedge ("appears to be", "likely a", "some kind of") to write the sentence at all

A missing profile costs nothing — the page renders as it did before. A confidently wrong one is the thing that gets a reference page distrusted.

STYLE

Write like a reference entry, not marketing copy. No "leading", "innovative", "cutting-edge", "best-in-class", "solutions provider", "revolutionising". Say what it actually does in concrete terms. Do not describe the news coverage itself ("has been covered for...", "recently appeared in...") — describe the company.

COMPANIES:

${blocks}

Respond with ONLY a JSON object mapping each id to its answer. No commentary. Example:
{"c1": {"known": true, "summary": "Qover is a Belgian insurtech that sells embedded insurance through banks, mobility platforms and retailers via an API rather than to consumers directly.", "kind": "Insurtech", "place": "Brussels, Belgium"}, "c2": {"known": false}}`;
}

const MARKETING = /\b(?:leading|innovative|cutting[- ]edge|best[- ]in[- ]class|world[- ]class|revolutionis|revolutioniz|game[- ]chang|next[- ]generation|state[- ]of[- ]the[- ]art)/i;

/* A digit anywhere in the summary. Deliberately blunt: the rule the
   prompt is asked to follow is "no numbers, no dates", and a summary
   that carries one has ignored the rule that matters most, so the
   safe reading is that the sentence is not trustworthy rather than
   that one clause needs editing. Cheap to be strict — a rejected
   profile costs a page one paragraph, and the next prompt version
   gets another go at it.

   Roman-numeral and spelled-out cases ("Series B", "two million")
   slip through this and are left to the prompt; the point of the
   check is to catch the common shape, not to be a parser. */
const HAS_NUMBER = /\d/;

/* …except when the digit is in the company's own name. The prompt
   requires the summary to start with the name, so a bare digit test
   rejects 1Life, Akur8, Peak3, a16z, 360 One, 1Fort, 3IF Ventures,
   UM6P, D2C Consulting, Drive 2 Digital and O2 Telefónica — eleven
   companies, seven of them one-story pages, on their name alone.
   Worse, the failure is *permanent* and silent: every prompt version
   re-asks and re-rejects, and the log just shows a decline.

   So strip the name before testing. Whitespace in the name is matched
   loosely, because "360 One" is written "360One" about as often, and
   the strip is global so a possessive or a second mention is covered
   too. This does mean a stray digit adjacent to the name could hide
   inside the strip; that is a far cheaper error than blacklisting
   eleven companies forever. */
function stripName(summary, name) {
  const n = String(name || "").trim();
  if (!n) return summary;
  const pattern = n
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");
  return summary.replace(new RegExp(pattern, "gi"), " ");
}

function normalise(raw, name = "") {
  const base = { pv: PROMPT_VERSION };
  if (!raw || typeof raw !== "object" || raw.known !== true) return { known: false, ...base };

  const summary = String(raw.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length < 30 || summary.length > MAX_SUMMARY) return { known: false, ...base };
  if (HAS_NUMBER.test(stripName(summary, name))) return { known: false, reason: "number", ...base };
  if (MARKETING.test(summary)) return { known: false, reason: "marketing", ...base };

  const kind = KINDS.has(String(raw.kind || "").trim()) ? String(raw.kind).trim() : "";
  let place = String(raw.place || "").replace(/\s+/g, " ").trim().slice(0, MAX_PLACE);
  if (/^(?:n\/?a|unknown|none|unclear|not specified)$/i.test(place)) place = "";

  return { known: true, summary, kind, place, ...base };
}

function extract(need) {
  const out = {};
  let ok = 0, failed = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK).map((c, k) => ({ ...c, id: `c${i + k}` }));
    const parsed = parseJsonObject(callClaude(buildPrompt(chunk)));
    if (!parsed) {
      failed++;
      console.warn(`  ✗ profile chunk @${i} unparseable — those companies keep no profile`);
      continue;
    }
    ok++;
    for (const it of chunk) {
      if (!(it.id in parsed)) continue;
      out[it.slug] = { ...normalise(parsed[it.id], it.name), n: it.n, seen: it.seen };
    }
  }
  console.log(`  chunks: ${ok} ok, ${failed} failed`);
  return out;
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/* Evidence for one company: newest headlines, each with its summary
   line when the feed gave one. The store's summaries are short (median
   67 chars on the wire, blank on plenty of stored items), so this is
   a cheap way to add the little context a bare headline lacks.

   Deduplicated on the headline first, because the same story reaches
   the wire from more than one feed and the archive keeps both — Zurich
   and Corgi each spend two of their twelve slots on a repeat. Twelve
   slots of *distinct* coverage describes a company; twelve slots
   holding six stories twice describes it half as well, and the model
   is being asked what the company does rather than how widely it was
   reported. */
function evidenceFor(c) {
  const seen = new Set();
  const out = [];
  for (const a of c.articles || []) {
    const title = String(a.title || "").trim();
    if (!title) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const extra = (a.summary || "").replace(/\s+/g, " ").trim().slice(0, 200);
    out.push(extra ? `${title} — ${extra}` : title);
    if (out.length >= EVIDENCE_MAX) break;
  }
  return out;
}

function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  const store = loadJSON(STORE, null);
  if (!store || !store.seen) {
    console.error("No companies-store.json — run companies.js first.");
    process.exit(0);
  }
  const db = loadJSON(DB, null);
  if (!db || !Array.isArray(db.companies)) {
    console.error("No companies.json — run companies.js first.");
    process.exit(0);
  }
  store.profiles = store.profiles || {};

  if (!claudeAvailable()) {
    console.log("Profiles: no Claude credentials — keeping cache, pages render without a profile.");
    return;
  }

  /* Rewrite when the prompt moved, or when the company has coverage
     newer than the profile was written from. The second half is what
     keeps a one-story profile from outliving the one story. */
  const need = [];
  for (const c of db.companies) {
    if (!c.slug || !c.name) continue;
    const cached = store.profiles[c.slug];
    if (cached && cached.pv === PROMPT_VERSION && cached.seen === c.lastSeen) continue;
    const evidence = evidenceFor(c);
    if (!evidence.length) continue;
    need.push({ slug: c.slug, name: c.name, evidence, n: c.count || 0, seen: c.lastSeen || null });
  }

  /* Most-covered first. Unlike funding-extract's newest-first, the
     valuable end here is depth, not recency: those pages are the ones
     already indexable, they carry the most evidence, and when a
     --limit run is really a prompt-iteration pass they are the answers
     worth reading. */
  need.sort((a, b) => b.n - a.n || (new Date(b.seen || 0) - new Date(a.seen || 0)));
  const batch = need.slice(0, limit);

  console.log(
    `Profiles: ${need.length} company profile(s) need writing` +
      `${batch.length < need.length ? `, doing ${batch.length}` : ""}.`
  );
  if (!batch.length) { console.log("Nothing to do."); return; }

  const got = extract(batch);
  let wrote = 0, declined = 0;
  for (const [slug, profile] of Object.entries(got)) {
    store.profiles[slug] = profile;
    if (profile.known) wrote++; else declined++;
  }

  // Drop profiles for companies no longer in the index, so the cache
  // can't outlive the archive it describes. companies.js runs before
  // this, so db is this run's index and the comparison is current.
  const live = new Set(db.companies.map((c) => c.slug));
  for (const slug of Object.keys(store.profiles)) {
    if (!live.has(slug)) delete store.profiles[slug];
  }

  /* Every writer of this file names every key. funding-extract.js
     carries `profiles` through for the same reason this carries
     `funding` and `topics` through — a write that names only its own
     keys silently truncates the others' caches (rule 3c-v). */
  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted || {},
    funding: store.funding || {},
    profiles: store.profiles,
    topics: store.topics || {},
    glossary: store.glossary || {},
  }, null, 2));

  const total = Object.values(store.profiles).filter((p) => p.known).length;
  console.log(
    `Profile cache: +${wrote} written, ${declined} declined this pass · ` +
      `${total} profile(s) of ${Object.keys(store.profiles).length} companies.`
  );
}

if (require.main === module) main();

module.exports = { normalise, buildPrompt, evidenceFor, stripName, PROMPT_VERSION, KINDS };
