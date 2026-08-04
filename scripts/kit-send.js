#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   The brief, by email (rule 10)

   Posts the day's brief to Kit as a broadcast, so the one thing on
   this site nobody else wrote reaches people who asked for it
   instead of waiting to be found. Everything else here is discovered
   by search or by feed; this is the only channel that compounds
   without depending on a crawler, which is rule 9's argument about
   crawl budget applied to the audience rather than the index.

   It runs LAST in news.yml, after the push and after the IndexNow
   ping, for the reason rule 3c-v gives about ordering the Claude
   steps: the site is already live by here, so a failure costs an
   email and nothing else. The order also matters in the other
   direction — the email links to /brief/<date>/, so the page has to
   exist before the mail goes out. Sending before the push would
   deliver a link to a 404 the moment a subscriber is quick.

   Six rules:

   • ONLY CLAUDE'S BRIEFS ARE SENT. This falls out of rule 3b for
     free: briefs.json holds only prose Claude wrote, so a day that
     fell back to the deterministic brief has no entry and mails
     nothing. When brief-retry.yml later lands a real one, that run
     sends it. A fallback therefore costs a late email, never a
     stand-in one — the same trade rule 3b makes for the archive.

   • KIT IS THE RECORD OF WHAT WAS SENT, not a local file. The
     obvious design stamps `emailed` onto the brief entry, and it is
     broken here: this step runs AFTER news.yml's commit, so the
     stamp is left dirty in the runner and never pushed (the same
     failure rule 3e describes for a directory missing from the
     pathspec), and the next run mails the identical brief to every
     subscriber. So `description` on the broadcast carries
     `<TAG>-<date>` and alreadySent() looks for it. The record then
     lives in the same system as the thing it records, which means it
     survives a failed push, a re-run, a restored backup and a
     checkout on a different machine.

   • ONLY THE NEWEST BRIEF IS EVER A CANDIDATE. Not "every unsent
     brief" — that reads a ten-entry archive on first run and mails
     ten times. A brief nobody emailed on the day is not news the
     next day, and the archive is on the site for anyone who wants it.

   • public: false. Kit will happily publish a broadcast to its own
     web feed and creator profile, which would put a second copy of
     the brief on kit.com competing with /brief/<date>/ for the same
     query. That is exactly the duplication collectMonths() and
     PERIOD_DEAL_CAP exist to prevent (rule 3c-i), one domain over.

   • THE MAIL CARRIES LINKS HOME, and more than one. Rule 3h's
     design decision for feed.xml applies unchanged: the point of
     syndicating our own writing is the return path. The brief page,
     the wire and the tracker are all one tap from the bottom of
     every send.

   • FAILURE IS ORDINARY AND SOFT. No key, a rate limit, a 500: it
     logs and exits 0. The push already succeeded and the site is
     live, so an email that didn't go must not turn a good publish
     into a red run — rule 9's last rule, for the same reason.

   Local check:
     node scripts/kit-send.js --dry-run
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ORIGIN = (process.env.SITE_URL || "https://insurtechdaily.io").replace(/\/$/, "");

const API = "https://api.kit.com/v4";
const KEY = process.env.KIT_API_KEY || "";

/* The idempotency key. Kit's `description` is an internal label — it
   is never shown to a subscriber — so it is free to carry this. */
const TAG = "insurtech-daily-brief";

/* Kit rejects a send scheduled in the past, and "now" is in the past
   by the time the request lands. Two minutes is effectively immediate
   and never trips that. */
const SEND_DELAY_MIN = 2;

const escHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function loadBriefs() {
  const p = path.join(ROOT, "data", "briefs.json");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : raw.briefs;
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.log(`Kit: could not read briefs.json — ${err.message}`);
    return [];
  }
}

/* The newest brief by Central date (rule 3b-ii stamps `date`, so no
   timezone arithmetic belongs here). Only Claude's writing is in this
   file at all, but the `by` test is kept explicit so a future writer
   of briefs.json can't quietly widen what gets mailed. */
function newestBrief(briefs) {
  return briefs
    .filter((b) => b && b.date && b.headline && b.by === "claude")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
}

async function kit(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Kit-Api-Key": KEY,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* Kit returned something that isn't JSON — keep the raw text for
       the log rather than throwing a parse error over the real one. */
  }
  return { ok: res.ok, status: res.status, body, text };
}

