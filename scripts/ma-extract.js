#!/usr/bin/env node
/* ============================================================
   M&A extraction — Claude reads the deal out of the headline
   ------------------------------------------------------------
   Runs after funding-extract.js, before seo.js. Writes a
   per-article verdict into companies-store.json under `ma`, keyed
   by link, which scripts/ma.js then treats as the primary source.
   The architecture is funding-extract.js's, deliberately.

   WHY THIS EXISTS

   The same two failures, in the shapes an M&A tracker takes them.

   RECALL. The pair patterns in ma.js read "X acquires Y" and
   little else. They cannot read "Ageas sells Etiqa stake to Maybank
   for €1.1 billion" (a seller, a target and a buyer, in that
   order), "Everest agrees to sell Mexico insurance business to
   Fairfax", or "CCP approves Jazz-backed acquisition of TPL
   insurance in phase-I merger review" (a regulator, an acquirer
   named as an adjective, a target). Every miss is silent.

   PRECISION. The noun "acquisition" is a marketing word and the
   verb "buy" is a stock-tip word. "How to rethink acquisition KPIs
   in insurance", "5 Multiline Insurers to Buy Amid Inflation" and
   "'We're actively looking': CEO reveals juicy acquisition plans
   after Stockport move" all parse cleanly as deals and none is
   one. The regexes catch most by pattern; telling the rest apart
   needs the sentence read.

   And one failure that is this dataset's own: WHICH SIDE IS WHICH.
   A funding round has one company and the hard question is whether
   the other name is an investor (rule 3c-vi). A deal has two real
   parties, and an outlet may lead with either — "Etiqa stake
   bought by Maybank", "Optio to be acquired by Cinven and La
   Caisse". Getting them backwards does not lose a row, it prints a
   false one, which is worse.

   WHAT IS AND ISN'T CACHED

   Everything, including "not a deal" — the negative verdict is the
   whole point of the pass, so it has to persist or the false
   positives return on the next build (rule 3c-v). Keyed by link,
   stamped with PROMPT_VERSION.

   FAILURE IS ORDINARY

   No credentials, a rate limit, an unparseable reply: the link has
   no entry and ma.js's regexes decide it. The site degrades to
   what it did before this file existed. It is the LAST of the
   Claude steps for that reason — the brief is prose nobody else
   wrote, the company index feeds every page, the profiles and hub
   briefs are the only original writing on their page types, and
   this one has a working fallback.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { claudeAvailable, callClaude, parseJsonObject } = require("./claude");
const { admits } = require("./relevance");
const { isDealCandidate } = require("./ma");
const { RATES } = require("./funding");

const STORE = path.join(__dirname, "..", "data", "companies-store.json");

// Bump when the prompt changes so cached verdicts re-extract.
const PROMPT_VERSION = 2;

/* funding-extract.js's STALE_YEARS, for its reason: FinTech Global
   re-serves its back catalogue stamped with today's date, and an
   acquisition is a dated claim exactly as a round is. The tolerance is
   a full year either side, well past announced-in-December /
   completed-in-January drift — and a deal legitimately spans that gap
   more often than a round does, which is why nothing tighter would be
   safe here. */
const STALE_YEARS = 1;

const CHUNK = 30;

const VALID_TYPES = new Set([
  "Acquisition",
  "Merger",
  "Majority stake",
  "Asset purchase",
]);

const UNITS = { K: 1e-3, M: 1, B: 1e3, T: 1e6, CRORE: 10, LAKH: 0.1 };

