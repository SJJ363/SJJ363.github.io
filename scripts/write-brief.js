#!/usr/bin/env node
/* ============================================================
   Brief enhancer — rewrites the editor's brief with Claude CLI
   ------------------------------------------------------------
   Runs AFTER fetch-news.js, which has already written a solid
   deterministic brief into data/news.json. This step tries to
   upgrade that brief using the Claude Code CLI in headless mode
   (`claude -p`), authenticated by a Claude subscription via
   CLAUDE_CODE_OAUTH_TOKEN — no metered API key required.

   It is deliberately fail-safe: any problem (no CLI, no token,
   timeout, bad JSON) leaves the deterministic brief untouched and
   exits 0, so the build always ships a valid brief.

   Run locally to test:  node scripts/write-brief.js
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fundingStats } = require("./funding");

const FILE = path.join(__dirname, "..", "data", "news.json");
// Fallback forensics: not committed (see .gitignore) — CI uploads it as a
// build artifact so a failed enhancement can be diagnosed after the fact.
const DIAG = path.join(__dirname, "..", "brief-fallback.json");
const TIMEOUT_MS = 180000;
const MIN_BODY_CHARS = 80;
const MAX_ATTEMPTS = 2;
const MAX_SAVED_REPLY = 20000;

/* ---- small helpers ---- */
function money(mm) {
  if (mm >= 1000) { const b = mm / 1000; return `$${b >= 10 ? Math.round(b) : b.toFixed(1)} billion`; }
  return `$${Math.round(mm)} million`;
}
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/* Quote a headline with curly quotes, and neutralise any straight quote
   inside it. The reply has to be JSON whose strings are delimited by ",
   so showing the model straight-quoted phrases invites it to echo one into
   a field value and break the parse — which is exactly what happened on
   2026-07-25 (run #16). Curly quotes read the same and can't do that. */
const quoted = (s) => `“${clean(s).replace(/"/g, "'")}”`;

/* ---- turn a batch into a compact digest for the prompt ---- */
function buildDigest(data) {
  const articles = data.articles || [];
  const total = articles.length;
  const sources = (data.sources || []).length;

  const themes = (data.taxonomy || [])
    .filter((t) => t.name !== "Industry")
    .slice()
    .sort((a, b) => b.count - a.count);

  const funding = fundingStats(articles);

  const byCluster = articles
    .slice()
    .sort((a, b) => (b.cluster || 1) - (a.cluster || 1) || (b.score || 0) - (a.score || 0));
  const mostCovered = byCluster.filter((a) => (a.cluster || 1) >= 2).slice(0, 6);

  const topStories = articles
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 14);

  const lines = [];
  lines.push(`BATCH: ${total} stories from ${sources} outlets.`);
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

function buildPrompt(digest) {
  return `You are the editor of a respected insurtech news wire, writing a short briefing for busy insurance and fintech professionals.

Below is a digest of the latest batch of aggregated stories. Write a briefing that captures what is happening across the batch and why it matters.

${digest}

Write the briefing as a single JSON object with exactly these fields:
{
  "headline": "a punchy 5-9 word headline capturing the single biggest current in this batch (no trailing period)",
  "teaser": "one short fragment (~8-12 words) for a collapsed preview, e.g. 'AI moves into underwriting, funding rebounds, and what follows'",
  "whatsHappening": "2 to 4 sentences describing the THEMES across the batch in plain, engaging language",
  "whyItMatters": "2 to 3 sentences on the second-order effects and what to watch next"
}

Rules:
- Capture themes and their implications. Do NOT just list individual stories. You may anchor with at most one representative story if it genuinely helps.
- Write for a smart reader in a hurry: concrete, easy to understand, no jargon, no hype, no emojis.
- Ground claims in the digest above; do not invent specific numbers or company names that aren't there.
- Never use a double quote (") inside a field value — it ends the JSON string and breaks the parse. If you need to quote a phrase or a headline, use single quotes.
- Output ONLY the raw JSON object — no markdown, no code fences, no commentary before or after.`;
}

/* ---- call the Claude CLI in headless print mode ----
   Returns { text } on success, or { reason, detail, … } describing exactly
   how the call failed, so the fallback is never a mystery afterwards. */
function callClaude(prompt) {
  // Plain text output: stdout is simply the model's reply. Simpler and more
  // robust than the JSON envelope, which a startup banner line can corrupt.
  const args = ["-p"];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

  const startedAt = Date.now();
  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - startedAt;

  const out = res.stdout || "";
  const err = clean(res.stderr || "");
  const base = { elapsedMs, exitStatus: res.status, signal: res.signal || null, stderr: err.slice(0, 1000), replyChars: out.length };

  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM";
    console.warn(`  ✗ claude CLI ${timedOut ? "timed out" : "not runnable"}: ${res.error.message}`);
    return { ...base, reason: timedOut ? "cli-timeout" : "cli-unrunnable", detail: res.error.message, text: out };
  }

  console.log(`  claude exit=${res.status} stdout=${out.length}b in ${elapsedMs}ms${err ? ` stderr=${JSON.stringify(err.slice(0, 400))}` : ""}`);
  if (res.status !== 0) {
    console.warn("  ✗ claude exited non-zero");
    return { ...base, reason: `cli-exit-${res.status}`, detail: err.slice(0, 300) || "no stderr", text: out };
  }
  if (!clean(out)) return { ...base, reason: "empty-reply", detail: "CLI exited 0 with empty stdout", text: out };
  return { ...base, text: out };
}

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

