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
const { RELEVANCE, onTopic } = require("./relevance");

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
  ogImage: "/assets/og.svg", // 1200×630 branded card (see assets/og.svg)
  twitter: "", // add "@handle" if/when one exists
};

const url = (p = "/") => SITE.origin + (p.startsWith("/") ? p : "/" + p);

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

const HEAD_ASSETS = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/style.css?v=15" />
  <link rel="icon" href="${FAVICON}" />`;

/* ── The shared <head> builder — every page goes through here ── */
function head({ title, description, canonical, ogType = "website", jsonld = [] }) {
  const desc = clamp(description);
  const ogImg = url(SITE.ogImage);
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
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escAttr(desc)}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <link rel="canonical" href="${escAttr(cUrl)}" />
  <meta name="theme-color" content="#f7f4ee" />

  <meta property="og:type" content="${ogType}" />
  <meta property="og:site_name" content="${escAttr(SITE.name)}" />
  <meta property="og:title" content="${escAttr(title)}" />
  <meta property="og:description" content="${escAttr(desc)}" />
  <meta property="og:url" content="${escAttr(cUrl)}" />
  <meta property="og:image" content="${escAttr(ogImg)}" />
  <meta property="og:locale" content="${SITE.locale}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escAttr(title)}" />
  <meta name="twitter:description" content="${escAttr(desc)}" />
  <meta name="twitter:image" content="${escAttr(ogImg)}" />${
    SITE.twitter ? `\n  <meta name="twitter:site" content="${escAttr(SITE.twitter)}" />` : ""
  }

${HEAD_ASSETS}
${ld ? "\n" + ld + "\n" : ""}</head>`;
}

/* ── Shared chrome ──────────────────────────────────────────── */
const BRAND_MARK =
  `<a class="brand" href="/" aria-label="${escAttr(SITE.name)} home">` +
  `<span class="brand-tick"></span>` +
  `<span class="brand-name">Insurtech&nbsp;Daily</span></a>`;

function header(active) {
  const cls = (n) => (n === active ? ' class="active" aria-current="page"' : "");
  return `  <header class="topbar">
    ${BRAND_MARK}
    <nav class="nav">
      <a href="/"${cls("wire")}>The Wire</a>
      <a href="/brief/"${cls("brief")}>The Brief</a>
      <a href="/topic/"${cls("topics")}>Topics</a>
      <a href="/companies.html"${cls("companies")}>Companies</a>
    </nav>
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
    logo: url(SITE.ogImage),
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
    jsonld: [collectionLd, crumbLd],
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
  const date = isoDate(b.generatedAt) || isoDate(news.updatedAt);

  // A failed Claude enhancement leaves the briefing empty. Never
  // publish a stub for it — that day simply gets no page, and the
  // next run backfills it if the brief comes back.
  if (!date || !b.headline || !b.whatsHappening) return loadBriefs();

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
  const day = fullDate(b.generatedAt || b.date);
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
      logo: { "@type": "ImageObject", url: url(SITE.ogImage) },
    },
    image: url(SITE.ogImage),
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

  return `${head({ title, description, canonical, ogType: "article", jsonld: [articleLd, crumbLd] })}
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
            fullDate(b.generatedAt || b.date)
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

  return `${head({ title, description, canonical, jsonld: [collectionLd, crumbLd] })}
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
const topicSlug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");

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
      .filter((a) => {
        // Same rule the wire applies, using the provenance the store
        // carries. Entries written before that flag existed have no
        // `native`, so they face the stricter test — which is the right
        // default for an archive of mixed vintage.
        const text = a.title + " " + (a.summary || "");
        return a.native ? onTopic(text) : RELEVANCE.test(text);
      });
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

function topicPageHtml(topic, allTopics, db) {
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

  return `${head({ title, description, canonical, jsonld: [collectionLd, crumbLd] })}
<body>
${header("topics")}

  <main id="top">
    <p class="crumb"><a href="/topic/">← All topics</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Topic</p>
      <h1 class="tagline">${escHtml(topic.name)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
    </div>

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

  return `${head({ title, description, canonical, jsonld: [collectionLd, crumbLd] })}
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

function buildTopicPages(topics, db) {
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
    fs.writeFileSync(path.join(dir, "index.html"), topicPageHtml(t, topics, db));
  }
  fs.writeFileSync(path.join(outRoot, "index.html"), topicIndexHtml(topics));
  console.log(`  ✓ ${topics.length} topic pages under /topic/ + index`);
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
  fs.writeFileSync(p, html);
  console.log("  ✓ index.html structured data");
}

function injectCompaniesIndex(db) {
  const p = path.join(ROOT, "companies.html");
  let html = fs.readFileSync(p, "utf8");
  const companies = (db.companies || [])
    .slice()
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

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
      mainEntity: {
        "@context": "https://schema.org",
        "@type": "ItemList",
        numberOfItems: companies.length,
        itemListElement: companies.slice(0, 100).map((c, i) => ({
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

  fs.writeFileSync(p, html);
  console.log(`  ✓ companies.html — ${companies.length} rows + structured data`);
}

/* ══════════════════════════════════════════════════════════════
   sitemap.xml + robots.txt
   ══════════════════════════════════════════════════════════════ */
function buildSitemap(news, db, briefs = [], topics = []) {
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
        lastmod: isoDate(b.generatedAt) || b.date,
        priority: i === 0 ? "0.9" : "0.7",
        changefreq: i === 0 ? "daily" : "yearly",
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
  (db.companies || [])
    .slice()
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
  console.log(`  ✓ ${companies.length} company pages under /company/`);
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
  buildCompanyPages(db);
  buildBriefPages(briefs);
  buildTopicPages(topics, db);
  injectHomepage(news);
  injectCompaniesIndex(db);
  buildSitemap(news, db, briefs, topics);
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
