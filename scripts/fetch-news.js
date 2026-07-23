#!/usr/bin/env node
/* ============================================================
   Insurtech news fetcher
   Pulls RSS/Atom feeds, normalizes + dedupes, writes data/news.json.
   Dependency-free — runs on plain Node (18+). Fetched server-side
   (in GitHub Actions or locally), so no browser CORS issues.
   ============================================================ */

const fs = require("fs");
const path = require("path");

// Each feed: url + a fallback source label + whether to keyword-filter.
// Google News search feeds are already on-topic; broad feeds get filtered.
const FEEDS = [
  { url: "https://news.google.com/rss/search?q=insurtech&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=%22insurance+technology%22&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=%22digital+insurance%22&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=%22embedded+insurance%22&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://news.google.com/rss/search?q=insurtech+funding&hl=en-US&gl=US&ceid=US:en", source: "Google News" },
  { url: "https://www.finextra.com/rss/channel.aspx?channel=insurtech", source: "Finextra" },
];

// Relevance gate applied to every item — genuine insurtech coverage
// almost always mentions insurance in some form. Keeps the feed on-topic.
const RELEVANCE = /insur|insurtech|underwrit|reinsur|actuar|policyholder/i;

// Skip non-article URLs (e.g. Finextra webinars/events).
const SKIP_URL = /\/event-info\/|\/events?\/|\/webinar/i;

const MAX_ITEMS = 140;
const MAX_AGE_DAYS = 45;
const UA = "Mozilla/5.0 (compatible; InsurtechAggregator/1.0)";

/* ---------- tiny XML helpers ---------- */

function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s = "") {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// First inner text of <tag ...>...</tag>
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeEntities(m[1].trim()) : "";
}

// Extract blocks for a given element name (item or entry)
function blocks(xml, name) {
  const re = new RegExp(`<${name}[\\s>][\\s\\S]*?<\\/${name}>`, "gi");
  return xml.match(re) || [];
}

function extractLink(block) {
  // RSS: <link>URL</link>
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim().startsWith("http")) return decodeEntities(rss[1].trim());
  // Atom: <link href="URL" .../> (prefer rel="alternate")
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return decodeEntities(alt[1]);
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (any) return decodeEntities(any[1]);
  return "";
}

/* ---------- fetch + parse a feed ---------- */

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...blocks(xml, "item"), ...blocks(xml, "entry")];
    const out = [];

    for (const b of items) {
      const rawTitle = tag(b, "title");
      if (!rawTitle) continue;

      const link = extractLink(b);
      if (!link || SKIP_URL.test(link)) continue;

      // Date: RSS pubDate / dc:date, Atom published/updated
      const dateStr = tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated");
      const ts = dateStr ? Date.parse(dateStr) : NaN;
      if (isNaN(ts)) continue;
      // Drop future-dated items (events/webinars masquerading as news)
      if (ts > Date.now() + 864e5) continue;

      // Source: Google News embeds <source url=...>Publisher</source>
      let source = tag(b, "source") || feed.source;
      let title = rawTitle;
      // Google News titles are "Headline - Publisher"; strip the suffix.
      const dash = title.lastIndexOf(" - ");
      if (dash > 20 && source && title.slice(dash + 3).trim() === source) {
        title = title.slice(0, dash).trim();
      } else if (dash > 30) {
        const tail = title.slice(dash + 3).trim();
        if (tail.length < 40 && !/[.!?]$/.test(tail)) {
          if (!source || source === feed.source) source = tail;
          title = title.slice(0, dash).trim();
        }
      }

      let summary = stripTags(
        tag(b, "description") || tag(b, "summary") || tag(b, "content") || tag(b, "content:encoded")
      ).slice(0, 240);

      // Google News descriptions are usually just "Headline Source" — a
      // duplicate of the title. Drop those so cards read like a clean wire.
      const nt = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const ns = summary.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!ns || (ns.startsWith(nt.slice(0, 24)) && summary.length < title.length + source.length + 12)) {
        summary = "";
      }

      if (!RELEVANCE.test(title + " " + summary + " " + source)) continue;

      out.push({
        title: title.trim(),
        link,
        source: (source || "News").trim(),
        summary,
        publishedAt: new Date(ts).toISOString(),
        timestamp: ts,
      });
    }
    console.log(`  ✓ ${feed.url.slice(0, 60)}… → ${out.length}`);
    return out;
  } catch (err) {
    console.warn(`  ✗ ${feed.url.slice(0, 60)}… → ${err.message}`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/* ---------- main ---------- */

(async () => {
  console.log("Fetching insurtech feeds…");
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let all = results.flat();

  // Drop stale items
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  all = all.filter((a) => a.timestamp >= cutoff);

  // Dedupe by link and by normalized title
  const seen = new Set();
  const deduped = [];
  for (const a of all) {
    const keyLink = a.link.split("?")[0].toLowerCase();
    const keyTitle = a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(keyLink) || seen.has(keyTitle)) continue;
    seen.add(keyLink);
    seen.add(keyTitle);
    deduped.push(a);
  }

  deduped.sort((a, b) => b.timestamp - a.timestamp);
  const articles = deduped.slice(0, MAX_ITEMS);

  const payload = {
    updatedAt: new Date().toISOString(),
    count: articles.length,
    sources: [...new Set(articles.map((a) => a.source))].sort(),
    articles,
  };

  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "news.json"), JSON.stringify(payload, null, 2));
  console.log(`\nWrote data/news.json — ${articles.length} articles from ${payload.sources.length} sources.`);
})();
