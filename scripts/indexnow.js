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
   • It fails soft, always. This runs after the push has already
     succeeded; the site is live either way, and a search-engine
     ping that 500s must not turn a good publish into a red run.
     It says so loudly in the log instead.

   Usage:
     node scripts/indexnow.js                # HEAD~1..HEAD
     node scripts/indexnow.js --since <ref>  # <ref>..HEAD
     node scripts/indexnow.js --dry-run      # print, submit nothing
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENDPOINT = "https://api.indexnow.org/indexnow";
const ORIGIN = (process.env.SITE_URL || "https://insurtechdaily.io").replace(/\/+$/, "");

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

async function submit(key, file, urlList) {
  const body = {
    host: new URL(ORIGIN).host,
    key,
    keyLocation: `${ORIGIN}/${file}`,
    urlList,
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text().catch(() => "")).slice(0, 300) };
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
    console.log(`IndexNow (dry run): would submit ${urls.length} URL(s) with key ${file}`);
    for (const u of urls.slice(0, 20)) console.log("  " + u);
    if (urls.length > 20) console.log(`  … and ${urls.length - 20} more`);
    return;
  }

  try {
    const { status, text } = await submit(key, file, urls);
    // 200 accepted; 202 accepted with the key still being validated —
    // both are successes and the second is normal on the first ever run.
    if (status === 200 || status === 202) {
      console.log(`IndexNow: submitted ${urls.length} URL(s) — HTTP ${status}.`);
    } else {
      console.log(`IndexNow: submission refused — HTTP ${status}. ${text}`);
    }
  } catch (err) {
    console.log(`IndexNow: submission failed — ${err.message}`);
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
