#!/usr/bin/env node
/* ============================================================
   One-time historical backfill
   ------------------------------------------------------------
   The wire only ever sees what an RSS feed is currently serving, so the
   archive starts the day the site does. Everything derived from it starts
   empty with it: the funding tracker had 7 rows, month pages did not exist
   (they need two months), and 121 of 178 companies sat on a single story,
   below the 3 that make a company page indexable.

   Google News' search feed honours `after:` / `before:`, so the same
   searches the wire already runs can be replayed over past months. This
   walks them backwards a month at a time and folds what it finds into
   data/companies-store.json.

   Why this is a script you run by hand and not a workflow step:

   • It writes ONLY `store.seen`. That is deliberate and it is what keeps
     the backfill free. seo.js reads `seen` (via storeArticles), so the
     topic hubs, the funding tracker and the month pages all deepen on the
     next `node scripts/seo.js` with no model calls at all. companies.js
     builds its index from `store.extracted`, and its work list comes from
     the current news.json plus stale entries already IN `extracted` — it
     never walks `seen` looking for gaps. So a seen-only backfill is
     invisible to the scheduled run and cannot blow the shared budget.

   • Company attribution therefore needs the opt-in `--extract` pass below,
     which is metered and bounded by --limit so it can be run in stages.

   Usage:
     node scripts/backfill.js --months 24            # fetch + store (free)
     node scripts/backfill.js --months 24 --dry-run  # report, write nothing
     node scripts/backfill.js --extract --limit 200  # attribute companies
   ============================================================ */

const fs = require("fs");
const path = require("path");

// The feed list and the parser come from the wire, never a second copy:
// the "Headline - Publisher" split, the summary-is-just-the-headline test
// and the native flag all have to mean the same thing here as there.
const { FEEDS, parseFeedXml } = require("./fetch-news");
const { admits } = require("./relevance");
const { tagArticle } = require("./taxonomy");
const { claudeAvailable } = require("./claude");

const STORE = path.join(__dirname, "..", "data", "companies-store.json");
const DB = path.join(__dirname, "..", "data", "companies.json");

const UA = "Mozilla/5.0 (compatible; InsurtechAggregator/1.0)";
const THROTTLE_MS = 1500;   // between requests — this is ~120 of them
const RETRIES = 3;

/* ---------- args ---------- */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const has = (name) => process.argv.includes(`--${name}`);

/* ---------- month windows ---------- */

/* Inclusive-exclusive [after, before) pairs, newest first. Google News
   reads both as plain dates, so no timezone care is needed — a window that
   is a few hours off at the seam just means an article is offered by two
   adjacent queries, and the dedupe below collapses it. */
function monthWindows(count) {
  const out = [];
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  for (let i = 0; i < count; i++) {
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 1));
    out.push({
      after: start.toISOString().slice(0, 10),
      before: end.toISOString().slice(0, 10),
      label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    });
    if (--m < 0) { m = 11; y--; }
  }
  return out;
}

/* ---------- the searches to replay ---------- */

/* Only the Google News entries: they are searches, so they take date
   operators. A publisher's own WordPress feed serves its most recent ~20
   posts and has no way to ask for March 2025 — replaying those would just
   re-fetch what the wire already has. */
function googleNewsFeeds() {
  return FEEDS.filter((f) => f.url.includes("news.google.com"));
}

function datedUrl(feedUrl, win) {
  const u = new URL(feedUrl);
  const q = u.searchParams.get("q") || "";
  u.searchParams.set("q", `${q} after:${win.after} before:${win.before}`);
  return u.toString();
}

/* ---------- fetch with backoff ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === RETRIES) throw err;
      // Google News rate-limits a long walk; back off rather than losing
      // the month, which would leave a silent hole in the archive.
      await sleep(THROTTLE_MS * Math.pow(3, attempt));
    } finally {
      clearTimeout(t);
    }
  }
}

/* ---------- dedupe against what is already stored ---------- */

/* The store is keyed by link, but the same story reaches it under two
   different links: a news.google.com redirect from the search feed, and
   the publisher's own URL from their RSS. Keying alone would file both and
   put the story on a topic hub twice and in a company's list twice. Match
   on the headline as well, with the wire's own loose normalisation. */
function titleKey(title = "") {
  return title.toLowerCase()
    .replace(/[il]/g, "1").replace(/o/g, "0")
    .replace(/[^a-z0-9]+/g, "").trim();
}

/* ---------- the backfill ---------- */

