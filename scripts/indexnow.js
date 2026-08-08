#!/usr/bin/env node
/* ============================================================
   IndexNow — tell the engines that support it which URLs a push
   just changed.

   Why this exists at all. Every page here is discovered by
   crawling: sitemap.xml lists ~925 URLs and then we wait. On a
   domain a few weeks old the crawl budget is the scarcest thing
   there is (rule 5a says the same about Google's JS-render pass),
   so a brief published at 08:00 CT may not be looked at for days,
   and by then it is not news. IndexNow inverts that — the site
   states what changed, at push time, and the engine fetches it
   instead of scheduling a guess.

   What it does NOT do: Google does not participate. This reaches
   Bing, Yandex, Seznam and Naver, which sounds like a consolation
   prize and is not one — Bing indexes a young domain far faster
   than Google does, and it is what DuckDuckGo and the assistant
   surfaces answer from. The evergreen pages built for questions
   rather than news (rule 3e's glossary, rule 3d-i's hubs) are
   exactly the queries those surfaces get asked.

   Six rules:
   • The changed set comes from `git diff`, never from the
     filesystem. seo.js rewrites all ~1,400 pages every run and
     git is the only thing here that knows which of them actually
     differ. Submitting unchanged URLs is what gets a host's
     submissions discounted, so the honest set is also the
     effective one.
   • It maps files to URLs through the same shape seo.js writes
     them in — <dir>/index.html is /<dir>/ — and submits nothing
     it cannot map. Transports (sitemap.xml, feed.xml, the funding
     feed, the CSV/JSON downloads) are excluded: they are not pages
     to index, which is rules 3h and 3i's reason for keeping them
     out of the sitemap, and several of them are dirty on every
     build regardless.
   • company.html is excluded for the reason it is excluded from
     SOCIAL_PAGES and FOOTLINK_PAGES — a noindex redirect shim
     titled "Redirecting…" should not be announced to anybody.
   • Deletions are submitted, deliberately. A pruned company page
     (buildCompanyPages) should be recrawled and found gone; that
     is what the protocol is for, and leaving it out means the
     engine keeps a dead URL until it re-crawls on its own.
   • The key is discovered from the root, not hardcoded here. The
     file at /<key>.txt IS the credential — it proves control of
     the host — so rotating it is swapping one committed file, and
     a fork that removes it gets a clean skip rather than a run
     that submits somebody else's URLs under our key.
   • It submits to ONE endpoint, walking ENDPOINTS until one accepts.
     The protocol has participants share what they receive, so a
     second POST of the same list buys nothing. The aggregator is
     first and currently refuses this host — see ENDPOINTS below for
     the evidence and for why it is still first.
   • It fails soft, always. This runs after the push has already
     succeeded; the site is live either way, and a search-engine
     ping that 500s must not turn a good publish into a red run.
     It says so loudly in the log instead — which is exactly how a
     chronic 403 went unnoticed for as long as this file existed, so
     the log now names every endpoint it fell past even on success.

   Usage:
     node scripts/indexnow.js                # HEAD~1..HEAD
     node scripts/indexnow.js --since <ref>  # <ref>..HEAD
     node scripts/indexnow.js --dry-run      # print, submit nothing
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ORIGIN = (process.env.SITE_URL || "https://insurtechdaily.io").replace(/\/+$/, "");

/* ── The endpoints, in preference order ────────────────────────
   ONE endpoint is submitted to, not all of them: the protocol has
   participants share what they receive, so a second POST of the same
   list is redundant at best and looks like duplicate submission at
   worst. This is a ladder — first 2xx wins and the rest are never
   called — in the shape write-brief.js's model ladder already uses.

   It exists because the aggregator refuses this host. Every run from
   at least 2026-08-06 to 2026-08-08 came back

     403 {"errorCode":"UserForbiddedToAccessSite"}

   from api.indexnow.org AND from www.bing.com/indexnow, while Yandex
   accepted the byte-identical payload with a 202. So the credential is
   sound — the key file is live at the root, returns 200 and contains
   exactly its own name — and the refusal is Bing's alone, almost
   certainly because the host is not verified in Bing Webmaster Tools
   (which is separate from Search Console).

   The failure was invisible for the reason the fail-soft rule below
   makes it invisible: the step stays green and only the log says
   otherwise, so a mechanism written to shorten crawl wait on a young
   domain submitted nothing for as long as it has existed.

   THE AGGREGATOR STAYS FIRST, and that is the point of ordering rather
   than replacing. It reaches every participant in one call, so it is
   the right target the moment it works; leaving it at the head means
   the day Bing verification lands this file needs no edit and quietly
   goes back to the better route. Until then it costs one failed
   request per push, which is nothing against a push that has already
   rebuilt ~1,400 pages.

   A network error advances the ladder too, not just a refusal — one
   2026-08-08 run died on `fetch failed` reaching the aggregator, which
   a second endpoint would have survived. */
