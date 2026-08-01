#!/usr/bin/env node
/* ============================================================
   Glossary definitions — the original prose on a term page
   ------------------------------------------------------------
   Runs after topic-brief.js, reads the archive through glossary.js,
   and writes a short definition per term into companies-store.json
   under `glossary`, keyed by term slug. seo.js renders it as the top
   of /glossary/<slug>/ and uses the first sentence as the page's meta
   description.

   WHY THIS EXISTS

   Company pages, topic hubs and the funding tracker all answer
   questions about *this week*. Nothing here answered "what is an MGA",
   which is a question with steady volume that does not decay and does
   not depend on the news — and which the site was already accumulating
   evidence for without ever stating the answer.

   The differentiator is the pair, not the definition. Anyone can
   define an MGA; the reference sites define it better and have a
   decade of authority doing so. What they cannot show is twenty-five
   headlines about MGAs from the last two years with the companies
   attached. So a term earns a crawlable page on its coverage
   (indexableTerm() in glossary.js), and this file writes the half that
   makes the coverage worth landing on.

   WHAT THE MODEL MAY AND MAY NOT SAY

   The same split profile.js and topic-brief.js use, and for the same
   reason — a wrong sentence in our own voice is worse than a thin
   page, because a borrowed headline is at least someone else's claim,
   attributed and linked.

     · The definition and the mechanics come from the model's own
       knowledge. That is what the page is for.
     · Anything about who is doing this or how it is moving comes from
       the headlines handed over, and nowhere else.
     · Statistics come from neither, on topic-brief.js's rule rather
       than profile.js's: this page has no derived numeric table under
       it that would catch an invented figure, and it needs to be able
       to say "IFRS 17" and "Solvency II", which are names rather than
       claims. STATISTIC is imported rather than re-declared so the two
       cannot drift.

   SHORTER THAN A TOPIC BRIEF, ON PURPOSE

   A hub is a subject with fourteen sections' worth of ground to cover.
   A term is one idea, and a reader who searched it wants it answered
   in the first screen. Two or three sections, no headings: at this
   length headings would be furniture on a page that is already short,
   where on a 500-word hub explainer they are structure.

   FAILURE IS ORDINARY

   No credentials, a rate limit, an unparseable reply: the term gets no
   entry, no page is built for it, and the glossary index simply lists
   one fewer term. It runs LAST of the six Claude steps because it is
   the only one whose absence removes nothing that already existed.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { claudeAvailable, callClaude, parseJsonObject } = require("./claude");
const { TERMS, collectTerms, MIN_STORIES } = require("./glossary");
const { STATISTIC, MARKETING } = require("./topic-brief");

const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "data", "companies-store.json");

/* Bump to rewrite every cached definition. Twenty-eight terms, one
   call each, so a full backfill is 28 calls — small enough that this
   needs no --limit, exactly as topic-brief.js doesn't. */
const PROMPT_VERSION = 1;

/* A definition is written ONCE and then left alone.

   This is the one refresh rule that differs from every other Claude
   step here, and the difference is the subject. A company profile goes
   stale because the company does things; a topic brief goes stale
   because the subject's centre of gravity moves. What an MGA *is* does
   not change — it did not change last year and it will not change
   because eleven more MGA headlines arrived.

   So there is no growth trigger at all: `stale()` asks only whether
   the prompt moved or whether the last attempt failed. The coverage
   list under the definition is rebuilt from the archive on every
   build, so the page stays current without the prose being rewritten.
   That also makes this the cheapest step on the site — zero calls a
   day once the cache is full, not merely few. */
const MAX_TRIES = 3;

const MAX_SUMMARY = 300;
const MIN_PARAS = 2;
const MAX_PARAS = 3;
const MIN_PARA = 200;
const MAX_PARA = 620;

/* Same budget and same reason as the other two writers: the opening
   sentence is lifted as the meta description, a result cuts at ~158,
   and a definition that stops mid-clause on an ellipsis is the one
   thing a page answering "what is X" cannot ship. */
const FIRST_SENTENCE_MAX = 155;
const FIRST_SENTENCE_TARGET = 135;