/* Ask Kit whether this date already went out. One page is plenty:
   broadcasts come back newest first and this runs at most three times
   a day, so a brief sent today is never 50 broadcasts deep. */
async function alreadySent(date) {
  const { ok, status, body, text } = await kit("/broadcasts?per_page=50");
  if (!ok) {
    throw new Error(`could not list broadcasts — HTTP ${status} ${text.slice(0, 200)}`);
  }
  const want = `${TAG}-${date}`;
  const hit = (body?.broadcasts || []).find((b) => b && b.description === want);
  return hit || null;
}

/* Kit wraps this in the account's template, so it wants article
   markup and not a document: no <html>, no <style>, nothing that
   assumes a stylesheet survives the trip into a mail client. */
function emailHtml(b) {
  const briefUrl = `${ORIGIN}/brief/${b.date}/`;
  const parts = [];

  if (b.teaser) parts.push(`<p><em>${escHtml(b.teaser)}</em></p>`);
  parts.push(`<h2>What's happening</h2>`, `<p>${escHtml(b.whatsHappening)}</p>`);
  if (b.whyItMatters) {
    parts.push(`<h2>Why it matters</h2>`, `<p>${escHtml(b.whyItMatters)}</p>`);
  }

  parts.push(
    `<p><a href="${escHtml(briefUrl)}"><strong>Read this brief on Insurtech Daily &rarr;</strong></a></p>`,
    `<hr />`
  );

  const counts =
    b.storyCount && b.sourceCount
      ? `Written from ${b.storyCount} stories across ${b.sourceCount} sources. `
      : "";

  parts.push(
    `<p><small>${escHtml(counts)}` +
      `<a href="${escHtml(ORIGIN)}/">The wire</a> &middot; ` +
      `<a href="${escHtml(ORIGIN)}/funding/">Funding tracker</a> &middot; ` +
      `<a href="${escHtml(ORIGIN)}/brief/">Brief archive</a></small></p>`
  );

  return parts.join("\n");
}

function broadcastPayload(b) {
  const sendAt = new Date(Date.now() + SEND_DELAY_MIN * 60 * 1000).toISOString();
  return {
    subject: b.headline,
    preview_text: b.teaser || "",
    /* Internal label, and the idempotency key alreadySent() reads. */
    description: `${TAG}-${b.date}`,
    content: emailHtml(b),
    /* Never published to Kit's web feed — see the header. */
    public: false,
    published_at: b.generatedAt || new Date().toISOString(),
    send_at: sendAt,
    /* "If nothing is provided, will default to all of your
       subscribers" — the field is required, so an empty array is how
       you provide nothing. */
    subscriber_filter: [],
  };
}

async function main() {
  const dry = process.argv.includes("--dry-run");

  if (!KEY && !dry) {
    console.log("Kit: no KIT_API_KEY set — skipping the email.");
    return;
  }

  const brief = newestBrief(loadBriefs());
  if (!brief) {
    console.log("Kit: no Claude-written brief to send.");
    return;
  }

  const payload = broadcastPayload(brief);

  if (dry) {
    console.log(`Kit (dry run): would send "${brief.headline}" for ${brief.date}`);
    console.log(`  description : ${payload.description}`);
    console.log(`  send_at     : ${payload.send_at}`);
    console.log(`  preview     : ${payload.preview_text}`);
    console.log("  ── content ──");
    console.log(payload.content);
    return;
  }

  const sent = await alreadySent(brief.date);
  if (sent) {
    console.log(`Kit: brief for ${brief.date} already sent (broadcast ${sent.id}).`);
    return;
  }

  const { ok, status, body, text } = await kit("/broadcasts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!ok) {
    console.log(`Kit: broadcast refused — HTTP ${status}. ${text.slice(0, 400)}`);
    return;
  }

  const id = body?.broadcast?.id ?? body?.id ?? "?";
  console.log(`Kit: queued brief for ${brief.date} — broadcast ${id}, sending ${payload.send_at}.`);
}

/* Guarded like every other entry point here (rule 9): without it,
   merely requiring this file mails the newsletter. */
if (require.main === module) {
  main().catch((err) => console.log(`Kit: ${err.message}`));
}

module.exports = { emailHtml, newestBrief, broadcastPayload, TAG };
