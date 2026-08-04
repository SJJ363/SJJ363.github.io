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

/* Escapes, then forces the result to pure ASCII by turning every
   non-ASCII code point into a numeric entity.
   The second half matters more than it looks. Trade headlines are
   full of curly quotes, em dashes and accented company names —
   "It's How We've Always Done It", Münchener, Peña — and unlike a
   browser, a mail client that guesses the wrong charset has no
   <meta> to correct it and renders them as â€œ mojibake. Entities
   carry no charset dependency at all, so they survive whatever the
   client decides. The /u flag makes the class match whole code
   points, so an astral character (an emoji in a headline) encodes as
   one entity rather than two broken surrogate halves. */
const escHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[^\x20-\x7E\n\t]/gu, (c) => `&#${c.codePointAt(0)};`);

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

/* The wire's own thread grouping, imported rather than reimplemented
   (rule 5a): re-reports of one story must collapse here exactly as
   they do on the homepage, or the email advertises five "stories"
   that are one story five outlets ran. seo.js is guarded by
   require.main, so importing it builds nothing. */
function topStories(n = WIRE_ITEMS) {
  let wireThreads;
  try {
    ({ wireThreads } = require("./seo.js"));
  } catch (err) {
    console.log(`Kit: wire section skipped — ${err.message}`);
    return [];
  }

  const p = path.join(ROOT, "data", "news.json");
  if (!fs.existsSync(p)) return [];
  let articles = [];
  try {
    articles = JSON.parse(fs.readFileSync(p, "utf8")).articles || [];
  } catch (err) {
    console.log(`Kit: could not read news.json — ${err.message}`);
    return [];
  }

  /* Widen until something is there, the way wireLead() does: a quiet
     night must still produce a section rather than an empty heading. */
  const now = Date.now();
  let pool = [];
  for (const hours of [24, 48, 72]) {
    pool = articles.filter((a) => a.timestamp && now - a.timestamp <= hours * 3.6e6);
    if (pool.length >= n) break;
  }
  if (!pool.length) pool = articles;

  return wireThreads(pool)
    .map((g) => g.head)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, n);
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

/* ── Styling ──────────────────────────────────────────────────
   Kit wraps this in the account's template, so it wants article
   markup and not a document: no <html>, no <style>. Mail clients
   strip <style> blocks (and Gmail strips @font-face), so everything
   here is INLINE and every font is a stack that resolves on the
   recipient's machine — Georgia standing in for Newsreader and
   Helvetica for Libre Franklin, which is exactly what style.css
   already falls back to. The palette is style.css's :root, with the
   rule colour flattened from rgba onto paper because email clients
   can't be relied on to composite alpha. */
const C = {
  paper: "#f7f4ee",
  ink: "#1c1a15",
  ink2: "#45413a",
  ink3: "#837d70",
  accent: "#9a2b1e",
  rule: "#d9d5cc",
};
const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "Helvetica, Arial, sans-serif";

/* How many wire headlines ride along under the brief. Enough to show
   what kind of day it was, few enough that the call to action isn't
   buried under a second newsletter. */
const WIRE_ITEMS = 5;

/* The bulletproof email spacer: a div whose height, line-height and
   font-size all match. Top margin or padding on the FIRST element is
   the obvious way to do this and is unreliable — several clients
   collapse or drop it, and Kit's template supplies no top padding of
   its own, so the masthead ends up flush against the subject header.
   A spacer is a real box and survives everywhere, Outlook included. */
const spacer = (h) =>
  `<div style="height:${h}px;line-height:${h}px;font-size:${h}px;">&nbsp;</div>`;

const rule = (m = "26px") =>
  `<div style="border-top:1px solid ${C.rule};font-size:0;line-height:0;margin:${m} 0;">&nbsp;</div>`;

const kicker = (t) =>
  `<div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:0.14em;text-transform:uppercase;color:${C.accent};margin:0 0 14px;">${escHtml(t)}</div>`;

const h2 = (t) =>
  `<h2 style="font-family:${SERIF};font-weight:normal;font-size:21px;line-height:1.25;color:${C.ink};margin:28px 0 10px;">${escHtml(t)}</h2>`;

const para = (t) =>
  `<p style="font-family:${SANS};font-size:16px;line-height:1.62;color:${C.ink2};margin:0 0 16px;">${escHtml(t)}</p>`;