function buildPrompt(t) {
  const name = t.full ? `${t.term} (${t.full})` : t.term;
  const headlines = t.evidence.map((e) => `  - ${e}`).join("\n");
  return `You write the definition at the top of a glossary page on an insurtech news archive.

The term is ${JSON.stringify(name)}. Below your text the page lists the ${t.n} stories in our archive whose headlines mention it. Your text answers "what is this, and why does it matter" for a reader who searched the term and may know nothing about insurance.

Answer with:
  "known": true or false — see below
  "summary": 1-2 sentences, at most ${MAX_SUMMARY} characters total, present tense.
      The FIRST sentence must define ${JSON.stringify(t.term)} plainly and stand on its own, because it is used by itself as the page's search-result description. Aim for about ${FIRST_SENTENCE_TARGET} characters. It is DISCARDED above ${FIRST_SENTENCE_MAX}, so write the short version and put the qualifications in the second sentence.
  "body": an array of ${MIN_PARAS}-${MAX_PARAS} paragraphs, each between ${MIN_PARA} and ${MAX_PARA} characters. The answer is discarded if there are too many or if any one runs long. Suggested shape:
      1. how it works in practice — who the parties are, what changes hands, where it sits in the chain between a policyholder and the capital that ultimately carries the risk
      2. why it exists and what the hard parts or common misunderstandings are
      3. optionally, how it shows up in insurance technology specifically: what gets built, bought or automated around it

Define the term as it is used in insurance. If it has a broader meaning elsewhere, ignore that.

WHAT YOU MAY USE

Your own knowledge of the industry for the definition and the mechanics — that is the point of the page. The headlines below only for anything about who is active or how the activity is moving.

WHAT YOU MUST NOT STATE

No statistics of any kind: no money, no percentages, no growth rates, no years or dates, no counts of companies, deals or policyholders. This page has no sourced figures on it and nothing under it that would contradict a wrong one. Describe shape and direction in words instead. Naming a regulation or standard that contains a digit is fine — IFRS 17, Solvency II, PSD2 are names, not claims.

WHEN TO ANSWER known: false

Answer {"known": false} when the term is too vague or too contested to define cleanly, or when you would have to guess. A missing definition costs nothing: the page is simply not built. This is a normal answer.

STYLE

Write like a reference work: plain, concrete, unhurried. No "leading", "innovative", "cutting-edge", "rapidly evolving", "game-changing". Do not open with a rhetorical question, do not address the reader as "you", and do not describe our coverage as coverage — describe the term.

HEADLINES WE HOLD
${headlines}

Respond with ONLY a JSON object. No commentary. Example:
{"known": true, "summary": "A managing general agent is a firm an insurer authorises to underwrite and bind policies on its behalf, rather than merely selling them.", "body": ["The insurer supplies the capacity and carries the risk; the MGA supplies the underwriting judgement, the distribution and usually the technology...", "The arrangement exists because a carrier cannot economically build specialist expertise for every niche..."]}`;
}

/* Length of the first sentence, matched the way descFromProfile() in
   seo.js matches it. Keep the two in step — the guard is only
   meaningful if it measures the sentence seo.js will actually lift. */
function ledeLength(summary) {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(summary);
  return (m ? m[0] : summary).trim().length;
}

