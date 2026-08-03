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
const { TAXONOMY, FALLBACK_TAG, tagArticle, topicSlug, subjectOf } = require("./taxonomy");
const { fundingDeals } = require("./funding");
const {
  collectTerms: collectGlossaryTerms,
  indexableTerm,
  MIN_STORIES: GLOSSARY_MIN_STORIES,
  STORY_CAP: GLOSSARY_STORY_CAP,
} = require("./glossary");
const {
  countryOf,
  inMarket,
  indexableMarket,
  MIN_COMPANIES: MARKET_MIN_COMPANIES,
  MIN_STORIES: MARKET_MIN_STORIES,
  COMPANY_CAP: MARKET_COMPANY_CAP,
  STORY_CAP: MARKET_STORY_CAP,
  DEAL_CAP: MARKET_DEAL_CAP,
} = require("./markets");
const { cardFor, W: OG_W, H: OG_H } = require("./og");
const { linker, companyLinker, plainLinker } = require("./autolink");

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
   no migration and no redirect. Lower it as the store deepens.

   The story count is not the only door. A company with one story but a
   disclosed funding round is not a thin page — the round is a *fact*
   about the company (amount, stage, lead, date, deduplicated across
   every outlet that reported it), and that table exists nowhere else
   for companies this small. The reason to withhold a one-story page is
   that it restates someone else's headline; that reason doesn't apply
   to a page carrying data the tracker assembled. So funded companies
   pass on their funding block alone.

   There is a third door, and it closes the gate's original argument
   rather than loosening it. The stated reason to withhold a one-story
   page is that it *restates one outlet's headline*. A page carrying an
   original profile — what the company does, which side of the market
   it sits on, where it is (rule 3a-ii) — is no longer doing that. The
   profile is the thing whose absence the gate was describing.

   Two conditions, not one. The profile must be `known` (the writer
   declines rather than guessing, so a decline is real evidence there
   was nothing to say), and its `kind` must be set and not "Other".
   `kind` is the model's answer to "which side of the insurance market
   is this", so a blank means it couldn't place the company at all, and
   "Other" means it placed it *outside* the market: measured against
   the first profiled batch, "Other" caught exactly the pages for a
   grocery-delivery company, an asset-financing lender and an electric
   utility — all honest pages, none of them insurtech content that
   should compete in search. They stay built and linked, as thin pages
   always have.

   PAGE_MIN_STORIES itself does NOT move. Lowering it globally would
   admit the pages that have no profile too, which is the exact
   mass-produced-stub failure this whole gate exists to prevent.

   FUNDED_SLUGS and PROFILED_SLUGS are both set once per build, the
   same way NAV_TOPICS is, because every reader of the gate — the page
   builder, the sitemap and the companies index — has to agree about
   it. */
const PAGE_MIN_STORIES = 3;
let FUNDED_SLUGS = new Set();
function setFundedSlugs(deals) {
  FUNDED_SLUGS = new Set(deals.filter((d) => d.company).map((d) => d.company.slug));
}
let PROFILED_SLUGS = new Set();
function setProfiledSlugs(profiles = {}) {
  PROFILED_SLUGS = new Set(
    Object.entries(profiles)
      .filter(([, p]) => p && p.known && p.kind && p.kind !== "Other")
      .map(([slug]) => slug)
  );
}
const indexable = (c) =>
  (c.count || (c.articles || []).length) >= PAGE_MIN_STORIES ||
  FUNDED_SLUGS.has(c.slug) ||
  PROFILED_SLUGS.has(c.slug);

/* ── Escaping ───────────────────────────────────────────────── */
const escHtml = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/* The live glossary terms, for the contextual links autolink.js puts
   into our own prose. Set once per build like NAV_TOPICS and
   FUNDED_SLUGS above, and for the same reason: the company pages, the
   topic hubs and the glossary itself all link against this list, they
   are built in three different passes, and a list that differed
   between them would link terms some pages have a page for and others
   do not.

   It has to be set BEFORE buildCompanyPages(), which is why main()
   computes the terms up front and hands them to buildGlossaryPages()
   later, rather than that function collecting them itself. */
let LINK_TERMS = [];
function setLinkTerms(terms) {
  LINK_TERMS = terms || [];
}
/* One linker per page — it is stateful (first mention only, page
   budget), so sharing one across pages would silently stop linking
   after the first few. */
const proseLinker = (self = null) =>
  LINK_TERMS.length ? linker({ terms: LINK_TERMS, self, esc: escHtml }) : plainLinker(escHtml);

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
  <link rel="stylesheet" href="/style.css?v=33" />
  <link rel="icon" href="${FAVICON}" />
  <link rel="alternate" type="application/rss+xml" title="Insurtech Daily — The Brief" href="/feed.xml" />
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

/* The glossary is linked from here rather than from the nav, and that
   is a constraint rather than a preference: five items is what the
   375px and 360px rows in style.css are measured for (rule 2b), and a
   sixth needs those breakpoints re-measured, not assumed. The footer
   is on every generated page, so one link here is a route from
   everywhere — which is what a hub with no nav slot needs to be
   crawlable at all. Same reasoning as /funding/companies/, which is
   reached from the tracker index and the company blocks. */
/* The hubs with no nav slot, written here and nowhere else. Generated
   pages take it through FOOTER; index.html and companies.html take the
   identical markup through their <!-- SEO:FOOTLINKS --> markers, every
   build (rule 2d) — because those two are the highest-authority pages
   on the site and had no footer links at all, so /glossary/,
   /funding/companies/ and /market/ got nothing from either. */
const FOOT_LINKS = `    <p class="foot-links"><a href="/glossary/">Insurance glossary</a> ·
      <a href="/funding/companies/">Most funded companies</a> ·
      <a href="/market/">Markets</a> ·
      <a href="/topic/">All topics</a> ·
      <a href="/feed.xml">RSS</a></p>`;

const FOOTER = `  <footer class="site-footer">
    <p class="foot-desc">
      <b>Insurtech Daily</b> is an aggregator of publicly available insurtech headlines.
      Every story links to its original source.
    </p>
${FOOT_LINKS}
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

/* ── The profile block ──────────────────────────────────────────
   Written by scripts/profile.js, cached in companies-store.json, and
   the only sentence on a company page that isn't a label or someone
   else's headline. It goes first because it is the page's lede: a
   reader who lands here from a search wants to know what the company
   is before they read what it did last Tuesday.

   The attribution line is one short sentence repeated across ~1,300
   pages, and it stays. This site's credibility rests on saying where
   a claim came from — the funding tracker carries METHOD_NOTE for
   exactly that reason — and a synthesised paragraph with no
   provenance reads as a fact we're asserting rather than a summary we
   assembled. Sixty characters is a cheap price for that distinction.

   No profile renders nothing, which is what makes the whole step
   fail-soft (see profile.js). */
/* A profile is written to be read on the page (up to 320 chars, one or
   two sentences); a description is written to be shown in a result
   (~158 before it is cut). Handing the whole paragraph to clamp() gives
   a sentence that stops mid-clause on an ellipsis, which is both worse
   to read and likelier to get replaced by a snippet Google picks
   itself. The first sentence is a complete thought and almost always
   the "what it does" one, since the prompt asks for name-first. Fall
   back to the clamped paragraph when even that won't fit. */
function descFromProfile(summary) {
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(summary);
  if (first && first[0].trim().length >= 60 && first[0].trim().length <= 158) {
    return first[0].trim();
  }
  return summary;
}

/* The kind and the headquarters, under the profile. The place is a
   link wherever its market has a page (rule 3g) — which is what
   makes /market/<country>/ reachable at all, ~1,100 pages pointing
   at ~15 hubs, the same shape /funding/companies/ is reached by.

   It is a .company-badge rather than a neutral .co-tag, and that is
   the chart lesson from rule 3c-i applied one page down: anything
   that navigates is accent ink at rest. A grey chip that happens to
   be clickable is a link nobody finds. The kind, which navigates
   nowhere, keeps the neutral chip — so the two now read as what
   they are rather than as one undifferentiated row. */
function companyMetaTags(profile) {
  const tags = [];
  if (profile.kind) tags.push(`<span class="co-tag">${escHtml(profile.kind)}</span>`);
  if (profile.place) {
    /* Linked only when this company is actually in the set that page
       lists — inMarketSet() as well as a built page. An investor or an
       "Other" keeps its place as plain text: sending a fund to a page
       headed "insurance and insurtech companies in the United States"
       that correctly does not list it is a link that lies about where
       it goes. */
    const market = inMarketSet(profile) ? countryOf(profile.place) : null;
    tags.push(
      market && MARKET_SLUGS.has(market.slug)
        ? `<a class="company-badge" href="/market/${escAttr(market.slug)}/">${escHtml(
            profile.place
          )}</a>`
        : `<span class="co-tag">${escHtml(profile.place)}</span>`
    );
  }
  return tags;
}

function companyProfileBlock(c, profile) {
  if (!profile || !profile.known || !profile.summary) return "";
  const meta = companyMetaTags(profile);
  /* The profile is the only sentence on this page nobody else wrote
     (rule 3a-ii), which is exactly why it is the right place to link
     from: the anchor sits in our own prose rather than in a quoted
     headline. One paragraph, so the per-paragraph cap makes this at
     most one link — 269 of the 684 profiles carry a term mention. */
  const link = proseLinker();
  return `    <section class="co-profile">
      <p class="co-desc">${link(profile.summary)}</p>
${meta.length ? `      <p class="co-tags">${meta.join("")}</p>\n` : ""}      <p class="co-attrib">Profile compiled by ${escHtml(SITE.name)} from the coverage below.</p>
    </section>`;
}

function companyPageHtml(c, deals = [], profile = null) {
  const canonical = `/company/${c.slug}/`;
  const storyWord = c.count === 1 ? "story" : "stories";
  const sources = (c.sources || []).slice(0, 6).join(", ");

  /* When we hold rounds for a company, the funding is what the page is
     *for* — "<name> funding" is the query it can actually win, and the
     title and description are the only part of the page a search result
     shows. Lead with the money and keep the coverage line behind it. */
  const raised = deals.reduce((s, d) => s + (d.amountM || 0), 0);
  const latest = deals[0];
  const title = deals.length
    ? `${c.name} funding, rounds & insurtech news | ${SITE.name}`
    : `${c.name} — insurtech news & coverage | ${SITE.name}`;
  /* Kept under the ~158 chars a result actually shows, so the tail isn't
     an ellipsis: the money leads, the promise of the table closes it.
     One round doesn't get a "most recently" — it gets stated outright. */
  const description = deals.length
    ? (deals.length === 1
        ? `${c.name} raised ${money(latest.amountM)}${
            latest.stage ? ` in a ${latest.stage} round` : ""
          } on ${fullDate(latest.publishedAt)}.`
        : `${c.name} has raised ${money(raised)} across ${deals.length} disclosed rounds, ` +
          `most recently ${money(latest.amountM)}${
            latest.stage ? ` (${latest.stage})` : ""
          } on ${fullDate(latest.publishedAt)}.`) +
      ` Amount, stage, lead investor and source for each.`
    /* Without rounds, the profile is the best description this page
       has: it is specific to the company and unique across the site,
       where the count-and-sources fallback is a template ~945 pages
       shared almost verbatim. Funded pages keep the money-led version
       above — "<name> funding" is the query they can win, and no
       description beats the number in a result snippet. */
    : profile && profile.known && profile.summary
      ? descFromProfile(profile.summary)
      : `${c.count} insurtech ${storyWord} on ${c.name}` +
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
    /* The profile is the only thing we can say about the Organization
       itself rather than about our coverage of it, so it belongs on
       the `about` node. Clamped longer than a meta description: this
       is machine-read, not shown in a result snippet. */
    about: {
      "@type": "Organization",
      name: c.name,
      ...(profile && profile.known && profile.summary
        ? { description: clamp(profile.summary, 320) }
        : {}),
    },
    mainEntity: itemListLd(`${c.name} coverage`, articles, 50),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Companies", path: "/companies.html" },
    { name: c.name, path: canonical },
  ]);

  /* The rounds table is a dataset in the same sense /funding/ is, just
     scoped to one company — same claim, same variables, so it gets the
     same markup rather than a company-shaped approximation of it. */
  const fundingLd = deals.length
    ? {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: `${c.name} funding rounds`,
        description: clamp(
          `Every disclosed funding round raised by ${c.name}, with amount, stage, lead investor, announcement date and the reporting each figure comes from.`,
          300
        ),
        url: url(canonical),
        keywords: [c.name, "funding rounds", "insurtech", "venture capital"],
        isAccessibleForFree: true,
        creator: { "@type": "Organization", name: SITE.name, url: url("/") },
        about: { "@type": "Organization", name: c.name },
        inLanguage: SITE.lang,
        temporalCoverage: `${isoDate(deals[deals.length - 1].publishedAt)}/${isoDate(
          deals[0].publishedAt
        )}`,
        variableMeasured: [
          "Amount raised (USD)",
          "Round stage",
          "Lead investor",
          "Announcement date",
        ],
      }
    : null;

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
    ogImage: cardFor(deals.length ? "funding" : "company"),
    imageAlt: `${c.name} on ${SITE.name}`,
    // Structured data on a noindex page is ignored anyway; emitting only
    // the breadcrumb keeps the markup honest about what this page is.
    jsonld: thin ? [crumbLd] : [collectionLd, ...(fundingLd ? [fundingLd] : []), crumbLd],
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

${companyProfileBlock(c, profile)}
${facts}

${companyFundingBlock(c, deals)}
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
    /* Provenance for the company links, stamped by write-brief.js from
       the window this brief was written from (rule 3b-vi). Carried
       through here because briefs.json is the durable store and the
       source for every brief page — an entry that loses it can never
       get it back, since the window is gone by the next run.
       Entries written before the field existed simply have none and
       render exactly as they did, the same way rule 3b-v treats a
       store entry with no `firstSeen`. */
    companies: Array.isArray(b.companies) ? b.companies : [],
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

/* The brief's company links, resolved against the FINISHED index — the
   slugs stamped by write-brief.js are provenance, not addresses (rule
   3c-iv). A slug with no record is dropped rather than linked: seo.js
   prunes every /company/<slug>/ without one, so the alternative is a
   dead link in the site's best prose. The name comes from the record
   too, so a canonicalisation applies to old briefs on the next build.

   `linkCompanies` is passed in rather than read from a module global
   because briefBlocks() is called once per page and the linker it
   builds is stateful. */
function briefCompanies(b, db) {
  const slugs = Array.isArray(b.companies) ? b.companies : [];
  if (!slugs.length) return [];
  const bySlug = new Map((db.companies || []).map((c) => [c.slug, c]));
  return slugs
    .map((s) => bySlug.get(s))
    .filter((c) => c && c.name)
    .map((c) => ({ slug: c.slug, name: c.name }));
}

/* One linker per brief page — stateful (first mention only, page
   budget), so it must not be shared across pages. Falls back to plain
   escaping for the entries written before the stamp existed, which is
   every brief archived before 2026-08-02. */
function briefLinker(b, db) {
  const companies = briefCompanies(b, db);
  return companies.length
    ? companyLinker({ companies, esc: escHtml })
    : plainLinker(escHtml);
}

function briefBlocks(b, link = null) {
  const text = link || ((s) => escHtml(s));
  const blocks = [
    `      <div class="brief-block">
        <h2 class="brief-label">What's happening</h2>
        <p class="brief-text">${text(b.whatsHappening)}</p>
      </div>`,
  ];
  if (b.whyItMatters) {
    blocks.push(`      <div class="brief-block">
        <h2 class="brief-label">Why it matters</h2>
        <p class="brief-text">${text(b.whyItMatters)}</p>
      </div>`);
  }
  return blocks.join("\n");
}

/* newer/older are the adjacent archive entries — the prev/next pair
   gives crawlers a path through every brief without the index. */
function briefPageHtml(b, newer, older, db = {}) {
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
${briefBlocks(b, briefLinker(b, db))}
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

function buildBriefPages(briefs, db = {}) {
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
      briefPageHtml(b, briefs[i - 1], briefs[i + 1], db)
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
/* Claude's per-article funding verdicts, written by funding-extract.js
   and keyed by link. Read once per build and handed to fundingDeals(),
   which prefers them over its own regexes — including a verdict of "not
   a round", which is how the fund vehicles, the sector tallies and the
   AI-coding raises stay off a page about insurtech funding.

   Empty is a valid state (no credentials, a rate-limited run, a fresh
   clone), and it means the regexes decide everything, as they did
   before the cache existed. */
function fundingFacts() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")).funding || {};
  } catch {
    return {};
  }
}

/* Claude's per-company profiles, written by profile.js and keyed by
   slug. Empty is a valid state — no credentials, a rate-limited run, a
   fresh clone — and it means every company page renders exactly as it
   did before profiles existed. */
function companyProfiles() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")).profiles || {};
  } catch {
    return {};
  }
}

/* Claude's per-topic explainers, written by topic-brief.js and keyed by
   topic slug. Empty is a valid state for the same reasons as the two
   caches above, and it means every hub renders exactly as it did before
   briefs existed — a statline, three badge lists and borrowed headlines. */
function topicBriefs() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")).topics || {};
  } catch {
    return {};
  }
}

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

/* The standing explainer at the top of a hub — the only prose on the
   page nobody else wrote. Reuses .co-desc from the company profile so
   the two original blocks on this site read as one thing and share the
   phone breakpoint, rather than forking a near-identical paragraph
   style the way the funding tables nearly did (rule 3a-i). */
/* The explainer that leads a hub.

   Two cached shapes render here and both must keep working. v2 briefs
   are `sections` — a heading and a paragraph each, written as real h2s
   so the page reads as a reference article rather than a lede above a
   wire. v1 briefs are a flat `body` array of paragraphs with no
   headings, and they do not disappear on the version bump: a topic
   whose rewrite is declined deliberately keeps its published v1 prose
   (see the loop in topic-brief.js), which may be months. Dropping the
   `body` branch would blank those hubs, which is the outcome the
   decline guard exists to prevent. */
function topicBriefBlock(topic, brief) {
  if (!brief || !brief.known || !brief.summary) return "";

  /* The longest original prose on the site — ~400–600 words across the
     lede and MIN_SECTIONS–MAX_SECTIONS sections — so this is the one
     surface where the page budget rather than the paragraph cap binds.
     Headings are NOT linked: an h2 is the page's own structure, and a
     link inside one competes with the heading it is supposed to be. */
  const link = proseLinker();
  const lede = link(brief.summary);

  const blocks = Array.isArray(brief.sections) && brief.sections.length
    ? brief.sections
        .map(
          (s) => `      <h2 class="brief-h">${escHtml(s.heading)}</h2>
      <p class="co-desc">${link(s.text)}</p>`
        )
        .join("\n")
    /* The older flat shape, still rendered because a declined rewrite
       deliberately keeps the published brief (rule 3d-i). */
    : (brief.body || []).map((p) => `      <p class="co-desc">${link(p)}</p>`).join("\n");

  return `    <section class="topic-brief">
      <p class="co-desc topic-lede">${lede}</p>
