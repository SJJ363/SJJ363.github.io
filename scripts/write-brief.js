#!/usr/bin/env node
/* ============================================================
   Brief writer — Claude first, deterministic only as a last resort
   ------------------------------------------------------------
   Runs AFTER fetch-news.js, which has already written a solid
   deterministic brief into data/news.json. This step replaces that
   brief with one Claude actually wrote.

   What it writes *from* is not the whole batch: brief-window.js narrows
   news.json to the stories that landed since the last published
   briefing, and the last few briefings' headlines go into the prompt as
   ground already covered. The wire holds 45 days, so writing from all
   of it produced a brief that restated the same themes daily.

   The deterministic brief is the safety net, not a coin flip: it is
   the only page on the site nobody wrote, so shipping it is a visible
   failure. Everything here exists to make that outcome rare enough to
   be an incident rather than a Tuesday.

   The escalation ladder, in order — each rung only runs if the ones
   above it failed:

     1. Claude Code CLI, default model, up to MAX_SAMPLES draws.
        A malformed reply is a sampling slip; another draw fixes it.
     2. Transient failures (overloaded, network, 5xx) retry with
        exponential backoff instead of giving up.
     3. Usage/session limits fall down the CLI model ladder
        (sonnet, haiku). Weekly per-model caps are separate from the
        shared 5-hour session limit, so this rescues the former.
     4. If the limit resets inside WAIT_CAP_MS, wait it out in-run.
     5. The Anthropic API directly (ANTHROPIC_API_KEY), which draws on
        a completely separate quota from the subscription. This is the
        rung that makes a subscription limit survivable at all — with
        structured outputs, so the reply cannot fail to parse.
     6. Re-publish today's existing Claude-written brief from the
        archive, if this date already has one. Slightly stale prose
        beats prose nobody wrote.
     7. Deterministic — and stamp `retryAfter` so brief-retry.yml
        comes back and tries again once the limit has reset.

   Exits 0 in every case. The build always ships a valid brief.

   Run locally to test:  node scripts/write-brief.js
   Retry a fallback:     node scripts/write-brief.js --if-fallback
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fundingStats } = require("./funding");
const { localDate } = require("./schedule");
const { briefWindow } = require("./brief-window");

const FILE = path.join(__dirname, "..", "data", "news.json");
const BRIEFS = path.join(__dirname, "..", "data", "briefs.json");
const STORE = path.join(__dirname, "..", "data", "companies-store.json");
// Fallback forensics: not committed (see .gitignore) — CI uploads it as a
// build artifact so a failed enhancement can be diagnosed after the fact.
const DIAG = path.join(__dirname, "..", "brief-fallback.json");

const CLI_TIMEOUT_MS = 180000;
const API_TIMEOUT_MS = 120000;
const MIN_BODY_CHARS = 80;
const MAX_SAMPLES = 3;            // draws per transport before moving down the ladder
const MAX_SAVED_REPLY = 20000;
const WAIT_CAP_MS = 15 * 60 * 1000;   // longest we'll idle in-run waiting for a reset
const RETRY_FLOOR_MS = 30 * 60 * 1000; // if we can't read a reset time, ask CI back in 30m
const API_MODEL = process.env.BRIEF_API_MODEL || "claude-opus-5";
const CLI_LADDER = (process.env.BRIEF_CLI_MODELS || "sonnet,haiku")
  .split(",").map((s) => s.trim()).filter(Boolean);

const RETRY_ONLY = process.argv.includes("--if-fallback");

/* ---- small helpers ---- */
function money(mm) {
  if (mm >= 1000) { const b = mm / 1000; return `$${b >= 10 ? Math.round(b) : b.toFixed(1)} billion`; }
  return `$${Math.round(mm)} million`;
}
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

/* Quote a headline with curly quotes, and neutralise any straight quote
   inside it. The reply has to be JSON whose strings are delimited by ",
   so showing the model straight-quoted phrases invites it to echo one into
   a field value and break the parse — which is exactly what happened on
   2026-07-25 (run #16). Curly quotes read the same and can't do that. */
