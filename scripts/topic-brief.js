#!/usr/bin/env node
/* ============================================================
   Topic briefs — the original prose on a topic hub
   ------------------------------------------------------------
   Runs LAST of the Claude steps in news.yml (after profile.js),
   reads the archive, and writes a short explainer per taxonomy
   category into companies-store.json under `topics`, keyed by the
   topic slug. seo.js renders it directly under the h1 and uses its
   first sentence as the page's meta description.

   WHY THIS EXISTS

   The fifteen topic hubs were the last page type here carrying no
   sentence anybody wrote. /topic/embedded/ was a story count, a
   company badge list, a co-tag list, a source list and 109 borrowed
   headlines — the same description rule 3a-ii gives company pages
   before profiles existed, on the pages with the most to gain.

   They have the most to gain because of what their URLs are pointed
   at. A company page can win "<name> funding" and little else, and a
   month page can win "insurtech funding August 2025" — both real,
   both narrow, both decaying. /topic/embedded/, /topic/cyber/ and
   /topic/claims-and-underwriting/ sit on evergreen definitional
   queries ("what is embedded insurance", "AI in insurance
   underwriting") whose volume does not decay and does not depend on
   this week's news. The site already held those URLs, already had
   them indexed, and put nothing on them worth ranking.

   The other half is that all fifteen shared one meta description
   template — "N insurtech stories tagged X, from A, B and C" — which
   is the same near-duplication the profile work removed from ~945
   company pages.

   WHY IT IS SECTIONED, AND WHY IT IS LONGER THAN A LEDE

   The first version wrote a summary and three flat paragraphs — about
   250 words with no internal structure, sitting above sixty headlines
   under an h1 reading "Embedded" and a title reading "Embedded —
   insurtech news & coverage". Every signal on that page except the
   prose said *news index*, which is the wrong page for the query it is
   pointed at: someone searching "what is embedded insurance" is offered
   a taxonomy label and a wire.

   So the answer is now a `sections` array — a heading and a paragraph
   each, MIN_SECTIONS to MAX_SECTIONS of them — rendered as real h2s,
   which roughly doubles the prose and gives the page the shape of a
   reference article rather than an intro paragraph. The headings are
   written by the model rather than fixed here, because a fixed set
   ("How it works", "Why it matters") is a template on fourteen pages,
   which is the near-duplication this whole step exists to remove.

   The other half of the fix is not in this file: seo.js now titles and
   headlines the page with the *subject* rather than the category label
   (taxonomy.js's SUBJECTS). Prose alone could not fix an h1 reading
   "Cyber", and the h1 was doing more damage than the word count.

   WHAT THE MODEL MAY AND MAY NOT SAY

   The split is profile.js's, for the same reason: a wrong sentence in
   our own voice is worse than a thin page, because a borrowed
   headline is at least someone else's claim, attributed and linked.

     · Definition and mechanics come from the model's own knowledge.
       This is the point of the page — someone searching "what is
       embedded insurance" wants the concept explained, and no
       arrangement of headlines explains a concept.
     · Who is active and what the coverage pattern looks like comes
       from the archive, which is handed over as evidence: a sample of
       headlines spanning the whole period, the most-covered companies,
       and the categories this one co-occurs with.
     · Statistics come from NEITHER. See below — the rule here is
       narrower than the one profiles use, on purpose.

   WHY THE NUMERIC RULE IS NARROWER THAN profile.js's

   profile.js rejects a summary containing any digit at all, and is
   right to: a company page renders the funding table a few
   centimetres under the profile, so a recalled figure lands next to a
   sourced one and the page contradicts itself.

   A topic hub has no derived numeric table. Nothing on the page would
   catch an invented statistic, which makes "premiums grew 30% last
   year" the failure to guard rather than a digit as such — so the
   test is targeted at the shapes an unsourced statistic actually
   takes: money, percentages, years, and large bare quantities.

   The narrower rule is also what lets the brief use the vocabulary
   these queries are searched with. "IFRS 17", "PSD2" and "Solvency
   II" are named standards, not claims about the world; they carry no
   date and cannot go stale, and a Regulation explainer that cannot
   name them is an explainer about nothing. A blanket digit ban would
   have rejected that brief every time, permanently and silently,
   exactly the way it once rejected Akur8 and 1Fort.

   WHAT IS CACHED, AND WHEN IT IS REWRITTEN

   Keyed by slug, stamped with PROMPT_VERSION as `extracted`,
   `funding` and `profiles` are, plus `n` — the story count the brief
   was written from.

   Two shapes live in this cache at once, and that is not a migration
   waiting to happen. A PROMPT_VERSION bump rewrites every topic, but
   only as each one is asked and only if it answers — and a declined
   rewrite deliberately keeps the published brief (see the loop in
   main()), which may be v1 for another season. So topicBriefBlock() in
   seo.js renders `sections` and the older flat `body` both, and will
   keep doing so as long as one hub is still carrying the old shape.

   The refresh rule is the one real departure from profile.js. A
   profile is rewritten when the company gains *any* newer coverage,
   which is affordable because ~15 companies move in a day. A topic
   moves every single day — all fifteen hubs gain stories continuously
   — so the same rule would rewrite the entire set daily to change
   almost nothing, since one more story does not change what embedded
   insurance is. So a brief is rewritten when the topic has grown
   materially: GROWTH times the count it was written from, or
   MIN_GROWTH stories more, whichever is further. In practice that is
   every couple of months per topic, and zero calls on a normal day.

   Steady state is therefore nothing at all, and the whole cost is a
   PROMPT_VERSION bump: fifteen calls, one per topic. That is small
   enough that this needs no --limit, which every other Claude step
   here does.

   FAILURE IS ORDINARY

   No credentials, a rate limit, an unparseable reply: the topic gets
   no entry, no block renders, and the hub is exactly what it was.
   It is the last Claude step for the same reason profile.js was
   before it — softest failure of the five, and nothing downstream
   needs a brief to exist.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { claudeAvailable, callClaude, parseJsonObject } = require("./claude");
const { admits } = require("./relevance");
const { tagArticle, topicSlug, subjectOf, TAXONOMY } = require("./taxonomy");

const ROOT = path.join(__dirname, "..");
const STORE = path.join(ROOT, "data", "companies-store.json");
const DB = path.join(ROOT, "data", "companies.json");

// Bump when the prompt changes so cached briefs are rewritten. A bump
// re-runs all fifteen topics — one call each, so the whole backfill is
// fifteen calls and needs no --limit.
const PROMPT_VERSION = 2;

/* Rewrite when the topic has grown to GROWTH times the count the brief
   was written from AND by at least MIN_GROWTH stories — whichever
   threshold is further out is the one that binds.

   The multiplier is the real rule: growth worth rewriting for is
   proportional, so the big hubs need many more stories to earn a
   rewrite than the small ones do. The floor exists only to stop a very
   small category thrashing, where a quarter of the count is a story or
   two — a brand-new hub at four stories would otherwise be rewritten at
   five. Nothing in the taxonomy is that small today (Cyber is the
   smallest at 55, so the multiplier binds everywhere), which is exactly
   why the floor is worth having before one is.

   At current counts Embedded next refreshes at 137 stories and Cyber at
   69 — on the order of a couple of months each. */
