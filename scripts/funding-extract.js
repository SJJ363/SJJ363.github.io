#!/usr/bin/env node
/* ============================================================
   Funding extraction — Claude reads the round out of the headline
   ------------------------------------------------------------
   Runs after companies.js, before seo.js. Writes a per-article
   verdict into companies-store.json under `funding`, keyed by link,
   which scripts/funding.js then treats as the primary source.

   WHY THIS EXISTS

   The tracker used to be regexes alone, and regexes lost rounds in
   a way that could not be patched away. "Prosus pours $460M into
   Alan at $6.3B" is Alan's largest round and the wire carried the
   story; the tracker never saw it, because "pours" was not on a
   list of nine funding verbs. Nor was "Investors bet $10M that
   Laka's collective insurance can fix bike coverage", nor "General
   Magic Nabs $7.2M", nor "Chapter pockets $75M". Adding verbs is a
   treadmill: English has more ways to say this than a list can
   hold, and each miss is silent — a row that simply isn't there.

   The reverse failure was as bad. `Blitzy raises $200 mn for AI
   coding` and `Cake Raises $13MM Seed Round … to Adopt Open-Source
   AI` sat on a page about insurtech funding because an insurtech
   outlet had reported them; `JVP raises $290M from TPG` was a fund,
   not a round; `InsuranceDekho could secure up to $100m` never
   happened at that number. Distinguishing those needs the sentence
   read, not matched.

   WHAT IS AND ISN'T CACHED

   Everything, including "not a round" — a negative verdict is the
   whole point of the pass, so it has to persist or the false
   positives come straight back. Keyed by link and stamped with
   PROMPT_VERSION, exactly like companies.js's `extracted` map, so
   a prompt change re-extracts the archive and a rerun costs
   nothing.

   Only funding CANDIDATES are asked about (isFundingCandidate in
   funding.js) — a wide net over money figures and round vocabulary,
   about a third of the store. That keeps a full backfill in the
   low tens of calls and a normal run in the low single digits.

   FAILURE IS ORDINARY

   No credentials, a rate limit, an unparseable reply: the link
   simply has no entry, and funding.js falls back to its regexes for
   that article. The site degrades to what it did before this file
   existed rather than losing the row. Nothing here is on the
   critical path, which is why news.yml lets it fail soft.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { claudeAvailable, callClaude, parseJsonObject } = require("./claude");
const { admits } = require("./relevance");
const { isFundingCandidate, RATES } = require("./funding");

const STORE = path.join(__dirname, "..", "data", "companies-store.json");

// Bump when the prompt changes so cached verdicts re-extract.
const PROMPT_VERSION = 4;

/* How far a round's real announcement may sit behind the article's date
   before the record is treated as a republished archive item.

   FinTech Global's RSS re-serves its own back catalogue stamped with
   today's date. Some of those carry a conference suffix and are caught
   deterministically (STALE_RECORD in funding.js); these do not:

     "FinTech giant Acrisure secures $2.1bn funding led by Bain Capital"
        filed 2025-05-21 — the round was 2021
     "InsurTech giant HUB International lands $1.6bn funding to hit $29bn
      valuation" filed 2025-05-14 — the round was 2023

   Both would have been the largest row on the tracker by a factor of
   three. Acrisure escaped only because CAP_M then sat at $2000M, which
   was luck rather than a guard — and CAP_M has since come down to
   venture scale, so it no longer catches even that much.

   Nothing in either headline says the date is wrong, so this cannot be
   read off the text — it needs to be recognised. That is a fair question
   to ask the model and a poor one to trust loosely, so the field is
   optional (null when it doesn't recognise the round) and the tolerance
   is a full year either side, well past any announced-in-December /
   written-up-in-January drift. Only a confident, large gap drops a row. */
const STALE_YEARS = 1;

/* Smaller than companies.js's 45: each answer here is an object with six
   fields rather than a list of names, and an over-long reply is one that
   gets truncated and thrown away whole. */
const CHUNK = 30;

const VALID_STAGES = new Set([
  "Pre-seed", "Pre-Series A", "Pre-Series B", "Pre-Series C",
  "Seed", "Series A", "Series B", "Series C", "Series D", "Series E+",
  "Venture debt", "Growth", "Strategic",
]);

/* Multipliers into MILLIONS of the stated currency. `crore` and `lakh` are
   here because Indian trade press writes rounds that way and always has —
   "Plum bags ₹193 crore", "InsuranceDekho Raises Rs 38.5 Cr" — and a
   tracker that can't read them is blind to one of the three biggest
   insurtech markets. */
const UNITS = { K: 1e-3, M: 1, B: 1e3, T: 1e6, CRORE: 10, LAKH: 0.1 };

