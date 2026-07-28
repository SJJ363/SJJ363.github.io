/* ============================================================
   SEO build — the single source of truth for how every page on
   Insurtech Daily is made discoverable.

   Run after the data is refreshed (fetch-news + companies). It:
     • pre-renders a real, crawlable HTML page for every company
       at /company/<slug>/  (unique URL, title, description,
       canonical, OpenGraph/Twitter cards, JSON-LD, and the full
       coverage list server-rendered so it works without JS);
     • injects fresh structured data + a server-rendered company
       list into index.html and companies.html between markers;
     • regenerates sitemap.xml and robots.txt.

   Everything reads from data/news.json and data/companies.json —
   the same files the client uses — so the static pages and the
   live app never disagree.

   ── Keeping the site SEO-clean over time ────────────────────
   Any new generated page MUST go through head() so it gets a
   unique title, description, canonical, OG/Twitter and robots
   meta. Add its URL to buildSitemap(). That's the whole rule.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { admits } = require("./relevance");
const { TAXONOMY, FALLBACK_TAG, tagArticle, topicSlug } = require("./taxonomy");
const { fundingDeals } = require("./funding");
const { cardFor, W: OG_W, H: OG_H } = require("./og");

const ROOT = path.join(__dirname, "..");
const NEWS = path.join(ROOT, "data", "news.json");
const DB = path.join(ROOT, "data", "companies.json");
const BRIEFS = path.join(ROOT, "data", "briefs.json");
const STORE = path.join(ROOT, "data", "companies-store.json");

/* ── Site identity — change here, propagates everywhere ─────── */
const SITE = {
  // Canonical origin. Served from the custom domain declared in /CNAME —
  // keep the two in sync. Override with SITE_URL for previews/staging.
  origin: (process.env.SITE_URL || "https://insurtechdaily.io").replace(/\/+$/, ""),
  name: "Insurtech Daily",
  tagline: "Insurtech news, aggregated",
  description:
    "Insurtech funding, launches, partnerships and platform moves — aggregated from hundreds of outlets and refreshed through the day.",
  locale: "en_US",
  lang: "en",
  /* The default share card. PNG, not SVG, and that is the whole point:
     no link-preview crawler anywhere rasterizes SVG, so the vector card
     this used to point at rendered as no card at all — on Facebook,
     LinkedIn, X, Slack, Discord and iMessage alike. Cards are built by
     scripts/og.js; pick one per page type with cardFor(). */
  ogImage: cardFor("home"),
  /* Organization JSON-LD wants a logo, and a 1.91:1 news card is the
     wrong shape for one even now that it's the right format. */
  logo: "/assets/logo.png",
  twitter: "", // add "@handle" if/when one exists
};

const url = (p = "/") => SITE.origin + (p.startsWith("/") ? p : "/" + p);

/* ── Which company pages are worth indexing ─────────────────────
   A company that has appeared once gets a page with a headline, a
   summary line and an outbound link on it — nothing a search result
   should point at, and there are ~140 of them against ~30 with real
   depth. Mass-produced near-identical pages are a sitewide quality
   liability, not just dead weight on their own URLs.

   So thin pages are still *built* and still linked: the wire, the
   topic hubs, the companies index and the related-company badges all
   point at /company/<slug>/, and a reader who clicks one should land
   somewhere real. They are simply kept out of the index — noindex
   (so they can't rank) + follow (so their outbound links still
   count) — and out of the sitemap and the index's ItemList.

   The gate is a floor, not a decision: as the archive grows a company
   crosses it and its page becomes indexable on the next build, with
   no migration and no redirect. Lower it as the store deepens. */
const PAGE_MIN_STORIES = 3;
const indexable = (c) => (c.count || (c.articles || []).length) >= PAGE_MIN_STORIES;

/* ── Escaping ───────────────────────────────────────────────── */
const escHtml = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const escAttr = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/* Trim a description to a clean length on a word boundary. */
function clamp(s, n = 158) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

/* Absolute-date formatter — stable across builds (no "2h ago" drift on
   pre-rendered pages). Pinned to UTC: without it the date renders in the
   build machine's zone, so a local run west of Greenwich turns "Jul 24"
   into "Jul 23" on every page and CI turns it back on the next run. */
function fullDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
function isoDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toISOString().slice(0, 10) : "";
}

/* The favicon + font links are identical on every page — one place. */
const FAVICON =
  'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%23f7f4ee%22/><rect x=%2222%22 y=%2226%22 width=%228%22 height=%2250%22 fill=%22%239a2b1e%22/><rect x=%2238%22 y=%2234%22 width=%2240%22 height=%227%22 fill=%22%231c1a15%22/><rect x=%2238%22 y=%2249%22 width=%2240%22 height=%225%22 fill=%22%23837d70%22/><rect x=%2238%22 y=%2260%22 width=%2228%22 height=%225%22 fill=%22%23837d70%22/></svg>';

/* ── Analytics ──────────────────────────────────────────────────
   One Google tag for the whole site, written here and nowhere else.
   Generated pages pick it up from head(); the three hand-authored
   pages take the identical block through their SEO:GA marker. That
   split is the only way a page can end up with two tags — so never
   paste a second gtag snippet into a page, change GA_ID here.
   Set GA_ID="" to build a tag-free copy (local checks, forks). ── */
const GA_ID = process.env.GA_ID ?? "G-TMPWQVXYLF";
const ANALYTICS = GA_ID
  ? `  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${escAttr(GA_ID)}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${escAttr(GA_ID)}');
  </script>`
  : "";

const HEAD_ASSETS = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/style.css?v=20" />
  <link rel="icon" href="${FAVICON}" />
  <script src="/nav.js?v=1" defer></script>`;

/* ── The social card block ──────────────────────────────────────
   Written here and nowhere else, so every page — generated or
   hand-authored — carries an identical, complete set.

   The width/height/type trio is not decoration. Facebook and LinkedIn
   both queue an image they have not measured and render the link
   *without* a card on that first scrape; declaring the dimensions lets
   them lay the card out immediately, which is the difference between a
   preview on the first paste and a preview once someone re-shares.
   The alt text is what screen readers announce in a timeline, and X
   requires it to expose alt at all. ── */
function socialTags({ title, desc, cUrl, ogType, ogImage, imageAlt }) {
  const ogImg = url(ogImage || SITE.ogImage);
  const alt = imageAlt || `${SITE.name} — ${SITE.tagline}`;
  return `  <meta property="og:type" content="${escAttr(ogType)}" />
  <meta property="og:site_name" content="${escAttr(SITE.name)}" />
  <meta property="og:title" content="${escAttr(title)}" />
  <meta property="og:description" content="${escAttr(desc)}" />
  <meta property="og:url" content="${escAttr(cUrl)}" />
  <meta property="og:image" content="${escAttr(ogImg)}" />
  <meta property="og:image:secure_url" content="${escAttr(ogImg)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="${OG_W}" />
  <meta property="og:image:height" content="${OG_H}" />
  <meta property="og:image:alt" content="${escAttr(alt)}" />
  <meta property="og:locale" content="${SITE.locale}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escAttr(title)}" />
  <meta name="twitter:description" content="${escAttr(desc)}" />
  <meta name="twitter:image" content="${escAttr(ogImg)}" />
  <meta name="twitter:image:alt" content="${escAttr(alt)}" />${
    SITE.twitter ? `\n  <meta name="twitter:site" content="${escAttr(SITE.twitter)}" />` : ""
  }`;
}

/* ── The shared <head> builder — every page goes through here ── */
function head({
  title,
  description,
  canonical,
  ogType = "website",
  jsonld = [],
  robots = "index, follow, max-image-preview:large, max-snippet:-1",
  // Which share card this page type gets — a cardFor() path. Defaults to
  // the masthead card, so a new page type previews correctly on day one
  // and only needs its own card if it earns one.
  ogImage = SITE.ogImage,
  imageAlt,
  // Page-specific enhancement scripts (deferred, additive). The page must
  // still be complete without them — see rule 5 in CLAUDE.md.
  scripts = [],
}) {
  const desc = clamp(description);
  const cUrl = url(canonical);
  const ld = (Array.isArray(jsonld) ? jsonld : [jsonld])
    .filter(Boolean)
    .map(
      (obj) =>
        `  <script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n  </script>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="${SITE.lang}">
<head>
${ANALYTICS ? ANALYTICS + "\n" : ""}  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escAttr(desc)}" />
  <meta name="robots" content="${escAttr(robots)}" />
  <link rel="canonical" href="${escAttr(cUrl)}" />
  <meta name="theme-color" content="#f7f4ee" />

${socialTags({ title, desc, cUrl, ogType, ogImage, imageAlt })}