const quoted = (s) => `“${clean(s).replace(/"/g, "'")}”`;

/* ---- turn a batch into a compact digest for the prompt ----
   `window` (from brief-window.js) narrows the batch to the stories that
   landed since the previous briefing. Everything counted here — themes,
   money, corroboration, outlets — is counted over that window and not
   over the 45-day batch, or the digest would report six weeks of totals
   under a heading that says "since yesterday". */
function buildDigest(data, window) {
  const articles = (window && window.articles) || data.articles || [];
  const total = articles.length;
  const sources = new Set(articles.map((a) => a.source).filter(Boolean)).size;

  const counts = new Map();
  for (const a of articles) {
    for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const themes = [...counts]
    .filter(([name]) => name !== "Industry")
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const funding = fundingStats(articles);

  // One entry per story, not per re-report: a cluster's members are all in the
  // window, so listing each of them made three widely-covered stories look
  // like six and spent the prompt on the same headline twice.
  const seenCluster = new Set();
  const mostCovered = articles
    .slice()
    .sort((a, b) => (b.cluster || 1) - (a.cluster || 1) || (b.score || 0) - (a.score || 0))
    .filter((a) => (a.cluster || 1) >= 2)
    .filter((a) => {
      const key = a.clusterId || a.link;
      if (seenCluster.has(key)) return false;
      seenCluster.add(key);
      return true;
    })
    .slice(0, 6);

  // Same reason, and it matters more here: 14 slots spent three times on the
  // same acquisition is three themes the writer never sees.
  const seenSample = new Set();
  const topStories = articles
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter((a) => {
      const key = a.clusterId || a.link;
      if (seenSample.has(key)) return false;
      seenSample.add(key);
      return true;
    })
    .slice(0, 14);

  const lines = [];
  if (window && window.since && !window.widened) {
    lines.push(`NEW SINCE THE LAST BRIEFING: ${total} stories from ${sources} outlets, all of which reached the wire after the ${window.priorDate} briefing was published (${window.since}). The wire's full archive is larger; these are the ones that are new.`);
  } else if (window && window.widened) {
    lines.push(`RECENT STORIES: the ${total} most recent stories on the wire, from ${sources} outlets. (Intended window: everything new since the last briefing — widened because ${window.widened}, so some of this may already have been covered.)`);
  } else {
    lines.push(`BATCH: ${total} stories from ${sources} outlets.`);
  }
  lines.push("");
  lines.push("DOMINANT THEMES (by number of stories):");
  themes.slice(0, 8).forEach((t) => lines.push(`- ${t.name}: ${t.count}`));
  lines.push("");
  if (funding.count) {
    lines.push(`MONEY IN PLAY: ~${money(funding.total)} in disclosed funding across ${funding.count} disclosed rounds.`);
    lines.push("");
  }
  if (mostCovered.length) {
    lines.push("MOST-CORROBORATED STORIES (same story, multiple outlets):");
    mostCovered.forEach((a) => lines.push(`- ${quoted(a.title)} — ${a.cluster} outlets`));
    lines.push("");
  }
  lines.push("A SAMPLE OF HEADLINES:");
  topStories.forEach((a) => lines.push(`- ${quoted(a.title)} (${a.source}) [${(a.tags || []).join(", ")}]`));
  return lines.join("\n");
}

const FIELDS = ["headline", "teaser", "whatsHappening", "whyItMatters"];

/* What the site has already told this reader. The digest is narrowed to new
   stories, but a theme can stay dominant for a week on genuinely new
   stories — so the model also needs to see the framing it has already used,
   or it writes "AI moves from pilot to plumbing" four days running. */
function recentBriefs(briefs, date, n = 3) {
  const prior = (briefs || [])
    .filter((b) => b && b.date && b.headline && (!date || b.date < date))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, n);
  if (!prior.length) return "";
  const lines = ["ALREADY PUBLISHED (this site's own recent briefings — do not re-tell these):"];
  prior.forEach((b) => lines.push(`- ${b.date}: ${quoted(b.headline)}${b.teaser ? ` — ${clean(b.teaser)}` : ""}`));
  return lines.join("\n");
}