/* ---- judge a reply: { brief } if usable, else { reason, detail } ----
   Every rejection path names the guard that tripped, so the fallback
   diagnostics say which one rather than just "unavailable". */
function judgeReply(text) {
  if (!text) return { reason: "empty-reply", detail: "no text to parse" };
  const raw = sliceJson(text.replace(/```(?:json)?/gi, ""));
  if (!raw) { console.warn("  no JSON object found in reply"); return { reason: "no-json", detail: "no brace-balanced object in reply" }; }
  // Tolerate trailing commas before } or ] (a common model slip).
  const jsonStr = raw.replace(/,(\s*[}\]])/g, "$1");
  let obj;
  try { obj = JSON.parse(jsonStr); }
  catch (e) { console.warn(`  JSON parse failed: ${e.message}`); return { reason: "json-parse", detail: e.message }; }

  const req = ["headline", "teaser", "whatsHappening", "whyItMatters"];
  for (const k of req) {
    if (typeof obj[k] !== "string" || !obj[k].trim()) {
      console.warn(`  field missing/empty: ${k}`);
      return { reason: `field-missing:${k}`, detail: `type ${typeof obj[k]}` };
    }
  }
  for (const k of ["whatsHappening", "whyItMatters"]) {
    const len = clean(obj[k]).length;
    if (len < MIN_BODY_CHARS) {
      console.warn(`  ${k} too short (${len} < ${MIN_BODY_CHARS})`);
      return { reason: `too-short:${k}`, detail: `${len} chars, need ${MIN_BODY_CHARS}` };
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
    },
  };
}

// Back-compat wrapper: brief object, or null when the reply is unusable.
function extractBrief(text) {
  return judgeReply(text).brief || null;
}

/* ---- record why we fell back ----
   Two trails, because each answers a different question later:
   1. `briefing.fallback` in news.json — committed, so `git log` alone tells
      you the reason for any past run without needing CI logs or auth.
   2. brief-fallback.json — uncommitted, uploaded as a CI artifact, and holds
      the bulky evidence (the raw reply) that shouldn't ship to the site. */
function recordFallback(data, info, extra = {}) {
  const at = new Date().toISOString();
  console.log(`Claude brief unavailable (${info.reason}) — keeping deterministic brief.`);
  if (info.detail) console.log(`  detail: ${info.detail}`);
  if (info.text) console.log(`  raw reply (first 800 chars): ${JSON.stringify(info.text.slice(0, 800))}`);

  if (data && data.briefing) {
    data.briefing.by = "deterministic";
    data.briefing.fallback = { reason: info.reason, at };
    try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.warn(`  could not stamp news.json: ${e.message}`); }
  }

  try {
    fs.writeFileSync(DIAG, JSON.stringify({
      at,
      reason: info.reason,
      detail: info.detail || null,
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

/* ---- main (never throws, never fails the build) ---- */
function main() {
  let data = null;
  try {
    // Any leftover from a previous local run would be misleading evidence.
    fs.rmSync(DIAG, { force: true });

    data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!data.articles || !data.articles.length) { console.log("No articles — skipping."); return; }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      recordFallback(data, { reason: "no-credentials", detail: "neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set" });
      return;
    }

    const prompt = buildPrompt(buildDigest(data));
    let brief = null, last = null, priorReason = null, attempt = 0;

    // A malformed reply is a sampling slip, not a systemic failure — one more
    // draw almost always parses, and the step has ~170s of its budget spare.
    // CLI-level failures (auth, timeout) won't fix themselves, so they don't retry.
    while (attempt < MAX_ATTEMPTS && !brief) {
      attempt++;
      console.log(`Asking Claude to write the brief…${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      const call = callClaude(prompt);
      if (call.reason) { last = call; break; }

      const verdict = judgeReply(call.text);
      if (verdict.brief) { brief = verdict.brief; break; }
      last = { ...call, ...verdict };
      if (attempt < MAX_ATTEMPTS) { priorReason = verdict.reason; console.log(`  retrying after ${verdict.reason}`); }
    }

    if (!brief) {
      recordFallback(data, last, { promptChars: prompt.length, attempts: attempt, priorReason });
      return;
    }

    data.briefing = brief; // existing key keeps its position (before `articles`)
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    console.log(`✓ Brief rewritten by Claude${attempt > 1 ? ` (attempt ${attempt})` : ""} — "${brief.headline}"`);
  } catch (err) {
    recordFallback(data, { reason: "script-error", detail: `${err.message}\n${err.stack || ""}`.slice(0, 2000) });
  }
}

if (require.main === module) main();

module.exports = { buildDigest, buildPrompt, extractBrief, judgeReply };