${HEAD_ASSETS}${scripts
    .map((s) => `\n  <script src="${escAttr(s)}" defer></script>`)
    .join("")}
${ld ? "\n" + ld + "\n" : ""}</head>`;
}

/* ── Shared chrome ──────────────────────────────────────────── */
const BRAND_MARK =
  `<a class="brand" href="/" aria-label="${escAttr(SITE.name)} home">` +
  `<span class="brand-tick"></span>` +
  `<span class="brand-name">Insurtech&nbsp;Daily</span></a>`;

/* ── The nav ────────────────────────────────────────────────────
   One builder for every page, hand-authored ones included (they take
   it through the SEO:NAV marker), so the Topics menu can never drift
   between the wire and the generated pages.

   Topics is a <details> dropdown rather than a link to the hub index:
   on a phone that turns "find the cyber stories" from three taps
   (Topics → hub → topic) into two, and the links are real <a>s in the
   served HTML, so crawlers get a link to every hub from every page.
   ── */
let NAV_TOPICS = [];

/* Taxonomy order, not story count — count order reshuffles the nav on
   every run and turns each build into a diff across ~200 pages. */
function setNavTopics(topics) {
  const order = new Map(
    [...TAXONOMY.map(([n]) => n), FALLBACK_TAG].map((n, i) => [topicSlug(n), i])
  );
  NAV_TOPICS = topics
    .map((t) => ({ name: t.name, slug: t.slug }))
    .sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99));
}

function navMarkup(active, currentTopic = "") {
  const cls = (n) => (n === active ? ' class="active" aria-current="page"' : "");
  // Funding sits at top level rather than inside Topics: /topic/funding/ is
  // the story feed, /funding/ is the deal table, and the table is the thing
  // worth a permanent slot — it's the only page here that isn't a list of
  // someone else's headlines.
  // No topics built yet (a first run, or an injection before the hubs
  // exist) — degrade to the plain link rather than an empty menu.
  const topics = NAV_TOPICS.length
    ? `      <details class="nav-drop"${active === "topics" ? ' data-active="true"' : ""}>
        <summary class="nav-drop-btn">Topics<span class="nav-caret" aria-hidden="true"></span></summary>
        <div class="nav-drop-menu">
${NAV_TOPICS.map(
  (t) =>
    `          <a href="/topic/${escAttr(t.slug)}/"${
      t.slug === currentTopic ? ' class="active" aria-current="page"' : ""
    }>${escHtml(t.name)}</a>`
).join("\n")}
          <a class="nav-drop-all" href="/topic/">All topics</a>
        </div>
      </details>`
    : `      <a href="/topic/"${cls("topics")}>Topics</a>`;

  return `    <nav class="nav" aria-label="Sections">
      <a href="/"${cls("wire")}>The Wire</a>
      <a href="/brief/"${cls("brief")}>The Brief</a>
      <a href="/funding/"${cls("funding")}>Funding</a>
${topics}
      <a href="/companies.html"${cls("companies")}>Companies</a>
    </nav>`;
}

function header(active, currentTopic = "") {
  return `  <header class="topbar">
    ${BRAND_MARK}
${navMarkup(active, currentTopic)}
  </header>`;
}

const FOOTER = `  <footer class="site-footer">
    <p class="foot-desc">
      <b>Insurtech Daily</b> is an aggregator of publicly available insurtech headlines.
      Every story links to its original source.
    </p>
    <p class="foot-meta">© ${new Date().getFullYear()}</p>
  </footer>`;

/* ── Structured-data fragments ──────────────────────────────── */
function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    url: url("/"),
    description: SITE.description,
    logo: url(SITE.logo),
  };
}

function websiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: url("/"),
    description: SITE.description,
    inLanguage: SITE.lang,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: url("/?q={search_term_string}") },
      "query-input": "required name=search_term_string",
    },
  };
}

function breadcrumbLd(crumbs) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: url(c.path),
    })),
  };
}

/* An ItemList of headlines/articles — used on the home page and
   company pages so search engines see the coverage as a list. */
function itemListLd(name, articles, limit = 30) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    numberOfItems: articles.length,
    itemListElement: articles.slice(0, limit).map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: a.link,
      name: a.title,
    })),
  };
}

/* ══════════════════════════════════════════════════════════════
   COMPANY PAGES — one real, crawlable page per company
   ══════════════════════════════════════════════════════════════ */
function companyArticleLi(a) {
  const tags = (a.tags || []).filter((t) => t !== "Industry").slice(0, 4);
  const tagHtml = tags.length
    ? `\n        <div class="card-tags">${tags
        .map((t) => `<span class="tag-pill">${escHtml(t)}</span>`)
        .join("")}</div>`
    : "";
  return `      <li class="story">
        <a class="story-main" href="${escAttr(a.link)}" target="_blank" rel="noopener noreferrer">
          <div class="meta"><span class="src">${escHtml(a.source)}</span><span class="dot"> · </span><span class="time">${escHtml(
    fullDate(a.publishedAt)
  )}</span></div>
          <h3>${escHtml(a.title)}</h3>${
    a.summary ? `\n          <p class="summary">${escHtml(a.summary)}</p>` : ""
  }
        </a>${tagHtml}
      </li>`;
}

function companyPageHtml(c) {
  const canonical = `/company/${c.slug}/`;
  const storyWord = c.count === 1 ? "story" : "stories";
  const sources = (c.sources || []).slice(0, 6).join(", ");
  const title = `${c.name} — insurtech news & coverage | ${SITE.name}`;
  const description =
    `${c.count} insurtech ${storyWord} on ${c.name}` +
    (sources ? `, reported by ${sources}` : "") +
    ". Funding, launches, partnerships and platform moves, tracked by Insurtech Daily.";

  const articles = c.articles || [];
  const thin = !indexable(c);

  // JSON-LD: breadcrumb + a CollectionPage that is about the company
  // (as an Organization) and contains the coverage as an ItemList.
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${c.name} — insurtech coverage`,
    url: url(canonical),
    description: clamp(description),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    about: { "@type": "Organization", name: c.name },
    mainEntity: itemListLd(`${c.name} coverage`, articles, 50),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Companies", path: "/companies.html" },
    { name: c.name, path: canonical },
  ]);

  const statBits = [`${c.count} ${storyWord}`];
  if (c.firstSeen) statBits.push(`tracked since ${fullDate(c.firstSeen)}`);
  if (c.lastSeen) statBits.push(`last seen ${fullDate(c.lastSeen)}`);

  // Facts blocks (themes / related / sources)
  const factBlocks = [];
  if (c.topics && c.topics.length) {
    factBlocks.push(
      `      <div class="co-fact">
        <h2 class="fact-label">Most-covered themes</h2>
        <div class="tags">${c.topics
          .map((t) => `<span class="tag-pill">${escHtml(t.name)}</span>`)
          .join("")}</div>
      </div>`
    );
  }
  if (c.related && c.related.length) {
    factBlocks.push(
      `      <div class="co-fact">
        <h2 class="fact-label">Also involved</h2>
        <div class="badges">${c.related
          .map(
            (r) =>
              `<a class="company-badge" href="/company/${escAttr(r.slug)}/">${escHtml(r.name)}</a>`
          )
          .join("")}</div>
      </div>`
    );
  }
  if (c.sources && c.sources.length) {
    factBlocks.push(
      `      <div class="co-fact">
        <h2 class="fact-label">Reported by</h2>
        <p class="co-sources">${escHtml(c.sources.join(", "))}</p>
      </div>`
    );
  }
  const facts = factBlocks.length
    ? `    <section class="co-facts">\n${factBlocks.join("\n")}\n    </section>`
    : "";

  const coverage = articles.length
    ? `    <h2 class="section-label">Coverage</h2>
    <ol class="feed" aria-label="Coverage">
${articles.map(companyArticleLi).join("\n")}
    </ol>`
    : `    <p class="empty">No coverage tracked yet.</p>`;

  return `${head({
    title,
    description,
    canonical,
    ogType: "profile",
    ogImage: cardFor("company"),
    imageAlt: `${c.name} on ${SITE.name}`,
    // Structured data on a noindex page is ignored anyway; emitting only
    // the breadcrumb keeps the markup honest about what this page is.
    jsonld: thin ? [crumbLd] : [collectionLd, crumbLd],
    robots: thin ? "noindex, follow" : undefined,
  })}
<body>
${header("companies")}

  <main id="top">
    <p class="crumb"><a href="/companies.html">← All companies</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Company</p>
      <h1 class="tagline">${escHtml(c.name)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
    </div>

${facts}

${coverage}
  </main>

${FOOTER}
</body>
</html>
`;
}