function buildPrompt(items) {
  const lines = items
    .map(
      (it) =>
        `${it.id}: [filed ${String(it.publishedAt).slice(0, 10)}] ${JSON.stringify(it.title)}`
    )
    .join("\n");
  return `You extract MERGERS AND ACQUISITIONS from insurance / insurtech news headlines.

A deal here is one company acquiring another company, a controlling stake in one, or a defined book of business — or two companies merging.

Answer {"deal": false} when the headline is anything else. In particular:
- the WORD "acquisition" with no transaction under it: customer acquisition, talent acquisition, acquisition costs, acquisition strategy, "rethinking acquisition KPIs"
- a stock tip or listicle ("5 Multiline Insurers to Buy Amid Inflation", "3 insurance stocks to buy now")
- consumers buying insurance ("Jubilee Health Wants Kenyans to Buy Insurance Where They Already Transact", "changing the way insurance is bought in the UK")
- a FUNDING ROUND, including one raised in order to make acquisitions later ("American Growth Insurance raises $70mn to buy U.S. brokerages"). That is a round, it is on the funding tracker, and there is no target here yet.
- a MINORITY investment — a stake under 50%, or one described as a minority stake. "Tokio Marine takes minority stake in Igloo" and "Mapfre takes 38.9% stake in Spanish insurtech Tuio" are investments, not changes of ownership. A stake of 50% or more IS a deal even when the headline never says "majority": "Wipro to raise stake in Aggne Global to 80%" is one.
- a deal that has NOT been agreed: rumoured, explored, "in talks", "eyes", "could acquire", "is said to be considering", "bids for". An ANNOUNCED or AGREED deal IS a deal, even before it closes — "Allianz to acquire HSBC Life Singapore" counts.
- a partnership, joint venture, distribution agreement, investment round, IPO, share buyback, employee share plan or executive appointment
- a deal outside insurance. THE TEST IS WHAT THE TARGET DOES, NOT WHO THE BUYER IS. Insurers buy things that have nothing to do with insurance, and those are not insurance M&A: "Wipro to Acquire Applied Value Technologies for $40 Million to Boost Application Services Capabilities" is an IT-services deal, "ColCap Acquires Digital Mortgage Lender Molo" is mortgage lending, and "Allianz expands Asia strategy with UOB Asset Management acquisition" is asset management. All three were wrongly counted before. Insurance means insurers, reinsurers, insurtechs, brokers, MGAs, TPAs, adjusters, and technology or services sold INTO underwriting, claims, distribution or employee benefits. A general IT consultancy, a bank, a lender, an asset manager, a payments firm or a generic AI vendor is not insurance merely because an insurer bought it.

When it IS a deal, answer with:
  "deal": true
  "acquirer": the company DOING the buying, full common name. Never the seller, never the regulator, never the news outlet.
  "target": the company or business BEING bought, full common name. Never a description — if the headline never names it ("Gallagher acquires tenant specialist Canadian digital broker"), answer {"deal": false}, because a row with no named target cannot be filed or checked. This is the rule most often got wrong: "Income sells digital insurance platform to Embed Financial" came back with the target "digital insurance platform", "Allianz hands cyber book to Coalition" with "cyber book", and "Markel sells reinsurance renewal rights to Nationwide" with "reinsurance renewal rights". None of those is a name and all three should have been {"deal": false}. A target that is a proper noun attached to a named parent IS acceptable, because it can still be filed: "Everest's Mexico insurance business", "Allstate's employer benefits business", "Neodigital's insurance portfolio".
  "seller": the party disposing of it, when the headline names one separate from the target ("Ageas sells Etiqa stake to Maybank for EUR 1.1 billion" -> seller "Ageas", target "Etiqa", acquirer "Maybank"); otherwise ""
  "type": one of ${[...VALID_TYPES].join(", ")}
  "amount": the price exactly as printed, or null if the headline states no price. MOST DEALS STATE NO PRICE — null is the normal answer and is not a failure.
  "currency": ISO code for that number — USD, EUR, GBP, INR, CAD, AUD, SGD, MYR, ZAR, BRL, CHF, JPY, HKD, NZD, AED, SAR
  "unit": "K", "M", "B", "crore" or "lakh"
  "announced": the calendar year the deal was actually announced, IF you recognise this specific deal from your own knowledge; otherwise null

Which side is which is the thing to get right. Outlets lead with either party, and reversing them prints a false row rather than losing a true one:
- "Etiqa stake bought by Maybank" -> acquirer "Maybank", target "Etiqa"
- "Optio to be acquired by Cinven and La Caisse" -> acquirer "Cinven and La Caisse", target "Optio"
- "CCP approves Jazz-backed acquisition of TPL Insurance" -> acquirer "JazzWorld", target "TPL Insurance". The regulator is not a party.
- "Mapfre Expands US Footprint with Strategic Acquisition of Safety Insurance Group" -> acquirer "Mapfre", target "Safety Insurance Group"

Rules that matter:
- Strip the descriptors trade press hangs on a name. "Duck Creek acquires London-based insurtech Send Technology" -> target "Send Technology". But do NOT strip a word that is part of the name: "Mile Auto Acquires Insurance House" -> target "Insurance House", not "House".
- Take the PRICE of the deal, never a valuation, a fund size, or the acquirer's market cap. "Allianz to Buy HSBC's Singapore Insurer in $2.1 Billion Deal" -> amount 2.1, unit "B".
- Read the currency from the headline, not from the "$". "Jazz International to Acquire TPL Insurance for Rs4.15 Billion" is INR.
- One headline covering several unrelated stories ("Beazley acquires kWh Analytics; Aon names North America CEO: Insurtech news") is a deal for the acquisition it leads with — acquirer "Beazley", target "kWh Analytics".
- Do not infer a price the headline does not state. null is a correct answer.

About "announced": one feed here re-publishes its own back catalogue with today's date on it, so the filed date is sometimes years off. If you recognise the deal and know the year it was announced, give that year — it is checked against the filed date and a large gap drops the row. If you do not recognise it, answer null. Do not guess.

HEADLINES:
${lines}

Respond with ONLY a JSON object mapping each id to its answer. No commentary. Example:
{"a1": {"deal": true, "acquirer": "Allianz", "target": "HSBC Life Singapore", "seller": "HSBC", "type": "Acquisition", "amount": 2.1, "currency": "USD", "unit": "B", "announced": null}, "a2": {"deal": false}}`;
}