function longDate(d) {
  const dt = new Date(`${d}T12:00:00Z`);
  if (isNaN(dt)) return "";
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* The bulletproof-button pattern: a table cell carries the fill, so
   it survives Outlook's Word renderer, where padding on an <a> does
   not. */
function cta(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;"><tr><td bgcolor="${C.accent}" style="border-radius:2px;">
  <a href="${escHtml(href)}" style="display:inline-block;padding:13px 24px;font-family:${SANS};font-size:15px;font-weight:bold;color:${C.paper};text-decoration:none;">${escHtml(label)} &rarr;</a>
</td></tr></table>`;
}

/* Headlines ride along as TEXT, not links, and that is the whole
   design decision here. Rule 3h calls syndicating the wire "the
   whole mistake": every item on it is another outlet's headline
   pointing at another outlet's URL, so a subscriber is sent off this
   site on every one and we get nothing back. Naming the outlet
   without linking it keeps the scannable substance — a reader can
   see whether today matters to them — while every actual click in
   this email still lands on our own pages. */
function wireBlock(stories) {
  if (!stories.length) return "";
  const rows = stories
    .map(
      (a) =>
        `<div style="margin:0 0 15px;">
  <div style="font-family:${SERIF};font-size:17px;line-height:1.35;color:${C.ink};">${escHtml(a.title)}</div>
  <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${C.ink3};margin-top:4px;">${escHtml(a.source || "")}</div>
</div>`
    )
    .join("\n");
  /* Not "Also on the wire": the brief's lead story is usually the
     wire's top story too, so a heading promising *other* news would
     be wrong on most days. */
  return `${rule()}\n${kicker("Today's top headlines")}\n${rows}`;
}

function emailHtml(b, stories = []) {
  const briefUrl = `${ORIGIN}/brief/${b.date}/`;
  const p = [];

  /* Masthead, then the date. The date carries the permalink to
     /brief/<date>/ — the CTA now points at the wire, so this is what
     keeps the brief's own page one tap away. */
  p.push(
    spacer(26),
    `<div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:0.16em;text-transform:uppercase;color:${C.accent};margin:0 0 7px;">Insurtech Daily &middot; The Brief</div>`,
    `<div style="font-family:${SANS};font-size:13px;color:${C.ink3};margin:0;"><a href="${escHtml(briefUrl)}" style="color:${C.ink3};text-decoration:none;">${escHtml(longDate(b.date))}</a></div>`,
    rule("20px")
  );

  if (b.teaser) {
    p.push(
      `<p style="font-family:${SERIF};font-style:italic;font-size:20px;line-height:1.45;color:${C.ink};margin:0 0 4px;">${escHtml(b.teaser)}</p>`
    );
  }

  p.push(h2("What's happening"), para(b.whatsHappening));
  if (b.whyItMatters) p.push(h2("Why it matters"), para(b.whyItMatters));

  p.push(wireBlock(stories));
  p.push(cta(`${ORIGIN}/`, "See the rest of today's stories on The Wire"));
  p.push(rule());

  const counts =
    b.storyCount && b.sourceCount
      ? `Written from ${b.storyCount} stories across ${b.sourceCount} sources. `
      : "";
  const small = `font-family:${SANS};font-size:12px;line-height:1.6;color:${C.ink3};margin:0;`;
  const a = `color:${C.accent};text-decoration:underline;`;

  p.push(
    `<p style="${small}">${escHtml(counts)}` +
      `<a href="${escHtml(ORIGIN)}/funding/" style="${a}">Funding tracker</a> &middot; ` +
      `<a href="${escHtml(ORIGIN)}/brief/" style="${a}">Brief archive</a></p>`,
    /* Symmetry with the top, and it keeps the sign-off from touching
       Kit's own unsubscribe footer. */
    spacer(18)
  );

  return p.filter(Boolean).join("\n");
}

function broadcastPayload(b, { draft = false } = {}) {
  const sendAt = new Date(Date.now() + SEND_DELAY_MIN * 60 * 1000).toISOString();
  return {
    subject: b.headline,
    preview_text: b.teaser || "",
    /* Internal label, and the idempotency key alreadySent() reads.
       A draft MUST NOT carry the real key: alreadySent() matches on
       exact equality, so a preview filed under it would convince the
       next scheduled run that the day's brief had already gone out
       and suppress the only real send. The `-preview-` infix can
       never collide with it. */
    description: draft ? `${TAG}-preview-${b.date}` : `${TAG}-${b.date}`,
    content: emailHtml(b, topStories()),
    /* Never published to Kit's web feed — see the header. */
    public: false,
    published_at: b.generatedAt || new Date().toISOString(),
    /* null is what makes it a draft rather than a scheduled send. */
    send_at: draft ? null : sendAt,
    /* "If nothing is provided, will default to all of your
       subscribers" — the field is required, so an empty array is how
       you provide nothing. */
    subscriber_filter: [],
  };
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  /* --draft files the brief in Kit as an unsent draft, so it can be
     read in Kit's own editor and test-mailed from there. That is the
     ONLY accurate preview: --dry-run prints the HTML this file
     generates, but a subscriber sees it wrapped in the account's
     email template, and nothing local can render that. */
  const draft = process.argv.includes("--draft");

  if (!KEY && !dry) {
    console.log("Kit: no KIT_API_KEY set — skipping the email.");
    return;
  }

  const brief = newestBrief(loadBriefs());
  if (!brief) {
    console.log("Kit: no Claude-written brief to send.");
    return;
  }

  const payload = broadcastPayload(brief, { draft });

  if (dry) {
    console.log(`Kit (dry run): would send "${brief.headline}" for ${brief.date}`);
    console.log(`  description : ${payload.description}`);
    console.log(`  send_at     : ${payload.send_at}`);
    console.log(`  preview     : ${payload.preview_text}`);
    console.log("  ── content ──");
    console.log(payload.content);
    return;
  }

  /* Drafts skip the check deliberately: re-previewing after a prompt
     or template change is the whole point, and a draft is filed under
     a description the check can't match anyway. Repeat runs leave
     repeat drafts — delete them in Kit, they send to nobody. */
  if (!draft) {
    const sent = await alreadySent(brief.date);
    if (sent) {
      console.log(`Kit: brief for ${brief.date} already sent (broadcast ${sent.id}).`);
      return;
    }
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
  if (draft) {
    console.log(`Kit: filed brief for ${brief.date} as DRAFT — broadcast ${id}. Nothing was sent.`);
    console.log("     Open it in Kit → Broadcasts to read it in the real template,");
    console.log("     and use Kit's own preview/test send to mail yourself a copy.");
    return;
  }
  console.log(`Kit: queued brief for ${brief.date} — broadcast ${id}, sending ${payload.send_at}.`);
}

/* Guarded like every other entry point here (rule 9): without it,
   merely requiring this file mails the newsletter. */
if (require.main === module) {
  main().catch((err) => console.log(`Kit: ${err.message}`));
}

module.exports = { emailHtml, newestBrief, broadcastPayload, TAG };