${blocks}
      <p class="co-attrib">Written by ${escHtml(SITE.name)} from the coverage below.</p>
    </section>`;
}

function topicPageHtml(topic, allTopics, db, deals = [], brief = null) {
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

  /* Title and h1 name the *subject*, not the category label. "Embedded"
     is a nav chip; "Embedded insurance" is what the query says, and a
     page whose h1 is one word and whose title says "news & coverage"
     reads as a wire to a reader looking for a definition — which is the
     query these hubs are actually placed on (rule 3d-i). "Explained"
     only appears once there is an explainer to justify it; without a
     brief the page falls back to what it always said, so the title can
     never over-promise prose the page does not carry. */
  const subject = subjectOf(topic.name);
  const explained = !!(brief && brief.known && brief.summary);
  const title = explained
    ? `${subject} explained — companies, deals and latest news | ${SITE.name}`
    : `${subject} — insurtech news & coverage | ${SITE.name}`;
  /* The brief's opening sentence is a definition of the subject, which
     is both what the evergreen query for this page is asking for and the
     only description here that isn't the same template as the other
     thirteen hubs — "N insurtech stories tagged X, from A, B and C" said
     nothing about X and said it identically everywhere. Same substitution
     descFromProfile() makes on an unfunded company page, and the same
     helper, since both want one complete sentence inside the ~158 a
     result shows. */
  const description =
    brief && brief.known && brief.summary
      ? descFromProfile(brief.summary)
      : `${n} insurtech ${word} tagged ${topic.name}` +
        (sources.length ? `, from ${sources.slice(0, 3).map(([s]) => s).join(", ")} and others` : "") +
        ". Tracked continuously by Insurtech Daily.";

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${subject} — insurtech coverage`,
    url: url(canonical),
    description: clamp(description),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    // The brief's definition describes the *subject*, so it belongs on
    // the Thing rather than only on the page — that is the difference
    // between "a page about embedded insurance" and "what embedded
    // insurance is", and the latter is what this hub is for.
    about: {
      "@type": "Thing",
      // The subject, for the same reason the h1 uses it: "Embedded" is
      // this site's filing label, "Embedded insurance" is the thing.
      name: subject,
      ...(explained ? { description: clamp(brief.summary, 300) } : {}),
    },
    mainEntity: itemListLd(`${subject} coverage`, topic.articles, 50),
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
    imageAlt: `${subject} — insurtech coverage on ${SITE.name}`,
    jsonld: [collectionLd, crumbLd],
  })}
<body>
${header("topics", topic.slug)}

  <main id="top">
    <p class="crumb"><a href="/topic/">← All topics</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Topic</p>
      <h1 class="tagline">${escHtml(subject)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
    </div>

${topicBriefBlock(topic, brief)}

${trackerCue}

${facts}

    <h2 class="section-label">Coverage</h2>
    <ol class="feed" aria-label="${escAttr(subject)} coverage">
${shown.map(companyArticleLi).join("\n")}
    </ol>
${more}
  </main>

${FOOTER}
</body>
</html>
`;
}

function topicIndexHtml(topics, briefs = {}) {
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
      /* Prefer the brief's definition over the latest headline. This
         index is a reader asking what the themes *are* — a directory,
         not a wire — and a row reading "Embedded: cover sold inside
         another company's checkout" answers that where "Bolttech ties up
         with…" answers a question nobody on this page asked. The
         headline stays as the fallback, and the freshness it carried is
         already in the date beside it. */
      const brief = briefs[t.slug];
      const blurb =
        brief && brief.known && brief.summary
          ? descFromProfile(brief.summary)
          : latest && latest.title;
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
          <h2>${escHtml(subjectOf(t.name))}</h2>
          ${blurb ? `<p class="summary">${escHtml(blurb)}</p>` : ""}
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

function buildTopicPages(topics, db, deals = [], briefs = {}) {
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
    fs.writeFileSync(
      path.join(dir, "index.html"),
      topicPageHtml(t, topics, db, deals, briefs[t.slug] || null)
    );
  }
  fs.writeFileSync(path.join(outRoot, "index.html"), topicIndexHtml(topics, briefs));
  const written = topics.filter((t) => briefs[t.slug] && briefs[t.slug].known).length;
  console.log(
    `  ✓ ${topics.length} topic pages under /topic/ + index (${written} with a brief)`
  );
}

/* ══════════════════════════════════════════════════════════════
   THE GLOSSARY — /glossary/ + /glossary/<term>/

   The only page type here aimed squarely at a question that has
   nothing to do with this week. A company page can win "<name>
   funding", a month page "insurtech funding August 2025", a hub
   "what is embedded insurance" — this one answers "what is an MGA",
   which is asked at the same rate every month of every year.

   What makes it more than a dictionary entry is the pair: a
   definition nobody else wrote, above the archive's own coverage of
   the term. Reference sites define an MGA better than this site ever
   will and have a decade of authority doing it; none of them can put
   twenty-five MGA headlines from the last two years underneath. That
   pairing is also why the page is gated on coverage rather than on
   having a definition — see indexableTerm() in glossary.js, and the
   measurement in its header for why the term list is short.
   ══════════════════════════════════════════════════════════════ */

/* Claude's per-term definitions, written by glossary-write.js. Empty
   is valid and means no term pages are built at all — the same
   fail-soft contract topicBriefs() and companyProfiles() have. */
function glossaryDefs() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")).glossary || {};
  } catch {
    return {};
  }
}

/* The whole store, for collectTerms() — which does its own relevance
   filtering (rule 3c-ii) and needs the raw `seen` map, not the shaped
   article list storeArticles() returns here. */
function rawStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return { seen: {} };
  }
}

function glossaryPageHtml(t, def, allTerms, db) {
  const canonical = `/glossary/${t.slug}/`;
  const heading = t.full && t.full.toLowerCase() !== t.term.toLowerCase()
    ? `${t.term} (${t.full})`
    : t.term;
  const n = t.n;
  const word = n === 1 ? "story" : "stories";
  const indexed = indexableTerm(t);

  /* "X explained", the same formula the hubs use, rather than "What is
     X?" — which needs an article the term list does not carry and
     produces "What is MGA?" for every initialism in it. Deriving the
     article is not worth 28 hand-written strings when the phrasing
     below matches the same intent and reads correctly for all of
     them. */
  const title = `${t.term} explained — definition and insurtech coverage | ${SITE.name}`;
  const description = descFromProfile(def.summary);

  /* The companies named in the stories that matched, resolved against
     the finished index the way every company link on this site must be
     (rule 3c-iv) — a raw extraction name skips canonicalisation and
     JUNK, and seo.js prunes any /company/<slug>/ without a record, so
     trusting it puts dead links on the page. */
  const bySlug = new Map((db.companies || []).map((c) => [c.slug, c]));
  const links = new Set(t.articles.map((a) => a.link));
  const counts = new Map();
  for (const c of db.companies || []) {
    const hits = (c.articles || []).filter((a) => links.has(a.link)).length;
    if (hits) counts.set(c.slug, hits);
  }
  const companies = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([slug]) => bySlug.get(slug))
    .filter(Boolean);

  const hub = t.topic ? { name: t.topic, slug: topicSlug(t.topic) } : null;
  const shown = t.articles.slice(0, GLOSSARY_STORY_CAP);

  const defLd = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: t.term,
    ...(t.full ? { alternateName: t.full } : {}),
    description: clamp(def.summary, 300),
    url: url(canonical),
    inDefinedTermSet: { "@type": "DefinedTermSet", name: `${SITE.name} insurance glossary`, url: url("/glossary/") },
  };
  const pageLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${t.term} — definition and coverage`,
    url: url(canonical),
    description: clamp(description),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    ...(shown.length ? { mainEntity: itemListLd(`${t.term} coverage`, t.articles, 30) } : {}),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Glossary", path: "/glossary/" },
    { name: t.term, path: canonical },
  ]);

  /* Terms explain each other — a reinsurance definition says "cedes",
     a fronting one says "MGA" — so the glossary is the densest source
     of these links on the site as well as their destination. `self`
     keeps the page from linking its own term back to itself. */
  const link = proseLinker(t.slug);
  const lede = link(def.summary);
  const paras = (def.body || [])
    .map((p) => `      <p class="co-desc">${link(p)}</p>`)
    .join("\n");

  const related = allTerms
    .filter((o) => o.slug !== t.slug && o.topic === t.topic && (o.def || {}).known)
    .slice(0, 6);

  return `${head({
    title,
    description,
    canonical,
    // Thin terms are built and linked but kept out of the index, the
    // same split rule 3a makes for company pages.
    robots: indexed
      ? "index, follow, max-image-preview:large, max-snippet:-1"
      : "noindex, follow",
    ogImage: cardFor("glossary"),
    imageAlt: `${t.term} — insurance glossary on ${SITE.name}`,
    jsonld: [defLd, pageLd, crumbLd],
  })}
<body>
${header("glossary")}

  <main id="top">
    <p class="crumb"><a href="/glossary/">← Glossary</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Term</p>
      <h1 class="tagline">${escHtml(heading)}</h1>
      <p class="statline">${escHtml(
        n ? `${n} ${word} mention it` : "Definition only · no coverage yet"
      )}</p>
    </div>

    <section class="topic-brief">
      <p class="co-desc topic-lede">${lede}</p>
${paras}
      <p class="co-attrib">Written by ${escHtml(SITE.name)}.</p>
    </section>

${hub ? `    <p class="topic-cue">For the running coverage rather than the definition, see the
      <a href="/topic/${escAttr(hub.slug)}/">${escHtml(subjectOf(hub.name))} hub</a>.</p>` : ""}

${companies.length ? `    <section class="co-facts">
      <div class="co-fact">
        <h2 class="fact-label">Companies in these stories</h2>
        <div class="badges">${companies
          .map((c) => `<a class="company-badge" href="/company/${escAttr(c.slug)}/">${escHtml(c.name)}</a>`)
          .join("")}</div>
      </div>${related.length ? `
      <div class="co-fact">
        <h2 class="fact-label">Related terms</h2>
        <div class="badges">${related
          .map((o) => `<a class="company-badge" href="/glossary/${escAttr(o.slug)}/">${escHtml(o.term)}</a>`)
          .join("")}</div>
      </div>` : ""}
    </section>` : ""}

${shown.length ? `    <h2 class="section-label">${escHtml(t.term)} in the news</h2>
    <ol class="feed" aria-label="${escAttr(t.term)} coverage">
${shown.map(companyArticleLi).join("\n")}
    </ol>${
      n > shown.length
        ? `\n    <p class="topic-more">Showing the ${shown.length} most recent of ${n}.</p>`
        : ""
    }` : ""}
  </main>

${FOOTER}
</body>
</html>
`;
}

function glossaryIndexHtml(rows) {
  const canonical = "/glossary/";
  const title = `Insurance and insurtech glossary | ${SITE.name}`;
  // Leads with the terms themselves, which is what gets typed into a
  // search box — and says what the page holds rather than advertising
  // how plainly it says it.
  const description =
    "What MGA, reinsurance, parametric cover, takaful, excess and surplus lines and other insurance terms mean, with recent stories on each.";

  const setLd = {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    name: `${SITE.name} insurance glossary`,
    url: url(canonical),
    description: clamp(description),
    hasDefinedTerm: rows.map((r) => ({
      "@type": "DefinedTerm",
      name: r.term,
      description: clamp(r.def.summary, 300),
      url: url(`/glossary/${r.slug}/`),
    })),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Glossary", path: canonical },
  ]);

  const items = rows
    .map((r) => {
      const blurb = descFromProfile(r.def.summary);
      return `      <li class="story">
        <a class="story-main" href="/glossary/${escAttr(r.slug)}/">
          <div class="meta"><span class="src">${
            r.n ? `${r.n} ${r.n === 1 ? "story" : "stories"}` : "definition"
          }</span></div>
          <h2>${escHtml(r.term)}</h2>
          <p class="summary">${escHtml(blurb)}</p>
        </a>
      </li>`;
    })
    .join("\n");

  /* Kicker / h1 / factual statline, the shape every other index here
     uses ("Browse · Topics · 14 themes"). No standing paragraph under
     it: the funding index carries one because the tracker makes
     derived claims that need a method note, and a list of defined
     terms makes none. A page that explains that a glossary contains
     definitions is explaining itself to nobody. */
  const stories = rows.reduce((s, r) => s + r.n, 0);
  const statline = [
    `${rows.length} ${rows.length === 1 ? "term" : "terms"}`,
    `${stories} ${stories === 1 ? "story" : "stories"} mentioning them`,
  ].join("  ·  ");

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("glossary"),
    imageAlt: `Insurance glossary on ${SITE.name}`,
    jsonld: [setLd, crumbLd],
  })}
<body>
${header("glossary")}

  <main id="top">
    <div class="intro">
      <p class="co-kicker">Reference</p>
      <h1 class="tagline">Insurance glossary</h1>
      <p class="statline">${escHtml(statline)}</p>
    </div>

    <ol class="feed" aria-label="Glossary terms">
${items}
    </ol>
  </main>