function buildPrompt(items) {
  // The filed date travels with each headline, because one of the
  // questions below is whether the two agree.
  const lines = items
    .map((it) => `${it.id}: [filed ${String(it.publishedAt).slice(0, 10)}] ${JSON.stringify(it.title)}`)
    .join("\n");
  return `You extract FUNDING ROUNDS from insurance / insurtech news headlines.

A funding round is a company raising investment capital FOR ITSELF — seed, venture, growth or strategic equity, or venture debt.

Answer {"round": false} when the headline is anything else. In particular:
- a sector tally, market-size forecast or periodic roundup ("InsurTech funding reaches $420m in January", "Over $2bn raised across this week's 22 FinTech deals")
- an INVESTOR raising a fund to deploy ("3IF Ventures closes USD 12M fund to back insurtech startups", "Northwestern Mutual announces $150 million Fund III")
- an acquisition, merger, stake purchase, IPO, public placing or share offering
- a private-equity recapitalisation or control investment in a brokerage, agency or agency rollup. These are real disclosed raises by insurance companies, and they are still not rounds for this table: they are balance-sheet deals for consolidators, an order of magnitude larger than the venture rounds around them, and one of them dominates a whole year of the tracker. Acrisure's $2.1bn led by Bain Capital, HUB International's $1.6bn at a $29bn valuation and Highstreet Insurance's "$550 million in new capital" are all excluded. Judge this on the KIND of deal, not the size — a large growth round into an insurtech is still a round even when a private-equity firm leads it, and a small recapitalisation of a brokerage rollup is still not one.
- a company SPENDING money — buying something, investing in its own R&D, or committing capital to a partner, a joint venture or another company ("CGC commits $200m to GreenieRE to expand clean energy insurance" is a commitment by CGC, not a round raised by GreenieRE)
- underwriting capacity, a lending facility, a debt refinancing, an earnings or revenue figure, a claims payout, a fine, a settlement, a prize or a grant competition
- a round that has NOT closed: rumoured, planned, "in talks", "could raise", "seeks", "targets", "eyes", "set to raise"
- a round by a company that is NOT in insurance. Insurance means insurers, reinsurers, insurtechs, brokers, MGAs, and technology sold into underwriting, claims, distribution or employee benefits. An AI coding tool, a payments company or a general fraud-detection vendor is NOT insurance, even when an insurtech publication reports its round.

When it IS a closed insurance funding round, answer with:
  "round": true
  "company": the company that RAISED the money, full common name. Never the investor, never the news outlet. ("Prosus pours $460M into Alan" -> "Alan")
  "amount": the number exactly as printed, or null if the headline states no amount
  "currency": ISO code for that number — USD, EUR, GBP, INR, CAD, AUD, SGD, MYR, ZAR, BRL, CHF, JPY, HKD, NZD, AED, SAR
  "unit": "K", "M", "B", "crore" or "lakh"
  "stage": one of ${[...VALID_STAGES].join(", ")} — or "" when the headline does not say. "pre-Series A" is Pre-Series A, not Series A.
  "lead": the lead investor, only when the headline says who led it; otherwise ""
  "announced": the calendar year the round was actually announced, IF you recognise this specific round from your own knowledge; otherwise null

About "announced": one feed here re-publishes its own back catalogue with today's date on it, so the filed date is sometimes years off. Acrisure's $2.1bn led by Bain Capital was announced in 2021 but arrives filed 2025; Hippo's $100m Series D was 2018; Shift Technology's $60m Series C was 2021. If you recognise the round and know its year, give that year — it is checked against the filed date and a large gap drops the row. If you do not recognise it, answer null. Do not guess: null is the right answer for the great majority of these, which are small rounds you have no reason to know.

Rules that matter:
- When a headline gives BOTH a round total and an increment added to it, take the TOTAL. "PolicyStreet tops up Series C to US$26mil with additional US$5mil from BlueOrchard" is a $26M round, not a $5M one — the $5M is part of the $26M, and filing it separately counts the same money twice. Same for "extends Series B to $40m with a further $8m".
- Take the amount RAISED, never the valuation. "Prosus pours $460M into Alan at $6.3B" -> amount 460. "Corgi raises $160 mn Series B at $1.3 bn valuation" -> amount 160. "Insurtech firm Alan valued at $8.9B after Teachers' backs Series G" -> amount null (only a valuation is stated), stage "Series E+".
- Read the currency from the headline, not from the "$". "Quandri secures $16.5 million CAD" is CAD. "Roojai Raises US$60 Million" is USD. "Tuio closes a financing round of 15 million euros" is EUR.
- Do not infer an amount the headline does not state. null is a correct answer.

HEADLINES:
${lines}

Respond with ONLY a JSON object mapping each id to its answer. No commentary. Example:
{"a1": {"round": true, "company": "Alan", "amount": 460, "currency": "USD", "unit": "M", "stage": "", "lead": "Prosus"}, "a2": {"round": false}}`;
}

/* Trust nothing about shape. A model that answers "€10 million" in the
   amount field, "Series G" as a stage we don't render, or a currency we
   hold no rate for should cost one row's precision, never a build. */
