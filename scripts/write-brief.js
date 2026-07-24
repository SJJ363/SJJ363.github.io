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

const FILE = path.join(__dirname, "..", "data", "news.json");

/* ---- small helpers (mirrors build-brief.js) ---- */
function amountM(text) {
  const m = text.match(/\$\s?([\d,.]+)\s?(k|m|mn|bn|b|million|billion|thousand)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(n)) return 0;
  const u = (m[2] || "").toLowerCase();
  if (u === "bn" || u === "b" || u === "billion") return n * 1000;
  if (u === "k" || u === "thousand") return n / 1000;
  return n;
}
function money(mm) {
  if (mm >= 1000) { const b = mm / 1000; return `$${b >= 10 ? Math.round(b) : b.toFixed(1)} billion`; }
  return `$${Math.round(mm)} million`;
}
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/* ---- turn a batch into a compact digest for the prompt ---- */
function buildDigest(data) {
  const articles = data.articles || [];
  const total = articles.length;
  const sources = (data.sources || []).length;

  const themes = (data.taxonomy || [])
    .filter((t) => t.name !== "Industry")
    .slice()
    .sort((a, b) => b.count - a.count);

  const funding = articles.filter((a) => (a.tags || []).includes("Funding"));
  let fundTotal = 0;
  funding.forEach((a) => { fundTotal += amountM(a.title); });

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
  if (funding.length) {
    lines.push(`MONEY IN PLAY: ~${money(fundTotal)} in disclosed funding across ${funding.length} stories.`);
    lines.push("");
  }
  if (mostCovered.length) {
    lines.push("MOST-CORROBORATED STORIES (same story, multiple outlets):");
    mostCovered.forEach((a) => lines.push(`- "${clean(a.title)}" — ${a.cluster} outlets`));
    lines.push("");
  }
  lines.push("A SAMPLE OF HEADLINES:");
  topStories.forEach((a) => lines.push(`- "${clean(a.title)}" (${a.source}) [${(a.tags || []).join(", ")}]`));
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
- Output ONLY the raw JSON object — no markdown, no code fences, no commentary before or after.`;
}

/* ---- call the Claude CLI in headless print mode ---- */
function callClaude(prompt) {
  // Plain text output: stdout is simply the model's reply. Simpler and more
  // robust than the JSON envelope, which a startup banner line can corrupt.
  const args = ["-p"];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (res.error) { console.warn(`  ✗ claude CLI not runnable: ${res.error.message}`); return null; }

  const out = res.stdout || "";
  const err = clean(res.stderr || "");
  console.log(`  claude exit=${res.status} stdout=${out.length}b${err ? ` stderr=${JSON.stringify(err.slice(0, 400))}` : ""}`);
  if (res.status !== 0) { console.warn("  ✗ claude exited non-zero"); return null; }
  return out;
}

/* ---- pull the JSON object out of the model's reply ---- */
function extractBrief(text) {
  if (!text) return null;
  // Drop any code fences anywhere, then take the outermost {...}.
  let s = text.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  // Tolerate trailing commas before } or ] (a common model slip).
  const jsonStr = s.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1");
  let obj;
  try { obj = JSON.parse(jsonStr); } catch { return null; }

  const req = ["headline", "teaser", "whatsHappening", "whyItMatters"];
  for (const k of req) if (typeof obj[k] !== "string" || !obj[k].trim()) return null;
  if (clean(obj.whatsHappening).length < 80 || clean(obj.whyItMatters).length < 80) return null;

  const headline = clean(obj.headline).replace(/[.]+$/, "");
  const whatsHappening = clean(obj.whatsHappening);
  const whyItMatters = clean(obj.whyItMatters);
  return {
    headline,
    teaser: clean(obj.teaser),
    whatsHappening,
    whyItMatters,
    spoken: `Here's the brief. ${headline}. ${whatsHappening} Why it matters. ${whyItMatters}`,
    generatedAt: new Date().toISOString(),
    by: "claude",
  };
}

/* ---- main (never throws, never fails the build) ---- */
function main() {
  try {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      console.log("No Claude credentials in env — keeping deterministic brief.");
      return;
    }
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!data.articles || !data.articles.length) { console.log("No articles — skipping."); return; }

    console.log("Asking Claude to write the brief…");
    const reply = callClaude(buildPrompt(buildDigest(data)));
    const brief = extractBrief(reply);
    if (!brief) {
      console.log("Claude brief unavailable — keeping deterministic brief.");
      if (reply) console.log(`  raw reply (first 800 chars): ${JSON.stringify(reply.slice(0, 800))}`);
      return;
    }

    data.briefing = brief; // existing key keeps its position (before `articles`)
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    console.log(`✓ Brief rewritten by Claude — "${brief.headline}"`);
  } catch (err) {
    console.warn(`Brief enhancer error (keeping deterministic brief): ${err.message}`);
  }
}

if (require.main === module) main();

module.exports = { buildDigest, buildPrompt, extractBrief };