${FOOTER}
</body>
</html>
`;
}

/* Terms are built only where a definition exists — the definition IS
   the page, so a term without one has nothing to render and is left
   out of the index rather than shipped empty. Coverage then decides
   indexing, not existence. */
function glossaryLive(store) {
  const defs = glossaryDefs();
  return collectGlossaryTerms(store)
    .map((t) => ({ ...t, def: defs[t.slug] || null }))
    .filter((t) => t.def && t.def.known);
}

function buildGlossaryPages(live, db) {
  const outRoot = path.join(ROOT, "glossary");
  fs.mkdirSync(outRoot, { recursive: true });
  const wanted = new Set(live.map((t) => t.slug));
  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (fs.statSync(dir).isDirectory() && !wanted.has(name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const t of live) {
    const dir = path.join(outRoot, t.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), glossaryPageHtml(t, t.def, live, db));
  }

  /* A to Z. This is a reference list, and a reader arriving at a
     glossary is looking up a term they already have in mind rather
     than browsing what we cover most — story count is the wrong axis
     for that, and it also reshuffles the whole page as coverage
     shifts. `sensitivity: "base"` so an initialism like MGA files
     under M with the words rather than ahead of them all. */
  const rows = live
    .slice()
    .sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
  fs.writeFileSync(path.join(outRoot, "index.html"), glossaryIndexHtml(rows));

  const indexed = live.filter(indexableTerm).length;
  console.log(
    `  ✓ ${live.length} glossary pages under /glossary/ + index ` +
      `(${indexed} indexable, ${live.length - indexed} noindex under ${GLOSSARY_MIN_STORIES} stories)`
  );
  return live;
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
function shortMonthLabel(key) {
  const d = new Date(key + "-01T00:00:00Z");
  return isNaN(d)
    ? key
    : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/* ── Quarters and years ─────────────────────────────────────────
   Keyed off monthKey, so every period on the site is cut on the same
   UTC boundary the months already use. A second convention (Central,
   say, to match the brief's publishing clock) would put a round
   announced late on March 31 in Q1 on one page and Q2 on another. */
const quarterKey = (iso) => {
  const k = monthKey(iso);
  return k ? `${k.slice(0, 4)}-q${Math.ceil(+k.slice(5, 7) / 3)}` : "";
};
const quarterLabel = (key) => `Q${key.slice(-1)} ${key.slice(0, 4)}`;
const quarterMonthKeys = (key) => {
  const y = key.slice(0, 4);
  const q = +key.slice(-1);
  return [0, 1, 2].map((i) => `${y}-${String((q - 1) * 3 + i + 1).padStart(2, "0")}`);
};
const yearKey = (iso) => monthKey(iso).slice(0, 4);

const totalOf = (deals) => deals.reduce((s, d) => s + (Number(d.amountM) || 0), 0);

/* The median round, alongside the total.

   A quarter's total is dominated by whichever quarter happened to
   contain one $550M outlier — Q2 2025 outranks Q4 2025 on the strength
   of a single row. The median is what "a round" is worth in this market
   and moves only when the market does, so both go on every aggregate
   page and neither is presented alone. */
function medianOf(deals) {
  const s = deals.map((d) => Number(d.amountM) || 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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

/* The figure as its outlet printed it, for a row this table converted.

   Indian rounds get crore rather than a rupee count in the millions:
   "₹193cr" is what the headline said and what a reader would search for,
   and "₹1,930M" is a unit nobody in that market uses. */
const CURRENCY_GLYPH = {
  EUR: "€", GBP: "£", INR: "₹", JPY: "¥", CHF: "CHF ",
  CAD: "C$", AUD: "A$", NZD: "NZ$", SGD: "S$", HKD: "HK$",
  MYR: "RM", ZAR: "R", BRL: "R$", AED: "AED ", SAR: "SAR ",
};
function nativeMoney(m, currency) {
  if (!m || m <= 0 || !currency || currency === "USD") return "";
  if (currency === "INR") {
    const cr = m / 10; // m is millions of rupees; 1 crore = 10 million
    return "₹" + (cr >= 100 ? Math.round(cr) : Math.round(cr * 10) / 10) + "cr";
  }
  const g = CURRENCY_GLYPH[currency] || currency + " ";
  if (m >= 1000) return g + (Math.round(m / 100) / 10).toFixed(1) + "B";
  if (m < 1) return g + Math.round(m * 1000) + "K";
  return g + (Math.round(m * 10) / 10).toFixed(Number.isInteger(m) ? 0 : 1) + "M";
}

/* Longest corporate suffix an extracted name may carry over the indexed
   record (or vice versa) and still be treated as the same company.
   "Technologies" is 12; a descriptive phrase is longer. */
const PREFIX_SLACK = 12;

/* The Company cell for a row with no company record behind it — no page
   to link to, so all we can print is a name.

   The extractor's answer first; failing that, the headline up to its
   funding verb. That split used to know six verbs, and a headline using
   a seventh put its entire text in the cell: one row read "Insurance-tech
   startup plans to double Charlotte workforce after $45M raise" where a
   company name belongs. So the verb list is wide, the result is capped,
   and anything that fails both tests renders an em dash — a blank cell is
   a missing name, a sentence in a Company column is a broken table. */
const RAISE_VERB =
  /\s+(?:raises?|raised|secures?|secured|lands?|closes?|closed|bags?|nets?|nabs?|pockets?|scoops?|scores?|hauls?|snags?|draws?|attracts?|receives?|gets?|announces?|completes?|extends?|wins?|picks up|pulls in|brings in)\b/i;
function unlinkedCompany(d) {
  const head = String(d.title || "").split(RAISE_VERB)[0].replace(/^Exclusive:\s*/i, "").trim();
  // The extractor's answer only if it reads like a name. When it hands back
  // a descriptor — "Pie Insurance co-founder's new startup", "Midtown
  // startup" — it is telling us the headline never named the company, and
  // a phrase in a Company column is worse than an em dash.
  const raiser = String(d.raiser || "").trim();
  const namey = raiser && raiser.length <= 32 && !/\b(?:co-?founder|startup|firm|company|platform|its|new)\b/i.test(raiser);
  const name = namey ? raiser : (head && head.length <= 40 ? head : "");
  return name || "—";
}

/* The amount cell, shared by the tracker's table and the one on a company
   page so a converted round can never read differently in the two places. */
function amountCell(d) {
  const native = nativeMoney(d.nativeM, d.currency);
  return (
    escHtml(money(d.amountM)) +
    (native ? `<span class="deal-native">as reported: ${escHtml(native)}</span>` : "")
  );
}

/* Attach the raising company to each deal.

   The company names come from companies.json (Claude-extracted, and far
   better than anything a regex gets out of a headline), joined on the
   article link. A headline names both sides of a round — "X raises $Y
   led by Z" — so of the companies on that article we take the one
   mentioned EARLIEST in the title, which is the raiser in essentially
   every headline construction.

   "Essentially every" was optimistic. The construction that breaks it is
   investor-first, and it is common: "Beams Fintech Fund leads $70 Mn
   round in InsuranceDekho", "Antler leads $500K round in
   InsurancePadosi", "Thrive And Sequoia Back Pace With $46 Million",
   "Prosus pours $460M into Alan". Earliest-mentioned files every one of
   those under the INVESTOR.

   So the extractor's answer wins when it has one: funding-extract.js is
   asked for the company that raised, specifically, and the name it
   returns is matched against the companies actually on that article —
   never trusted as a slug of its own. That last part matters for the
   same reason rule 3c-iv does: a raw name skips canonicalisation and
   prefix-merging, and a `/company/<slug>/` built from one is a dead
   link. If the name doesn't resolve, we fall back to position. */
function attachCompanies(deals, db) {
  const byLink = new Map();
  for (const c of db.companies || []) {
    for (const a of c.articles || []) {
      if (!a.link) continue;
      if (!byLink.has(a.link)) byLink.set(a.link, []);
      byLink.get(a.link).push({ slug: c.slug, name: c.name });
    }
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return deals.map((d) => {
    const cands = byLink.get(d.link) || [];
    let picked = null;
    if (d.raiser) {
      const want = norm(d.raiser);
      picked =
        cands.find((c) => norm(c.name) === want) ||
        /* "Alan" against a record named "Alan Health", "Corgi" against
           "Corgi Insurance" — one is a prefix of the other and they are
           the same company. Bounded at four characters so a short generic
           answer can't attach itself to an unrelated record, and the
           overhang is capped at PREFIX_SLACK.

           That cap is not cosmetic. The extractor sometimes answers with
           a descriptor instead of a name, and "Pie Insurance co-founder
           raises $7.5M for new insurtech startup" came back as company
           "Pie Insurance co-founder's new startup" — which begins with a
           real company's name. Uncapped, the round of a company that
           isn't Pie Insurance was filed on Pie Insurance's page and added
           to its ranking total. A corporate suffix is short ("Health",
           "Insurance", "Group", "Technologies"); a descriptive phrase is
           not, and that is the whole distinction being drawn here. */
        (want.length >= 4 &&
          cands.find((c) => {
            const n = norm(c.name);
            if (n.startsWith(want)) return n.length - want.length <= PREFIX_SLACK;
            if (want.startsWith(n)) return want.length - n.length <= PREFIX_SLACK;
            return false;
          })) ||
        null;
    }
    /* The extractor named a raiser and none of the companies on this
       article is it. That is information, not a gap: it means the company
       that raised is not in the index for this story, and guessing by
       position will pick one that is — the wrong one.

       "Pie Insurance co-founder raises $7.5M for new insurtech startup"
       names exactly one company, and it isn't the raiser. Both the prefix
       rule above and the positional fallback below land on Pie Insurance,
       putting another company's round on its page and its ranking total.
       Rule 3c-vi already says an unlinked descriptor beats a wrong link;
       this is the same principle one step earlier. */
    if (!picked && d.raiser) return { ...d, company: null };

    if (!picked) {
      /* Position, but not before ruling out the two entities we can
         positively identify as the wrong side of the round: the lead
         investor the headline names outright, and whoever is the SUBJECT
         of an investing verb. Without this the fallback filed rounds
         under Prosus, a16z, Antler, Balderton, Aviva and Scottish Equity
         Partners — every one of them the party writing the cheque. */
      /* Matched as a prefix in either direction, because the phrase the
         headline uses and the name the index holds rarely line up
         exactly: "Apis Partners' Funds Lead US$60 Million Series C in …
         Roojai" yields "Apis Partners' Funds" against a record called
         "Apis Partners", and an equality test filed the round under the
         investor anyway — twice, since Roojai's own report of the same
         round became a second row. */
      const bad = [];
      const isBad = (name) => {
        const n = norm(name);
        if (n.length < 4) return false;
        // Substring rather than prefix once the name is long enough to be
        // distinctive: "Japanese wealth fund Cool Japan Fund leads US$21
        // million … for PolicyStreet" buries the investor's name mid-phrase,
        // and the round belongs to PolicyStreet.
        return bad.some((b) => b.startsWith(n) || n.startsWith(b) || (n.length >= 5 && b.includes(n)));
      };
      if (d.lead) bad.push(norm(d.lead));
      const inv = d.title.match(
        // The hyphen matters: "Aviva-backed AI broker raises £950k" names
        // its backer and never names the broker, and attributing that
        // round to Aviva is exactly the error this guard exists to stop.
        /^(?:Exclusive:\s*)?(.{2,45}?)[\s-]+(?:co-)?(?:leads?|led|backs?|backed|pours?|invests?|bets?|hands?|commits?)\b/i
      );
      if (inv) bad.push(norm(inv[1]));
      const usable = cands.filter((c) => !isBad(c.name));
      /* When ruling out the investor leaves nothing, the answer is
         nothing. "Aviva-backed AI broker raises £950k" names one company
         and it is the backer; the broker is never named. Falling back to
         the full candidate list here — as this did — links the round to
         Aviva's page, which is both a wrong attribution and $1.2M added
         to a FTSE insurer's total on the ranking. An unlinked descriptor
         is the honest cell. */
      const pool = usable.length || bad.length ? usable : cands;
      const ranked = pool
        .map((c) => ({ ...c, at: d.title.toLowerCase().indexOf(c.name.toLowerCase()) }))
        .filter((c) => c.at >= 0)
        .sort((a, b) => a.at - b.at);
      picked = ranked[0] || pool[0] || null;
    }
    return { ...d, company: picked };
  });
}

/* Second dedup pass, only possible once companies are attached.

   funding.js collapses re-reports by amount + shared headline tokens,
   which misses the case where two outlets describe one round in barely
   overlapping words — PolicyStreet's $26M Series C was filed both as
   "raises Series C to $26 mn" and "Extends Malaysia's Largest Insurtech
   Funding Round to US$26M", sharing exactly one distinctive token.

   It also misses the bigger case: outlets that agree it's one round and
   disagree about the number. The original three causes were a non-US
   round printed in local currency ("Quandri secures $16.5 million CAD" /
   "Quandri raises $12m"), a figure that drifts as a round is re-reported
   (Corgi's $160M Series B came back as $106M three weeks later), and a
   round rumoured before it closed ("InsuranceDekho could secure up to
   $100m", closing at $70M).

   Two of those three are now handled upstream and no longer reach here:
   funding.js converts currencies, so Quandri's two reports arrive as
   $12.05M and $12M, and it declines the conditional outright, so the
   rumoured figure is never a row. The bound stays because the third
   cause — a figure that simply drifts between outlets — has no upstream
   fix, and because rows that arrive from the regex fallback rather than
   the extractor still exhibit all three.

   Requiring the amounts to match left all of those on the table as
   separate rows — six duplicates that made the tracker look like it was
   double-counting, on the one page here that isn't a restatement of
   someone else's reporting.

   So the amounts no longer have to be equal, only within SAME_ROUND_MAX
   of each other. A company does not close two rounds inside 45 days, but
   it does raise a $14.5M round and then a $70M one 6 weeks apart — which
   is exactly the pair a ratio bound keeps apart and a pure
   same-company-same-window rule would have merged. Against every such
   pair in the archive (12 of them, across 6 companies) 2x separates the
   re-reports from the genuinely distinct rounds with room on both
   sides: the widest true duplicate is 1.73x, the closest true pair
   4.83x. */
const SAME_ROUND_MAX = 2;
const sameRound = (a, b) =>
  a > 0 && b > 0 && Math.max(a, b) / Math.min(a, b) <= SAME_ROUND_MAX;

/* Collapse one cluster of reports into the row that represents it.

   Which figure survives matters as much as the merge: taking the newest,
   as first-wins did, is how Corgi's May round would have been filed at
   the $106M a single outlet printed three weeks late rather than the
   $160M two of them reported on the day. So the row shows the figure the
   most outlets stated.

   Ties go to the SMALLER figure, which looks timid and isn't. The two
   ways a cluster disagrees about the number are a local outlet printing
   local currency (Quandri's "$16.5 million CAD" against the same round's
   $12m) and a round rumoured before it closed ("could secure up to
   $100m", closed at $70M) — and in both the inflated figure is the
   larger one. Taking the larger on a tie filed Quandri in Canadian
   dollars on a table that says it counts US dollars, and filed
   InsuranceDekho at a number nobody ever raised. The tracker already
   says its totals are a floor on real activity; the tie-break is where
   that has to be true.

   The representative is then the *earliest* report carrying that figure,
   adopted whole — link, source, date and title travel together, so a row
   can never cite a number the source it links to didn't print, and
   "Announced" is the first report of the round rather than the last.
   Everyone else becomes the +n in the source column. */
function resolveRound(members) {
  if (members.length === 1) {
    return { ...members[0], alsoReportedBy: [...members[0].alsoReportedBy] };
  }
  const tally = new Map();
  for (const m of members) {
    const key = Math.round(m.amountM * 10) / 10;
    if (!tally.has(key)) tally.set(key, []);
    tally.get(key).push(m);
  }
  const winners = [...tally.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0][1];
  const rep = winners
    .slice()
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))[0];

  const outlets = [];
  for (const m of members) {
    for (const s of [m.source, ...(m.alsoReportedBy || [])]) {
      if (s && s !== rep.source && !outlets.includes(s)) outlets.push(s);
    }
  }
  // members arrive newest-first, so this keeps the previous "first
  // non-empty wins" behaviour for the two fields that are often blank.
  return {
    ...rep,
    alsoReportedBy: outlets,
    stage: (members.find((m) => m.stage) || {}).stage || "",
    lead: (members.find((m) => m.lead) || {}).lead || "",
  };
}

function dedupeByCompany(deals) {
  const clusters = [];
  for (const d of deals) {
    const hit =
      d.company &&
      clusters.find(
        ([k]) =>
          k.company &&
          k.company.slug === d.company.slug &&
          sameRound(k.amountM, d.amountM) &&
          Math.abs(new Date(k.publishedAt) - new Date(d.publishedAt)) / 86400000 <= 45
      );
    if (hit) hit.push(d);
    else clusters.push([d]);
  }
  return clusters.map(resolveRound);
}

function collectDeals(news, db) {
  const pool = storeArticles();
  const arts = pool.length ? pool : news.articles || [];
  const deals = dedupeByCompany(attachCompanies(fundingDeals(arts, { facts: fundingFacts() }), db));
  // resolveRound() can hand a row an earlier date than the report it was
  // clustered under, and everything downstream — the "most recent" table,
  // the month split, the sitemap's lastmod — reads this array as
  // newest-first. Re-sort rather than assume the input order survived.
  return deals.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
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
    : escHtml(unlinkedCompany(d));
  const outlets = [d.source, ...(d.alsoReportedBy || [])].filter(Boolean);
  const also =
    outlets.length > 1
      ? `<span class="deal-also" title="${escAttr(outlets.join(", "))}">+${outlets.length - 1}</span>`
      : "";
  return `        <tr data-stage="${escAttr(d.stage || "")}" data-amount="${
    Number(d.amountM) || 0
  }" data-date="${escAttr(isoDate(d.publishedAt))}">
          <td class="deal-co">${co}</td>
          <td class="deal-amt">${amountCell(d)}</td>
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
            <th scope="col" class="deal-stage">Stage</th>
            <th scope="col" class="deal-lead">Lead investor</th>
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

/* ── A company's own rounds, on its own page ─────────────────────
   The tracker's data restricted to one company. This is the only part
   of /company/<slug>/ that isn't a restatement of someone else's
   headline: the amount, stage, lead and date, deduplicated across every
   outlet that covered the round, is a record that doesn't exist in one
   place anywhere else for companies this small.

   Same rows as the tracker minus the Company column (it's the page) and
   minus the sort/filter controls — six rows don't need sorting, and the
   block then needs no JS at all. The cells keep the tracker's classes so
   the styling and the phone breakpoints are shared, not re-tuned.

   The deals come pre-sorted newest-first from collectDeals(). */
