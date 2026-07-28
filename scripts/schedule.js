#!/usr/bin/env node
/*
  scripts/schedule.js — the publishing clock.

  The site publishes on a Central-time clock: the wire refreshes at 08:00,
  13:00 and 18:00 Monday–Friday and once at 13:00 on Saturday and Sunday, and
  the brief is written once a day, off the first refresh of that day.

  GitHub's cron is UTC-only and has no idea DST exists, so news.yml fires
  hourly and this script decides which firings are real — the schedule lives
  here, not in the cron. It answers three questions from the committed
  data/news.json alone:

    run   — is a wire refresh due right now?
    brief — does today still need its brief?
    retry — is a fallen-back brief for *today* owed another attempt?

  `run` is settled by comparing news.json's `updatedAt` against the most recent
  slot rather than by matching a wall-clock time, which is what makes the
  schedule self-healing in both directions: the duplicate firing an hour later
  (the wrong-offset one) sees the slot already served and exits, while a slot
  whose run was skipped or failed outright is picked up by the next firing
  instead of being lost for the day.

  Everything here is decided in *local wall-clock terms* — the date and hour a
  Chicago reader would see — so no UTC-offset arithmetic is needed anywhere and
  the answers don't shift twice a year.
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ZONE = "America/Chicago";
const WEEKDAY_SLOTS = [8, 13, 18];
const WEEKEND_SLOTS = [13];
const NEWS = path.join(__dirname, "..", "data", "news.json");

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// hourCycle "h23" rather than hour12:false — the latter reports midnight as
// "24" on some ICU builds, which would put every midnight in the wrong day.
const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/* An instant, as Chicago sees it. */
function local(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when || "");
  if (isNaN(d)) return null;
  const p = {};
  for (const { type, value } of PARTS.formatToParts(d)) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: DAYS[p.weekday],
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/* The local calendar date of an instant — the stamp every brief carries. */
const localDate = (when) => (local(when) || {}).date || "";

const slotsFor = (weekday) =>
  weekday === 0 || weekday === 6 ? WEEKEND_SLOTS : WEEKDAY_SLOTS;

const hhmm = (h) => `${String(h).padStart(2, "0")}:00`;

/* The date a briefing belongs to. New briefs carry it explicitly; anything
   written before this field existed falls back to when it was generated. */
const briefDateOf = (news) => {
  const b = (news && news.briefing) || {};
  return b.date || localDate(b.generatedAt) || "";
};

function readNews() {
  try {
    return JSON.parse(fs.readFileSync(NEWS, "utf8"));
  } catch {
    return {}; // no wire yet — the first run builds one
  }
}

/* ── the decision ── */
function schedule(now = new Date(), news = readNews()) {
  const t = local(now);
  const slots = slotsFor(t.weekday);
  const passed = slots.filter((h) => t.hour >= h);
  const slot = passed.length ? passed[passed.length - 1] : null;

  // Has the most recent slot already been served? `updatedAt` is rewritten on
  // every fetch, so it is a reliable record of the last refresh that landed.
  const last = news.updatedAt ? local(news.updatedAt) : null;
  const served =
    slot !== null && last && last.date === t.date && last.hour >= slot;

  const run = slot !== null && !served;
  const reason =
    slot === null
      ? `before the first slot of the day (${hhmm(slots[0])} CT)`
      : served
        ? `${hhmm(slot)} CT already served at ${hhmm(last.hour)}`
        : `${hhmm(slot)} CT slot is due`;

  // How long until the next slot opens today, if one is still to come. Only
  // same-day slots count: the wait is short by construction, so this stays
  // plain wall-clock arithmetic and never has to reason about a DST boundary.
  const mins = t.hour * 60 + t.minute;
  const upcoming = slots.filter((h) => h * 60 > mins);
  const waitMins = upcoming.length ? upcoming[0] * 60 - mins : null;

  // One brief a day, hung off the day's date rather than off a particular
  // slot: if the 08:00 run is missed entirely, the 13:00 one writes it.
  const brief = briefDateOf(news) !== t.date;

  // A retry is only ever owed for *today's* brief. Without the date check a
  // limit that lifted after midnight would rewrite yesterday's brief against
  // whatever batch is on the wire and file it under the wrong day.
  const b = news.briefing || {};
  const owed = b.by !== "claude" || !!b.fallback;
  const until = b.fallback && b.fallback.retryAfter;
  const ready = !until || Date.now() >= Date.parse(until);
  const retry = owed && ready && briefDateOf(news) === t.date;

  return {
    run,
    brief,
    retry,
    waitMins,
    date: t.date,
    slot: slot === null ? "" : hhmm(slot),
    nextSlot: upcoming.length ? hhmm(upcoming[0]) : "",
    now: `${t.date} ${hhmm(t.hour).slice(0, 3)}${String(t.minute).padStart(2, "0")} CT`,
    reason,
  };
}