/* ══════════════════════════════════════════════════════════════
   THE BRIEF ARCHIVE — the only original writing on the site.
   news.json holds just the *current* briefing and is overwritten
   every run, so each build folds today's into data/briefs.json and
   gives every past day a permanent, crawlable URL of its own.
   ══════════════════════════════════════════════════════════════ */
function loadBriefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(BRIEFS, "utf8"));
    return Array.isArray(raw.briefs) ? raw.briefs : [];
  } catch {
    return []; // no archive yet — the first run creates it
  }
}

/* Upsert today's briefing. The workflow runs several times a day, so
   a date already in the archive is replaced rather than appended —
   each day keeps one page holding that day's latest brief. */
function recordBrief(news) {
  const b = news.briefing || {};
  // `b.date` is the brief's day in Central terms, stamped when it was written.
  // Prefer it over the UTC date of `generatedAt`, which rolls over to tomorrow
  // for anything written or retried after 18:00 CT — the archive would then
  // file the 18:00 slot's brief under the following day.
  const date = b.date || isoDate(b.generatedAt) || isoDate(news.updatedAt);

  // A failed Claude enhancement leaves the briefing empty. Never
  // publish a stub for it — that day simply gets no page, and the
  // next run backfills it if the brief comes back.
  if (!date || !b.headline || !b.whatsHappening) return loadBriefs();

  // The archive holds Claude's writing and nothing else — it is the only
  // original prose on the site, so a machine-assembled stand-in doesn't
  // belong in it however well it reads. A run that fell back leaves the
  // deterministic brief on the wire (the homepage always shows something)
  // but writes no archive entry: that date simply has no page until
  // brief-retry.yml lands a real one, which then upserts in place.
  //
  // Note the test is `!== "claude"`, not `=== "deterministic"`. The brief
  // fetch-news.js writes carries no `by` field at all — only write-brief.js
  // stamps one — so an equality test would archive an unstamped stub.
  //
  // This also subsumes the downgrade case that lost the 2026-07-26 brief: a
  // fallback run can't replace a Claude entry it may not write in the first place.
  if (b.by !== "claude") {
    console.log(`  ↻ ${date}: no archive entry yet — brief is ${b.by || "unwritten"}, waiting for Claude`);
    return loadBriefs();
  }

  // The wire refreshes after the brief is written, so most builds see prose
  // they have already archived — against a *later* batch. Re-stamping the
  // entry then would leave the prose describing the morning while storyCount
  // and topics described the evening. Identical prose means a finished entry:
  // leave it exactly as filed.
  const filed = loadBriefs().find((x) => x.date === date);
  if (filed && filed.headline === b.headline && filed.generatedAt === (b.generatedAt || news.updatedAt)) {
    return loadBriefs();
  }

  const entry = {
    date,
    headline: b.headline,
    teaser: b.teaser || "",
    whatsHappening: b.whatsHappening,
    whyItMatters: b.whyItMatters || "",
    generatedAt: b.generatedAt || news.updatedAt,
    by: b.by || "",
    storyCount: news.count || (news.articles || []).length,
    sourceCount: (news.sources || []).length,
    topics: (news.taxonomy || [])
      .slice()
      .sort((x, y) => (y.count || 0) - (x.count || 0))
      .slice(0, 6)
      .map((t) => ({ name: t.name, count: t.count })),
  };

  const briefs = loadBriefs().filter((x) => x.date !== date);
  briefs.push(entry);
  briefs.sort((x, y) => y.date.localeCompare(x.date)); // newest first
  fs.writeFileSync(
    BRIEFS,
    JSON.stringify(
      { updatedAt: new Date().toISOString(), count: briefs.length, briefs },
      null,
      2
    ) + "\n"
  );
  return briefs;
}

function briefBlocks(b) {
  const blocks = [
    `      <div class="brief-block">
        <h2 class="brief-label">What's happening</h2>
        <p class="brief-text">${escHtml(b.whatsHappening)}</p>
      </div>`,
  ];
  if (b.whyItMatters) {
    blocks.push(`      <div class="brief-block">
        <h2 class="brief-label">Why it matters</h2>
        <p class="brief-text">${escHtml(b.whyItMatters)}</p>
      </div>`);
  }
  return blocks.join("\n");
}

/* newer/older are the adjacent archive entries — the prev/next pair
   gives crawlers a path through every brief without the index. */
function briefPageHtml(b, newer, older) {
  const canonical = `/brief/${b.date}/`;
  const day = fullDate(b.date || b.generatedAt);
  const title = `${b.headline} — insurtech brief, ${day} | ${SITE.name}`;
  const description = b.teaser || b.whatsHappening;

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: clamp(b.headline, 110), // Google ignores headlines past ~110
    description: clamp(description),
    url: url(canonical),
    datePublished: b.generatedAt,
    dateModified: b.generatedAt,
    inLanguage: SITE.lang,
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    author: { "@type": "Organization", name: SITE.name, url: url("/") },
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      url: url("/"),
      logo: { "@type": "ImageObject", url: url(SITE.logo) },
    },
    // Google Discover and the news carousels read `image`, not og:image —
    // and a 1200×630 raster is what they want, same as the scrapers.
    image: {
      "@type": "ImageObject",
      url: url(cardFor("brief")),
      width: OG_W,
      height: OG_H,
    },
    articleSection: "Insurtech",
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "The Brief", path: "/brief/" },
    { name: day, path: canonical },
  ]);

  const statBits = [day];
  if (b.storyCount) statBits.push(`${b.storyCount} stories`);
  if (b.sourceCount) statBits.push(`${b.sourceCount} sources`);

  const topics = (b.topics || []).length
    ? `    <section class="co-facts">
      <div class="co-fact">
        <h2 class="fact-label">Most-covered that day</h2>
        <div class="tags">${b.topics
          .map(
            (t) =>
              `<span class="tag-pill">${escHtml(t.name)}${
                t.count ? ` <span class="cnt">${t.count}</span>` : ""
              }</span>`
          )
          .join("")}</div>
      </div>
    </section>`
    : "";

  const nav = [];
  if (older)
    nav.push(
      `<a class="brief-nav-link" rel="prev" href="/brief/${escAttr(older.date)}/">` +
        `<span class="brief-nav-dir">← Earlier</span>` +
        `<span class="brief-nav-title">${escHtml(older.headline)}</span></a>`
    );
  if (newer)
    nav.push(
      `<a class="brief-nav-link next" rel="next" href="/brief/${escAttr(newer.date)}/">` +
        `<span class="brief-nav-dir">Later →</span>` +
        `<span class="brief-nav-title">${escHtml(newer.headline)}</span></a>`
    );
  const navHtml = nav.length
    ? `    <nav class="brief-nav" aria-label="More briefs">\n      ${nav.join("\n      ")}\n    </nav>`
    : "";

  return `${head({
    title,
    description,
    canonical,
    ogType: "article",
    ogImage: cardFor("brief"),
    imageAlt: `The Brief, ${fullDate(b.date)} — ${SITE.name}`,
    jsonld: [articleLd, crumbLd],
  })}
<body>
${header("brief")}

  <main id="top">
    <p class="crumb"><a href="/brief/">← All briefs</a></p>

    <div class="intro brief-head-page">
      <p class="co-kicker">The Brief</p>
      <h1 class="tagline">${escHtml(b.headline)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
      ${b.teaser ? `<p class="brief-lede-text">${escHtml(b.teaser)}</p>` : ""}
    </div>

    <article class="brief-article">
${briefBlocks(b)}
    </article>

${topics}

${navHtml}

    <p class="brief-provenance">
      Written from the ${b.storyCount || ""} headlines Insurtech Daily aggregated
      that day. Every underlying story links to its original source on
      <a href="/">the wire</a>.
    </p>
  </main>

${FOOTER}
</body>
</html>
`;
}

function briefIndexHtml(briefs) {
  const canonical = "/brief/";
  const title = `The Brief — daily insurtech briefings | ${SITE.name}`;
  const description =
    "A daily read on what moved in insurtech — what's happening and why it matters, written from the headlines aggregated that day.";

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "The Brief — daily insurtech briefings",
    url: url(canonical),
    description: clamp(description),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    mainEntity: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Daily briefs",
      numberOfItems: briefs.length,
      itemListElement: briefs.slice(0, 50).map((b, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: url(`/brief/${b.date}/`),
        name: b.headline,
      })),
    },
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "The Brief", path: canonical },
  ]);

  const rows = briefs.length
    ? `    <ol class="feed brief-archive" aria-label="Brief archive">
${briefs
  .map(
    (b) => `      <li class="story">
        <a class="story-main" href="/brief/${escAttr(b.date)}/">
          <div class="meta"><span class="time">${escHtml(
            fullDate(b.date || b.generatedAt)
          )}</span>${
      b.storyCount
        ? `<span class="dot"> · </span><span class="src">${b.storyCount} stories</span>`
        : ""
    }</div>
          <h2>${escHtml(b.headline)}</h2>
          ${b.teaser ? `<p class="summary">${escHtml(b.teaser)}</p>` : ""}
        </a>
      </li>`
  )
  .join("\n")}
    </ol>`
    : `    <p class="empty">No briefs published yet.</p>`;

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("brief"),
    imageAlt: `The Brief archive — ${SITE.name}`,
    jsonld: [collectionLd, crumbLd],
  })}