function companyFundingBlock(c, deals = []) {
  if (!deals.length) return "";
  const raised = deals.reduce((s, d) => s + (d.amountM || 0), 0);
  const oldest = deals[deals.length - 1];

  const bits = [`${deals.length} disclosed round${deals.length === 1 ? "" : "s"}`];
  if (raised > 0) bits.push(`${money(raised)} raised`);
  if (oldest) bits.push(`first tracked ${fullDate(oldest.publishedAt)}`);

  const rows = deals
    .map((d) => {
      const outlets = [d.source, ...(d.alsoReportedBy || [])].filter(Boolean);
      const also =
        outlets.length > 1
          ? `<span class="deal-also" title="${escAttr(outlets.join(", "))}">+${
              outlets.length - 1
            }</span>`
          : "";
      return `        <tr>
          <td class="deal-amt">${amountCell(d)}</td>
          <td class="deal-stage">${
            d.stage ? escHtml(d.stage) : '<span class="deal-blank">—</span>'
          }</td>
          <td class="deal-lead">${
            d.lead ? escHtml(d.lead) : '<span class="deal-blank">—</span>'
          }</td>
          <td class="deal-date"><time datetime="${escAttr(isoDate(d.publishedAt))}">${escHtml(
        fullDate(d.publishedAt)
      )}</time></td>
          <td class="deal-src"><a class="deal-link" href="${escAttr(
            d.link
          )}" target="_blank" rel="noopener noreferrer">${escHtml(
        d.source || "source"
      )}<span class="deal-ext" aria-hidden="true">↗</span></a>${also}</td>
        </tr>`;
    })
    .join("\n");

  return `    <section class="co-funding">
      <h2 class="section-label">Funding</h2>
      <p class="statline">${escHtml(bits.join("  ·  "))}</p>
      <div class="table-wrap">
        <table class="deal-table">
          <caption class="sr-only">${escHtml(
            c.name
          )} funding rounds — amount, stage, lead investor, date and source</caption>
          <thead>
            <tr>
              <th scope="col">Amount</th>
              <th scope="col" class="deal-stage">Stage</th>
              <th scope="col" class="deal-lead">Lead investor</th>
              <th scope="col">Announced</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
      <p class="co-fund-note">Disclosed rounds only, as reported in the insurtech press —
        see the <a href="/funding/">funding tracker</a> for what is counted and what isn't,
        or how this compares in the <a href="/funding/companies/">ranking of the most-funded
        insurtech companies</a>.</p>
    </section>
`;
}

/* The disclosure note is the honest part of the tracker and the only
   prose on it: what's counted, what isn't, and why the total is a
   floor. Shown on every tracker page. */
const METHOD_NOTE = `    <section class="method">
      <h2 class="fact-label">How this is compiled</h2>
      <p class="method-text">
        Every row is a funding round announced in the insurtech press and
        aggregated by Insurtech Daily. A round is counted only when a
        publication states a figure, so rounds closed without a number
        are absent. Amounts are shown in US dollars; a round reported in
        another currency is converted at a fixed reference rate and the
        row shows the figure as it was originally printed, so it can be
        checked against the reporting it links to. Market-size forecasts,
        earnings, acquisition prices and
        catastrophe losses are excluded, as are valuations — a headline
        that gives only what a company is now worth, and not what it
        raised, is not counted as a round. So are money raised by
        investors into their own funds, capital a company is spending
        rather than raising, public offerings and placings, and rounds
        still described as planned or rumoured. The same round reported by
        several outlets is collapsed into one row, with the extra outlets
        counted in the source column. Stage and lead investor are filled
        in only where a headline states them outright and left blank
        otherwise. Totals are therefore a floor on real activity, not a
        market estimate. Figures link to the reporting they come from —
        check it before citing.
      </p>
      <p class="method-text">
        The earliest months here were backfilled from dated searches
        rather than collected live, and those searches surface less the
        further back they reach. Coverage is thinner at the start of the
        archive than at the end, so a rise across the earliest periods
        may be this tracker seeing more rather than the market doing
        more. The quarter-on-quarter and year-on-year figures on the
        period pages are shown only between periods the archive covers
        in full.
      </p>
      <p class="method-text">
        This tracker is a work in progress, and data may contain errors
        and/or some rounds may be missing from this tracker. We do not
        guarantee the accuracy or completeness of the data tracked here.
      </p>
    </section>`;

function fundingSummary(deals) {
  const total = totalOf(deals);
  const stages = new Map();
  for (const d of deals) if (d.stage) stages.set(d.stage, (stages.get(d.stage) || 0) + 1);
  const biggest = deals.slice().sort((a, b) => b.amountM - a.amountM)[0];
  return {
    total,
    median: medianOf(deals),
    stages: [...stages.entries()].sort((a, b) => b[1] - a[1]),
    biggest,
  };
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

/* The capital series — the same calendar-grid-as-chart idea as
   monthChart, cut to four columns and plotted in dollars rather than
   round counts.

   Both series have to exist and neither replaces the other. Counts say
   how busy the market was; dollars say how much money moved, and they
   disagree often enough to be worth separate charts (2026 Q1 leads on
   both, but 2024 Q3 raised more across 13 rounds than 2024 Q4 did across
   20). Dollars is the series a reader arrives wanting, so it goes first.

   Doubling as navigation is deliberate: the year label links to the year
   page and each bar to its quarter, which is what puts every aggregate
   page one click from /funding/ and one link from a crawler. */
function quarterChart(quarters, yearPages = new Set(), heading = "By quarter") {
  const QN = ["Q1", "Q2", "Q3", "Q4"];
  const byKey = new Map(quarters.map((q) => [q.key, q]));
  const keys = quarters.map((q) => q.key).sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  const max = Math.max(...quarters.map((q) => totalOf(q.deals)), 1);

  const years = [];
  for (let y = +last.slice(0, 4); y >= +first.slice(0, 4); y--) years.push(y);

  const rows = years
    .map((y) => {
      const cells = QN.map((label, i) => {
        const key = `${y}-q${i + 1}`;
        const q = byKey.get(key);
        if (!q) {
          // Same convention as the month chart: outside the covered range
          // the label goes but the baseline stays, so a ragged axis never
          // reads as a rendering fault.
          const out = key < first || key > last;
          return `<li class="mo-cell${out ? " mo-out" : " mo-zero"}">
              <span class="mo-bar"></span><span class="mo-m">${label}</span>
            </li>`;
        }
        const cap = totalOf(q.deals);
        const n = q.deals.length;
        return `<li class="mo-cell">
              <a class="mo-link" href="/funding/${escAttr(key)}/" aria-label="${escAttr(
          quarterLabel(key)
        )} — ${escAttr(money(cap) || "no disclosed capital")} across ${n} round${
          n === 1 ? "" : "s"
        }">
                <span class="mo-n">${escHtml(money(cap) || "—")}</span>
                <span class="mo-bar"><i style="height:${Math.max(
                  2,
                  Math.round((cap / max) * 100)
                )}%"></i></span><span class="mo-m">${label}</span>
              </a>
            </li>`;
      }).join("\n            ");
      const yLabel = yearPages.has(String(y))
        ? `<a class="mo-ylink" href="/funding/${y}/">${y}</a>`
        : String(y);
      return `          <div class="mo-year">
            <span class="mo-y">${yLabel}</span>
            <ol class="mo-row mo-row-q">
            ${cells}
            </ol>
          </div>`;
    })
    .join("\n");

  return `      <div class="co-fact co-fact-wide">
        <h2 class="fact-label">${escHtml(
          heading
        )} <span class="fact-sub">— disclosed capital per quarter</span></h2>
        <div class="mo-chart mo-chart-cap">
${rows}
        </div>
      </div>`;
}

/* The period pages, written out as plain links.

   The quarter chart already links to every one of them — the year label
   to the year page, each bar to its quarter — and that was for a while
   the only route in. It doesn't work: a bar chart reads as a picture,
   so the affordance is invisible and the pages may as well not be
   linked. Charts are a poor primary navigation and a fine secondary
   one, so the chart keeps its links and this block is the obvious way
   in. It also gives a crawler an unambiguous list rather than twelve
   <a>s wrapped around <span>s of bar geometry. */
function periodIndex(quarters, years) {
  if (!quarters.length && !years.length) return "";
  const yearKeys = years.map((y) => y.key);
  const byYear = new Map(yearKeys.map((k) => [k, []]));
  for (const q of quarters) {
    const y = q.key.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(q);
  }
  const rows = [...byYear.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([y, qs]) => {
      const yLink = yearKeys.includes(y)
        ? `<a class="pi-year" href="/funding/${escAttr(y)}/">${escHtml(y)}</a>`
        : `<span class="pi-year pi-plain">${escHtml(y)}</span>`;
      const qLinks = qs
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(
          (q) =>
            `<a class="pi-q" href="/funding/${escAttr(q.key)}/">Q${q.key.slice(-1)}</a>`
        )
        .join('<span class="pi-sep" aria-hidden="true">·</span>');
      return `          <li class="pi-row">${yLink}<span class="pi-qs">${qLinks}</span></li>`;
    })
    .join("\n");

  return `      <div class="co-fact co-fact-wide">
        <h2 class="fact-label">Period pages <span class="fact-sub">— totals, medians and the change on the period before</span></h2>
        <ol class="period-index">
${rows}
        </ol>
      </div>`;
}

/* The change against the period before it — the one number a reader (or
   an outlet quoting the tracker) actually came for.

   Stated only for a period that has closed. A quarter three weeks old
   compared against a full one is not a decline, it is an arithmetic
   error with a minus sign, and this site's whole method note is a
   promise not to print numbers like that. In-progress periods say so
   instead. */
function deltaBlock(cur, prev, labelFn) {
  if (!prev || !prev.deals.length) return "";
  const a = totalOf(prev.deals);
  const b = totalOf(cur.deals);
  if (!a) return "";
  const pct = Math.round(((b - a) / a) * 100);
  const dn = cur.deals.length - prev.deals.length;
  const word = pct > 0 ? "up" : pct < 0 ? "down" : "level";
  const cls = pct > 0 ? "delta-up" : pct < 0 ? "delta-down" : "";
  const capital =
    pct === 0
      ? "level on capital"
      : `${word} <b>${Math.abs(pct)}%</b> on capital`;
  const rounds =
    dn === 0
      ? "same number of rounds"
      : `${dn > 0 ? "+" : "−"}${Math.abs(dn)} round${Math.abs(dn) === 1 ? "" : "s"}`;
  return `      <div class="co-fact">
        <h2 class="fact-label">vs ${escHtml(labelFn(prev.key))}</h2>
        <p class="co-sources ${cls}">${capital}, ${escHtml(rounds)} — ${escHtml(
    money(a)
  )} across ${prev.deals.length}.</p>
      </div>`;
}

/* Stage mix as a static breakdown. The tracker's identical-looking pills
   are filter controls driven by funding.js; here there is no table to
   filter down to, so these are plain text and deliberately not buttons. */
function stageBlock(stages) {
  if (!stages.length) return "";
  return `      <div class="co-fact">
        <h2 class="fact-label">By stage</h2>
        <div class="tags">${stages
          .map(
            ([s, c]) =>
              `<span class="tag-pill">${escHtml(s)} <span class="cnt">${c}</span></span>`
          )
          .join("")}</div>
      </div>`;
}

function biggestBlock(biggest) {
  if (!biggest) return "";
  return `      <div class="co-fact">
        <h2 class="fact-label">Largest round</h2>
        <p class="co-sources"><b>${escHtml(money(biggest.amountM))}</b> — ${
    biggest.company
      ? `<a class="deal-link" href="/company/${escAttr(biggest.company.slug)}/">${escHtml(
          biggest.company.name
        )}</a>`
      : escHtml(biggest.title)
  }</p>
      </div>`;
}

/* The months inside a quarter, as a linked breakdown rather than a
   three-bar chart: at three periods the shape carries nothing the
   numbers don't, and the numbers are the point. */
function monthBreakdown(qKey, monthKeys, byMonth, archiveStart) {
  const nowMonth = monthKey(new Date().toISOString());
  const startMonth = monthKey(archiveStart);
  const rows = quarterMonthKeys(qKey).map((k) => {
    const m = byMonth.get(k);
    const label = shortMonthLabel(k);
    if (!m || !m.deals.length) {
      // "No disclosed rounds" is a claim about a month, and it can only be
      // made about one the archive actually covers. The first quarter's
      // leading months predate the store and the current quarter's
      // trailing months haven't happened — asserting an empty month for
      // either is stating a fact we don't have.
      const val =
        startMonth && k < startMonth
          ? "Before this archive"
          : k > nowMonth
          ? "Not yet"
          : "No disclosed rounds";
      return `          <li class="pl-row pl-empty"><span class="pl-inner"><span class="pl-label">${escHtml(
        label
      )}</span><span class="pl-val">${val}</span></span></li>`;
    }
    const n = m.deals.length;
    const inner =
      `<span class="pl-label">${escHtml(label)}</span>` +
      `<span class="pl-val">${escHtml(money(totalOf(m.deals)) || "—")} <span class="pl-n">${n} round${
        n === 1 ? "" : "s"
      }</span></span>`;
    return monthKeys.has(k)
      ? `          <li class="pl-row"><a class="pl-inner pl-link" href="/funding/${escAttr(
          k
        )}/">${inner}</a></li>`
      : `          <li class="pl-row"><span class="pl-inner">${inner}</span></li>`;
  });
  return `      <div class="co-fact co-fact-wide">
        <h2 class="fact-label">By month <span class="fact-sub">— round-by-round tables</span></h2>
        <ol class="period-list">
${rows.join("\n")}
        </ol>
      </div>`;
}

/* Prev/next between sibling periods, in the brief archive's markup. */
function periodNav(newer, older, base, labelFn, label) {
  const nav = [];
  if (older)
    nav.push(
      `<a class="brief-nav-link" rel="prev" href="${base}${escAttr(older.key)}/">` +
        `<span class="brief-nav-dir">← Earlier</span>` +
        `<span class="brief-nav-title">${escHtml(labelFn(older.key))}</span></a>`
    );
  if (newer)
    nav.push(
      `<a class="brief-nav-link next" rel="next" href="${base}${escAttr(newer.key)}/">` +
        `<span class="brief-nav-dir">Later →</span>` +
        `<span class="brief-nav-title">${escHtml(labelFn(newer.key))}</span></a>`
    );
  return nav.length
    ? `    <nav class="brief-nav" aria-label="${escAttr(label)}">\n      ${nav.join(
        "\n      "
      )}\n    </nav>`
    : "";
}

/* The ranking, teased on the tracker index.

   Written as five plain links with their numbers rather than a bare
   "see the ranking" line: the top of the list is the part a reader
   wants, and .pl-link makes them accent ink and underlined at rest —
   the same rule the month links follow, and for the same reason. */
function rankTeaser(rows) {
  if (!rows.length) return "";
  const shown = rows.slice(0, 5);
  return `      <div class="co-fact co-fact-wide">
        <h2 class="fact-label">Most-funded companies <span class="fact-sub">— total raised across every disclosed round</span></h2>
        <ol class="period-list">
${shown
  .map(
    (r) =>
      `          <li class="pl-row"><a class="pl-inner pl-link" href="/company/${escAttr(
        r.slug
      )}/"><span class="pl-label">${escHtml(r.name)}</span><span class="pl-val">${escHtml(
        money(r.total)
      )} <span class="pl-n">${r.rounds} round${r.rounds === 1 ? "" : "s"}</span></span></a></li>`
  )
  .join("\n")}
        </ol>
        <p class="topic-more"><a href="/funding/companies/">All ${rows.length} companies, ranked →</a></p>
      </div>`;
}

function fundingIndexHtml(deals, months, quarters = [], years = [], ranked = []) {
  const canonical = "/funding/";
  const { total, median, stages, biggest } = fundingSummary(deals);
  const n = deals.length;
  const shown = deals.slice(0, DEAL_CAP);
  const oldest = deals[n - 1];
  const title = `Insurtech funding tracker — every disclosed round | ${SITE.name}`;
  const description =
    `${n} disclosed insurtech funding round${n === 1 ? "" : "s"} totalling at least ${money(
      total
    )}${median ? `, ${money(median)} median` : ""} — capital by quarter, plus amount, stage, ` +
    `lead investor and source for every round.`;

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
    /* A Dataset with nothing to distribute is a claim the surfaces that
       read this markup can't act on — the download is what makes the
       @type true rather than aspirational. Declared only here: the
       month, quarter and year pages are isPartOf this dataset and the
       file is the whole of it, so pointing every period page at it
       would advertise one archive from a dozen URLs. */
    distribution: [
      {
        "@type": "DataDownload",
        name: "Insurtech funding rounds (CSV)",
        encodingFormat: "text/csv",
        contentUrl: url("/funding.csv"),
      },
      {
        "@type": "DataDownload",
        name: "Insurtech funding rounds (JSON)",
        encodingFormat: "application/json",
        contentUrl: url("/funding.json"),
      },
    ],
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Funding tracker", path: canonical },
  ]);

  const statBits = [`${n} round${n === 1 ? "" : "s"}`, `${money(total)} disclosed`];
  if (median) statBits.push(`${money(median)} median`);
  if (oldest) statBits.push(`since ${fullDate(oldest.publishedAt)}`);

  const factBlocks = [];
  // Capital first: it's the series a reader arrives wanting, and putting
  // it above the stage filters keeps the filters next to the table they
  // act on.
  if (quarters.length) {
    factBlocks.push(quarterChart(quarters, new Set(years.map((y) => y.key))));
    factBlocks.push(periodIndex(quarters, years));
  }
  // The other axis, directly under the time one — every page below this
  // point on the tracker slices by date, and this is the only link to
  // the ranking that doesn't.
  if (ranked.length) factBlocks.push(rankTeaser(ranked));
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
  if (biggest) factBlocks.push(biggestBlock(biggest));
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

${downloadBlock(n)}

${METHOD_NOTE}
  </main>

