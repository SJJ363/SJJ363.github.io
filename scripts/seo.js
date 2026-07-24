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

const ROOT = path.join(__dirname, "..");
const NEWS = path.join(ROOT, "data", "news.json");
const DB = path.join(ROOT, "data", "companies.json");

/* ── Site identity — change here, propagates everywhere ─────── */
const SITE = {
  // Canonical origin. Override in CI with SITE_URL if a custom
  // domain is ever added (e.g. https://insurtechdaily.news).
  origin: (process.env.SITE_URL || "https://sjj363.github.io").replace(/\/+$/, ""),
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

/* Absolute-date formatter — stable across builds (no "2h ago"
   drift on pre-rendered pages). */
function fullDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
  <link rel="stylesheet" href="/style.css?v=13" />
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
      <a href="/companies.html"${cls("companies")}>Companies</a>
    </nav>
  </header>`;
}

const FOOTER = `  <footer class="site-footer">
    <p class="foot-desc">
      <b>Insurtech Daily</b> is an automated aggregator of publicly available insurtech headlines.
      Every story links to its original source.
    </p>
    <p class="foot-meta">Auto-refreshed via GitHub Actions · © ${new Date().getFullYear()}</p>
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
          <h3>${escHtml(a.title)}</h3>
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
function buildSitemap(news, db) {
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
  buildCompanyPages(db);
  injectHomepage(news);
  injectCompaniesIndex(db);
  buildSitemap(news, db);
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

module.exports = { head, SITE, companyPageHtml, clamp, isoDate };