function buildPrompt(digest, recent = "") {
  return `You are the editor of a respected insurtech news wire, writing a short briefing for busy insurance and fintech professionals.

Below is a digest of the stories that have come in since your last briefing. Write a briefing that captures what is happening in them and why it matters.

${digest}
${recent ? `\n${recent}\n` : ""}
Write the briefing as a single JSON object with exactly these fields:
{
  "headline": "a punchy 5-9 word headline capturing the single biggest current in these new stories (no trailing period)",
  "teaser": "one short fragment (~8-12 words) for a collapsed preview, e.g. 'AI moves into underwriting, funding rebounds, and what follows'",
  "whatsHappening": "2 to 4 sentences describing the THEMES across these new stories in plain, engaging language",
  "whyItMatters": "2 to 3 sentences on the second-order effects and what to watch next"
}

Rules:
- Capture themes and their implications. Do NOT just list individual stories. You may anchor with at most one representative story if it genuinely helps.
- This is today's briefing, not a standing summary of the industry. Write about what has moved since the last one. Where a theme also appears in ALREADY PUBLISHED above, either leave it out or say specifically what is new about it — never restate it in fresh words.
- Reuse none of the headlines or framings listed under ALREADY PUBLISHED.
- Write for a smart reader in a hurry: concrete, easy to understand, no jargon, no hype, no emojis.
- Ground claims in the digest above; do not invent specific numbers or company names that aren't there.
- Never use a double quote (") inside a field value — it ends the JSON string and breaks the parse. If you need to quote a phrase or a headline, use single quotes.
- Output ONLY the raw JSON object — no markdown, no code fences, no commentary before or after.`;
}

/* ============================================================
   Failure classification
   ------------------------------------------------------------
   The old code treated every non-zero exit the same and gave up.
   But the three families need opposite responses: a limit needs
   *time* or a different quota, a transient needs a short retry, and
   auth needs a human. Naming them is what lets the ladder work.
   ============================================================ */