const GROWTH = 1.25;
const MIN_GROWTH = 8;

/* One topic per call, against profile.js's twelve companies. Each answer
   here is a sectioned article rather than two sentences and each question
   carries EVIDENCE_MAX headlines rather than twelve, so a chunk of even
   two would be a long enough reply to risk truncation — and a truncated
   reply is thrown away whole, taking the other topic with it. Fifteen
   calls is the entire cost of a full rebuild, so there is nothing to buy
   by batching. */
const EVIDENCE_MAX = 28;

/* Half the headline sample is the newest coverage and half is spread
   evenly across everything older. Newest-only is what profile.js wants
   — a company's recent news describes the company — but it is wrong
   here: the last 28 stories tagged Embedded describe six weeks of
   embedded insurance, and the brief is supposed to describe the
   subject. The spread is what lets the model say how the topic has
   moved rather than what happened lately. */
const RECENT_SHARE = 0.5;

const MAX_SUMMARY = 340;

/* One heading and one paragraph per section. Three sections is a
   complete explainer — what it is, how it works, what is happening —
   and four is the most this page can carry before the coverage list it
   introduces is pushed off the screen entirely.

   The paragraph floor is what makes a section worth a heading: under
   MIN_SECTION a heading introduces two sentences and the page reads as
   a form rather than an article. The ceiling is the same judgement the
   first version made at 520, loosened because a section now has a
   heading carrying part of its work.

   Together: roughly 400-600 words of prose, against ~250 before. */