const ENDPOINTS = [
  "https://api.indexnow.org/indexnow",
  "https://yandex.com/indexnow",
  "https://www.bing.com/indexnow",
];

/* The protocol's own ceiling per request. Nothing here approaches it —
   a full-site rebuild is ~1,400 pages — but a run that somehow exceeded
   it would be rejected whole rather than truncated, so cap and say so. */
const MAX_URLS = 10000;

/* The key file is a bare hex string, 8–128 chars, named for its own
   contents. robots.txt and CNAME can't collide with that shape. */
const KEY_FILE = /^[a-f0-9]{8,128}\.txt$/i;

/* Files that are not pages. The transports are rules 3h/3i's "a sitemap
   lists pages to index, these are downloads", applied to the same
   question one layer along. */
const SKIP_FILES = new Set([
  "sitemap.xml",
  "robots.txt",
  "feed.xml",
  "funding-feed.xml",
  "funding.csv",
  "funding.json",
  "company.html", // the noindex redirect shim
  "CNAME",
]);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/* The key is whatever hex .txt sits at the root. Zero of them means this
   site has not been enrolled and we skip; two means somebody left an old
   one behind mid-rotation, and guessing which is live would submit under
   a key the engine may already have retired. */
function findKey() {
  const hits = fs.readdirSync(ROOT).filter((f) => KEY_FILE.test(f));
  if (hits.length !== 1) return { hits };
  const file = hits[0];
  const key = fs.readFileSync(path.join(ROOT, file), "utf8").trim();
  // The filename is derived from the contents; if they disagree, the
  // engine fetches /<name>.txt, reads a different string and rejects
  // every URL in the batch.
  if (key !== path.basename(file, ".txt")) return { hits, mismatch: file };
  return { key, file };
}

/* One repo path → one URL, or null for something that is not a page.
   Mirrors how seo.js lays pages out; a path shape it does not recognise
   is skipped rather than guessed at. */
function toUrl(file) {
  if (file.startsWith("data/") || file.startsWith("scripts/") || file.startsWith(".")) return null;
  if (file.startsWith("assets/")) return null;
  if (SKIP_FILES.has(file)) return null;
  if (KEY_FILE.test(file)) return null;
  if (!file.endsWith(".html")) return null;

  if (file === "index.html") return ORIGIN + "/";
  if (file.endsWith("/index.html")) return ORIGIN + "/" + file.slice(0, -"index.html".length);
  // A hand-authored page at the root, e.g. companies.html.
  if (!file.includes("/")) return ORIGIN + "/" + file;
  return null;
}

function changedUrls(since) {
  const range = since ? `${since}..HEAD` : "HEAD~1..HEAD";
  let files;
  try {
    // A first commit has no parent, so HEAD~1 does not resolve — there
    // is nothing to diff against and nothing sensible to submit.
    files = git(["diff", "--name-only", range]).split("\n").filter(Boolean);
  } catch (err) {
    console.log(`IndexNow: cannot diff ${range} — ${err.message.split("\n")[0]}`);
    return [];
  }
  const urls = new Set();
  for (const f of files) {
    const u = toUrl(f);
    if (u) urls.add(u);
  }
  return [...urls];
}