async function backfill() {
  const months = Number(arg("months", 24));
  const dry = has("dry-run");
  const feeds = googleNewsFeeds();
  const windows = monthWindows(months);

  const store = fs.existsSync(STORE)
    ? JSON.parse(fs.readFileSync(STORE, "utf8"))
    : { seen: {}, extracted: {} };
  store.seen = store.seen || {};
  store.extracted = store.extracted || {};

  const before = Object.keys(store.seen).length;
  const known = new Set(Object.values(store.seen).map((v) => titleKey(v.title)));

  console.log(`Backfilling ${months} month(s) × ${feeds.length} search(es) = ${months * feeds.length} requests.`);
  console.log(`Store holds ${before} article(s) before this run.\n`);

  let added = 0, dupes = 0, offTopic = 0, failed = 0;

  for (const win of windows) {
    let monthAdded = 0;
    for (const feed of feeds) {
      const url = datedUrl(feed.url, win);
      let xml;
      try {
        xml = await fetchWithRetry(url);
      } catch (err) {
        console.warn(`  ✗ ${win.label} ${feed.url.slice(40, 70)} → ${err.message}`);
        failed++;
        await sleep(THROTTLE_MS);
        continue;
      }

      // Same parser as the wire, so admission (native → onTopic) and the
      // headline/source cleanup are identical to a live run.
      const items = parseFeedXml(xml, { ...feed, url });

      for (const a of items) {
        // Re-apply the store's own gate. parseFeedXml already applied the
        // feed's admission rule; admits() is what every *reader* of the
        // store applies, and an entry that cannot survive it would be
        // dead weight that seo.js filters out on every future build.
        if (!admits({ title: a.title, summary: a.summary, native: a.native })) { offTopic++; continue; }

        const tk = titleKey(a.title);
        if (store.seen[a.link] || known.has(tk)) { dupes++; continue; }
        known.add(tk);

        store.seen[a.link] = {
          title: a.title,
          source: a.source,
          publishedAt: a.publishedAt,
          tags: tagArticle(a.title + " " + (a.summary || "")),
          summary: a.summary || "",
          ...(a.native ? { native: true } : {}),
        };
        added++; monthAdded++;
      }
      await sleep(THROTTLE_MS);
    }
    console.log(`  ${win.label}  +${monthAdded}`);
  }

  console.log(`\nAdded ${added} · skipped ${dupes} duplicate · ${offTopic} off-topic · ${failed} request(s) failed.`);

  if (dry) {
    console.log("\n--dry-run — nothing written.");
    return;
  }
  if (!added) {
    console.log("\nNothing new — store untouched.");
    return;
  }

  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted,
  }, null, 2));

  console.log(`Wrote data/companies-store.json — ${Object.keys(store.seen).length} article(s).`);
  console.log("\nNext: node scripts/seo.js   (rebuilds the tracker, month pages and hubs — no model calls)");
  console.log("Then, to attribute companies: node scripts/backfill.js --extract --limit 200");
}

/* ---------- opt-in company attribution ---------- */

/* Metered, so it is separate, bounded and never runs from the workflow.

   It writes `by: "claude"` + the current PROMPT_VERSION, which matters more
   than it looks: companies.js re-extracts any stored entry whose `by` is
   not "claude" or whose `pv` is stale. Filling these in heuristically
   would hand the next scheduled run a work list of every backfilled
   article at once — the exact budget blowout this file exists to avoid.
   So if Claude is not available, this refuses rather than falling back. */
async function extractPass() {
  const { extractWithClaude, canonicalName, slugify } = require("./companies");
  const { PROMPT_VERSION } = require("./companies");

  /* claudeAvailable() tests for the env vars the workflow injects. A local
     shell usually has neither, even with the CLI installed and logged in for
     interactive use — `claude -p` in a subprocess is a separate session and
     answers "Not logged in". So say what the options actually are rather
     than naming two variables and leaving the reader to guess. */
  if (!claudeAvailable()) {
    console.error(
      "No Claude credentials in this environment.\n\n" +
      "This pass costs model calls, so it will not guess. Pick one:\n" +
      "  • Run it in Actions — the repo already has the secret:\n" +
      "      gh workflow run backfill.yml -f months=0 -f limit=200\n" +
      "  • Or export CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) and re-run.\n" +
      "  • Or export ANTHROPIC_API_KEY for the metered quota.\n\n" +
      "Refusing to write heuristic entries instead: companies.js treats any\n" +
      "non-Claude entry as stale, so the next scheduled run would try to\n" +
      "re-extract the whole backfill at once."
    );
    process.exit(1);
  }

  const limit = Number(arg("limit", 200));
  const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
  store.extracted = store.extracted || {};

  const pending = Object.entries(store.seen)
    .filter(([link]) => !store.extracted[link])
    // Oldest first is arbitrary; newest first means a partial run improves
    // the pages most likely to be linked to soonest.
    .sort((a, b) => new Date(b[1].publishedAt) - new Date(a[1].publishedAt))
    .slice(0, limit)
    .map(([link, m]) => ({ title: m.title, link, source: m.source }));

  const total = Object.keys(store.seen).filter((l) => !store.extracted[l]).length;
  if (!pending.length) { console.log("Nothing to extract — every stored article has companies."); return; }

  console.log(`Extracting ${pending.length} of ${total} unattributed article(s)…`);

  const knownNames = (JSON.parse(fs.readFileSync(DB, "utf8")).companies || []).map((c) => c.name);
  // Outlets are never the actor company — same exclusion companies.js uses.
  const exclude = new Set(Object.values(store.seen).map((m) => slugify(m.source)));

  const res = extractWithClaude(pending, knownNames, exclude);
  if (!res) { console.error("Extraction failed outright — store untouched."); process.exit(1); }

  let written = 0;
  for (const a of pending) {
    const names = res[a.link];
    if (!names) continue;   // leave it pending rather than filing a heuristic guess
    store.extracted[a.link] = { names: names.map(canonicalName), by: "claude", pv: PROMPT_VERSION };
    written++;
  }

  fs.writeFileSync(STORE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    seen: store.seen,
    extracted: store.extracted,
  }, null, 2));

  const left = total - written;
  console.log(`Wrote ${written} extraction(s). ${left} still unattributed.`);
  if (left) console.log(`Run again to continue: node scripts/backfill.js --extract --limit ${limit}`);
  console.log("\nThen: node scripts/companies.js && node scripts/seo.js");
}

/* ---------- main ---------- */

(async () => {
  if (has("extract")) await extractPass();
  else await backfill();
})().catch((err) => { console.error(err); process.exit(1); });