const AUTH_RE = /(invalid api ?key|authentication[_ ]error|unauthorized|not logged in|please run [`'"]?claude (login|setup)|token (has )?expired|credit balance is too low)/i;
const LIMIT_RE = /(session limit|usage limit|rate[_ ]limit|limit reached|quota|too many requests|429|\bresets?\b)/i;
const TRANSIENT_RE = /(overloaded|529|503|502|500|internal server error|bad gateway|gateway timeout|socket hang ?up|econnreset|etimedout|enotfound|eai_again|fetch failed|network|temporarily unavailable)/i;

function classify(...parts) {
  const s = parts.filter(Boolean).join(" ");
  if (AUTH_RE.test(s)) return "auth";
  if (LIMIT_RE.test(s)) return "usage-limit";
  if (TRANSIENT_RE.test(s)) return "transient";
  return "unknown";
}

/* When does the limit lift? The CLI says things like
   "You've hit your session limit · resets 10:20pm (UTC)" or
   "resets in 45 minutes". Only trust an explicit UTC clock time —
   a bare local time we can't place would produce a confidently
   wrong wake-up, which is worse than no answer. */
function parseResetAt(text, now = new Date()) {
  const s = clean(text);
  if (!s) return null;

  const rel = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(s);
  if (rel && (rel[1] || rel[2])) {
    const ms = Number(rel[1] || 0) * 3600000 + Number(rel[2] || 0) * 60000;
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }

  const abs = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(UTC|GMT|Z)\s*\)?/i.exec(s);
  if (abs) {
    let h = Number(abs[1]);
    const min = Number(abs[2] || 0);
    const ap = (abs[3] || "").toLowerCase();
    if (ap) { h = h % 12; if (ap === "pm") h += 12; }
    if (h > 23 || min > 59) return null;
    const at = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, 0, 0
    ));
    if (at <= now) at.setUTCDate(at.getUTCDate() + 1); // already past today → tomorrow
    return at.toISOString();
  }
  return null;
}

/* ============================================================
   Transport 1: the Claude Code CLI
   ============================================================ */

/* The CLI resolves ANTHROPIC_API_KEY ahead of the subscription token,
   so leaving the key in its environment would silently move every CLI
   call onto metered billing. Strip it — the API key belongs to the API
   rung of the ladder and nowhere else. */
function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function callCli(prompt, model) {
  const args = ["-p"];
  const chosen = model || process.env.CLAUDE_MODEL || null;
  if (chosen) args.push("--model", chosen);

  const startedAt = Date.now();
  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: cliEnv(),
  });
  const elapsedMs = Date.now() - startedAt;

  const out = res.stdout || "";
  const err = clean(res.stderr || "");
  const label = `cli${chosen ? `:${chosen}` : ""}`;
  const base = {
    transport: label, elapsedMs, exitStatus: res.status, signal: res.signal || null,
    stderr: err.slice(0, 1000), replyChars: out.length, text: out,
  };

  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM";
    console.warn(`  ✗ ${label} ${timedOut ? "timed out" : "not runnable"}: ${res.error.message}`);
    return {
      ...base,
      reason: timedOut ? "cli-timeout" : "cli-unrunnable",
      kind: timedOut ? "transient" : "unknown",
      detail: res.error.message,
    };
  }

  console.log(`  ${label} exit=${res.status} stdout=${out.length}b in ${elapsedMs}ms${err ? ` stderr=${JSON.stringify(err.slice(0, 400))}` : ""}`);

  if (res.status !== 0) {
    // The CLI reports usage limits on *stdout* with a non-zero exit and an
    // empty stderr, so both streams have to be classified together.
    const kind = classify(out, err);
    const detail = clean(out).slice(0, 300) || err.slice(0, 300) || "no output";
    console.warn(`  ✗ ${label} exited non-zero (${kind}): ${detail}`);
    return { ...base, reason: `cli-exit-${res.status}`, kind, detail, resetAt: parseResetAt(out) };
  }
  if (!clean(out)) {
    return { ...base, reason: "empty-reply", kind: "transient", detail: "CLI exited 0 with empty stdout" };
  }
  return base; // success — caller judges the text
}

/* ============================================================
   Transport 2: the Anthropic API directly
   ------------------------------------------------------------
   Separate quota from the subscription, so it is unaffected by the
   session limit that knocked out the CLI. Structured outputs make the
   reply schema-guaranteed, so this rung cannot fail on a bad parse.
   ============================================================ */
async function callApi(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { transport: "api", reason: "api-no-key", kind: "auth", detail: "ANTHROPIC_API_KEY not set" };
  }

  const body = {
    model: API_MODEL,
    max_tokens: 8000,
    // Thinking stays on (it is the default on Opus 5 and disabling it invites
    // stray tags in the visible text); `effort: low` keeps this cheap instead.
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: Object.fromEntries(FIELDS.map((f) => [f, { type: "string" }])),
          required: FIELDS,
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: "user", content: prompt }],
  };

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    const detail = `${e.name}: ${e.message}`;
    console.warn(`  ✗ api request failed: ${detail}`);
    return { transport: "api", reason: "api-network", kind: classify(detail) === "unknown" ? "transient" : classify(detail), detail };
  }

  const elapsedMs = Date.now() - startedAt;
  const raw = await res.text();
  const base = { transport: "api", elapsedMs, exitStatus: res.status, replyChars: raw.length };
  console.log(`  api ${API_MODEL} status=${res.status} body=${raw.length}b in ${elapsedMs}ms`);

  if (!res.ok) {
    const kind = res.status === 429 ? "usage-limit"
      : res.status >= 500 ? "transient"
      : res.status === 401 || res.status === 403 ? "auth"
      : classify(raw);
    const retryAfter = Number(res.headers.get("retry-after"));
    console.warn(`  ✗ api ${res.status} (${kind}): ${clean(raw).slice(0, 300)}`);
    return {
      ...base, reason: `api-http-${res.status}`, kind,
      detail: clean(raw).slice(0, 500), text: raw,
      resetAt: Number.isFinite(retryAfter) && retryAfter > 0
        ? new Date(Date.now() + retryAfter * 1000).toISOString() : null,
    };
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch (e) { return { ...base, reason: "api-bad-envelope", kind: "unknown", detail: e.message, text: raw }; }

  // A safety classifier can decline with a normal 200 — check before reading content.
  if (payload.stop_reason === "refusal") {
    const category = (payload.stop_details && payload.stop_details.category) || "unknown";
    return { ...base, reason: "api-refusal", kind: "unknown", detail: `refusal category=${category}`, text: raw };
  }
  if (payload.stop_reason === "max_tokens") {
    return { ...base, reason: "api-truncated", kind: "transient", detail: "hit max_tokens", text: raw };
  }

  const text = (payload.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!clean(text)) {
    return { ...base, reason: "api-empty", kind: "transient", detail: `stop_reason=${payload.stop_reason}`, text: raw };
  }
  return { ...base, text, model: payload.model || API_MODEL };
}

/* ============================================================
   Judging a reply
   ============================================================ */

// Find the first complete, brace-balanced {...} object, respecting string
// literals — robust to any prose the model tacks on before or after the JSON.
function sliceJson(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/* Returns { brief } if usable, else { reason, detail }. Every rejection path
   names the guard that tripped, so the diagnostics say which one rather than
   just "unavailable". */
function judgeReply(text, meta = {}) {
  if (!text) return { reason: "empty-reply", kind: "transient", detail: "no text to parse" };
  const raw = sliceJson(text.replace(/```(?:json)?/gi, ""));
  if (!raw) { console.warn("  no JSON object found in reply"); return { reason: "no-json", kind: "malformed", detail: "no brace-balanced object in reply" }; }
  // Tolerate trailing commas before } or ] (a common model slip).
  const jsonStr = raw.replace(/,(\s*[}\]])/g, "$1");
  let obj;
  try { obj = JSON.parse(jsonStr); }
  catch (e) { console.warn(`  JSON parse failed: ${e.message}`); return { reason: "json-parse", kind: "malformed", detail: e.message }; }

  for (const k of FIELDS) {
    if (typeof obj[k] !== "string" || !obj[k].trim()) {
      console.warn(`  field missing/empty: ${k}`);
      return { reason: `field-missing:${k}`, kind: "malformed", detail: `type ${typeof obj[k]}` };
    }
  }
  for (const k of ["whatsHappening", "whyItMatters"]) {
    const len = clean(obj[k]).length;
    if (len < MIN_BODY_CHARS) {
      console.warn(`  ${k} too short (${len} < ${MIN_BODY_CHARS})`);
      return { reason: `too-short:${k}`, kind: "malformed", detail: `${len} chars, need ${MIN_BODY_CHARS}` };
    }
  }

  return {
    brief: {
      headline: clean(obj.headline).replace(/[.]+$/, ""),
      teaser: clean(obj.teaser),
      whatsHappening: clean(obj.whatsHappening),
      whyItMatters: clean(obj.whyItMatters),
      generatedAt: new Date().toISOString(),
      by: "claude",
      via: meta.transport || "cli",
      ...(meta.model ? { model: meta.model } : {}),
    },
  };
}