<body>
${header("brief")}

  <main id="top">
    <div class="intro">
      <p class="co-kicker">Archive</p>
      <h1 class="tagline">The Brief</h1>
      <p class="statline">${briefs.length} briefing${
    briefs.length === 1 ? "" : "s"
  }  ·  what's happening and why it matters, every day</p>
    </div>

${rows}
  </main>

${FOOTER}
</body>
</html>
`;
}

function buildBriefPages(briefs) {
  const outRoot = path.join(ROOT, "brief");
  fs.mkdirSync(outRoot, { recursive: true });

  // Deliberately never pruned — unlike company pages, the archive
  // accumulating *is* the point. Every page is rewritten from the
  // store each run so template changes reach the whole archive.
  briefs.forEach((b, i) => {
    const dir = path.join(outRoot, b.date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "index.html"),
      briefPageHtml(b, briefs[i - 1], briefs[i + 1])
    );
  });
  fs.writeFileSync(path.join(outRoot, "index.html"), briefIndexHtml(briefs));
  console.log(
    `  ✓ ${briefs.length} brief page${briefs.length === 1 ? "" : "s"} under /brief/ + archive index`
  );
}

/* ══════════════════════════════════════════════════════════════
   TOPIC HUBS — one page per taxonomy category.
   The chips on the wire are a client-side filter with no URL, so
   none of this was reachable by a crawler. Built from the persistent
   store (every article ever seen) rather than the current batch,
   which is what keeps the smaller categories from being one-line
   pages: Health & Life has 9 stories across the archive but might
   have none in today's 140.
   ══════════════════════════════════════════════════════════════ */
/* topicSlug now lives in taxonomy.js — og.js names each hub's share
   card after the same slug, and two copies would drift silently. */

/* The store is keyed by link, with the article's fields as the value.
   It is an archive of everything ever admitted, including items let in
   under older, looser rules — so re-apply the current gate on the way
   out. Without it the hubs resurface a lettuce recall and a Red Sea
   strike that the wire has already stopped carrying. */
function storeArticles() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
    return Object.entries(raw.seen || {})
      .map(([link, v]) => ({ link, ...v }))
      .filter((a) => a && a.title && a.publishedAt)
      // Same rule the wire applies, shared with companies.js so the hubs,
      // the tracker and the company index can never disagree about what
      // the archive still counts as an insurtech story.
      .filter(admits)
      // Re-tag rather than trust the stored tags: those are frozen at
      // fetch time, so a taxonomy fix would never reach the archive.
      // Today that matters because Funding used to match a bare money
      // figure and swept in every earnings report and deal price.
      .map((a) => ({ ...a, tags: tagArticle(a.title + " " + (a.summary || "")) }));
  } catch {
    return [];
  }
}

function collectTopics(news) {
  const pool = storeArticles();
  const arts = pool.length ? pool : news.articles || [];
  const by = new Map();
  for (const a of arts) {
    for (const t of a.tags || []) {
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(a);
    }
  }
  return [...by.entries()]
    .map(([name, list]) => ({
      name,
      slug: topicSlug(name),
      articles: list
        .slice()
        .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt)),
    }))
    .filter((t) => t.slug && t.articles.length)
    .sort((a, b) => b.articles.length - a.articles.length);
}

const STORY_CAP = 60; // page weight guard; the count in the statline is the true total

function topicPageHtml(topic, allTopics, db, deals = []) {
  const canonical = `/topic/${topic.slug}/`;
  const n = topic.articles.length;
  const word = n === 1 ? "story" : "stories";
  const newest = topic.articles[0];
  const oldest = topic.articles[n - 1];

  // Companies already carry their own topic breakdown — invert it.
  const companies = (db.companies || [])
    .map((c) => {
      const hit = (c.topics || []).find((t) => t.name === topic.name);
      return hit ? { slug: c.slug, name: c.name, n: hit.count || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 14);

  const co = new Map();
  for (const a of topic.articles) {
    for (const t of a.tags || []) if (t !== topic.name) co.set(t, (co.get(t) || 0) + 1);
  }
  const related = [...co.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count, slug: topicSlug(name) }))
    .filter((r) => allTopics.some((t) => t.slug === r.slug));

  const srcMap = new Map();
  for (const a of topic.articles) if (a.source) srcMap.set(a.source, (srcMap.get(a.source) || 0) + 1);
  const sources = [...srcMap.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);

  const title = `${topic.name} — insurtech news & coverage | ${SITE.name}`;
  const description =
    `${n} insurtech ${word} tagged ${topic.name}` +
    (sources.length ? `, from ${sources.slice(0, 3).map(([s]) => s).join(", ")} and others` : "") +
    ". Tracked continuously by Insurtech Daily.";

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${topic.name} — insurtech coverage`,
    url: url(canonical),
    description: clamp(description),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    about: { "@type": "Thing", name: topic.name },
    mainEntity: itemListLd(`${topic.name} coverage`, topic.articles, 50),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Topics", path: "/topic/" },
    { name: topic.name, path: canonical },
  ]);

  const statBits = [`${n} ${word}`];
  if (oldest) statBits.push(`tracked since ${fullDate(oldest.publishedAt)}`);
  if (newest) statBits.push(`latest ${fullDate(newest.publishedAt)}`);

  // The funding hub and the funding tracker are two views of the same
  // subject and would otherwise compete for the same queries. Point the
  // hub at the table explicitly: this page is the reporting, that one is
  // the numbers, and the link tells both readers and crawlers which is which.
  const trackerCue =
    topic.slug === "funding" && deals.length
      ? `    <p class="topic-cue">Looking for the numbers? The
      <a href="/funding/">insurtech funding tracker</a> has all ${deals.length}
      disclosed rounds in one table — amount, stage, lead investor and source.</p>`
      : "";

  const factBlocks = [];
  if (companies.length) {
    factBlocks.push(`      <div class="co-fact">
        <h2 class="fact-label">Most active here</h2>
        <div class="badges">${companies
          .map(
            (c) =>
              `<a class="company-badge" href="/company/${escAttr(c.slug)}/">${escHtml(
                c.name
              )}</a>`
          )
          .join("")}</div>
      </div>`);
  }
  if (related.length) {
    factBlocks.push(`      <div class="co-fact">
        <h2 class="fact-label">Often alongside</h2>
        <div class="badges">${related
          .map(
            (r) =>
              `<a class="company-badge" href="/topic/${escAttr(r.slug)}/">${escHtml(
                r.name
              )} <span class="cnt">${r.count}</span></a>`
          )
          .join("")}</div>
      </div>`);
  }
  if (sources.length) {
    factBlocks.push(`      <div class="co-fact">
        <h2 class="fact-label">Reported by</h2>
        <p class="co-sources">${escHtml(sources.map(([s]) => s).join(", "))}</p>
      </div>`);
  }
  const facts = factBlocks.length
    ? `    <section class="co-facts">\n${factBlocks.join("\n")}\n    </section>`
    : "";

  const shown = topic.articles.slice(0, STORY_CAP);
  const more =
    n > shown.length
      ? `    <p class="topic-more">Showing the ${shown.length} most recent of ${n}.</p>`
      : "";

  return `${head({
    title,
    description,
    canonical,
    // One card per hub, keyed on the same slug that built the URL.
    ogImage: cardFor(`topic-${topic.slug}`),
    imageAlt: `${topic.name} — insurtech coverage on ${SITE.name}`,
    jsonld: [collectionLd, crumbLd],
  })}
<body>
${header("topics", topic.slug)}

  <main id="top">
    <p class="crumb"><a href="/topic/">← All topics</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Topic</p>
      <h1 class="tagline">${escHtml(topic.name)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
    </div>

${trackerCue}

${facts}

    <h2 class="section-label">Coverage</h2>
    <ol class="feed" aria-label="${escAttr(topic.name)} coverage">
${shown.map(companyArticleLi).join("\n")}
    </ol>
${more}
  </main>

${FOOTER}
</body>
</html>
`;
}