${FOOTER}
</body>
</html>
`;
}

/* ── /funding/companies/ — the tracker's other axis ─────────────
   Every other funding URL slices the archive by time. Time is not how
   anyone looks for this: "insurtech funding August 2024" is nobody's
   search, and "most funded insurtech companies" is, so the one ranking
   the data supports is worth a page of its own.

   It is not a re-sort of /funding/ either, which is the test these URLs
   have to pass (see collectQuarters). A per-company total aggregates
   ACROSS rounds — Nirvana's $204M over three, Alan's $309M over two —
   and that number appears nowhere in the round table, on any period
   page, or in anyone else's reporting. The largest-single-rounds block
   below it is the secondary, capped the way a period page's table is.

   It also does a second job: it is a ranked hub linking every company
   that has a disclosed round, and those are exactly the pages the
   funding door in indexable() lets through. Before this they were
   reachable mainly through the 1,300-link companies index. */
const COMPANY_RANK_MIN = 10;
const COMPANY_RANK_CAP = 250;

/* Deals arrive newest-first from collectDeals(), and the per-company
   lists inherit that order — so deals[0] is the most recent round and
   the first non-empty stage is the latest one stated. Rounds without an
   attributed company are dropped: they can't be summed under a name or
   linked to a page, and a row that is neither is not a ranking entry. */
function collectFundedCompanies(deals) {
  const by = new Map();
  for (const d of deals) {
    if (!d.company) continue;
    if (!by.has(d.company.slug))
      by.set(d.company.slug, { slug: d.company.slug, name: d.company.name, deals: [] });
    by.get(d.company.slug).deals.push(d);
  }
  const rows = [...by.values()].map((c) => ({
    ...c,
    total: totalOf(c.deals),
    rounds: c.deals.length,
    latest: c.deals[0],
    stage: (c.deals.find((d) => d.stage) || {}).stage || "",
  }));
  // Capital, then round count, then name — so the order is stable across
  // builds instead of reshuffling ties on every run.
  rows.sort((a, b) => b.total - a.total || b.rounds - a.rounds || a.name.localeCompare(b.name));
  // Too few companies and the ranking is just the round table with the
  // columns moved — the same duplicate-of-/funding/ guard collectMonths()
  // applies. It starts by itself once the archive is deep enough.
  return rows.length >= COMPANY_RANK_MIN ? rows.slice(0, COMPANY_RANK_CAP) : [];
}

/* The ranking. No sort controls and no data-deal-table hook: there is
   one meaningful order here and the page is already in it, so the table
   needs no JS at all (same call as companyFundingBlock).

   Cells reuse the tracker's classes wherever the content matches, which
   is what keeps the phone breakpoints shared rather than re-tuned —
   .deal-stage drops at 360px here exactly as it does there. */
function companyRankTable(rows) {
  return `    <div class="table-wrap">
      <table class="deal-table rank-table">
        <caption class="sr-only">Insurtech companies ranked by total disclosed funding — rank, company, capital raised, number of rounds, latest stage and most recent round</caption>
        <thead>
          <tr>
            <th scope="col" class="rank-n">#</th>
            <th scope="col">Company</th>
            <th scope="col">Disclosed</th>
            <th scope="col" class="rank-rounds">Rounds</th>
            <th scope="col" class="deal-stage">Latest stage</th>
            <th scope="col" class="deal-date">Most recent</th>
          </tr>
        </thead>
        <tbody>
${rows
  .map(
    (r, i) => `          <tr>
            <td class="rank-n">${i + 1}</td>
            <td class="deal-co"><a class="deal-link" href="/company/${escAttr(
              r.slug
            )}/">${escHtml(r.name)}</a></td>
            <td class="deal-amt">${escHtml(money(r.total))}</td>
            <td class="rank-rounds">${r.rounds}</td>
            <td class="deal-stage">${
              r.stage ? escHtml(r.stage) : '<span class="deal-blank">—</span>'
            }</td>
            <td class="deal-date"><time datetime="${escAttr(
              isoDate(r.latest.publishedAt)
            )}">${escHtml(fullDate(r.latest.publishedAt))}</time></td>
          </tr>`
  )
  .join("\n")}
        </tbody>
      </table>
    </div>`;
}

function fundingCompaniesHtml(rows, deals) {
  const canonical = "/funding/companies/";
  const capital = rows.reduce((s, r) => s + r.total, 0);
  const nRounds = rows.reduce((s, r) => s + r.rounds, 0);
  const multi = rows.filter((r) => r.rounds > 1).length;
  const top = rows[0];

  const title = `Most-funded insurtech companies | ${SITE.name}`;
  const description =
    `${rows.length} insurtech companies ranked by disclosed capital raised — ` +
    `${money(capital)} across ${nRounds} round${nRounds === 1 ? "" : "s"}` +
    (top ? `, led by ${top.name} at ${money(top.total)}` : "") +
    ". Round counts, stage and the reporting behind every figure.";

  // A ranked list is what ItemList is for, and the positions are the
  // page. The Dataset markup stays on /funding/, which holds the rows —
  // this page is a derived ranking of them, not a second copy.
  const listLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Most-funded insurtech companies",
    description: clamp(description, 300),
    url: url(canonical),
    numberOfItems: rows.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: rows.map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: url(`/company/${r.slug}/`),
      name: r.name,
    })),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Funding tracker", path: "/funding/" },
    { name: "Most-funded companies", path: canonical },
  ]);

  const biggest = deals.slice().sort((a, b) => b.amountM - a.amountM).slice(0, PERIOD_DEAL_CAP);
  const statBits = [
    `${rows.length} companies`,
    `${money(capital)} disclosed`,
    `${nRounds} round${nRounds === 1 ? "" : "s"}`,
  ];
  if (multi) statBits.push(`${multi} raised more than once`);

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("funding"),
    imageAlt: `Most-funded insurtech companies — ${SITE.name}`,
    jsonld: [listLd, crumbLd],
    // Only the largest-rounds table below wants sorting; the ranking
    // above is already in its one meaningful order.
    scripts: [FUNDING_JS],
  })}
<body>
${header("funding")}

  <main id="top">
    <p class="crumb"><a href="/funding/">← Full funding tracker</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Tracker</p>
      <h1 class="tagline">Most-funded insurtech companies</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
      <p class="dek">
        Every company in this archive with a disclosed round, ranked by total
        capital raised across all of them. Totals count only rounds a
        publication stated in US dollars, so they are a floor — the
        <a href="/funding/">full tracker</a> lists each round with the
        reporting it came from.
      </p>
    </div>

${companyRankTable(rows)}

    <h2 class="section-label">Largest single rounds</h2>
${dealTable(biggest, "Largest disclosed insurtech funding rounds")}
${
  deals.length > biggest.length
    ? `    <p class="topic-more">The ${biggest.length} largest of ${deals.length}, by amount. Every round is listed in date order in the <a href="/funding/">full tracker</a>.</p>`
    : ""
}

${downloadBlock(deals.length)}

${METHOD_NOTE}
  </main>

${FOOTER}
</body>
</html>
`;
}

function fundingMonthHtml(m, newer, older, quarterKeys = new Set()) {
  const canonical = `/funding/${m.key}/`;
  const label = monthLabel(m.key);
  const qKey = quarterKey(m.key + "-01");
  const inQuarter = quarterKeys.has(qKey);
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
    ...(inQuarter ? [{ name: quarterLabel(qKey), path: `/funding/${qKey}/` }] : []),
    { name: label, path: canonical },
  ]);

  const navHtml = periodNav(newer, older, "/funding/", monthLabel, "Other months");

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
    <p class="crumb"><a href="/funding/">← Full funding tracker</a>${
      inQuarter
        ? ` · <a href="/funding/${escAttr(qKey)}/">← ${escHtml(quarterLabel(qKey))}</a>`
        : ""
    }</p>

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

/* ── The aggregate pages: /funding/<year>/ and /funding/<year>-q<n>/ ──

   How many rounds get shown is the whole design constraint. A quarter
   holds the same rows its three months hold, so printing them all makes
   the quarter page a fourth copy of a table Google has already crawled
   three times. PERIOD_DEAL_CAP keeps it to the largest few — enough to
   show what the period was about, short enough that the aggregates above
   are unmistakably the page. The full table stays one click down. */
const PERIOD_DEAL_CAP = 10;
const QUARTER_MIN_DEALS = 5;
const YEAR_MIN_DEALS = 8;

/* Is this the period we're currently inside? Read off the same UTC
   boundary the keys are cut on, so the answer can't disagree with the
   grouping. Matters because an in-progress period gets no delta. */
const isCurrent = (key, keyFn) => key === keyFn(new Date().toISOString());

/* The first day a period covers — "2025" → 2025-01-01, "2025-q2" →
   2025-04-01. */
const periodStart = (key) =>
  key.includes("-q") ? `${quarterMonthKeys(key)[0]}-01` : `${key}-01-01`;

/* A period is partial at BOTH ends of the archive, and a comparison
   against a partial period is arithmetic with a minus sign rather than a
   finding. The open end is obvious — three weeks of a quarter. The
   closed end is the one that actually shipped a wrong number: the store
   starts 2024-08-08, so "2024" is five months of data, and 2025 measured
   against it read "up 682% on capital" on a page whose method note
   promises the totals are a floor, not an estimate. Both ends suppress
   the delta and say why instead. */
function partialWhy(key, keyFn, archiveStart) {
  if (isCurrent(key, keyFn)) return "open";
  if (archiveStart && periodStart(key) < archiveStart) return "truncated";
  return "";
}

function periodPageHtml({
  key,
  label,
  deals,
  canonical,
  crumbs,
  kicker,
  h1,
  minDeals,
  temporalCoverage,
  breakdown,
  delta,
  partial,
  partialNote,
  navHtml,
  extraDesc,
}) {
  const { total, median, stages, biggest } = fundingSummary(deals);
  const n = deals.length;
  const thin = n < minDeals;
  const shown = deals.slice().sort((a, b) => b.amountM - a.amountM).slice(0, PERIOD_DEAL_CAP);

  const title = `Insurtech funding in ${label} — ${
    money(total) || "no disclosed capital"
  } across ${n} round${n === 1 ? "" : "s"} | ${SITE.name}`;
  const description =
    `Insurtech raised at least ${money(total)} across ${n} disclosed round${
      n === 1 ? "" : "s"
    } in ${label}${median ? `, ${money(median)} median` : ""}.${extraDesc ? ` ${extraDesc}` : ""}`;

  const datasetLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Insurtech funding rounds — ${label}`,
    description: clamp(description, 300),
    url: url(canonical),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: SITE.name, url: url("/") },
    inLanguage: SITE.lang,
    temporalCoverage,
    isPartOf: { "@type": "Dataset", name: "Insurtech funding rounds", url: url("/funding/") },
    variableMeasured: [
      { "@type": "PropertyValue", name: "Disclosed capital raised (USD)", value: total * 1e6 },
      { "@type": "PropertyValue", name: "Disclosed rounds", value: n },
      ...(median
        ? [{ "@type": "PropertyValue", name: "Median round size (USD)", value: median * 1e6 }]
        : []),
    ],
  };
  const crumbLd = breadcrumbLd(crumbs);

  const factBlocks = [delta, stageBlock(stages), biggestBlock(biggest), breakdown].filter(Boolean);
  const facts = factBlocks.length
    ? `    <section class="co-facts">\n${factBlocks.join("\n")}\n    </section>`
    : "";

  const statBits = [`${n} round${n === 1 ? "" : "s"}`, `${money(total)} disclosed`];
  if (median) statBits.push(`${money(median)} median`);
  if (partial === "open") statBits.push("in progress");
  else if (partial === "truncated") statBits.push("partial coverage");

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("funding"),
    imageAlt: `Insurtech funding, ${label} — ${SITE.name}`,
    jsonld: thin ? [crumbLd] : [datasetLd, crumbLd],
    robots: thin ? "noindex, follow" : undefined,
    scripts: [FUNDING_JS],
  })}
<body>
${header("funding")}

  <main id="top">
    <p class="crumb">${crumbs
      .slice(1, -1)
      .map((c) => `<a href="${escAttr(c.path)}">← ${escHtml(c.name)}</a>`)
      .join(" · ")}</p>

    <div class="intro co-head">
      <p class="co-kicker">${escHtml(kicker)}</p>
      <h1 class="tagline">${escHtml(h1)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
      ${partialNote ? `<p class="dek">${partialNote}</p>` : ""}
    </div>

${facts}

    <h2 class="section-label">${
      shown.length < n ? `Largest rounds in ${escHtml(label)}` : `All rounds in ${escHtml(label)}`
    }</h2>
${dealTable(shown, `Largest insurtech funding rounds in ${label}`)}
${
  shown.length < n
    ? `    <p class="topic-more">The ${shown.length} largest of ${n}, by amount. Every round is listed in date order on the pages above and in the <a href="/funding/">full tracker</a>.</p>`
    : ""
}

${navHtml}

${METHOD_NOTE}
  </main>

${FOOTER}
</body>
</html>
`;
}

/* The delta is shown only when BOTH periods are whole — the one being
   read and the one it is measured against. */
function periodDelta(cur, prev, keyFn, labelFn, archiveStart) {
  if (partialWhy(cur.key, keyFn, archiveStart)) return "";
  if (!prev || partialWhy(prev.key, keyFn, archiveStart)) return "";
  return deltaBlock(cur, prev, labelFn);
}

function partialDek(partial, label, archiveStart) {
  if (partial === "open")
    return `${escHtml(
      label
    )} is still open, so these are running totals and no comparison against the previous period is shown until it closes.`;
  if (partial === "truncated")
    return `This archive begins ${escHtml(
      fullDate(archiveStart)
    )}, so ${escHtml(label)} is covered in part only. Its totals are not comparable with a whole period, and no change against the period before it is shown.`;
  return "";
}

function fundingQuarterHtml(q, newer, older, monthKeys, byMonth, hasYearPage, archiveStart) {
  const label = quarterLabel(q.key);
  const year = q.key.slice(0, 4);
  const partial = partialWhy(q.key, quarterKey, archiveStart);
  return periodPageHtml({
    key: q.key,
    label,
    deals: q.deals,
    canonical: `/funding/${q.key}/`,
    crumbs: [
      { name: "Home", path: "/" },
      { name: "Funding tracker", path: "/funding/" },
      ...(hasYearPage ? [{ name: year, path: `/funding/${year}/` }] : []),
      { name: label, path: `/funding/${q.key}/` },
    ],
    kicker: "Tracker",
    h1: `Insurtech funding, ${label}`,
    minDeals: QUARTER_MIN_DEALS,
    temporalCoverage: `${quarterMonthKeys(q.key)[0]}/${quarterMonthKeys(q.key)[2]}`,
    breakdown: monthBreakdown(q.key, monthKeys, byMonth, archiveStart),
    delta: periodDelta(q, older, quarterKey, quarterLabel, archiveStart),
    partial,
    partialNote: partialDek(partial, label, archiveStart),
    navHtml: periodNav(newer, older, "/funding/", quarterLabel, "Other quarters"),
    extraDesc: "Round count, median size, stage mix and the largest raises.",
  });
}