// Back-compat wrapper: brief object, or null when the reply is unusable.
function extractBrief(text) {
  return judgeReply(text).brief || null;
}

/* ============================================================
   The ladder
   ============================================================ */

/* Draw from one transport until it yields a usable brief or stops being
   worth asking. Malformed replies are resampled (a different draw almost
   always parses); transient failures back off; limits and auth failures
   return immediately so the caller can escalate to a different quota. */
async function drawFrom(label, run, state) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_SAMPLES; attempt++) {
    console.log(`Asking Claude via ${label}…${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    state.attempts++;
    const call = await run();
    if (call.reason) {
      last = call;
      state.trail.push(`${call.transport || label}:${call.kind || "unknown"}`);
      // Keep the first real failure as the recorded cause. Without this the
      // committed reason ends up being whatever the *last* rung said —
      // "api-no-key" reads like a config mistake when the actual story is a
      // session limit on the subscription.
      if (!state.cause) state.cause = call;
      if (call.resetAt) state.resetAt = state.resetAt || call.resetAt;
      if (call.kind === "usage-limit" || call.kind === "auth") return last; // won't fix itself here
      if (attempt < MAX_SAMPLES) {
        const backoff = 2000 * 2 ** (attempt - 1);
        console.log(`  retrying after ${call.reason} in ${backoff}ms`);
        await sleep(backoff);
      }
      continue;
    }

    const verdict = judgeReply(call.text, call);
    if (verdict.brief) return { brief: verdict.brief, attempt };
    last = { ...call, ...verdict };
    state.trail.push(`${call.transport || label}:${verdict.reason}`);
    if (!state.cause) state.cause = last;
    if (attempt < MAX_SAMPLES) console.log(`  retrying after ${verdict.reason}`);
  }
  return last;
}

async function produceBrief(prompt, state) {
  const rungs = [];

  // 1. The subscription CLI on its default model.
  rungs.push({ label: "cli", run: () => callCli(prompt, null) });
  // 2. Other models — weekly per-model caps are separate from the shared
  //    session limit, so a ladder step can clear a limit the default hit.
  for (const m of CLI_LADDER) rungs.push({ label: `cli:${m}`, run: () => callCli(prompt, m), onlyAfter: "usage-limit" });
  // 3. The metered API — an entirely separate quota.
  rungs.push({ label: "api", run: () => callApi(prompt) });

  let last = null;
  for (const rung of rungs) {
    if (rung.onlyAfter && (!last || last.kind !== rung.onlyAfter)) continue;
    const result = await drawFrom(rung.label, rung.run, state);
    if (result && result.brief) return result;
    last = result || last;
  }

  // Last live option: sit out a limit that lifts soon. This runs *after* the
  // API rung on purpose — waiting before it would make a healthy API key pay
  // a 15-minute toll for a subscription problem it doesn't have.
  if (state.resetAt && !state.waited) {
    const waitMs = Date.parse(state.resetAt) - Date.now();
    if (waitMs > 0 && waitMs <= WAIT_CAP_MS) {
      state.waited = true;
      console.log(`Every rung failed; the limit resets at ${state.resetAt} (${Math.round(waitMs / 1000)}s) — waiting it out.`);
      await sleep(waitMs + 5000);
      const retry = await drawFrom("cli (after reset)", () => callCli(prompt, null), state);
      if (retry && retry.brief) return retry;
      last = retry || last;
    } else {
      console.log(`Limit resets at ${state.resetAt} — too far off to wait for; brief-retry.yml will pick it up.`);
    }
  }
  return last;
}

/* ============================================================
   Last resorts and bookkeeping
   ============================================================ */

/* The day a briefing belongs to, in Central terms — the same stamp the archive
   files it under. Never the UTC date of `generatedAt`: a brief written or
   retried after 18:00 CT carries a UTC date of tomorrow. */
const briefDate = (data) =>
  (data.briefing || {}).date || localDate((data.briefing || {}).generatedAt) || localDate(data.updatedAt);

/* Rung 6: this date may already have a Claude-written brief from an earlier
   run today. Re-publishing it keeps human-quality prose on the site while the
   retry workflow goes after a fresh one — and, crucially, stops this run from
   overwriting that archive entry with a deterministic downgrade. */
function reuseTodaysClaudeBrief(data) {
  const date = briefDate(data);
  if (!date) return null;
  let store;
  try { store = JSON.parse(fs.readFileSync(BRIEFS, "utf8")); }
  catch { return null; }
  const prior = (store.briefs || []).find((b) => b.date === date && b.by === "claude");
  if (!prior || !prior.headline || !prior.whatsHappening) return null;
  return {
    date,
    headline: prior.headline,
    teaser: prior.teaser || "",
    whatsHappening: prior.whatsHappening,
    whyItMatters: prior.whyItMatters || "",
    generatedAt: prior.generatedAt || `${date}T12:00:00.000Z`,
    by: "claude",
    via: "archive",
  };
}

/* ---- record why we fell back ----
   Three trails, because each answers a different question later:
   1. `briefing.fallback` in news.json — committed, so `git log` alone tells
      you the reason for any past run without needing CI logs or auth.
   2. `briefing.fallback.retryAfter` — the machine-readable part:
      brief-retry.yml reads it to know when coming back is worth a run.
   3. brief-fallback.json — uncommitted, uploaded as a CI artifact, and holds
      the bulky evidence (the raw reply) that shouldn't ship to the site. */
function recordFallback(data, info, extra = {}) {
  const at = new Date().toISOString();
  info = info || { reason: "unknown", kind: "unknown" };
  const retryAfter = info.resetAt || extra.resetAt || new Date(Date.now() + RETRY_FLOOR_MS).toISOString();

  const kept = extra.outcome === "reused-archive"
    ? "kept today's earlier Claude brief"
    : "keeping deterministic brief";
  console.log(`Claude brief unavailable (${info.reason} / ${info.kind || "unknown"}) — ${kept}.`);
  if (extra.trail) console.log(`  ladder: ${extra.trail.join(" → ")}`);
  if (info.detail) console.log(`  detail: ${info.detail}`);
  console.log(`  retry due after ${retryAfter}`);
  if (info.text) console.log(`  raw reply (first 800 chars): ${JSON.stringify(info.text.slice(0, 800))}`);

  if (data && data.briefing) {
    data.briefing.by = "deterministic";
    data.briefing.fallback = {
      reason: info.reason, kind: info.kind || "unknown", at, retryAfter,
      // Every rung that was tried, in order — committed, so `git log` alone
      // shows how far down the ladder a past run got.
      ...(extra.trail ? { trail: extra.trail.join(" → ") } : {}),
    };
    try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.warn(`  could not stamp news.json: ${e.message}`); }
  }

  try {
    fs.writeFileSync(DIAG, JSON.stringify({
      at,
      reason: info.reason,
      kind: info.kind || "unknown",
      transport: info.transport || null,
      detail: info.detail || null,
      retryAfter,
      exitStatus: info.exitStatus ?? null,
      signal: info.signal ?? null,
      elapsedMs: info.elapsedMs ?? null,
      stderr: info.stderr || null,
      replyChars: info.replyChars ?? (info.text ? info.text.length : 0),
      reply: info.text ? info.text.slice(0, MAX_SAVED_REPLY) : null,
      ...extra,
    }, null, 2));
    console.log(`  diagnostics written to ${path.basename(DIAG)}`);
  } catch (e) {
    console.warn(`  could not write diagnostics: ${e.message}`);
  }
}

function publish(data, brief, note) {
  // Carry the day stamp across the swap. A replacement brief is still *that
  // day's* brief, even when the retry that produced it ran after midnight UTC.
  brief.date = brief.date || briefDate(data) || localDate();
  data.briefing = brief; // existing key keeps its position (before `articles`)
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log(`✓ ${note} — "${brief.headline}"`);
}

/* ---- main (never throws, never fails the build) ---- */
async function main() {
  let data = null;
  try {
    // Any leftover from a previous local run would be misleading evidence.
    fs.rmSync(DIAG, { force: true });

    data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!data.articles || !data.articles.length) { console.log("No articles — skipping."); return; }

    if (RETRY_ONLY) {
      const b = data.briefing || {};
      // A brief Claude wrote and that carries no fallback stamp is finished work.
      if (b.by === "claude" && !b.fallback) { console.log("Brief already written by Claude — nothing to retry."); return; }
      // Only today's brief is ever owed a retry. A limit that lifts after
      // midnight would otherwise rewrite yesterday's brief from whatever batch
      // is on the wire and file the result under the wrong day.
      const owedFor = briefDate(data);
      const today = localDate();
      if (owedFor && owedFor !== today) {
        console.log(`Current brief is dated ${owedFor}, not today (${today}) — that day is closed.`);
        return;
      }
      const until = b.fallback && b.fallback.retryAfter;
      if (until && Date.now() < Date.parse(until)) {
        console.log(`Fallback recorded ${b.fallback.reason}; not retrying until ${until}.`);
        return;
      }
      console.log(`Retrying a fallen-back brief (${(b.fallback || {}).reason || "unknown"}).`);
    }

    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      recordFallback(data, { reason: "no-credentials", kind: "auth", detail: "neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set" });
      return;
    }

    // Narrow the 45-day batch to what has landed since the last published
    // briefing. Measured against the brief's own Central date, so a retry
    // later the same day still measures from yesterday's briefing rather
    // than from the one it is itself replacing.
    const date = briefDate(data);
    const archive = readJson(BRIEFS, {}).briefs || [];
    const window = briefWindow(data.articles, {
      briefs: archive,
      seen: readJson(STORE, {}).seen || {},
      date,
    });
    console.log(
      window.widened
        ? `Window widened to the ${window.articles.length} most recent of ${window.batchCount} stories — ${window.widened}.`
        : `Window: ${window.articles.length} of ${window.batchCount} stories landed since the ${window.priorDate} briefing (${window.since}).`
    );

    const prompt = buildPrompt(buildDigest(data, window), recentBriefs(archive, date));
    const state = { attempts: 0, resetAt: null, waited: false, trail: [], cause: null };
    const result = await produceBrief(prompt, state);

    if (result && result.brief) {
      // Committed with the brief so `git log` shows what it was written from.
      result.brief.window = {
        since: window.since,
        stories: window.articles.length,
        of: window.batchCount,
        ...(window.priorDate ? { after: window.priorDate } : {}),
        ...(window.widened ? { widened: window.widened } : {}),
      };
      publish(data, result.brief, `Brief written by Claude via ${result.brief.via}${state.attempts > 1 ? ` (${state.attempts} attempts)` : ""}`);
      return;
    }

    // The reason worth committing is the first rung's — the subscription path
    // — not whatever the bottom of the ladder happened to say. `last` is kept
    // for the artifact, which holds the raw evidence.
    const cause = { ...(state.cause || result || {}), resetAt: state.resetAt || (state.cause || {}).resetAt };
    const notes = {
      promptChars: prompt.length, attempts: state.attempts,
      trail: state.trail, lastRung: result ? { reason: result.reason, kind: result.kind, detail: result.detail } : null,
    };

    // Every live rung failed. Before conceding, re-publish today's existing
    // Claude brief if there is one — it also prevents seo.js from replacing a
    // good archive entry with this run's deterministic one.
    const reused = reuseTodaysClaudeBrief(data);
    if (reused) {
      reused.fallback = {
        reason: cause.reason || "unknown",
        kind: cause.kind || "unknown",
        at: new Date().toISOString(),
        retryAfter: state.resetAt || new Date(Date.now() + RETRY_FLOOR_MS).toISOString(),
        trail: state.trail.join(" → "),
        reused: true,
      };
      publish(data, reused, "Kept today's earlier Claude brief (live rungs unavailable)");
      recordFallback(null, cause, { ...notes, outcome: "reused-archive" });
      return;
    }

    recordFallback(data, cause, { ...notes, outcome: "deterministic" });
  } catch (err) {
    recordFallback(data, { reason: "script-error", kind: "unknown", detail: `${err.message}\n${err.stack || ""}`.slice(0, 2000) });
  }
}

// main() is async, so a throw that escaped its own catch would surface as an
// unhandled rejection and take the process down with a non-zero exit. This
// step must never fail the build — the deterministic brief is already on disk.
if (require.main === module) {
  main().catch((err) => {
    console.warn(`Brief writer crashed after its own guards: ${err && err.stack}`);
    process.exitCode = 0;
  });
}

module.exports = { buildDigest, buildPrompt, recentBriefs, extractBrief, judgeReply, classify, parseResetAt };