function topicIndexHtml(topics) {
  const canonical = "/topic/";
  const total = topics.reduce((s, t) => s + t.articles.length, 0);
  const title = `Topics — every insurtech theme we track | ${SITE.name}`;
  const description =
    "Browse insurtech coverage by theme — funding, M&A, AI and automation, embedded, claims and underwriting, cyber and more, each with its own running archive.";

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Insurtech topics",
    url: url(canonical),
    description: clamp(description),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    mainEntity: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Topics",
      numberOfItems: topics.length,
      itemListElement: topics.map((t, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: url(`/topic/${t.slug}/`),
        name: t.name,
      })),
    },
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Topics", path: canonical },
  ]);

  const rows = topics
    .map((t) => {
      const latest = t.articles[0];
      return `      <li class="story">
        <a class="story-main" href="/topic/${escAttr(t.slug)}/">
          <div class="meta"><span class="src">${t.articles.length} ${
        t.articles.length === 1 ? "story" : "stories"
      }</span>${
        latest
          ? `<span class="dot"> · </span><span class="time">latest ${escHtml(
              fullDate(latest.publishedAt)
            )}</span>`
          : ""
      }</div>
          <h2>${escHtml(t.name)}</h2>
          ${latest ? `<p class="summary">${escHtml(latest.title)}</p>` : ""}
        </a>
      </li>`;
    })
    .join("\n");

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("topics"),
    imageAlt: `Insurtech topics on ${SITE.name}`,
    jsonld: [collectionLd, crumbLd],
  })}
<body>
${header("topics")}

  <main id="top">
    <div class="intro">
      <p class="co-kicker">Browse</p>
      <h1 class="tagline">Topics</h1>
      <p class="statline">${topics.length} themes  ·  ${total} tagged ${
    total === 1 ? "story" : "stories"
  } across the archive</p>
    </div>

    <ol class="feed topic-list" aria-label="Topics">
${rows}
    </ol>
  </main>

${FOOTER}
</body>
</html>
`;
}

function buildTopicPages(topics, db, deals = []) {
  const outRoot = path.join(ROOT, "topic");
  fs.mkdirSync(outRoot, { recursive: true });

  // Prune categories that no longer exist, the way company pages do —
  // the taxonomy is a fixed list, so a stale directory means a rename.
  const wanted = new Set(topics.map((t) => t.slug));
  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (fs.statSync(dir).isDirectory() && !wanted.has(name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const t of topics) {
    const dir = path.join(outRoot, t.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), topicPageHtml(t, topics, db, deals));
  }
  fs.writeFileSync(path.join(outRoot, "index.html"), topicIndexHtml(topics));
  console.log(`  ✓ ${topics.length} topic pages under /topic/ + index`);
}

/* ══════════════════════════════════════════════════════════════
   THE FUNDING TRACKER — /funding/ + /funding/<YYYY-MM>/

   Every other generated page on this site restates headlines the
   source publications wrote, and competes with them on their own
   material. This one doesn't: no single outlet covers more than its
   own rounds, so a deduplicated table across all of them is
   information that exists nowhere else — which is the whole reason
   it's worth building, and why it gets a top-level nav slot.

   Deals are re-derived from the persistent store on every build (see
   funding.js), never persisted, so a fix to the extraction regexes
   retroactively corrects the whole archive — the same contract
   taxonomy.js has with tags.
   ══════════════════════════════════════════════════════════════ */

/* A month page with two rows is the same thin-content liability as a
   one-story company page, so it gets the same treatment: built and
   linked, but noindex and out of the sitemap until it fills up. */
const MONTH_MIN_DEALS = 3;

/* Table enhancement (stage filtering + column sorting). Versioned like the
   other assets so a change isn't held behind a cached copy. */
const FUNDING_JS = "/funding.js?v=1";

const monthKey = (iso) => String(iso || "").slice(0, 7); // 2026-07
function monthLabel(key) {
  const d = new Date(key + "-01T00:00:00Z");
  return isNaN(d)
    ? key
    : d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/* $243K / $5.5M / $180M / $1.2B — one formatter so the table, the
   summary line and the meta description can never disagree. */
function money(m) {
  if (!m || m <= 0) return "";
  if (m >= 1000) {
    const b = m / 1000;
    return "$" + (Math.round(b * 10) / 10).toFixed(b < 10 ? 1 : 0) + "B";
  }
  if (m < 1) return "$" + Math.round(m * 1000) + "K";
  return "$" + (Math.round(m * 10) / 10).toFixed(Number.isInteger(m) ? 0 : 1) + "M";
}

/* Attach the raising company to each deal.

   The company names come from companies.json (Claude-extracted, and far
   better than anything a regex gets out of a headline), joined on the
   article link. A headline names both sides of a round — "X raises $Y
   led by Z" — so of the companies on that article we take the one
   mentioned EARLIEST in the title, which is the raiser in essentially
   every headline construction. */
function attachCompanies(deals, db) {
  const byLink = new Map();
  for (const c of db.companies || []) {
    for (const a of c.articles || []) {
      if (!a.link) continue;
      if (!byLink.has(a.link)) byLink.set(a.link, []);
      byLink.get(a.link).push({ slug: c.slug, name: c.name });
    }
  }
  return deals.map((d) => {
    const cands = byLink.get(d.link) || [];
    const ranked = cands
      .map((c) => ({ ...c, at: d.title.toLowerCase().indexOf(c.name.toLowerCase()) }))
      .filter((c) => c.at >= 0)
      .sort((a, b) => a.at - b.at);
    return { ...d, company: ranked[0] || cands[0] || null };
  });
}

/* Second dedup pass, only possible once companies are attached.

   funding.js collapses re-reports by amount + shared headline tokens,
   which misses the case where two outlets describe one round in barely
   overlapping words — PolicyStreet's $26M Series C was filed both as
   "raises Series C to $26 mn" and "Extends Malaysia's Largest Insurtech
   Funding Round to US$26M", sharing exactly one distinctive token. Same
   company and same amount inside the window is the same round. */
function dedupeByCompany(deals) {
  const kept = [];
  for (const d of deals) {
    const dup =
      d.company &&
      kept.find(
        (k) =>
          k.company &&
          k.company.slug === d.company.slug &&
          Math.round(k.amountM) === Math.round(d.amountM) &&
          Math.abs(new Date(k.publishedAt) - new Date(d.publishedAt)) / 86400000 <= 45
      );
    if (dup) {
      if (d.source && !dup.alsoReportedBy.includes(d.source)) dup.alsoReportedBy.push(d.source);
      if (!dup.stage) dup.stage = d.stage;
      if (!dup.lead) dup.lead = d.lead;
      continue;
    }
    kept.push({ ...d, alsoReportedBy: [...d.alsoReportedBy] });
  }
  return kept;
}

function collectDeals(news, db) {
  const pool = storeArticles();
  const arts = pool.length ? pool : news.articles || [];
  return dedupeByCompany(attachCompanies(fundingDeals(arts), db));
}

/* One row. The company cell links to its page when we know it (internal
   link into the archive), the headline links out to whoever reported it.

   Both link cells carry .deal-link: in a dense financial table the site's
   bare `a { color: inherit }` makes a link indistinguishable from the text
   beside it, and a reader who doesn't know the cells are clickable never
   reaches the company archive or the reporting.

   The sort/filter keys are attributes on the <tr>, not values re-parsed
   out of the rendered cells — "$1.2B" and "Jul 3, 2026" are display
   formats, and a client that has to reverse them will eventually disagree
   with the formatter about what they meant. */
function dealRow(d) {
  const co = d.company
    ? `<a class="deal-link" href="/company/${escAttr(d.company.slug)}/">${escHtml(
        d.company.name
      )}</a>`
    : escHtml((d.title.split(/\s+(?:raises|secures|lands|closes|bags|nets)\b/i)[0] || "—").trim());
  const outlets = [d.source, ...(d.alsoReportedBy || [])].filter(Boolean);
  const also =
    outlets.length > 1
      ? `<span class="deal-also" title="${escAttr(outlets.join(", "))}">+${outlets.length - 1}</span>`
      : "";
  return `        <tr data-stage="${escAttr(d.stage || "")}" data-amount="${
    Number(d.amountM) || 0
  }" data-date="${escAttr(isoDate(d.publishedAt))}">
          <td class="deal-co">${co}</td>
          <td class="deal-amt">${escHtml(money(d.amountM))}</td>
          <td class="deal-stage">${d.stage ? escHtml(d.stage) : '<span class="deal-blank">—</span>'}</td>
          <td class="deal-lead">${d.lead ? escHtml(d.lead) : '<span class="deal-blank">—</span>'}</td>
          <td class="deal-date"><time datetime="${escAttr(isoDate(d.publishedAt))}">${escHtml(
    fullDate(d.publishedAt)
  )}</time></td>
          <td class="deal-src"><a class="deal-link" href="${escAttr(
            d.link
          )}" target="_blank" rel="noopener noreferrer">${escHtml(
    d.source || "source"
  )}<span class="deal-ext" aria-hidden="true">↗</span></a>${also}</td>
        </tr>`;
}

/* Amount and Announced are sortable; the other four aren't (Company and
   Lead are unranked names, Stage has its own filter, Source is the
   outlet). The control is the header itself — a <button> inside the <th>
   so it's reachable by keyboard and announced as a control, with aria-sort
   on the <th> carrying the state. Without JS it renders as plain header
   text: the caret and the pointer only appear once funding.js has marked
   the document enhanced. */
function sortableTh(label, key) {
  return `            <th scope="col" class="th-sort" aria-sort="none">
              <button type="button" class="th-sort-btn" data-sort="${escAttr(key)}">${escHtml(
    label
  )}<span class="sort-caret" aria-hidden="true"></span></button>
            </th>`;
}

function dealTable(deals, caption) {
  if (!deals.length) return `    <p class="empty">No disclosed rounds yet in this period.</p>`;
  return `    <p class="deal-status" id="deal-status" role="status" hidden></p>
    <div class="table-wrap">
      <table class="deal-table" data-deal-table>
        <caption class="sr-only">${escHtml(caption)}</caption>
        <thead>
          <tr>
            <th scope="col">Company</th>