function fundingYearHtml(y, newer, older, quarters, archiveStart) {
  const label = y.key;
  const mine = quarters.filter((q) => q.key.startsWith(y.key + "-"));
  const partial = partialWhy(y.key, yearKey, archiveStart);
  return periodPageHtml({
    key: y.key,
    label,
    deals: y.deals,
    canonical: `/funding/${y.key}/`,
    crumbs: [
      { name: "Home", path: "/" },
      { name: "Funding tracker", path: "/funding/" },
      { name: label, path: `/funding/${y.key}/` },
    ],
    kicker: "Tracker",
    h1: `Insurtech funding in ${label}`,
    minDeals: YEAR_MIN_DEALS,
    temporalCoverage: y.key,
    breakdown: mine.length ? quarterChart(mine, new Set(), "By quarter") : "",
    delta: periodDelta(y, older, yearKey, (k) => k, archiveStart),
    partial,
    partialNote: partialDek(partial, label, archiveStart),
    navHtml: periodNav(newer, older, "/funding/", (k) => k, "Other years"),
    extraDesc: "Quarter-by-quarter capital, median round size and the year's largest raises.",
  });
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
function groupDeals(deals, keyFn) {
  const by = new Map();
  for (const d of deals) {
    const k = keyFn(d.publishedAt);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(d);
  }
  return [...by.entries()]
    .map(([key, list]) => ({ key, deals: list }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

function collectMonths(deals) {
  const months = groupDeals(deals, monthKey);
  return months.length > 1 ? months : [];
}

/* Quarters and years get pages for the same reason months do, and are
   gated the same way: one period is a duplicate of /funding/, so the
   split waits for the second.

   They are NOT a re-slicing of the month pages, and mustn't become one.
   A month page is the round-by-round table for a month; a quarter or
   year page is the aggregate layer — capital, round count, median, stage
   mix, the change against the period before it — with only the largest
   rounds shown (PERIOD_DEAL_CAP). That aggregate is the part of this
   dataset nobody else publishes for insurtech, and it is the only reason
   these URLs earn their place: build them as tables of the same rows and
   they are three copies of a page you already have. */
function collectQuarters(deals) {
  const quarters = groupDeals(deals, quarterKey);
  return quarters.length > 1 ? quarters : [];
}

function collectYears(deals) {
  const years = groupDeals(deals, yearKey);
  return years.length > 1 ? years : [];
}

function buildFundingPages(deals, months, quarters, years, ranked = []) {
  const outRoot = path.join(ROOT, "funding");
  fs.mkdirSync(outRoot, { recursive: true });

  // Every period type shares one directory, so the prune set has to know
  // about all three — a year page left out of it would be deleted on the
  // run after the one that wrote it. /funding/companies/ lives in the
  // same directory and is not a period at all, so it has to be named
  // here explicitly or the next run deletes the page this one wrote.
  const monthKeys = new Set(months.map((m) => m.key));
  const quarterKeys = new Set(quarters.map((q) => q.key));
  const wanted = new Set([...monthKeys, ...quarterKeys, ...years.map((y) => y.key)]);
  if (ranked.length) wanted.add("companies");
  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (fs.statSync(dir).isDirectory() && !wanted.has(name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const write = (key, html) => {
    const dir = path.join(outRoot, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), html);
  };

  const byMonth = new Map(months.map((m) => [m.key, m]));
  const yearKeys = new Set(years.map((y) => y.key));
  // deals arrive newest-first from collectDeals().
  const archiveStart = deals.length ? isoDate(deals[deals.length - 1].publishedAt) : "";

  months.forEach((m, i) => {
    write(m.key, fundingMonthHtml(m, months[i - 1], months[i + 1], quarterKeys));
  });
  quarters.forEach((q, i) => {
    write(
      q.key,
      fundingQuarterHtml(
        q,
        quarters[i - 1],
        quarters[i + 1],
        monthKeys,
        byMonth,
        yearKeys.has(q.key.slice(0, 4)),
        archiveStart
      )
    );
  });
  years.forEach((y, i) => {
    write(y.key, fundingYearHtml(y, years[i - 1], years[i + 1], quarters, archiveStart));
  });
  if (ranked.length) write("companies", fundingCompaniesHtml(ranked, deals));
  fs.writeFileSync(
    path.join(outRoot, "index.html"),
    fundingIndexHtml(deals, months, quarters, years, ranked)
  );

  const count = (list, min) => list.filter((p) => p.deals.length >= min).length;
  const line = (name, list, min) =>
    `${list.length} ${name} (${count(list, min)} indexable)`;
  console.log(
    `  ✓ funding tracker — ${deals.length} deals, ` +
      [
        line("year pages", years, YEAR_MIN_DEALS),
        line("quarter pages", quarters, QUARTER_MIN_DEALS),
        line("month pages", months, MONTH_MIN_DEALS),
        ranked.length ? `${ranked.length} companies ranked` : "company ranking held (too few)",
      ].join(", ")
  );
}

/* ══════════════════════════════════════════════════════════════
   MARKETS — /market/ + /market/<country>/

   The geography axis. Every other URL here slices the archive by
   company, by subject or by date; none of those is how the sector
   gets asked about geographically, and "insurtech companies India"
   is evergreen in the way a quarter page is not.

   The data was already being collected and thrown away: profile.js
   has asked for `place` on every company since profiles existed and
   seo.js rendered it as one grey badge. See scripts/markets.js for
   the alias curation and the gate — including why a market below
   the floor is not built at all, where a thin company page is
   (nothing but this site's own markup links a market page, so there
   is no dead-end to protect against).

   What makes it a page rather than a re-cut of the same rows is the
   same thing that makes /funding/2025-q2/ one: it leads with an
   aggregate — company count, kind mix, disclosed capital across all
   of them — that appears in no round table and in nobody else's
   reporting. The company table under it is the other half: ~470
   internal links onto company pages, arranged by the one attribute
   the companies index cannot show.
   ══════════════════════════════════════════════════════════════ */

/* Kinds are singular nouns in the cache because they label one
   company; the market lede counts them. */
const KIND_PLURAL = {
  Insurtech: "insurtechs",
  Insurer: "insurers",
  Broker: "brokers",
  Reinsurer: "reinsurers",
  MGA: "MGAs",
  "Technology vendor": "technology vendors",
  "Industry body": "industry bodies",
};
const kindPlural = (k, n) =>
  n === 1 ? k.toLowerCase() : KIND_PLURAL[k] || `${k.toLowerCase()}s`;

/* Set once per build, before the first company page is written —
   the setFundedSlugs()/setNavTopics() pattern, for the identical
   reason. A company page turns its place badge into a link to its
   market, and it must not link one that was never built. */
let MARKET_SLUGS = new Set();
function setMarketSlugs(markets) {
  MARKET_SLUGS = new Set(markets.map((m) => m.slug));
}

/* Membership is decided by the profile, and it applies the same
   judgment indexable()'s third door does: `known`, with a `kind`
   that is set and is not "Other". A blank kind means the writer
   couldn't place the company in the market at all and "Other" means
   it placed it outside — a grocery-delivery company on a page
   headed "Insurtech in India" is a worse error here than on its own
   page, because this page asserts a set.
   Investors go too, and that is this page's own rule rather than a
   borrowed one: a fund that led a round is on the other side of the
   market this page is describing (rule 3c-iii). They keep their own
   pages and their place in the tracker's lead column. */
const inMarketSet = (p) =>
  p && p.known && p.place && p.kind && p.kind !== "Other" && p.kind !== "Investor";

function collectMarkets(db, profiles, deals) {
  const bySlug = new Map();
  for (const d of deals) {
    if (!d.company) continue;
    if (!bySlug.has(d.company.slug)) bySlug.set(d.company.slug, []);
    bySlug.get(d.company.slug).push(d);
  }

  const by = new Map();
  for (const c of db.companies || []) {
    const p = profiles[c.slug];
    if (!inMarketSet(p)) continue;
    const country = countryOf(p.place);
    if (!country) continue;
    if (!by.has(country.slug)) by.set(country.slug, { ...country, companies: [] });
    const cd = bySlug.get(c.slug) || [];
    // Everything before the final comma — "Gurugram" out of "Gurugram,
    // India". Blank when the profile answered with the country alone,
    // which is a little over half of them.
    const city = String(p.place).split(",").slice(0, -1).join(",").trim();
    by.get(country.slug).companies.push({
      slug: c.slug,
      name: c.name,
      kind: p.kind,
      city,
      n: c.count || (c.articles || []).length || 0,
      rounds: cd.length,
      total: totalOf(cd),
      deals: cd,
      articles: c.articles || [],
    });
  }

  const markets = [...by.values()].map((m) => {
    // Coverage, not the union of every mention: a story naming three
    // Indian companies is one story on the market page.
    const seen = new Set();
    const articles = [];
    for (const c of m.companies) {
      for (const a of c.articles) {
        if (!a || !a.link || seen.has(a.link)) continue;
        seen.add(a.link);
        articles.push(a);
      }
    }
    articles.sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));

    const kinds = new Map();
    for (const c of m.companies) kinds.set(c.kind, (kinds.get(c.kind) || 0) + 1);

    const mDeals = m.companies
      .flatMap((c) => c.deals)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    /* Coverage first, then capital, then name. Coverage is what this
       archive actually knows about a company, and it keeps the order
       stable across builds where sorting on capital would leave the
       ~70% with no disclosed round in an arbitrary tail. */
    m.companies.sort((a, b) => b.n - a.n || b.total - a.total || a.name.localeCompare(b.name));

    return {
      ...m,
      articles,
      stories: articles.length,
      deals: mDeals,
      rounds: mDeals.length,
      total: totalOf(mDeals),
      kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
  });

  return markets
    .filter(indexableMarket)
    .sort((a, b) => b.companies.length - a.companies.length || a.name.localeCompare(b.name));
}

/* The company directory — the page's payload. Reuses the tracker's
   cell classes rather than forking a near-identical table, which is
   what keeps the phone breakpoints shared (rule 3a-i): .deal-lead
   drops the city at 600px and .deal-stage drops the type at 360,
   leaving company, coverage and capital, which are the spine. */
function marketCompanyTable(m) {
  const rows = m.companies.slice(0, MARKET_COMPANY_CAP);
  return `    <div class="table-wrap">
      <table class="deal-table">
        <caption class="sr-only">Insurance and insurtech companies tracked in ${escHtml(
          m.name
        )} — company, type, base, stories in this archive and disclosed funding</caption>
        <thead>
          <tr>
            <th scope="col">Company</th>
            <th scope="col" class="deal-stage">Type</th>
            <th scope="col" class="deal-lead">Based</th>
            <th scope="col" class="rank-rounds">Stories</th>
            <th scope="col">Disclosed</th>
          </tr>
        </thead>
        <tbody>
${rows
  .map(
    (c) => `          <tr>
            <td class="deal-co"><a class="deal-link" href="/company/${escAttr(
              c.slug
            )}/">${escHtml(c.name)}</a></td>
            <td class="deal-stage">${escHtml(c.kind)}</td>
            <td class="deal-lead">${
              c.city ? escHtml(c.city) : '<span class="deal-blank">—</span>'
            }</td>
            <td class="rank-rounds">${c.n}</td>
            <td class="deal-amt">${
              c.total ? escHtml(money(c.total)) : '<span class="deal-blank">—</span>'
            }</td>
          </tr>`
  )
  .join("\n")}
        </tbody>
      </table>
    </div>`;
}

function marketPageHtml(m, all) {
  const canonical = `/market/${m.slug}/`;
  const where = inMarket(m);
  const nCo = m.companies.length;
  const oldest = m.articles[m.articles.length - 1];

  /* The kind mix in words. Three at most: past that it stops being a
     characterisation of the market and becomes the table below it. */
  const mix = m.kinds
    .slice(0, 3)
    .map(([k, n]) => `${n} ${kindPlural(k, n)}`)
    .join(", ")
    .replace(/, ([^,]*)$/, " and $1");

  const title = `Insurtech in ${where} — companies, funding and news | ${SITE.name}`;
  /* Two kinds here where the dek carries three: a description is cut at
     158 with an ellipsis, and the half-sentence that survives should be
     the funding clause rather than a third of the kind list. */
  const descMix = m.kinds
    .slice(0, 2)
    .map(([k, n]) => `${n} ${kindPlural(k, n)}`)
    .join(" and ");
  const description =
    `${nCo} insurance and insurtech companies tracked in ${where}` +
    (descMix ? ` — ${descMix}` : "") +
    (m.total
      ? ` — with ${money(m.total)} disclosed across ${m.rounds} funding round${
          m.rounds === 1 ? "" : "s"
        }.`
      : `, and ${m.stories} stories naming them.`);

  /* CollectionPage about a Place, with the companies as the list.
     The Dataset markup stays on /funding/ — the rounds shown here are
     a slice of it, not a second dataset. */
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `Insurtech in ${where}`,
    url: url(canonical),
    description: clamp(description, 300),
    isPartOf: { "@type": "WebSite", name: SITE.name, url: url("/") },
    about: { "@type": "Place", name: m.name },
    mainEntity: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `Insurtech and insurance companies in ${where}`,
      numberOfItems: nCo,
      itemListElement: m.companies.slice(0, MARKET_COMPANY_CAP).map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: url(`/company/${c.slug}/`),
        name: c.name,
      })),
    },
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Markets", path: "/market/" },
    { name: m.name, path: canonical },
  ]);

  const statBits = [
    `${nCo} ${nCo === 1 ? "company" : "companies"}`,
    `${m.stories} ${m.stories === 1 ? "story" : "stories"}`,
  ];
  if (m.total) statBits.push(`${money(m.total)} disclosed`);

  const biggest = m.deals.slice().sort((a, b) => b.amountM - a.amountM)[0];
  /* The standing paragraph. Derived rather than written — the numbers
     in it are the reason this URL exists, and no sentence anyone else
     publishes states them for a market this small. */
  const dek =
    `${SITE.name} tracks ${nCo} insurance and insurtech ${
      nCo === 1 ? "company" : "companies"
    } headquartered in ${where}` +
    (mix ? ` — ${mix}` : "") +
    (oldest ? `, across ${m.stories} stories going back to ${fullDate(oldest.publishedAt)}` : "") +
    ". " +
    (m.rounds
      ? `Between them they have disclosed ${money(m.total)} across ${m.rounds} funding round${
          m.rounds === 1 ? "" : "s"
        }` +
        (biggest && biggest.company
          ? `, the largest ${biggest.company.name}'s ${money(biggest.amountM)}`
          : "") +
        ". "
      : "") +
    "Every figure is compiled from the coverage on this page.";

  const others = all
    .filter((x) => x.slug !== m.slug)
    .slice(0, 12)
    .map(
      (x) =>
        `<a class="company-badge" href="/market/${escAttr(x.slug)}/">${escHtml(
          x.name
        )} <span class="cnt">${x.companies.length}</span></a>`
    )
    .join("");

  const shownDeals = m.deals.slice(0, MARKET_DEAL_CAP);
  const fundingBlock = m.rounds
    ? `    <h2 class="section-label">Funding</h2>
${dealTable(
  shownDeals.slice().sort((a, b) => b.amountM - a.amountM),
  `Disclosed insurtech funding rounds by companies in ${m.name}`
)}
    <p class="topic-more">${
      m.rounds > shownDeals.length
        ? `The ${shownDeals.length} largest of ${m.rounds} disclosed rounds. `
        : ""
    }Every round is listed with its reporting in the
      <a href="/funding/">funding tracker</a>, and totals across all markets in the
      <a href="/funding/companies/">company ranking</a>.</p>
`
    : "";

  const shownArticles = m.articles.slice(0, MARKET_STORY_CAP);
  const moreCo =
    nCo > MARKET_COMPANY_CAP
      ? `    <p class="topic-more">Showing the ${MARKET_COMPANY_CAP} most covered of ${nCo}.</p>`
      : "";
  const moreArticles =
    m.stories > shownArticles.length
      ? `    <p class="topic-more">The ${shownArticles.length} most recent of ${m.stories} stories naming a company based in ${escHtml(
          where
        )}.</p>`
      : "";

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("market"),
    imageAlt: `Insurtech in ${where} — ${SITE.name}`,
    jsonld: [collectionLd, crumbLd],
    // The funding table sorts, the same as everywhere else it appears.
    scripts: m.rounds ? [FUNDING_JS] : [],
  })}
<body>
${header("markets")}

  <main id="top">
    <p class="crumb"><a href="/market/">← All markets</a></p>

    <div class="intro co-head">
      <p class="co-kicker">Market</p>
      <h1 class="tagline">Insurtech in ${escHtml(where)}</h1>
      <p class="statline">${escHtml(statBits.join("  ·  "))}</p>
      <p class="dek">${escHtml(dek)}</p>
    </div>

${fundingBlock}
    <h2 class="section-label">Companies</h2>
${marketCompanyTable(m)}
${moreCo}
${
  others
    ? `    <section class="co-facts">
      <div class="co-fact">
        <h2 class="fact-label">Other markets</h2>
        <div class="badges">${others}</div>
      </div>
    </section>`
    : ""
}

    <h2 class="section-label">Coverage</h2>
    <ol class="feed" aria-label="Insurtech coverage in ${escAttr(m.name)}">
${shownArticles.map(companyArticleLi).join("\n")}
    </ol>
${moreArticles}
  </main>

${FOOTER}
</body>
</html>
`;
}

function marketIndexHtml(markets) {
  const canonical = "/market/";
  const companies = markets.reduce((s, m) => s + m.companies.length, 0);
  const capital = markets.reduce((s, m) => s + m.total, 0);
  const title = `Insurtech by market — companies and funding by country | ${SITE.name}`;
  const description =
    `Insurtech and insurance companies tracked in ${markets.length} markets — ` +
    `${companies} companies with their coverage, headquarters and disclosed funding, country by country.`;

  const listLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Insurtech markets",
    url: url(canonical),
    description: clamp(description, 300),
    numberOfItems: markets.length,
    itemListElement: markets.map((m, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: url(`/market/${m.slug}/`),
      name: `Insurtech in ${inMarket(m)}`,
    })),
  };
  const crumbLd = breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Markets", path: canonical },
  ]);

  const rows = markets
    .map((m) => {
      const bits = [
        `${m.companies.length} ${m.companies.length === 1 ? "company" : "companies"}`,
        `${m.stories} ${m.stories === 1 ? "story" : "stories"}`,
      ];
      if (m.total) bits.push(`${money(m.total)} disclosed`);
      const lead = m.companies
        .slice(0, 4)
        .map((c) => c.name)
        .join(", ");
      return `      <li class="story">
        <a class="story-main" href="/market/${escAttr(m.slug)}/">
          <div class="meta"><span class="src">${escHtml(bits.join(" · "))}</span></div>
          <h2>Insurtech in ${escHtml(inMarket(m))}</h2>
          ${lead ? `<p class="summary">Most covered: ${escHtml(lead)}.</p>` : ""}
        </a>
      </li>`;
    })
    .join("\n");

  return `${head({
    title,
    description,
    canonical,
    ogImage: cardFor("market"),
    imageAlt: `Insurtech by market on ${SITE.name}`,
    jsonld: [listLd, crumbLd],
  })}
<body>
${header("markets")}

  <main id="top">
    <div class="intro">
      <p class="co-kicker">Browse</p>
      <h1 class="tagline">Markets</h1>
      <p class="statline">${markets.length} markets  ·  ${companies} companies  ·  ${escHtml(
    money(capital)
  )} disclosed</p>
      <p class="dek">
        Where the companies in this archive are headquartered, taken from
        ${SITE.name}'s own company profiles. A market appears once it holds
        ${MARKET_MIN_COMPANIES} companies and ${MARKET_MIN_STORIES} stories,
        so the list grows as the archive does.
      </p>
    </div>

    <ol class="feed" aria-label="Markets">