/* ── holding a runner for an imminent slot ──
   GitHub honours only about half of the hourly firings and delivers them in
   waves 1–3h apart (measured 2026-07-28: 9 runs in 19h, gaps of 0.9h to 3.5h),
   so the firing that lands half an hour *before* a slot is often the last one
   before it. On 2026-07-28 the 08:00 CT slot missed its wave by 31 minutes and
   the wire sat unrefreshed all morning.

   So rather than hand the slot back to GitHub's queue, a firing that lands
   inside WAIT_WINDOW_MIN of the next slot keeps its runner and waits. Runner
   minutes are free on a public repo; the alternative is publishing hours late.

   This is a mitigation, not a fix — it does nothing when a 3h gap straddles a
   slot with no firing in the window. Punctuality needs an external trigger
   calling the workflow_dispatch API, which bypasses the schedule queue. */
const WAIT_WINDOW_MIN = 100;
const WAIT_GRACE_MS = 20000; // land clearly past the boundary, not on it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Worth holding for? Only when nothing is due right now (a due slot runs
   immediately) and the next slot is close enough to be worth a runner. */
const shouldHold = (plan, windowMin = WAIT_WINDOW_MIN) =>
  !plan.run && plan.waitMins !== null && plan.waitMins <= windowMin;

/* Best-effort: another run may have served the slot while we slept, and this
   checkout would not know. Re-read the wire from the remote so the post-hold
   decision is made against what is actually published. A failure here is not
   worth aborting for — the worst case is a duplicate refresh. */
function refetchWire() {
  const opts = { stdio: "inherit", timeout: 60000 };
  if (spawnSync("git", ["fetch", "--depth=1", "origin", "HEAD"], opts).status !== 0) return;
  spawnSync("git", ["checkout", "FETCH_HEAD", "--", "data/news.json"], opts);
}

/* ── CLI ──
   Prints `key=value` lines and, in Actions, appends them to $GITHUB_OUTPUT.
   FORCE_RUN / FORCE_BRIEF let a manual dispatch override the clock, and
   `--wait` opts into the hold above (news.yml only — brief-retry.yml calls
   this bare, and must never sit on a runner). */
async function cli() {
  let plan = schedule();

  // A dispatch runs now, by definition — it must never wait for a slot.
  if (process.env.FORCE_RUN === "1" && !plan.run) {
    plan.run = true;
    plan.reason = `forced (clock says: ${plan.reason})`;
  }

  if (process.argv.includes("--wait") && shouldHold(plan)) {
    console.log(`${plan.now} — ${plan.reason}`);
    console.log(
      `Holding this runner ${plan.waitMins} min for the ${plan.nextSlot} CT slot — ` +
        `GitHub's next firing may not arrive before it.`
    );
    await sleep(plan.waitMins * 60000 + WAIT_GRACE_MS);
    refetchWire();
    plan = schedule();
    console.log("— resumed —");
  }

  if (process.env.FORCE_BRIEF === "force") plan.brief = true;
  if (process.env.FORCE_BRIEF === "skip") plan.brief = false;

  const out = {
    run: plan.run,
    brief: plan.brief,
    retry: plan.retry,
    date: plan.date,
    slot: plan.slot,
  };
  const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);

  console.log(`${plan.now} — ${plan.reason}`);
  console.log(
    `  wire refresh: ${plan.run ? "yes" : "no"} · daily brief: ${
      plan.brief ? "due" : "already written"
    } · brief retry: ${plan.retry ? "owed" : "no"}`
  );
  console.log(lines.join("\n"));

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

if (require.main === module) {
  cli().catch((err) => {
    // The gate must not fail the workflow: a crash here would look like a
    // broken build rather than a skipped slot. Emit nothing and let the
    // refresh job's `if` treat it as "no run".
    console.warn(`Schedule gate failed: ${err && err.stack}`);
    process.exitCode = 0;
  });
}

module.exports = { local, localDate, briefDateOf, schedule, shouldHold, slotsFor, WAIT_WINDOW_MIN, ZONE };