const MIN_SECTIONS = 3;
const MAX_SECTIONS = 4;
const MIN_SECTION = 260;
const MAX_SECTION = 760;

/* Long enough for "How embedded insurance is actually sold", short
   enough that it cannot be a sentence with a claim in it. A heading is
   rendered as an h2 and is the part of this page most likely to be
   lifted into a search result on its own. */
const MAX_HEADING = 62;
const MIN_HEADING = 8;

/* Same budget and same reason as profile.js: the first sentence is used
   by itself as the meta description, a result cuts at ~158 characters,
   and a sentence that stops mid-clause on an ellipsis is both worse to
   read and likelier to be replaced by a snippet Google picks itself.

   Unlike profile.js this is *enforced*, not just requested. There, an
   over-long first sentence still degrades to a clamped paragraph and
   the summary earns its place on the page regardless. Here the opening
   sentence is doing a second job — it is the definition the whole page
   is pointed at, and descFromProfile() hands seo.js the raw summary
   when no sentence fits the budget, which head() then cuts at 158 with
   an ellipsis. A definition that stops at "rather than from…" is the
   one thing this page cannot afford to ship, so a brief whose lede
   overruns is declined and re-asked. */
const FIRST_SENTENCE_MAX = 155;

/* What the prompt actually asks for, well under the hard cap above.
   The first live run declined 3 of 14 on the lede guard, and the ten
   that passed came in at 141, 141, 143, 144, 144, 145, 145, 149, 134,
   116 — the model aims at whatever ceiling it is given, so a bare
   "at most 155" puts the whole distribution against the limit and
   everything that misjudges by a word is discarded. Asking for ~135
   moves the target, not the guard. */
const FIRST_SENTENCE_TARGET = 135;

/* How many times a declined topic is re-asked before it is left alone.

   profile.js needs no such counter: a profile refreshes whenever the
   company gains coverage, so a decline is naturally retried within days.
   A topic brief refreshes on material growth, which is months — so
   without this a single malformed reply would silently cost a hub its
   brief for a whole season, and a PROMPT_VERSION bump would be the only
   way to notice.

   Bounded rather than unconditional because the retry is per run and
   there are three runs a day: fourteen topics declining forever would
   otherwise be ~42 calls a day spent re-asking a question already
   answered. Three attempts is enough to clear a transient bad reply and
   cheap enough to stop worrying about. */
const MAX_TRIES = 3;