${sortableTh("Amount", "amount")}
            <th scope="col">Stage</th>
            <th scope="col">Lead investor</th>
${sortableTh("Announced", "date")}
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
${deals.map(dealRow).join("\n")}
        </tbody>
      </table>
    </div>`;
}

/* The disclosure note is the honest part of the tracker and the only
   prose on it: what's counted, what isn't, and why the total is a
   floor. Shown on every tracker page. */
const METHOD_NOTE = `    <section class="method">
      <h2 class="fact-label">How this is compiled</h2>
      <p class="method-text">
        Every row is a funding round announced in the insurtech press and
        aggregated by Insurtech Daily. A round is counted only when a
        publication states a figure in US dollars, so raises disclosed
        only in other currencies, and rounds closed without a number, are
        absent. Market-size forecasts, earnings, acquisition prices and
        catastrophe losses are excluded, as are valuations — a headline
        that gives only what a company is now worth, and not what it
        raised, is not counted as a round. The same round reported by
        several outlets is collapsed into one row, with the extra outlets
        counted in the source column. Stage and lead investor are filled
        in only where a headline states them outright and left blank
        otherwise. Totals are therefore a floor on real activity, not a
        market estimate. Figures link to the reporting they come from —
        check it before citing.
      </p>
      <p class="method-text">
        This tracker is a work in progress, and data may contain errors
        and/or some rounds may be missing from this tracker. We do not
        guarantee the accuracy or completeness of the data tracked here.
      </p>
    </section>`;

function fundingSummary(deals) {
  const total = deals.reduce((s, d) => s + d.amountM, 0);
  const stages = new Map();
  for (const d of deals) if (d.stage) stages.set(d.stage, (stages.get(d.stage) || 0) + 1);
  const biggest = deals.slice().sort((a, b) => b.amountM - a.amountM)[0];
  return { total, stages: [...stages.entries()].sort((a, b) => b[1] - a[1]), biggest };
}

/* Page-weight guard, the table equivalent of STORY_CAP. The summary line
   and the totals always count every round — only the rendered rows are
   capped, and the months below hold the rest. */
const DEAL_CAP = 150;

/* The month list is navigation and a data series at the same time: the
   count per month is the only volume history the site holds, and spelling
   it out on two dozen identical pills wastes it — "July 2026 11" doesn't
   even read as two fields. So it's drawn as a small column chart on a
   fixed 12-column calendar grid, one row per year, which is what makes
   the years stack into aligned columns you can read down.

   Two consequences worth keeping: the list grows a row a year instead of
   a pill a month, and months inside the covered range that produced no
   rounds show up as gaps in the axis, which is information the pill
   strip couldn't express at all. Newest year first (the page's order
   everywhere else), Jan→Dec inside a year, so time still runs left to
   right where it's being compared. */
function monthChart(months) {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const byKey = new Map(months.map((m) => [m.key, m]));
  const keys = months.map((m) => m.key).sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  const max = Math.max(...months.map((m) => m.deals.length));

  const years = [];
  for (let y = +last.slice(0, 4); y >= +first.slice(0, 4); y--) years.push(y);

  const rows = years.map((y) => {
    const cells = MON.map((label, i) => {
      const key = `${y}-${String(i + 1).padStart(2, "0")}`;
      // The initial carries the column on a phone, where three letters
      // in a twelfth of 375px would collide.
      const mo = `<span class="mo-m" aria-hidden="true">${label[0]}<span class="mo-rest">${label.slice(
        1
      )}</span></span>`;
      const m = byKey.get(key);
      if (!m) {
        // Outside the covered range there was nothing to miss, so the
        // label goes but the baseline stays — a ragged axis would read
        // as a rendering fault rather than as coverage.
        const out = key < first || key > last;
        return `<li class="mo-cell${out ? " mo-out" : " mo-zero"}">
              <span class="mo-bar"></span>${mo}
            </li>`;
      }
      const n = m.deals.length;
      return `<li class="mo-cell">
              <a class="mo-link" href="/funding/${escAttr(key)}/" aria-label="${escAttr(
        monthLabel(key)
      )} — ${n} round${n === 1 ? "" : "s"}">
                <span class="mo-n" aria-hidden="true">${n}</span>
                <span class="mo-bar"><i style="height:${Math.round((n / max) * 100)}%"></i></span>${mo}
              </a>
            </li>`;
    }).join("\n            ");
    return `          <div class="mo-year">
            <span class="mo-y">${y}</span>
            <ol class="mo-row">
            ${cells}
            </ol>
          </div>`;
  }).join("\n");

  return `      <div class="co-fact co-fact-wide">
        <h2 class="fact-label">By month <span class="fact-sub">— disclosed rounds per month</span></h2>
        <div class="mo-chart">
${rows}
        </div>
      </div>`;
}

function fundingIndexHtml(deals, months) {
  const canonical = "/funding/";
  const { total, stages, biggest } = fundingSummary(deals);
  const n = deals.length;
  const shown = deals.slice(0, DEAL_CAP);
  const oldest = deals[n - 1];
  const title = `Insurtech funding tracker — every disclosed round | ${SITE.name}`;
  const description =
    `${n} disclosed insurtech funding round${n === 1 ? "" : "s"} totalling at least ${money(
      total
    )} — company, amount, stage, lead investor and source for each, updated through the day.`;

  // A table of rounds genuinely is a dataset; describing it as one is both
  // accurate and the markup Google's dataset surfaces look for.
  const datasetLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Insurtech funding rounds",
    description: clamp(description, 300),
    url: url(canonical),
    keywords: ["insurtech", "funding rounds", "venture capital", "insurance technology"],
    license: url("/funding/"),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: SITE.name, url: url("/") },
    inLanguage: SITE.lang,
    ...(oldest && deals[0]
      ? { temporalCoverage: `${isoDate(oldest.publishedAt)}/${isoDate(deals[0].publishedAt)}` }
      : {}),
    variableMeasured: ["Company", "Amount raised (USD)", "Round stage", "Lead investor", "Announcement date"],
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Funding tracker", path: canonical },
  ]);

  const statBits = [`${n} round${n === 1 ? "" : "s"}`, `${money(total)} disclosed`];
  if (oldest) statBits.push(`since ${fullDate(oldest.publishedAt)}`);

  const factBlocks = [];
  if (stages.length) {
    // The stage pills looked like controls long before they were any, so
    // they are now the filter: real <button>s with aria-pressed, multi-select
    // (an OR across the selected stages), driven by funding.js. Server-side
    // they still read as the stage breakdown they always were, which is what
    // a crawler and a JS-less reader get.
    factBlocks.push(`      <div class="co-fact co-fact-wide">
        <h2 class="fact-label">By stage <span class="fact-hint">— select to filter the table</span></h2>
        <div class="tags stage-filters" role="group" aria-label="Filter rounds by stage">${stages
          .map(
            ([s, c]) =>
              `<button type="button" class="tag-pill stage-filter" data-stage="${escAttr(
                s
              )}" aria-pressed="false">${escHtml(s)} <span class="cnt">${c}</span></button>`
          )
          .join("")}<button type="button" class="stage-clear" hidden>Clear</button></div>
      </div>`);
  }
  if (biggest) {
    factBlocks.push(`      <div class="co-fact">
        <h2 class="fact-label">Largest round</h2>
        <p class="co-sources"><b>${escHtml(money(biggest.amountM))}</b> — ${
      biggest.company
        ? `<a class="deal-link" href="/company/${escAttr(biggest.company.slug)}/">${escHtml(
            biggest.company.name
          )}</a>`
        : escHtml(biggest.title)
    }</p>
      </div>`);
  }
  if (months.length) factBlocks.push(monthChart(months));
  const facts = factBlocks.length
    ? `    <section class="co-facts">\n${factBlocks.join("\n")}\n    </section>`
    : "";

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("funding"),
    imageAlt: `Insurtech funding tracker — ${SITE.name}`,
    jsonld: [datasetLd, crumbLd],
    scripts: [FUNDING_JS],
  })}
<body>
${header("funding")}

  <main id="top">
    <div class="intro co-head">
      <p class="co-kicker">Tracker</p>
      <h1 class="tagline">Insurtech funding rounds</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
      <p class="dek">
        Compiles insurtech raises with disclosed dollar figures, pulled from
        across the trade press and deduplicated into one table. For the
        reporting behind the numbers, see <a href="/topic/funding/">funding coverage</a>.
      </p>
    </div>

${facts}

    <h2 class="section-label">${shown.length < n ? "Most recent rounds" : "All disclosed rounds"}</h2>
${dealTable(shown, "Insurtech funding rounds — company, amount, stage, lead investor, date and source")}
${
  shown.length < n
    ? `    <p class="topic-more">Showing the ${shown.length} most recent of ${n}. Earlier rounds are on the monthly pages above.</p>`
    : ""
}

${METHOD_NOTE}
  </main>

${FOOTER}
</body>
</html>
`;
}

