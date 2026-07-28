/* ============================================================
   Shared Claude Code CLI helper
   ------------------------------------------------------------
   Thin wrapper around `claude -p` (headless print mode) used by
   the brief writer and the company extractor. Authenticated by a
   Claude subscription via CLAUDE_CODE_OAUTH_TOKEN (or an API key).
   Fail-safe: returns null on any problem so callers fall back.
   ============================================================ */

const { spawnSync } = require("child_process");

function claudeAvailable() {
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// Run a prompt through the CLI; returns the model's text, or null on failure.
function callClaude(prompt, { timeout = 180000 } = {}) {
  const args = ["-p"];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

  const res = spawnSync("claude", args, {
    input: prompt, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) { console.warn(`  ✗ claude CLI not runnable: ${res.error.message}`); return null; }
  const out = res.stdout || "";
  const err = clean(res.stderr || "");
  console.log(`  claude exit=${res.status} stdout=${out.length}b${err ? ` stderr=${JSON.stringify(err.slice(0, 300))}` : ""}`);
  if (res.status !== 0) {
    /* Print what it actually said. The CLI reports usage limits on *stdout*
       with a non-zero exit and an empty stderr, so logging only the byte
       count — as this did — makes a limit indistinguishable from a crash.
       That cost a backfill run: five chunks failed in 2.5s each with
       "stdout=53b" and nothing to say whether to retry now or in an hour.
       write-brief.js classifies the same message properly; this is only
       the extractor path, which falls back rather than escalating, so it
       needs the text visible, not the ladder. */
    const detail = clean(out).slice(0, 300) || err.slice(0, 300) || "no output";
    console.warn(`  ✗ claude exited non-zero: ${detail}`);
    return null;
  }
  return out;
}

// Find the first complete, brace-balanced {...} object, respecting string
// literals — robust to any prose the model tacks on before or after JSON.
function sliceJson(s) {
  if (!s) return null;
  const t = s.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(start, i + 1);
  }
  return null;
}

// Parse a JSON object from a model reply, tolerating fences and trailing commas.
function parseJsonObject(text) {
  const raw = sliceJson(text);
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
}

module.exports = { claudeAvailable, callClaude, sliceJson, parseJsonObject, clean };