function buildPrompt(topic) {
  const companies = topic.companies.length
    ? `\nMost-covered companies in this category, busiest first:\n${topic.companies
        .map((c) => `  - ${c.name}`)
        .join("\n")}\n`
    : "";
  const related = topic.related.length
    ? `\nCategories these stories most often also fall under: ${topic.related.join(", ")}\n`
    : "";
  const headlines = topic.evidence.map((e) => `  - ${e}`).join("\n");

  return `You write the standing explainer that leads a topic page on an insurtech news archive.

The subject is ${JSON.stringify(topic.subject)}. Below your text, the page lists the ${topic.n} stories we hold on it. Your text is the top half of the page and answers "what is this, and what is actually happening in it" for a reader who arrived from a search engine and may know nothing about the subject.

Write it as a short reference article, not an introduction to a list.

Answer with:
  "known": true or false — see below
  "summary": 1-2 plain sentences, at most ${MAX_SUMMARY} characters total, present tense.
      The FIRST sentence must define ${JSON.stringify(topic.subject)} plainly for someone who has never heard of it and stand on its own, because it is used by itself as the page's search-result description. Aim for about ${FIRST_SENTENCE_TARGET} characters. It is DISCARDED if it exceeds ${FIRST_SENTENCE_MAX}, so leave yourself room — write the short version of the definition and put the qualifications in the second sentence.
  "sections": an array of ${MIN_SECTIONS}-${MAX_SECTIONS} objects, each with:
      "heading": ${MIN_HEADING}-${MAX_HEADING} characters, sentence case, no full stop. It is rendered as a real heading, so make it say what the section answers — "How a policy actually gets sold at checkout", "What makes it hard to underwrite", "Where the activity sits today". Write your own; do not reuse a generic set.
      "text": one paragraph, between ${MIN_SECTION} and ${MAX_SECTION} characters.
    The whole answer is discarded if there are too many sections or if any paragraph falls outside that range, so count before you answer.

    Cover this ground, in this order, one section each — merge or split as the subject needs:
      1. how it actually works — the mechanics, who the parties are, what changes hands, the vocabulary a reader will meet elsewhere
      2. why it matters in insurance now, and what the genuinely hard parts are
      3. what the coverage below shows: the kinds of companies active, how the activity has shifted over the period, which neighbouring subjects it keeps landing in
    A fourth is worth using when the subject has a real division inside it — the main varieties, the difference between two things readers confuse, or how it differs by market.

WHAT YOU MAY USE

For the definition and the mechanics, use your own knowledge of the insurance industry. Explain the concept properly — that is what this page is for, and no arrangement of headlines explains a concept.

For anything about who is active and how the activity has moved, use the evidence below and nothing else. The headline sample spans the whole period we have covered, oldest to newest, so it is a fair basis for saying how things have shifted.

WHAT YOU MUST NOT STATE — this is the important rule

No statistics, of any kind, from any source:
- no money: funding amounts, premium volumes, market sizes, valuations, revenue
- no percentages, multiples, or growth rates
- no years, dates, or "since 20XX"
- no counts: how many companies, how many deals, how many stories, how many policyholders

You do not have sourced figures for this subject, and this page has no table under it that would contradict a wrong one — which means nothing catches an invented statistic except a reader who already knew. Describe shape and direction in words instead: "most of the activity sits with brokers rather than carriers", "the emphasis has moved from distribution to claims". Those are things the evidence can actually support.

Naming a regulation or standard that happens to contain a digit is fine and often necessary — IFRS 17, PSD2, Solvency II. Those are names, not claims.

WHEN TO ANSWER known: false

Answer {"known": false} when you cannot explain the subject without guessing, or when the evidence is too thin to say anything about the activity that the headlines do not already say. A missing brief costs nothing — the page renders as it did before. This is a normal answer.

STYLE

Write like a reference work: plain, concrete, unhurried. No "leading", "innovative", "cutting-edge", "rapidly evolving", "game-changing", "in today's fast-paced world". Do not open with a rhetorical question. Do not describe the news coverage as coverage ("stories in this category show...") — describe the subject, and let the pattern speak. Do not address the reader as "you".

EVIDENCE
${companies}${related}
Headlines we hold, newest first then spread across the whole period:
${headlines}

Respond with ONLY a JSON object. No commentary. Example:
{"known": true, "summary": "Embedded insurance is cover sold inside another company's product or checkout, so the customer buys it from a retailer, bank or travel site rather than from an insurer.", "sections": [{"heading": "How a policy gets sold at checkout", "text": "The insurer or MGA supplies the underwriting and an API; the host brand supplies the customer and the moment of sale..."}, {"heading": "Why carriers want the distribution", "text": "For carriers the appeal is reach without acquisition spend..."}, {"heading": "Where the activity sits today", "text": "Most of it runs through intermediaries rather than balance-sheet carriers..."}]}`;
}

const MARKETING =
  /\b(?:leading|innovative|cutting[- ]edge|best[- ]in[- ]class|world[- ]class|revolutionis|revolutioniz|game[- ]chang|next[- ]generation|state[- ]of[- ]the[- ]art|rapidly evolving|fast[- ]paced|landscape of)/i;

/* The statistic shapes, rather than profile.js's bare /\d/ — see the
   header. Money with a symbol or a scale word, percentages in either
   spelling, four-digit years, and any bare number of three digits or
   more (which is what "700,000 policyholders" and "1.2 million users"
   collapse to once the scale words are covered). Two-digit numerals
   survive, which is deliberate: that is the range named standards live
   in (IFRS 17, PSD2) and it is too small to carry a market statistic. */