${rows}
    </ol>
  </main>

${FOOTER}
</body>
</html>
`;
}

function buildMarketPages(markets) {
  const outRoot = path.join(ROOT, "market");
  fs.mkdirSync(outRoot, { recursive: true });

  // A market that falls back below the floor (a company merged away, a
  // profile rewritten) has its directory removed, the way a renamed
  // topic's does — the sitemap and the filesystem must not drift.
  const wanted = new Set(markets.map((m) => m.slug));
  for (const name of fs.readdirSync(outRoot)) {
    const dir = path.join(outRoot, name);
    if (fs.statSync(dir).isDirectory() && !wanted.has(name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const m of markets) {
    const dir = path.join(outRoot, m.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), marketPageHtml(m, markets));
  }
  fs.writeFileSync(path.join(outRoot, "index.html"), marketIndexHtml(markets));

  const links = markets.reduce((s, m) => s + Math.min(m.companies.length, MARKET_COMPANY_CAP), 0);
  console.log(
    `  ✓ ${markets.length} market pages under /market/ + index ` +
      `(floor: ${MARKET_MIN_COMPANIES} companies and ${MARKET_MIN_STORIES} stories) — ` +
      `${links} links onto company pages`
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

/* ── The footer's hub links on the hand-authored pages ──────────
   The third thing to reach these two files through a marker, after
   the nav (rule 2b) and the Google tag (rule 2c), and it is here for
   the reason both of those are: this row is the only route to the
   hubs that have no nav slot, it has already changed twice — the
   glossary, then the markets — and a hand-typed copy would have gone
   stale on both occasions with nothing failing to say so.

   company.html is deliberately out of the list, exactly as it is for
   the social tags: a noindex redirect shim titled "Redirecting…"
   should not be handing out links. ── */
const FOOTLINK_PAGES = ["index.html", "companies.html"];

function injectFootLinks() {
  let n = 0;
  for (const file of FOOTLINK_PAGES) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, "utf8");
    const next = replaceBlock(html, "FOOTLINKS", FOOT_LINKS);
    if (next !== html) fs.writeFileSync(p, next);
    n++;
  }
  console.log(`  ✓ footer hub links on ${n} hand-authored page${n === 1 ? "" : "s"}`);
}

/* ══════════════════════════════════════════════════════════════
   The homepage, pre-rendered (rule 5, on the page that needed it)

   index.html is client-rendered: script.js fetches news.json and fills
   #brief, #lead and #feed. Served, the page carried an <h1>, a dek and
   six links — the nav and the footer — and nothing else. Not one story,
   not one company link, no route to /brief/<date>/, and none of the
   brief's prose, which rule 3b calls the only original writing here and
   rule 3h built a whole feed around.

   That is rule 5 unfollowed on the one page it matters most on.
   companies.html has done this correctly since it was written (the
   COLIST block below); the homepage simply never got a marker. Three
   things it costs:

   • Google renders JS on a second, deferred pass. On a young domain
     that budget is the scarcest thing there is, so for weeks the
     highest-authority page on the site reads, to a crawler, as an
     empty template.
   • 89% of the sitemap is company pages, and rule 3f already documents
     internal equity pooling in the weakest thing here. The root page —
     where every external link and the feed land — passed equity to five
     hubs and nothing else. Sixty wire rows put ~130 resolved company
     links and today's brief on it.
   • The brief was invisible without rendering, on the page it leads.

   The static markup is a faithful SUBSET of what script.js renders,
   never a different page — same rows in the same order with the same
   classes and the same rel on outbound links. It omits only the thread
   disclosures, which are an interactive control, and shows the outlet
   count in the meta instead (which is what metaEl() does when a row
   carries no thread). Rendering something the client then contradicts
   is the one way this becomes a liability rather than a fix.

   Hydration overwrites all of it: render() clears #lead and #feed
   before drawing, and renderBrief() rewrites the brief's spans — with
   one exception it makes deliberately, see the data-date guard in
   script.js, which keeps the server-rendered company links in the
   brief prose rather than flattening them back to text.
   ══════════════════════════════════════════════════════════════ */

/* Not the whole wire. 128 thread groups is 128 outbound links to other
   domains from the root page, and the fifth-oldest day on a 45-day
   batch is not why the homepage ranks — the freshest slice is. Sixty
   covers ~5 days, and the client still draws all of them for readers. */
const WIRE_ROWS = 60;

/* Month + day, UTC-pinned for fullDate()'s reason. Matches the format
   script.js's timeAgo() falls back to past a week, so the swap at
   hydration is a format the page already uses. */
function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/* script.js's groupThreads() and pickLead(), server-side. Ported rather
   than approximated: a static wire that showed all 140 articles while
   the client folds them into 128 rows would be two different pages at
   the same URL. Keep the two in step. */
function wireThreads(list) {
  const byId = new Map();
  const groups = [];
  list.forEach((a) => {
    if (!a.clusterId) {
      groups.push({ members: [a] });
      return;
    }
    let g = byId.get(a.clusterId);
    if (!g) {
      g = { members: [] };
      byId.set(a.clusterId, g);
      groups.push(g);
    }
    g.members.push(a);
  });
  groups.forEach((g) => {
    let head = g.members[0];
    for (const m of g.members) if ((m.score || 0) > (head.score || 0)) head = m;
    g.head = head;
    g.others = g.members.filter((m) => m !== head);
  });
  return groups;
}

const LEAD_WINDOWS_H = [24, 48, 72];
function wireLead(list) {
  const now = Date.now();
  let pool = list;
  for (const hours of LEAD_WINDOWS_H) {
    const fresh = list.filter(
      (a) => a.timestamp && now - a.timestamp <= hours * 3.6e6
    );
    if (fresh.length) {
      pool = fresh;
      break;
    }
  }
  let best = pool[0];
  for (const a of pool) if ((a.score || 0) > (best.score || 0)) best = a;
  return best;
}

/* Company badges are already resolved against the finished index by
   companies.js (rule 3c-iv), but seo.js prunes every /company/<slug>/
   without a record — so the slug set is checked here too. A badge the
   client would draw and this drops is one dead link fewer in served
   HTML, which is the right side to err on. */
function wireBadges(a, maxTags, live) {
  const badges = (a.companies || [])
    .filter((c) => c && c.slug && live.has(c.slug))
    .map(
      (c) =>
        `<a class="company-badge" href="/company/${escAttr(
          c.slug
        )}/">${escHtml(c.name)}</a>`
    );
  const tags = (a.tags || [])
    .filter((t) => t !== "Industry")
    .slice(0, maxTags)
    .map((t) => `<span class="tag-pill">${escHtml(t)}</span>`);
  if (!badges.length && !tags.length) return "";
  return `<div class="card-tags">${badges.join("")}${tags.join("")}</div>`;
}

function wireMeta(a) {
  let m =
    `<span class="src">${escHtml(a.source)}</span>` +
    `<span class="dot"> · </span>` +
    `<span class="time">${escHtml(shortDate(a.publishedAt))}</span>`;
  if (a.cluster > 1) {
    m += `<span class="dot"> · </span><span class="outlets">${a.cluster} outlets</span>`;
  }
  return `<div class="meta">${m}</div>`;
}

/* rel and target match what script.js writes. The stories are other
   outlets' and the links say so; making the served copy nofollow while
   the rendered one is not would be a difference for its own sake. */
const STORY_REL = ' target="_blank" rel="noopener noreferrer"';

function wireLeadCard(g, live) {
  const a = g.head;
  return `      <div class="lead-card">
        <a class="lead-main" href="${escAttr(a.link)}"${STORY_REL}>
          <div class="lead-badge-row"><span class="lead-badge">Lead story</span></div>
          ${wireMeta(a)}
          <h2>${escHtml(a.title)}</h2>
${a.summary ? `          <p class="summary">${escHtml(a.summary)}</p>\n` : ""}        </a>
        ${wireBadges(a, 4, live)}
      </div>`;
}

function wireRow(g, live) {
  const a = g.head;
  return `      <li class="story">
        <a class="story-main" href="${escAttr(a.link)}"${STORY_REL}>
          ${wireMeta(a)}
          <h3>${escHtml(a.title)}</h3>
${a.summary ? `          <p class="summary">${escHtml(a.summary)}</p>\n` : ""}        </a>
        ${wireBadges(a, 3, live)}
      </li>`;
}

function homeWire(news, db) {
  const articles = news.articles || [];
  const live = new Set((db.companies || []).map((c) => c.slug));
  if (!articles.length) {
    return `    <section class="lead" id="lead" aria-label="Lead story"></section>
    <ol class="feed" id="feed" aria-label="Latest stories"></ol>`;
  }
  const groups = wireThreads(articles);
  const lead = wireLead(articles);
  const leadGroup = groups.find((g) => g.members.includes(lead));
  if (leadGroup) {
    leadGroup.head = lead;
    leadGroup.others = leadGroup.members.filter((m) => m !== lead);
  }
  const rows = groups
    .filter((g) => g !== leadGroup)
    .slice(0, WIRE_ROWS)
    .map((g) => wireRow(g, live))
    .join("\n");
  return `    <section class="lead" id="lead" aria-label="Lead story">
${wireLeadCard(leadGroup || { head: lead, members: [lead], others: [] }, live)}
    </section>
    <ol class="feed" id="feed" aria-label="Latest stories">
${rows}
    </ol>`;
}

/* The chevron script.js's markup carries — kept in one place so the
   two branches of homeBrief() can't drift from each other. */
const CHEVRON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';

/* The brief section in full, `hidden` attribute included — the marker
   has to own that attribute, or a served brief sits inside a section
   the browser is told not to display until JS clears it.

   data-date is the hydration guard: script.js leaves the prose alone
   when news.json is describing the same brief this markup was built
   from, which is the normal case (seo.js runs after write-brief.js in
   the same job) and is what keeps the company links below. A newer
   brief in a fetched payload overwrites it with plain text, correctly.

   The links to /brief/<date>/ and /brief/ sit OUTSIDE #briefFoot on
   purpose: renderBrief() sets that node's textContent, so anything
   inside it is text the moment JS runs. */
function homeBrief(news, db) {
  const b = news.briefing || {};
  if (!b.whatsHappening) {
    return `    <section class="brief" id="brief" hidden>
      <button class="brief-head" id="briefToggle" type="button" aria-expanded="false" aria-controls="briefBody">
        <span class="brief-kicker"><span class="brief-spark" aria-hidden="true"></span>The Brief</span>
        <span class="brief-lede">
          <span class="brief-headline" id="briefHeadline"></span>
          <span class="brief-teaser" id="briefTeaser"></span>
        </span>
        <span class="brief-actions">
          <span class="brief-cue">
            <span class="brief-cue-label" id="briefCueLabel">Read the brief</span>
            <span class="brief-chevron" aria-hidden="true">${CHEVRON}</span>
          </span>
        </span>
      </button>
      <div class="brief-body" id="briefBody" role="region" aria-label="Editor's brief">
        <div class="brief-body-inner">
          <div class="brief-block"><h3 class="brief-label">What's happening</h3><p class="brief-text" id="briefWhat"></p></div>
          <div class="brief-block"><h3 class="brief-label">Why it matters</h3><p class="brief-text" id="briefWhy"></p></div>
          <p class="brief-foot" id="briefFoot"></p>
        </div>
      </div>
    </section>`;
  }

  // One linker for this block — stateful (first mention only, page
  // budget), so it is built here and not shared (rule 3b-vi).
  const link = briefLinker(b, db);
  const author = b.by === "claude" ? "Written" : "Generated";
  const day = fullDate(b.date || b.generatedAt);
  const foot = `${author} from this batch's themes${
    day ? " · " + day : ""
  }. A read of the wire, not investment advice.`;

  // The archive link the homepage never had. Only offered for a brief
  // that is actually in the archive — recordBrief() files Claude's
  // writing and nothing else (rule 3b), so a fallback brief has no
  // page to point at and gets the index alone.
  const archived = b.by === "claude" && b.date;
  const more = archived
    ? `<a class="brief-more" href="/brief/${escAttr(
        b.date
      )}/">Read this brief on its own page</a> · <a class="brief-more" href="/brief/">Brief archive</a>`
    : `<a class="brief-more" href="/brief/">Brief archive</a>`;

  return `    <section class="brief" id="brief" data-date="${escAttr(
    b.date || ""
  )}">
      <button class="brief-head" id="briefToggle" type="button" aria-expanded="false" aria-controls="briefBody">
        <span class="brief-kicker"><span class="brief-spark" aria-hidden="true"></span>The Brief</span>
        <span class="brief-lede">
          <span class="brief-headline" id="briefHeadline">${escHtml(
            b.headline || "The Brief"
          )}</span>
          <span class="brief-teaser" id="briefTeaser">${escHtml(
            b.teaser || ""
          )}</span>
        </span>
        <span class="brief-actions">
          <span class="brief-cue">
            <span class="brief-cue-label" id="briefCueLabel">Read the brief</span>
            <span class="brief-chevron" aria-hidden="true">${CHEVRON}</span>
          </span>
        </span>
      </button>
      <div class="brief-body" id="briefBody" role="region" aria-label="Editor's brief">
        <div class="brief-body-inner">
          <div class="brief-block">
            <h3 class="brief-label">What's happening</h3>
            <p class="brief-text" id="briefWhat">${link(b.whatsHappening)}</p>
          </div>
          <div class="brief-block">
            <h3 class="brief-label">Why it matters</h3>
            <p class="brief-text" id="briefWhy">${link(b.whyItMatters)}</p>
          </div>
          <p class="brief-foot" id="briefFoot">${escHtml(foot)}</p>
          <p class="brief-foot brief-links">${more}</p>
        </div>
      </div>
    </section>`;
}

/* The statline read "— stories · — sources · updated —" until JS ran. */
function homeStats(news) {
  const upd = fullDate(news.updatedAt);
  return `        <b id="statCount">${(news.articles || []).length}</b> stories <span class="sep">·</span>
        <b id="statSources">${
          (news.sources || []).length
        }</b> sources <span class="sep">·</span>
        updated <b id="statUpdated">${escHtml(upd)}</b>`;
}