function fundingMonthHtml(m, newer, older) {
  const canonical = `/funding/${m.key}/`;
  const label = monthLabel(m.key);
  const deals = m.deals;
  const { total, biggest } = fundingSummary(deals);
  const n = deals.length;
  const thin = n < MONTH_MIN_DEALS;

  const title = `Insurtech funding rounds, ${label} | ${SITE.name}`;
  const description =
    `${n} disclosed insurtech funding round${n === 1 ? "" : "s"} announced in ${label}, ` +
    `totalling at least ${money(total)}` +
    (biggest && biggest.company ? `, led by ${biggest.company.name}'s ${money(biggest.amountM)}` : "") +
    ".";

  const datasetLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Insurtech funding rounds — ${label}`,
    description: clamp(description, 300),
    url: url(canonical),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: SITE.name, url: url("/") },
    inLanguage: SITE.lang,
    temporalCoverage: m.key,
    isPartOf: { "@type": "Dataset", name: "Insurtech funding rounds", url: url("/funding/") },
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Funding tracker", path: "/funding/" },
    { name: label, path: canonical },
  ]);

  const nav = [];
  if (older)
    nav.push(
      `<a class="brief-nav-link" rel="prev" href="/funding/${escAttr(older.key)}/">` +
        `<span class="brief-nav-dir">← Earlier</span>` +
        `<span class="brief-nav-title">${escHtml(monthLabel(older.key))}</span></a>`
    );
  if (newer)
    nav.push(
      `<a class="brief-nav-link next" rel="next" href="/funding/${escAttr(newer.key)}/">` +
        `<span class="brief-nav-dir">Later →</span>` +
        `<span class="brief-nav-title">${escHtml(monthLabel(newer.key))}</span></a>`
    );
  const navHtml = nav.length
    ? `    <nav class="brief-nav" aria-label="Other months">\n      ${nav.join("\n      ")}\n    </nav>`
    : "";

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("funding"),
    imageAlt: `Insurtech funding, ${label} — ${SITE.name}`,
    jsonld: thin ? [crumbLd] : [datasetLd, crumbLd],
    robots: thin ? "noindex, follow" : undefined,
    // No stage filters on a month page (there's no facts block), but the
    // table sorts the same way — one script, one behaviour.
    scripts: [FUNDING_JS],
  })}
<body>
${header("funding")}

  <main id="top">
    <p class="crumb"><a href="/funding/">← Full funding tracker</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Tracker</p>
      <h1 class="tagline">Insurtech funding, ${escHtml(label)}</h1>
      <p class="statline">${escHtml(
        [`${n} round${n === 1 ? "" : "s"}`, `${money(total)} disclosed`].join("  ·  ")
      )}</p>
    </div>

${dealTable(deals, `Insurtech funding rounds announced in ${label}`)}

${navHtml}

${METHOD_NOTE}
  </main>

${FOOTER}
</body>
</html>
`;
}

/* Group into months, newest first. Months are derived from the data
   rather than authored, so — unlike the brief archive — stale
   directories are pruned: a dedup fix that empties a month should
   remove its page, not leave an orphan behind.

   While the archive spans a single month, that month's page would be a
   byte-for-byte duplicate of /funding/ — the worst kind of extra URL, a
   second copy of the page you actually want ranked. So the split only
   starts once there are two months to split. It begins on its own the
   first time a month rolls over; nothing has to be migrated, because
   both pages are rebuilt from the store every run. */
function collectMonths(deals) {
  const by = new Map();
  for (const d of deals) {
    const k = monthKey(d.publishedAt);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(d);
  }
  const months = [...by.entries()]
    .map(([key, list]) => ({ key, deals: list }))
    .sort((a, b) => b.key.localeCompare(a.key));
  return months.length > 1 ? months : [];
}

function buildFundingPages(deals, months) {
  const outRoot = path.join(ROOT, "funding");
  fs.mkdirSync(outRoot, { recursive: true });

  const wanted = new Set(months.map((m) => m.key));
  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (fs.statSync(dir).isDirectory() && !wanted.has(name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  months.forEach((m, i) => {
    const dir = path.join(outRoot, m.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), fundingMonthHtml(m, months[i - 1], months[i + 1]));
  });
  fs.writeFileSync(path.join(outRoot, "index.html"), fundingIndexHtml(deals, months));

  const idx = months.filter((m) => m.deals.length >= MONTH_MIN_DEALS).length;
  console.log(
    `  ✓ funding tracker — ${deals.length} deals, ${months.length} month page${
      months.length === 1 ? "" : "s"
    } (${idx} indexable, ${months.length - idx} noindex under ${MONTH_MIN_DEALS} deals)`
  );
}

/* ══════════════════════════════════════════════════════════════
   INJECTION into hand-authored pages (between HTML markers)
   ══════════════════════════════════════════════════════════════ */
function replaceBlock(html, marker, content) {
  const start = `<!-- SEO:${marker} -->`;
  const end = `<!-- /SEO:${marker} -->`;
  const re = new RegExp(
    `${start}[\\s\\S]*?${end}`,
    "m"
  );
  const block = `${start}\n${content}\n${end}`;
  if (re.test(html)) return html.replace(re, block);
  console.warn(`  ! marker SEO:${marker} not found — skipped`);
  return html;
}

/* The hand-authored pages don't go through head(), so the Google tag
   reaches them the same way the nav does — through a marker, refreshed
   every build. company.html is in the list for completeness; it is a
   redirect shim that replaces the location before the async tag can
   load, so it will rarely record a hit. */
const GA_PAGES = ["index.html", "companies.html", "company.html"];

function injectAnalytics() {
  let n = 0;
  for (const file of GA_PAGES) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, "utf8");
    const next = replaceBlock(html, "GA", ANALYTICS);
    if (next !== html) fs.writeFileSync(p, next);
    n++;
  }
  console.log(
    GA_ID
      ? `  ✓ Google tag ${GA_ID} on ${n} hand-authored page${n === 1 ? "" : "s"}`
      : `  ✓ analytics disabled (GA_ID empty) — tag cleared from ${n} page${n === 1 ? "" : "s"}`
  );
}

/* ── Social cards on the hand-authored pages ────────────────────
   Same problem the Google tag has: index.html and companies.html
   don't go through head(), so without a marker they keep whatever
   OG block was hand-typed into them — which is exactly how they
   ended up pointing at an SVG card that no platform renders, and
   stayed there through every subsequent build.

   So the block is generated for them too, from the same
   socialTags() the generated pages use. The per-page title and
   description live here rather than in the file, because they are
   now inputs to a builder rather than markup.

   Note these three are NOT the page's <title>/<meta description> —
   those stay hand-authored in the file. This is the share card's
   copy, which reads better shorter. ── */
const SOCIAL_PAGES = [
  {
    file: "index.html",
    canonical: "/",
    ogType: "website",
    card: "home",
    title: `${SITE.name} — insurtech news, aggregated all day`,
    description: SITE.description,
    imageAlt: `${SITE.name} — insurtech news, aggregated all day`,
  },
  {
    file: "companies.html",
    canonical: "/companies.html",
    ogType: "website",
    card: "companies",
    title: `Companies tracked — ${SITE.name}`,
    description:
      "A searchable index of every insurtech company tracked across Insurtech Daily's coverage.",
    imageAlt: `The company index on ${SITE.name}`,
  },
];