async function submit(endpoint, key, file, urlList) {
  const body = {
    host: new URL(ORIGIN).host,
    key,
    keyLocation: `${ORIGIN}/${file}`,
    urlList,
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text().catch(() => "")).slice(0, 300) };
}

/* 200 accepted; 202 accepted with the key still being validated — both
   are successes and the second is normal on a first submission. */
const accepted = (status) => status === 200 || status === 202;

/* Walk the ladder, stopping at the first endpoint that accepts. Returns
   the endpoint that took it, or null with every attempt for the log —
   a run that reached nobody should say what each one said rather than
   only the last, since "403 then fetch failed" and "403 then 403" are
   different problems. */
async function submitSomewhere(key, file, urls) {
  const tried = [];
  for (const endpoint of ENDPOINTS) {
    const host = new URL(endpoint).host;
    try {
      const { status, text } = await submit(endpoint, key, file, urls);
      if (accepted(status)) return { endpoint: host, status, tried };
      tried.push(`${host} HTTP ${status}${text ? ` ${text}` : ""}`);
    } catch (err) {
      tried.push(`${host} ${err.message}`);
    }
  }
  return { endpoint: null, tried };
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry-run");
  const sinceAt = argv.indexOf("--since");
  const since = sinceAt >= 0 ? argv[sinceAt + 1] : null;

  const { key, file, hits, mismatch } = findKey();
  if (!key) {
    if (mismatch) console.log(`IndexNow: ${mismatch} does not contain its own name — not submitting.`);
    else if (hits && hits.length > 1) console.log(`IndexNow: ${hits.length} key files at root (${hits.join(", ")}) — not submitting.`);
    else console.log("IndexNow: no key file at the site root — skipping.");
    return;
  }

  let urls = changedUrls(since);
  if (!urls.length) {
    console.log("IndexNow: no changed pages in this commit.");
    return;
  }
  if (urls.length > MAX_URLS) {
    console.log(`IndexNow: ${urls.length} changed pages, submitting the first ${MAX_URLS}.`);
    urls = urls.slice(0, MAX_URLS);
  }

  if (dry) {
    console.log(
      `IndexNow (dry run): would submit ${urls.length} URL(s) with key ${file}, ` +
        `trying ${ENDPOINTS.map((e) => new URL(e).host).join(" → ")}`
    );
    for (const u of urls.slice(0, 20)) console.log("  " + u);
    if (urls.length > 20) console.log(`  … and ${urls.length - 20} more`);
    return;
  }

  const { endpoint, status, tried } = await submitSomewhere(key, file, urls);
  if (endpoint) {
    console.log(`IndexNow: submitted ${urls.length} URL(s) to ${endpoint} — HTTP ${status}.`);
    // Name what was skipped rather than swallowing it. A run that had to
    // fall past the aggregator still worked, but it is also the only
    // evidence that the aggregator is still refusing the host, and that
    // is a thing worth being able to see from a green step.
    for (const t of tried) console.log(`  (fell past ${t})`);
  } else {
    console.log(`IndexNow: no endpoint accepted ${urls.length} URL(s).`);
    for (const t of tried) console.log(`  ${t}`);
  }
}

/* Guarded, like every other entry point here. Without this, merely
   requiring the file — a test, a future caller wanting toUrl() —
   submits whatever the last commit touched, which is a side effect no
   import should have and exactly the mistake that found this line. */
if (require.main === module) {
  // Fail soft, always: the push has already happened and the site is live.
  main().catch((err) => console.log(`IndexNow: ${err.message}`));
}

module.exports = { toUrl, changedUrls, findKey };