/* Trust nothing about shape — funding-extract.js's normalise()
   contract. The one substantive difference is that a MISSING AMOUNT
   IS NOT A REJECTION: next door a round with no figure is cached as a
   negative because every funding surface sums or ranks by capital,
   and here the great majority of real deals never state a price. A
   row is the pair and the date. */
function normalise(raw, publishedAt) {
  if (!raw || typeof raw !== "object" || raw.deal !== true) {
    return { deal: false, pv: PROMPT_VERSION };
  }

  const acquirer = String(raw.acquirer || "").trim().slice(0, 80);
  const target = String(raw.target || "").trim().slice(0, 80);
  /* Both sides or nothing. A one-sided row cannot be filed under a
     company, linked to a page or deduplicated against the outlet that
     names it — and the prompt is told to decline rather than describe,
     so an unnamed target arriving here means the answer drifted. */
  if (!acquirer || !target) return { deal: false, pv: PROMPT_VERSION };
  if (acquirer.toLowerCase() === target.toLowerCase()) {
    return { deal: false, pv: PROMPT_VERSION };
  }

  const year = Number(raw.announced);
  const filed = new Date(publishedAt || "").getUTCFullYear();
  if (Number.isInteger(year) && year > 1990 && filed && filed - year > STALE_YEARS) {
    return { deal: false, stale: year, pv: PROMPT_VERSION };
  }

  const type = VALID_TYPES.has(String(raw.type || "").trim())
    ? String(raw.type).trim()
    : "Acquisition";

  /* Undisclosed is the normal case and a complete row. Only a stated
     price is carried, and only in a currency we hold a rate for — an
     unconvertible figure is dropped to no-price rather than filed at
     face value, which is the mistake four Canadian rounds made next
     door before amountOf() read currencies (rule 3c-i). */
  const amount =
    typeof raw.amount === "number"
      ? raw.amount
      : parseFloat(String(raw.amount == null ? "" : raw.amount).replace(/[^\d.]/g, ""));
  const unit = String(raw.unit || "M").trim().toUpperCase();
  const currency = String(raw.currency || "USD").trim().toUpperCase();
  const priced = isFinite(amount) && amount > 0 && RATES[currency] !== undefined;

  const seller = String(raw.seller || "").trim().slice(0, 80);

  return {
    deal: true,
    acquirer,
    target,
    seller: /^(?:n\/?a|unknown|none|undisclosed)$/i.test(seller) ? "" : seller,
    type,
    ...(priced
      ? {
          amountM: amount * (UNITS[unit] !== undefined ? UNITS[unit] : 1),
          currency,
        }
      : {}),
    pv: PROMPT_VERSION,
  };
}