function injectSocial() {
  let n = 0;
  for (const p of SOCIAL_PAGES) {
    const file = path.join(ROOT, p.file);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, "utf8");
    const block = socialTags({
      title: p.title,
      desc: clamp(p.description),
      cUrl: url(p.canonical),
      ogType: p.ogType,
      ogImage: cardFor(p.card),
      imageAlt: p.imageAlt,
    });
    const next = replaceBlock(html, "OG", block);
    if (next !== html) fs.writeFileSync(file, next);
    n++;
  }
  console.log(`  ✓ social cards on ${n} hand-authored page${n === 1 ? "" : "s"}`);
}

function injectHomepage(news) {
  const p = path.join(ROOT, "index.html");
  let html = fs.readFileSync(p, "utf8");
  const articles = news.articles || [];
  const ld = [
    websiteLd(),
    organizationLd(),
    itemListLd("Latest insurtech headlines", articles, 30),
  ];
  const block = ld
    .map(
      (o) =>
        `  <script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n  </script>`
    )
    .join("\n");
  html = replaceBlock(html, "JSONLD", block);
  html = replaceBlock(html, "NAV", navMarkup("wire"));
  fs.writeFileSync(p, html);
  console.log("  ✓ index.html structured data + nav");
}

function injectCompaniesIndex(db) {
  const p = path.join(ROOT, "companies.html");
  let html = fs.readFileSync(p, "utf8");
  const companies = (db.companies || [])
    .slice()
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  const indexed = companies.filter(indexable);

  // Server-rendered list — real <a> links so every company page is
  // reachable by a crawler without running JS. The client script
  // re-renders this for search, but the links are here first.
  const rows = companies
    .map((c) => {
      const meta =
        `<span class="co-count">${c.count} ${c.count === 1 ? "story" : "stories"}</span>` +
        (c.lastSeen
          ? `<span class="dot"> · </span><span class="co-latest">latest ${escHtml(
              fullDate(c.lastSeen)
            )}</span>`
          : "");
      return `      <li class="co-row"><a class="co-link" href="/company/${escAttr(
        c.slug
      )}/"><span class="co-name">${escHtml(
        c.name
      )}</span><span class="co-meta">${meta}</span></a></li>`;
    })
    .join("\n");
  html = replaceBlock(html, "COLIST", rows);

  const ld = [
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Companies", path: "/companies.html" },
    ]),
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `Companies — ${SITE.name}`,
      url: url("/companies.html"),
      description: "A searchable index of every company tracked across Insurtech Daily's coverage.",
      isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
      // Every company stays in the visible list above — the rows are for
      // readers. The ItemList is for crawlers, so it carries only the
      // pages that are actually indexable.
      mainEntity: {
        "@context": "https://schema.org",
        "@type": "ItemList",
        numberOfItems: indexed.length,
        itemListElement: indexed.slice(0, 100).map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: url(`/company/${c.slug}/`),
          name: c.name,
        })),
      },
    },
  ];
  const block = ld
    .map(
      (o) =>
        `  <script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n  </script>`
    )
    .join("\n");
  html = replaceBlock(html, "JSONLD", block);

  // Keep the visible count accurate even before JS runs.
  html = replaceBlock(html, "COCOUNT", String(companies.length));
  html = replaceBlock(html, "NAV", navMarkup("companies"));

  fs.writeFileSync(p, html);
  console.log(`  ✓ companies.html — ${companies.length} rows + structured data`);
}

/* ══════════════════════════════════════════════════════════════
   sitemap.xml + robots.txt
   ══════════════════════════════════════════════════════════════ */
function buildSitemap(news, db, briefs = [], topics = [], months = [], deals = []) {
  const now = isoDate(new Date().toISOString());
  const entries = [
    { loc: "/", lastmod: isoDate(news.updatedAt) || now, priority: "1.0", changefreq: "hourly" },
    {
      loc: "/companies.html",
      lastmod: isoDate(db.updatedAt) || now,
      priority: "0.8",
      changefreq: "daily",
    },
  ];
  if (briefs.length) {
    entries.push({
      loc: "/brief/",
      lastmod: briefs[0].date || now,
      priority: "0.9",
      changefreq: "daily",
    });
    // Original writing, so ranked above the aggregated company pages.
    // A past day's brief never changes once its date has rolled over.
    briefs.forEach((b, i) => {
      entries.push({
        loc: `/brief/${b.date}/`,
        lastmod: b.date || isoDate(b.generatedAt),
        priority: i === 0 ? "0.9" : "0.7",
        changefreq: i === 0 ? "daily" : "yearly",
      });
    });
  }
  if (deals.length) {
    // Ranked with the brief, above the aggregated hubs: it's the other page
    // here that isn't a restatement of someone else's reporting.
    entries.push({
      loc: "/funding/",
      lastmod: isoDate(deals[0].publishedAt) || now,
      priority: "0.9",
      changefreq: "daily",
    });
    // Thin months are noindex — listing them would only ask Google to crawl
    // what it has been told not to index (same rule as company pages).
    months
      .filter((m) => m.deals.length >= MONTH_MIN_DEALS)
      .forEach((m, i) => {
        entries.push({
          loc: `/funding/${m.key}/`,
          lastmod: isoDate(m.deals[0].publishedAt) || now,
          priority: "0.7",
          // A month that has closed can't gain rounds; only the current one moves.
          changefreq: i === 0 ? "daily" : "monthly",
        });
      });
  }
  if (topics.length) {
    entries.push({ loc: "/topic/", lastmod: now, priority: "0.8", changefreq: "daily" });
    topics.forEach((t) => {
      entries.push({
        loc: `/topic/${t.slug}/`,
        lastmod: isoDate(t.articles[0] && t.articles[0].publishedAt) || now,
        priority: "0.7",
        changefreq: "daily",
      });
    });
  }
  // Thin company pages are noindex, so listing them here would only ask
  // Google to crawl what it has been told not to index.
  (db.companies || [])
    .filter(indexable)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .forEach((c) => {
      entries.push({
        loc: `/company/${c.slug}/`,
        lastmod: isoDate(c.lastSeen) || now,
        priority: "0.6",
        changefreq: "weekly",
      });
    });

  const body = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${escHtml(url(e.loc))}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), xml);
  console.log(`  ✓ sitemap.xml — ${entries.length} URLs`);
}

function buildRobots() {
  const txt = `# Insurtech Daily — robots.txt (generated by scripts/seo.js)
User-agent: *
Allow: /

Sitemap: ${url("/sitemap.xml")}
`;
  fs.writeFileSync(path.join(ROOT, "robots.txt"), txt);
  console.log("  ✓ robots.txt");
}

/* ══════════════════════════════════════════════════════════════
   Company page directory management
   ══════════════════════════════════════════════════════════════ */
function buildCompanyPages(db) {
  const outRoot = path.join(ROOT, "company");
  fs.mkdirSync(outRoot, { recursive: true });

  const companies = db.companies || [];
  const wanted = new Set(companies.map((c) => c.slug));

  // Prune pages for companies that no longer exist (e.g. after a
  // merge/rename in the extraction layer) so the sitemap and the
  // filesystem never drift.
  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (fs.statSync(dir).isDirectory() && !wanted.has(name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const c of companies) {
    const dir = path.join(outRoot, c.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), companyPageHtml(c));
  }
  const n = companies.filter(indexable).length;
  console.log(
    `  ✓ ${companies.length} company pages under /company/ — ` +
      `${n} indexable, ${companies.length - n} noindex (under ${PAGE_MIN_STORIES} stories)`
  );
}

/* ── Entry point ────────────────────────────────────────────── */
function main() {
  const news = JSON.parse(fs.readFileSync(NEWS, "utf8"));
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));

  console.log("SEO build:");
  // Fold today's briefing into the archive before anything reads it,
  // so the new page lands in this run's sitemap rather than the next.
  const briefs = recordBrief(news);
  const topics = collectTopics(news);
  const deals = collectDeals(news, db);
  const months = collectMonths(deals);
  // Every page's nav lists the hubs, so the list has to exist before
  // the first page is written.
  setNavTopics(topics);
  buildCompanyPages(db);
  buildBriefPages(briefs);
  buildTopicPages(topics, db, deals);
  buildFundingPages(deals, months);
  injectAnalytics();
  injectSocial();
  injectHomepage(news);
  injectCompaniesIndex(db);
  buildSitemap(news, db, briefs, topics, months, deals);
  buildRobots();
  console.log("SEO build complete.");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("SEO build failed:", err.message);
    process.exit(1);
  }
}

module.exports = { head, SITE, companyPageHtml, briefPageHtml, clamp, isoDate };