function normalise(raw, publishedAt) {
  if (!raw || typeof raw !== "object" || raw.round !== true) return { round: false, pv: PROMPT_VERSION };

  /* A real round filed years after it happened. Rejected rather than
     re-dated: the archive is organised by month and quarter, and moving a
     row to a date this feed never published would put a claim on a period
     page that no cited source supports. Dropping it costs one row; the
     alternative silently rewrites history. */
  const year = Number(raw.announced);
  const filed = new Date(publishedAt || "").getUTCFullYear();
  if (Number.isInteger(year) && year > 1990 && filed && filed - year > STALE_YEARS) {
    return { round: false, stale: year, pv: PROMPT_VERSION };
  }

  const amount = typeof raw.amount === "number"
    ? raw.amount
    : parseFloat(String(raw.amount || "").replace(/[^\d.]/g, ""));
  const unit = String(raw.unit || "M").trim().toUpperCase();
  const mult = UNITS[unit] !== undefined ? UNITS[unit] : 1;
  const currency = String(raw.currency || "USD").trim().toUpperCase();

  // No amount is not a failure — plenty of real rounds are announced
  // without one — but it is not a row either, since every surface here
  // sums or ranks by capital. Cached as a negative so we don't re-ask.
  if (!isFinite(amount) || amount <= 0) return { round: false, pv: PROMPT_VERSION };
  if (RATES[currency] === undefined) return { round: false, pv: PROMPT_VERSION };

  const stage = VALID_STAGES.has(String(raw.stage || "").trim()) ? String(raw.stage).trim() : "";
  const lead = String(raw.lead || "").trim().slice(0, 60);
  const company = String(raw.company || "").trim().slice(0, 60);

  return {
    round: true,
    company,
    amountM: amount * mult,   // millions of `currency`
    currency,
    stage,
    lead: /^(?:n\/?a|unknown|none|undisclosed)$/i.test(lead) ? "" : lead,
    pv: PROMPT_VERSION,
  };
}

function extract(need) {
  const out = {};
  let ok = 0, failed = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK).map((a, k) => ({ id: `a${i + k}`, title: a.title, link: a.link, publishedAt: a.publishedAt }));
    const parsed = parseJsonObject(callClaude(buildPrompt(chunk)));
    if (!parsed) {
      failed++;
      console.warn(`  ✗ funding chunk @${i} unparseable — those links fall back to regex`);
      continue;
    }
    ok++;
    for (const it of chunk) if (it.id in parsed) out[it.link] = normalise(parsed[it.id], it.publishedAt);
  }
  console.log(`  chunks: ${ok} ok, ${failed} failed`);
  return out;
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  const store = loadJSON(STORE, null);
  if (!store || !store.seen) { console.error("No companies-store.json — run companies.js first."); process.exit(0); }
  store.funding = store.funding || {};

  if (!claudeAvailable()) {
    console.log("Funding extraction: no Claude credentials — keeping cache, regexes will fill the gap.");
    return;
  }

  /* Candidates are re-derived from the whole store every run, not just
     from today's batch. That is what lets a widened pre-filter or a
     bumped prompt heal the archive on the next build, the same contract
     collectDeals() has with the tracker. */
  const need = [];
  for (const [link, meta] of Object.entries(store.seen)) {
    if (!meta || !meta.title || !meta.publishedAt) continue;
    if (!admits(meta)) continue;
    if (!isFundingCandidate(meta)) continue;
    const cached = store.funding[link];
    if (cached && cached.pv === PROMPT_VERSION) continue;
    need.push({ title: meta.title, link, publishedAt: meta.publishedAt });
  }
  // Newest first, so a run that hits a limit or a rate cap has still done
  // the articles anyone is looking at.
  need.sort((a, b) => new Date(store.seen[b.link].publishedAt) - new Date(store.seen[a.link].publishedAt));
  const batch = need.slice(0, limit);

  console.log(`Funding extraction: ${need.length} candidate(s) need parsing${batch.length < need.length ? `, doing ${batch.length}` : ""}.`);
  if (!batch.length) { console.log("Nothing to do."); return; }

  const got = extract(batch);
  let rounds = 0;
  for (const [link, verdict] of Object.entries(got)) {
    store.funding[link] = verdict;
    if (verdict.round) rounds++;
  }

  // Drop verdicts for links no longer in the store, so the cache can't
  // outlive the archive it describes.
  for (const link of Object.keys(store.funding)) {
    if (!store.seen[link]) delete store.funding[link];
  }

  /* `profiles` and `topics` belong to profile.js and topic-brief.js,
     which both run after this and write the same file — carry them
     through for the same reason companies.js carries `funding` through. */
  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted || {},
    funding: store.funding,
    profiles: store.profiles || {},
    topics: store.topics || {},
    glossary: store.glossary || {},
    ma: store.ma || {},
  }, null, 2));

  const total = Object.values(store.funding).filter((f) => f.round).length;
  console.log(`Funding cache: +${Object.keys(got).length} verdict(s), ${rounds} round(s) this pass · ${total} round(s) cached of ${Object.keys(store.funding).length}.`);
}

if (require.main === module) main();

module.exports = { normalise, buildPrompt, PROMPT_VERSION };