function extract(need) {
  const out = {};
  let ok = 0, failed = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK).map((a, k) => ({
      id: `a${i + k}`,
      title: a.title,
      link: a.link,
      publishedAt: a.publishedAt,
    }));
    const parsed = parseJsonObject(callClaude(buildPrompt(chunk)));
    if (!parsed) {
      failed++;
      console.warn(`  ✗ M&A chunk @${i} unparseable — those links fall back to regex`);
      continue;
    }
    ok++;
    for (const it of chunk) {
      if (it.id in parsed) out[it.link] = normalise(parsed[it.id], it.publishedAt);
    }
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
  if (!store || !store.seen) {
    console.error("No companies-store.json — run companies.js first.");
    process.exit(0);
  }
  store.ma = store.ma || {};

  if (!claudeAvailable()) {
    console.log("M&A extraction: no Claude credentials — keeping cache, regexes will fill the gap.");
    return;
  }

  /* Candidates re-derived from the whole store every run, not just
     today's batch — the contract that lets a widened pre-filter or a
     bumped prompt heal the archive on the next build. */
  const need = [];
  for (const [link, meta] of Object.entries(store.seen)) {
    if (!meta || !meta.title || !meta.publishedAt) continue;
    if (!admits(meta)) continue;
    if (!isDealCandidate(meta)) continue;
    const cached = store.ma[link];
    if (cached && cached.pv === PROMPT_VERSION) continue;
    need.push({ title: meta.title, link, publishedAt: meta.publishedAt });
  }
  // Newest first, so a run that hits a limit or a rate cap has still
  // done the articles anyone is looking at.
  need.sort(
    (a, b) => new Date(store.seen[b.link].publishedAt) - new Date(store.seen[a.link].publishedAt)
  );
  const batch = need.slice(0, limit);

  console.log(
    `M&A extraction: ${need.length} candidate(s) need parsing${
      batch.length < need.length ? `, doing ${batch.length}` : ""
    }.`
  );
  if (!batch.length) { console.log("Nothing to do."); return; }

  const got = extract(batch);
  let deals = 0;
  for (const [link, verdict] of Object.entries(got)) {
    store.ma[link] = verdict;
    if (verdict.deal) deals++;
  }

  // Drop verdicts for links no longer in the store, so the cache can't
  // outlive the archive it describes.
  for (const link of Object.keys(store.ma)) {
    if (!store.seen[link]) delete store.ma[link];
  }

  /* Every key belonging to another writer is carried through — the
     truncation hazard rule 3c-v documents. This file runs last of the
     six Claude steps, so it is the one most likely to drop somebody
     else's cache if this object is written short. */
  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted || {},
    funding: store.funding || {},
    profiles: store.profiles || {},
    topics: store.topics || {},
    glossary: store.glossary || {},
    ma: store.ma,
  }, null, 2));

  const total = Object.values(store.ma).filter((f) => f.deal).length;
  console.log(
    `M&A cache: +${Object.keys(got).length} verdict(s), ${deals} deal(s) this pass · ` +
      `${total} deal(s) cached of ${Object.keys(store.ma).length}.`
  );
}

if (require.main === module) main();

module.exports = { normalise, buildPrompt, PROMPT_VERSION };