function normalise(raw) {
  const base = { pv: PROMPT_VERSION };
  if (!raw || typeof raw !== "object" || raw.known !== true) return { known: false, ...base };

  const summary = String(raw.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length < 50 || summary.length > MAX_SUMMARY) return { known: false, reason: "shape", ...base };
  if (ledeLength(summary) > FIRST_SENTENCE_MAX) return { known: false, reason: "lede", ...base };

  const body = (Array.isArray(raw.body) ? raw.body : [])
    .map((p) => String(p || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (body.length < MIN_PARAS || body.length > MAX_PARAS) return { known: false, reason: "shape", ...base };
  if (body.some((p) => p.length < MIN_PARA || p.length > MAX_PARA))
    return { known: false, reason: "shape", ...base };

  const all = [summary, ...body].join(" ");
  if (STATISTIC.test(all)) return { known: false, reason: "statistic", ...base };
  if (MARKETING.test(all)) return { known: false, reason: "marketing", ...base };

  return { known: true, summary, body, ...base };
}

/* Newest first, then a spread across everything older — the same
   sampling topic-brief.js uses and for the same reason: the recent end
   of the archive is denser, so "the oldest N" would hand over one
   fortnight from two years ago and call it history. */
const EVIDENCE_MAX = 20;
function sampleEvidence(articles) {
  const seen = new Set();
  const uniq = [];
  for (const a of articles) {
    const key = String(a.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(a.title);
  }
  if (uniq.length <= EVIDENCE_MAX) return uniq;
  const head = uniq.slice(0, EVIDENCE_MAX / 2);
  const tail = uniq.slice(EVIDENCE_MAX / 2);
  const want = EVIDENCE_MAX - head.length;
  const step = tail.length / want;
  const spread = [];
  for (let i = 0; i < want; i++) spread.push(tail[Math.floor(i * step)]);
  return [...head, ...spread].filter(Boolean);
}

/* Ask again only if the prompt moved or the last attempt failed — see
   the header on why there is no growth trigger. */
function stale(cached) {
  if (!cached || cached.pv !== PROMPT_VERSION) return true;
  if (!cached.known) return (cached.tries || 0) < MAX_TRIES;
  return false;
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
  const onlyArg = process.argv.indexOf("--term");
  const only = onlyArg > -1 ? process.argv[onlyArg + 1] : null;
  const force = process.argv.includes("--force");
  /* Write definitions for terms below the indexing floor too. Off by
     default: a term with no coverage gets a noindex page, so its
     definition buys nothing today — but it will the moment the archive
     brings it over the floor, and pre-writing them is 12 calls. */
  const all = process.argv.includes("--all");

  const store = loadJSON(STORE, null);
  if (!store || !store.seen) {
    console.error("No companies-store.json — run companies.js first.");
    process.exit(0);
  }
  store.glossary = store.glossary || {};

  if (!claudeAvailable()) {
    console.log("Glossary: no Claude credentials — keeping cache, unwritten terms get no page.");
    return;
  }

  const terms = collectTerms(store)
    .filter((t) => all || t.n >= MIN_STORIES)
    .map((t) => ({ ...t, evidence: sampleEvidence(t.articles) }));

  const need = terms.filter(
    (t) => (!only || t.slug === only) && (force || stale(store.glossary[t.slug]))
  );
  // Best-covered first: on a bounded or interrupted run those are the
  // pages that matter, the same ordering profile.js and topic-brief.js use.
  need.sort((a, b) => b.n - a.n);
  const batch = need.slice(0, limit);

  console.log(
    `Glossary: ${need.length} of ${terms.length} terms need writing${force ? " (forced)" : ""}` +
      `${batch.length < need.length ? `, doing ${batch.length}` : ""}.`
  );
  if (!batch.length) { console.log("Nothing to do."); return; }

  let wrote = 0, declined = 0, failed = 0;
  for (const t of batch) {
    const parsed = parseJsonObject(callClaude(buildPrompt(t)));
    if (!parsed) {
      failed++;
      console.warn(`  ✗ ${t.term}: unparseable — keeping whatever was cached`);
      continue;
    }
    const fresh = normalise(parsed);
    const prev = store.glossary[t.slug];

    if (fresh.known) {
      store.glossary[t.slug] = fresh;
      wrote++;
      const words = [fresh.summary, ...fresh.body].join(" ").split(/\s+/).length;
      console.log(`  ✓ ${t.term} — ${fresh.body.length} paras, ~${words} words (${t.n} stories)`);
      continue;
    }

    /* Never let a decline take down a published definition — rule 3b's
       downgrade guard, which topic-brief.js carries for the same
       reason. A definition is rewritten only on a version bump, so a
       decline here would otherwise blank the page until the next one.
       After MAX_TRIES the kept entry takes the current version stamp
       so the asking stops, exactly as topic-brief.js does. */
    declined++;
    const tries = ((prev || {}).tries || 0) + 1;
    if (prev && prev.known) {
      const spent = tries >= MAX_TRIES;
      store.glossary[t.slug] = { ...prev, tries, ...(spent ? { pv: PROMPT_VERSION } : {}) };
      console.log(
        `  – ${t.term}: rewrite declined${fresh.reason ? ` (${fresh.reason})` : ""} — keeping the published definition` +
          (spent ? ` (no more attempts at this prompt)` : "")
      );
    } else {
      store.glossary[t.slug] = { ...fresh, tries };
      console.log(
        `  – ${t.term}: declined${fresh.reason ? ` (${fresh.reason})` : ""} — attempt ${tries} of ${MAX_TRIES}`
      );
    }
  }

  // Drop definitions for terms no longer in TERMS, so the cache cannot
  // outlive the list — the same prune buildGlossaryPages() does on disk.
  const live = new Set(TERMS.map((t) => t.slug));
  for (const slug of Object.keys(store.glossary)) {
    if (!live.has(slug)) delete store.glossary[slug];
  }

  /* Every writer of this file names every key (rule 3c-v). */
  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted || {},
    funding: store.funding || {},
    profiles: store.profiles || {},
    topics: store.topics || {},
    glossary: store.glossary,
  }, null, 2));

  const total = Object.values(store.glossary).filter((t) => t.known).length;
  console.log(
    `Glossary cache: +${wrote} written, ${declined} declined, ${failed} failed · ` +
      `${total} definition(s) of ${TERMS.length} terms.`
  );
}

if (require.main === module) main();

module.exports = { normalise, buildPrompt, stale, PROMPT_VERSION };