const STATISTIC = new RegExp(
  [
    "[$€£₹¥]\\s?\\d",
    "\\b\\d[\\d,.]*\\s?(?:million|billion|trillion|thousand|mn|bn|crore|lakh)\\b",
    "\\b\\d[\\d,.]*\\s?%",
    "\\b\\d[\\d,.]*\\s?per ?cent",
    "\\b(?:19|20)\\d{2}\\b",
    "\\b\\d[\\d,]{2,}\\b",
    "\\b\\d+x\\b",
  ].join("|"),
  "i"
);

/* Length of the first sentence, matched the same way descFromProfile()
   in seo.js matches it — a run up to the first ., ! or ? that is
   followed by a space or the end. Keep the two in step: this guard is
   only meaningful if it measures the sentence seo.js will actually
   lift. A summary with no sentence break at all measures whole, which
   is right — that is precisely the case that would be truncated. */
function ledeLength(summary) {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(summary);
  return (m ? m[0] : summary).trim().length;
}

function normalise(raw) {
  const base = { pv: PROMPT_VERSION };
  if (!raw || typeof raw !== "object" || raw.known !== true) return { known: false, ...base };

  const summary = String(raw.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length < 60 || summary.length > MAX_SUMMARY) return { known: false, ...base };
  if (ledeLength(summary) > FIRST_SENTENCE_MAX) return { known: false, reason: "lede", ...base };

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((s) => ({
      heading: String((s && s.heading) || "").replace(/\s+/g, " ").trim().replace(/[.:]$/, ""),
      text: String((s && s.text) || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.heading && s.text);
  if (sections.length < MIN_SECTIONS || sections.length > MAX_SECTIONS)
    return { known: false, reason: "shape", ...base };
  if (sections.some((s) => s.heading.length < MIN_HEADING || s.heading.length > MAX_HEADING))
    return { known: false, reason: "heading", ...base };
  if (sections.some((s) => s.text.length < MIN_SECTION || s.text.length > MAX_SECTION))
    return { known: false, reason: "shape", ...base };

  /* Headings are checked for duplication against each other because a
     repeated h2 is the one structural error a reader sees immediately,
     and the page already owns "Coverage" and the three fact labels — a
     brief heading colliding with one of those puts two identical h2s on
     the page with different content under them. */
  const taken = new Set(["coverage", "most active here", "often alongside", "reported by"]);
  const keys = sections.map((s) => s.heading.toLowerCase());
  if (keys.some((k, i) => taken.has(k) || keys.indexOf(k) !== i))
    return { known: false, reason: "heading", ...base };

  const all = [summary, ...sections.flatMap((s) => [s.heading, s.text])].join(" ");
  if (STATISTIC.test(all)) return { known: false, reason: "statistic", ...base };
  if (MARKETING.test(all)) return { known: false, reason: "marketing", ...base };

  return { known: true, summary, sections, ...base };
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/* The same view of the archive seo.js builds its hubs from — relevance
   gate re-applied on the way out (rule 3c-ii) and tags recomputed rather
   than trusted (rule 3d). Reimplementing either here would let the brief
   describe a set of stories the page below it does not contain. */
function storeArticles(store) {
  return Object.entries(store.seen || {})
    .map(([link, v]) => ({ link, ...v }))
    .filter((a) => a && a.title && a.publishedAt)
    .filter(admits)
    .map((a) => ({ ...a, tags: tagArticle(a.title + " " + (a.summary || "")) }));
}

/* Newest half, then an even spread across everything older. Sampling
   the tail evenly rather than taking the oldest N matters: the archive
   is denser at the recent end, so "oldest N" would hand over a cluster
   from one fortnight two years ago and call it history. */
function sampleEvidence(articles) {
  const seen = new Set();
  const uniq = [];
  for (const a of articles) {
    const title = String(a.title || "").trim();
    if (!title) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(a);
  }
  if (uniq.length <= EVIDENCE_MAX) return uniq.map(line);

  const recent = Math.round(EVIDENCE_MAX * RECENT_SHARE);
  const head = uniq.slice(0, recent);
  const tail = uniq.slice(recent);
  const want = EVIDENCE_MAX - recent;
  const step = tail.length / want;
  const spread = [];
  for (let i = 0; i < want; i++) spread.push(tail[Math.floor(i * step)]);
  return [...head, ...spread].filter(Boolean).map(line);
}

function line(a) {
  const extra = (a.summary || "").replace(/\s+/g, " ").trim().slice(0, 160);
  return extra ? `${a.title} — ${extra}` : a.title;
}

/* Topics as seo.js's collectTopics() sees them, plus the two structural
   facts a headline list does not carry: which companies dominate the
   category and which categories it co-occurs with. Both are already on
   the rendered page as badge lists, so handing them over costs nothing
   and stops the brief contradicting the block beside it. */
function collectTopics(store, db) {
  const arts = storeArticles(store);
  const by = new Map();
  for (const a of arts) {
    for (const t of a.tags || []) {
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(a);
    }
  }

  const order = new Map(TAXONOMY.map(([name], i) => [name, i]));
  return [...by.entries()]
    .map(([name, list]) => {
      const articles = list
        .slice()
        .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));

      const companies = (db.companies || [])
        .map((c) => {
          const hit = (c.topics || []).find((t) => t.name === name);
          return hit ? { name: c.name, n: hit.count || 0 } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
        .slice(0, 14);

      const co = new Map();
      for (const a of articles) {
        for (const t of a.tags || []) if (t !== name) co.set(t, (co.get(t) || 0) + 1);
      }
      const related = [...co.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([t]) => t);

      return {
        name,
        // What the page is titled and headlined with, and therefore what
        // the brief must define — "Embedded insurance", not "Embedded".
        subject: subjectOf(name),
        slug: topicSlug(name),
        n: articles.length,
        companies,
        related,
        evidence: sampleEvidence(articles),
      };
    })
    .filter((t) => t.slug && t.n)
    .sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
}

/* Does this topic need asking again?

   Three ways in: the prompt moved; the last answer was a decline and we
   have attempts left (MAX_TRIES — a decline must not be able to outlive
   the growth window); or the topic has grown materially since the brief
   was written (GROWTH / MIN_GROWTH). */
function stale(cached, n) {
  if (!cached || cached.pv !== PROMPT_VERSION) return true;
  if (!cached.known) return (cached.tries || 0) < MAX_TRIES;
  const was = cached.n || 0;
  return n >= Math.max(Math.ceil(was * GROWTH), was + MIN_GROWTH);
}

function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
  const only = (() => {
    const i = process.argv.indexOf("--topic");
    return i > -1 ? process.argv[i + 1] : null;
  })();
  /* Rewrite regardless of the growth window. Once the cache is full,
     `stale()` is false for months by design, which makes a manual run a
     no-op — fine for the scheduled step and useless for the dispatch
     button in topic-briefs.yml, whose whole purpose is "rewrite these
     now". Costs the full fourteen calls, which is the entire budget for
     this step anyway; pair it with --topic while iterating on a prompt. */
  const force = process.argv.includes("--force");

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
  store.topics = store.topics || {};

  if (!claudeAvailable()) {
    console.log("Topic briefs: no Claude credentials — keeping cache, hubs render without a brief.");
    return;
  }

  const topics = collectTopics(store, db);
  const need = topics.filter(
    (t) => (!only || t.slug === only) && (force || stale(store.topics[t.slug], t.n))
  );

  /* Busiest first. Unlike the taxonomy order the hubs are listed in,
     what matters for a bounded pass is which pages carry the most
     traffic and the most evidence — and on a prompt-iteration run those
     are the answers worth reading. */
  need.sort((a, b) => b.n - a.n);
  const batch = need.slice(0, limit);

  console.log(
    `Topic briefs: ${need.length} of ${topics.length} need writing` +
      `${force ? " (forced)" : ""}` +
      `${batch.length < need.length ? `, doing ${batch.length}` : ""}.`
  );
  if (!batch.length) { console.log("Nothing to do."); return; }

  let wrote = 0, declined = 0, failed = 0;
  for (const t of batch) {
    const parsed = parseJsonObject(callClaude(buildPrompt(t)));
    if (!parsed) {
      failed++;
      console.warn(`  ✗ ${t.name}: unparseable — hub keeps its previous brief`);
      continue;
    }
    const fresh = normalise(parsed);
    const prev = store.topics[t.slug];

    if (fresh.known) {
      // A good answer replaces whatever was there and clears the counter.
      store.topics[t.slug] = { ...fresh, n: t.n };
      wrote++;
      const words = [fresh.summary, ...fresh.sections.map((s) => s.text)]
        .join(" ")
        .split(/\s+/).length;
      console.log(
        `  ✓ ${t.subject} — ${fresh.sections.length} sections, ~${words} words (${t.n} stories)`
      );
      continue;
    }

    /* A decline must never take down a brief that is already published.
       Every refresh after the first is a *rewrite* of live prose, and
       roughly a quarter of answers decline — so overwriting on decline
       would mean a hub that has carried a good explainer for months
       silently loses it because one rewrite came back too long. That is
       rule 3b's downgrade guard, one level down: the fallback may not
       replace what has already shipped.

       So keep the published brief and take the new count with it, which
       resets the growth window — the hub simply carries slightly older
       prose until it next grows into a rewrite. `tries` is kept as a
       record of the failed attempt. Only a topic that has never had a
       brief caches the decline itself, which is what MAX_TRIES bounds. */
    declined++;
    const tries = ((prev || {}).tries || 0) + 1;
    if (prev && prev.known) {
      /* MAX_TRIES has to bound this path too, and only a version bump
         makes that visible. `stale()` asks about the prompt version
         first, so a kept brief still stamped with the *old* version is
         due for a rewrite on every run — and the try counter, which is
         only consulted for a topic that has never had a brief, never
         stops it. Under a single prompt version that is invisible;
         under a bump whose new shape an answer keeps missing it is
         fourteen calls a run, three runs a day, indefinitely.

         So after MAX_TRIES the kept brief takes the *current* version
         stamp: we asked at this version, we did not get an answer worth
         publishing, and we stop asking until the topic grows or the
         prompt moves again. The prose stays exactly as published — the
         stamp records which prompt last had a go at it, not what wrote
         it, and the shape is read from the entry rather than the
         version (topicBriefBlock() renders both). */
      const spent = tries >= MAX_TRIES;
      store.topics[t.slug] = { ...prev, n: t.n, tries, ...(spent ? { pv: PROMPT_VERSION } : {}) };
      console.log(
        `  – ${t.name}: rewrite declined${fresh.reason ? ` (${fresh.reason})` : ""}` +
          ` — keeping the published brief` +
          (spent ? ` (attempt ${tries} of ${MAX_TRIES} — no more rewrites at this prompt)` : "")
      );
    } else {
      store.topics[t.slug] = { ...fresh, n: t.n, tries };
      console.log(
        `  – ${t.name}: declined${fresh.reason ? ` (${fresh.reason})` : ""}` +
          ` — attempt ${tries} of ${MAX_TRIES}`
      );
    }
  }

  // Drop briefs for categories that no longer exist, so the cache can't
  // outlive the taxonomy — the same prune buildTopicPages() does on disk.
  const live = new Set(topics.map((t) => t.slug));
  for (const slug of Object.keys(store.topics)) {
    if (!live.has(slug)) delete store.topics[slug];
  }

  /* Every writer of this file names every key. companies.js,
     funding-extract.js and profile.js all carry `topics` through for the
     same reason this carries theirs — a write that names only its own
     keys silently truncates the others' caches (rule 3c-v). */
  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted || {},
    funding: store.funding || {},
    profiles: store.profiles || {},
    topics: store.topics,
    glossary: store.glossary || {},
    ma: store.ma || {},
  }, null, 2));

  const total = Object.values(store.topics).filter((t) => t.known).length;
  console.log(
    `Topic brief cache: +${wrote} written, ${declined} declined, ${failed} failed · ` +
      `${total} brief(s) of ${topics.length} topics.`
  );
}

if (require.main === module) main();

/* STATISTIC and MARKETING are exported for glossary-write.js, which
   guards the same kind of prose against the same two failures. Shared
   rather than copied for taxonomy.js's reason: two regexes with one
   job drift, and the drift is silent — the looser copy simply starts
   publishing what the stricter one rejects. */
module.exports = {
  normalise, buildPrompt, collectTopics, sampleEvidence, stale,
  STATISTIC, MARKETING, PROMPT_VERSION,
};