function injectHomepage(news, db) {
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
  html = replaceBlock(html, "STATS", homeStats(news));
  html = replaceBlock(html, "BRIEF", homeBrief(news, db));
  html = replaceBlock(html, "WIRE", homeWire(news, db));
  fs.writeFileSync(p, html);
  const rows = Math.min(
    WIRE_ROWS,
    Math.max(0, wireThreads(articles).length - 1)
  );
  console.log(
    `  ✓ index.html — brief + ${rows} wire rows pre-rendered, structured data + nav`
  );
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
function buildSitemap(
  news,
  db,
  briefs = [],
  topics = [],
  months = [],
  deals = [],
  quarters = [],
  years = [],
  ranked = [],
  terms = [],
  markets = []
) {
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
  /* Glossary terms, gated on coverage exactly as company pages are
     (indexableTerm()). A definition with nothing behind it is the page
     a reference site already has and has ranked for years; the
     crawler-facing list holds only the terms where this archive
     supplies the second half. Deliberately outside the deals block
     below — the glossary does not depend on the funding data. */
  const indexedTerms = terms.filter(indexableTerm);
  if (indexedTerms.length) {
    entries.push({ loc: "/glossary/", lastmod: now, priority: "0.7", changefreq: "weekly" });
    for (const t of indexedTerms) {
      entries.push({
        loc: `/glossary/${t.slug}/`,
        lastmod: isoDate((t.articles[0] || {}).publishedAt) || now,
        priority: "0.6",
        changefreq: "weekly",
      });
    }
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
    // Ranked with /funding/ itself: a per-company total is an aggregate
    // across rounds, which no period page and no outlet publishes.
    if (ranked.length) {
      entries.push({
        loc: "/funding/companies/",
        lastmod: isoDate(deals[0].publishedAt) || now,
        priority: "0.9",
        changefreq: "daily",
      });
    }
    // The aggregate pages rank above the month tables: a year or quarter
    // total is the part of this dataset that exists nowhere else, while a
    // month page is the same rows cut finer.
    const period = (list, min, prio) =>
      list
        .filter((p) => p.deals.length >= min)
        .forEach((p, i) => {
          entries.push({
            loc: `/funding/${p.key}/`,
            lastmod: isoDate(p.deals[0].publishedAt) || now,
            priority: prio,
            // A closed period can't gain rounds; only the current one moves.
            changefreq: i === 0 ? "daily" : "monthly",
          });
        });
    period(years, YEAR_MIN_DEALS, "0.8");
    period(quarters, QUARTER_MIN_DEALS, "0.8");
    // Thin months are noindex — listing them would only ask Google to crawl
    // what it has been told not to index (same rule as company pages).
    period(months, MONTH_MIN_DEALS, "0.7");
  }
  /* Markets carry no separate gate here: collectMarkets() returns only
     the ones that cleared the floor, and a market below it has no page
     to list (see scripts/markets.js on why this differs from rule 3a).
     Ranked with the hubs — a market page is an aggregate over companies,
     the way a hub is one over a theme. */
  if (markets.length) {
    entries.push({ loc: "/market/", lastmod: now, priority: "0.8", changefreq: "daily" });
    markets.forEach((m) => {
      entries.push({
        loc: `/market/${m.slug}/`,
        lastmod: isoDate(m.articles[0] && m.articles[0].publishedAt) || now,
        priority: "0.7",
        changefreq: "weekly",
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
   The data export — /funding.csv and /funding.json

   The tracker is the one thing on this site that is not a restatement
   of someone else's reporting (rule 3c-i): no outlet covers more than
   its own rounds, so a table deduplicated across all of them exists
   nowhere else. Until now it existed only as HTML, which is the wrong
   shape for the people who would link to it. An analyst, a newsletter
   writer or a journalist writing "the state of insurtech funding"
   cites a file they can open and check; nobody scrapes a table to
   cite it, they use whatever they can download, and if that is not
   here it is someone else's.

   It is also the markup half of the same argument. /funding/ has
   carried Dataset JSON-LD for a while, and a Dataset with no
   distribution.contentUrl is close to invisible to the surfaces that
   read it — Google Dataset Search among them — because there is
   nothing to distribute. Declaring the two downloads is what turns
   the existing claim into an indexable one.

   Six rules:
   • Both files are built from ONE row builder (exportRow), the way
     fundingStats() is a thin wrapper over fundingDeals(). A CSV and a
     JSON that disagree about a round are worse than either alone.
   • Rows are derived on every build, never persisted — the same
     contract collectDeals() has (rule 3c-i), so a regex or extractor
     fix retroactively corrects the download along with the pages.
   • The source column is what makes the file citable rather than
     merely downloadable. Every row carries the outlet, the URL it was
     reported at and the other outlets that ran it, so a reader can
     check any figure without coming back here first. That is also why
     amounts ship BOTH ways: converted USD and the figure the outlet
     actually printed, which is rule 3c-i's "a converted row prints
     what the outlet printed", carried into the file.
   • Neither file is in sitemap.xml, for feed.xml's reason: a sitemap
     lists pages to index, and these are transports. Discovery is the
     Dataset distribution and the visible block on /funding/.
   • Text cells are guarded against spreadsheet formula injection. A
     field opening = + - or @ is executed on open by Excel and Sheets,
     and every text cell here is derived from a headline written by
     someone else. No row in the archive triggers it today; publishing
     a file for strangers to open in a spreadsheet is not the place to
     rely on that holding.
   • They must be in the `git add` pathspec of every workflow that
     commits pages — the hazard rules 3e, 3g and 3h all carry. Both
     files change whenever the archive does, and funding.json stamps
     generatedAt, so they are dirty on most builds. That is the churn
     sitemap.xml already has, not a signal.
   ══════════════════════════════════════════════════════════════ */

/* Amounts are millions, converted through funding.js's fixed rate
   table. Three decimals is $1,000 of precision — enough that a €250k
   round survives the conversion, short of exposing float noise. */
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/* One round, flat. Both files serialise exactly this, so the column
   set is declared once and the two can never drift apart. */
function exportRow(d) {
  const slug = d.company ? d.company.slug : "";
  // unlinkedCompany() is a DISPLAY fallback and returns an em dash when
  // the headline named no raiser (rule 3c-vi). An em dash is a fine
  // table cell and a terrible data value — it reads as a name to
  // anything that groups on this column, so an unattributed round
  // ships blank.
  const raw = unlinkedCompany(d);
  return {
    company: d.company ? d.company.name : raw === "—" ? "" : raw,
    company_url: slug ? url(`/company/${slug}/`) : "",
    amount_usd_millions: round3(d.amountM),
    amount_reported_millions: round3(d.nativeM || d.amountM),
    reported_currency: d.currency || "USD",
    stage: d.stage || "",
    lead_investor: d.lead || "",
    announced: isoDate(d.publishedAt),
    source: d.source || "",
    source_url: d.link || "",
    also_reported_by: (d.alsoReportedBy || []).join("; "),
  };
}

const EXPORT_COLUMNS = Object.keys(exportRow({}));

/* What each column means, carried inside funding.json so the file
   explains itself to someone who arrives at it without the page. */
const EXPORT_FIELDS = {
  company: "Company that raised the round, as canonicalised by this site. Blank where the headline named no raiser.",
  company_url: "That company's page here. Blank where no company was attributed.",
  amount_usd_millions: "Amount raised, in millions of US dollars, converted at a fixed reference rate.",
  amount_reported_millions: "The same amount in millions of the currency the outlet printed.",
  reported_currency: "ISO code of the currency the outlet printed.",
  stage: "Round stage, only where a headline states it outright. Blank otherwise.",
  lead_investor: "Lead investor, only where a headline states it outright. Blank otherwise.",
  announced: "Date the round was reported, YYYY-MM-DD.",
  source: "Outlet the figure in this row was taken from.",
  source_url: "The report that figure comes from — check it before citing.",
  also_reported_by: "Other outlets that covered the same round, semicolon-separated.",
};

/* A leading = + - or @ makes Excel and Google Sheets treat a cell as a
   formula. Every text value here came out of somebody else's headline,
   so it is escaped rather than trusted. Numbers are exempt: they are
   written unquoted and a negative amount is not a thing this data has. */
const CSV_FORMULA = /^[=+\-@\t\r]/;
function csvCell(v) {
  if (typeof v === "number") return String(v);
  let s = v === null || v === undefined ? "" : String(v);
  if (CSV_FORMULA.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildFundingExport(deals = []) {
  const rows = deals.map(exportRow);

  // RFC 4180: CRLF between records. No byte-order mark — it would help
  // one Excel path and put a stray ﻿ on the first column name in
  // every plain UTF-8 reader, which is the audience that matters here.
  const csv = [
    EXPORT_COLUMNS.join(","),
    ...rows.map((r) => EXPORT_COLUMNS.map((k) => csvCell(r[k])).join(",")),
  ].join("\r\n") + "\r\n";
  fs.writeFileSync(path.join(ROOT, "funding.csv"), csv);

  const json = {
    name: "Insurtech funding rounds",
    description:
      "Every insurtech funding round with a disclosed figure, aggregated from across the trade " +
      "press and deduplicated into one row per round. A floor on real activity, not a market estimate.",
    publisher: SITE.name,
    url: url("/funding/"),
    method: url("/funding/"),
    terms: "Free to use with attribution to " + SITE.name + " and a link to " + url("/funding/") + ".",
    generatedAt: new Date().toISOString(),
    count: rows.length,
    totalDisclosedUsdMillions: round3(totalOf(deals)),
    // The archive runs newest-first (collectDeals sorts it), so the
    // coverage bounds read off the two ends.
    coverage: rows.length
      ? { from: rows[rows.length - 1].announced, to: rows[0].announced }
      : null,
    fields: EXPORT_FIELDS,
    rounds: rows,
  };
  fs.writeFileSync(path.join(ROOT, "funding.json"), JSON.stringify(json, null, 2) + "\n");

  console.log(`  ✓ funding.csv + funding.json — ${rows.length} rounds`);
}

/* The visible half. A download nobody can see is a download nobody
   links to, and the Dataset markup alone only reaches machines.
   Built from .method/.method-text, which are already the tracker's
   "how to use this" voice — so this adds no CSS and needs no
   stylesheet cache-bust (rule 3c-i).

   The attribution line spells the URL out as its own anchor text
   rather than saying "this tracker": the block's job is to tell a
   citing reader what to link to, and the other phrasing links to the
   page it is printed on. */
function downloadBlock(n) {
  return `    <section class="method">
      <h2 class="fact-label">Download the data</h2>
      <p class="method-text">
        All ${n} round${n === 1 ? "" : "s"} as
        <a href="/funding.csv" download>CSV</a> or
        <a href="/funding.json">JSON</a> — company, amount in US dollars,
        the figure as originally printed, stage, lead investor, date and
        a link to the reporting behind every row. Rebuilt with this page,
        so a download is never older than what is shown above.
      </p>
      <p class="method-text">
        Free to use with attribution to Insurtech Daily and a link back to
        <a href="/funding/">${escHtml(url("/funding/").replace(/^https?:\/\//, ""))}</a>.
        Please read how the numbers are compiled below before citing them.
      </p>
    </section>`;
}

/* ══════════════════════════════════════════════════════════════
   The feed

   /feed.xml carries the BRIEF ARCHIVE, and nothing else. That is the
   whole design decision, so it is worth writing down.

   The obvious feed for a news aggregator is the wire, and the wire is
   exactly the wrong thing to syndicate: every item on it is another
   outlet's headline pointing at another outlet's URL. A feed of those
   sends a subscriber away from this site on every item, hands them
   content we did not write, and gives us nothing back. The brief is
   the inverse — it is the one thing here nobody else wrote (rule 3b),
   each item links to a /brief/<date>/ page of ours, and the prose
   carries the company links windowCompanies() stamped (rule 3b-vi),
   so a copy of this feed republished anywhere is a copy full of links
   home. One item a day is thin next to a wire feed; it is also the
   only version of this that is worth a subscriber having.

   Three rules:
   • Hrefs are absolutised on the way out. The linkers emit
     root-relative paths, which is right for a page (rule 4) and
     broken in a feed — the reader resolves against ITS own origin, or
     nothing at all. Anything rendered into an item body has to be
     rewritten to SITE.origin, so the rewrite lives here rather than
     at the call sites and covers whatever a body picks up later.
   • It is not in sitemap.xml. A sitemap lists pages a crawler should
     index; feed.xml is a transport, and listing it asks Google to
     index a document that renders as markup. Discovery is the
     <link rel="alternate"> in HEAD_ASSETS, which is the mechanism
     every reader and aggregator actually looks for.
   • Full prose in content:encoded, teaser in description. Readers
     that show only the summary get the teaser; readers that show the
     body get the whole brief. Truncating both is how a feed becomes a
     thing people unsubscribe from.
   ══════════════════════════════════════════════════════════════ */

/* ~a month of dailies. The archive is append-only (rule 3b) and every
   entry keeps its page, so the feed is a window on it, not a mirror. */
const FEED_MAX = 30;

/* RSS 2.0 wants RFC-822, which Date has no formatter for. Pinned to
   GMT for the reason fullDate() is pinned to UTC: a local build and a
   CI build must not disagree about an item's date. */
const RFC822_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC822_MON = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function rfc822(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${RFC822_DAY[d.getUTCDay()]}, ${p(d.getUTCDate())} ` +
    `${RFC822_MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`
  );
}

/* Root-relative → absolute. See the rule above: a feed body is read
   somewhere else, so /company/foo/ resolves against the reader's
   origin and lands nowhere. */
const absolutise = (html) =>
  String(html).replace(/(href|src)="\/(?!\/)/g, `$1="${SITE.origin}/`);

/* CDATA is the readable way to carry HTML through XML, and it has
   exactly one failure mode: a literal `]]>` inside the payload ends
   the section early and corrupts the document. Prose never contains
   one — but "never" is what the OG block said too, so split it. */
const cdata = (s) => `<![CDATA[${String(s).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;

function feedItemHtml(b, db) {
  const link = briefLinker(b, db);
  const parts = [`<h2>What's happening</h2>`, `<p>${link(b.whatsHappening)}</p>`];
  if (b.whyItMatters) {
    parts.push(`<h2>Why it matters</h2>`, `<p>${link(b.whyItMatters)}</p>`);
  }
  parts.push(
    `<p><a href="${escAttr(url(`/brief/${b.date}/`))}">Read this brief on ${escHtml(SITE.name)}</a></p>`
  );
  return absolutise(parts.join("\n"));
}

function buildFeed(briefs = [], db = {}) {
  const items = briefs.slice(0, FEED_MAX);
  const self = url("/feed.xml");
  const built = rfc822(new Date().toISOString());

  const body = items
    .map((b) => {
      const loc = url(`/brief/${b.date}/`);
      const day = fullDate(b.date || b.generatedAt);
      return `    <item>
      <title>${escHtml(b.headline)}</title>
      <link>${escHtml(loc)}</link>
      <guid isPermaLink="true">${escHtml(loc)}</guid>
      <pubDate>${rfc822(b.generatedAt || b.date)}</pubDate>
      <description>${escHtml(b.teaser || clamp(b.whatsHappening))}</description>
      <content:encoded>${cdata(feedItemHtml(b, db))}</content:encoded>
      <dc:creator>${escHtml(SITE.name)}</dc:creator>
      <category>Insurtech</category>
      <source url="${escAttr(self)}">${escHtml(SITE.name)}</source>
      <!-- ${escHtml(day)} -->
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escHtml(SITE.name)} — The Brief</title>
    <link>${escHtml(url("/brief/"))}</link>
    <atom:link href="${escAttr(self)}" rel="self" type="application/rss+xml" />
    <description>${escHtml(
      "A daily written brief on what moved in insurtech — funding, launches, " +
        "partnerships and platform moves, read across hundreds of outlets."
    )}</description>
    <language>${escHtml(SITE.lang)}</language>
    <lastBuildDate>${built}</lastBuildDate>
    <generator>scripts/seo.js</generator>
    <image>
      <url>${escHtml(url(SITE.logo))}</url>
      <title>${escHtml(SITE.name)}</title>
      <link>${escHtml(url("/brief/"))}</link>
    </image>
${body}
  </channel>
</rss>
`;
  fs.writeFileSync(path.join(ROOT, "feed.xml"), xml);
  console.log(`  ✓ feed.xml — ${items.length} briefs`);
}

/* ══════════════════════════════════════════════════════════════
   Company page directory management
   ══════════════════════════════════════════════════════════════ */
function buildCompanyPages(db, deals = [], profiles = {}) {
  const outRoot = path.join(ROOT, "company");
  fs.mkdirSync(outRoot, { recursive: true });

  // One pass over the deals rather than a filter per company — 1,300
  // companies against ~190 rounds makes the naive version quadratic.
  const bySlug = new Map();
  for (const d of deals) {
    if (!d.company) continue;
    if (!bySlug.has(d.company.slug)) bySlug.set(d.company.slug, []);
    bySlug.get(d.company.slug).push(d);
  }

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

  let funded = 0, profiled = 0;
  for (const c of companies) {
    const cd = bySlug.get(c.slug) || [];
    if (cd.length) funded++;
    const profile = profiles[c.slug] && profiles[c.slug].known ? profiles[c.slug] : null;
    if (profile) profiled++;
    const dir = path.join(outRoot, c.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), companyPageHtml(c, cd, profile));
  }
  const n = companies.filter(indexable).length;
  // The second number is the point of the funding door: pages that carry
  // round data and would otherwise have been noindex on story count.
  const onFunding = companies.filter(
    (c) => (c.count || 0) < PAGE_MIN_STORIES && FUNDED_SLUGS.has(c.slug)
  ).length;
  // Pages that clear the gate on the profile ALONE — too thin on stories
  // and carrying no round. This is the number the profile work exists to
  // move, so it gets its own line rather than being folded into the total.
  const onProfile = companies.filter(
    (c) =>
      (c.count || 0) < PAGE_MIN_STORIES &&
      !FUNDED_SLUGS.has(c.slug) &&
      PROFILED_SLUGS.has(c.slug)
  ).length;
  console.log(
    `  ✓ ${companies.length} company pages under /company/ — ` +
      `${n} indexable, ${companies.length - n} noindex (under ${PAGE_MIN_STORIES} stories,` +
      ` no disclosed round, no profile)\n` +
      `    ${funded} carry a funding block; ${onFunding} of those are indexable on it alone\n` +
      `    ${profiled} carry an original profile; ${onProfile} of those are indexable on it alone`
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
  const quarters = collectQuarters(deals);
  const years = collectYears(deals);
  const ranked = collectFundedCompanies(deals);
  const profiles = companyProfiles();
  // `briefs` above is the daily-brief archive; these are the standing
  // topic explainers. Two different things called a brief on this site.
  const hubBriefs = topicBriefs();
  // Every page's nav lists the hubs, so the list has to exist before
  // the first page is written — and so must the funded-company set,
  // which the company pages, the companies index and the sitemap all
  // consult through indexable().
  setNavTopics(topics);
  setFundedSlugs(deals);
  setProfiledSlugs(profiles);
  /* Same contract as the two above: the company pages turn a profile's
     place into a link to its market, so the set of markets that HAVE a
     page has to exist before the first company page is written. */
  const markets = collectMarkets(db, profiles, deals);
  setMarketSlugs(markets);
  /* Reads the persistent store rather than this run's batch, like the
     hubs do — a term's coverage is the whole archive, not today's wire.
     Collected here rather than inside buildGlossaryPages() because the
     company pages and the topic hubs link glossary terms out of their
     own prose (autolink.js) and are built first, so the list has to
     exist before the first page is written. */
  const terms = glossaryLive(rawStore());
  setLinkTerms(terms);
  buildCompanyPages(db, deals, profiles);
  buildBriefPages(briefs, db);
  buildTopicPages(topics, db, deals, hubBriefs);
  buildFundingPages(deals, months, quarters, years, ranked);
  buildGlossaryPages(terms, db);
  buildMarketPages(markets);
  injectAnalytics();
  injectSocial();
  injectFootLinks();
  injectHomepage(news, db);
  injectCompaniesIndex(db);
  buildSitemap(news, db, briefs, topics, months, deals, quarters, years, ranked, terms, markets);
  buildRobots();
  buildFeed(briefs, db);
  buildFundingExport(deals);
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

module.exports = { head, SITE, companyPageHtml, briefPageHtml, clamp, isoDate, descFromProfile };
