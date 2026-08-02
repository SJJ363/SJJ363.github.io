/* ============================================================
   MARKETS — the geography axis, /market/<country>/
   ------------------------------------------------------------
   Every other URL on this site slices the archive by company, by
   subject or by date. None of those is how the sector is asked
   about geographically: "insurtech companies India", "insurtech
   UK", "insurtech startups Germany" are typed constantly and are
   evergreen in the way /glossary/ and the topic hubs are, where
   /funding/2026-q3/ decays the moment the quarter closes.

   THE DATA WAS ALREADY BEING THROWN AWAY

   profile.js has asked for `place` ("City, Country", or just the
   country) on every company since profiles existed, and seo.js
   rendered it as one grey badge and used it for nothing. At the
   time this was written 577 of 744 written profiles carried one
   across 61 country tails — and the profile backfill was a little
   over half done, so both numbers roughly double.

   WHY IT PASSES THE TEST THESE PAGES HAVE TO PASS

   The same test collectQuarters() and /funding/companies/ pass: a
   market page leads with an aggregate that exists in no single
   round table and in nobody else's reporting — how many companies
   this archive tracks in a country, what kinds they are, what they
   have disclosed between them, and the coverage underneath. A page
   that merely re-listed the same headlines under a flag would be
   the duplication PERIOD_DEAL_CAP and collectMonths() exist to
   prevent, one directory over.

   ON THE ALIASES

   Curated and hand-verified, like CANON_LIST in companies.js and
   TERMS in glossary.js, and for the same reason: "United States",
   "USA" and "US" all appear as tails in the same cache and are one
   market. Left un-collapsed they are three pages splitting one
   country's companies between them, which is worse than having no
   geography axis at all. Everything not in the list is taken at
   face value — the tails a language model writes for country names
   are clean, and a wrong-but-rare tail simply never reaches the
   floor.

   The US-state map is defensive rather than observed: no state has
   ever appeared as a tail, but the prompt asks for "City, Country"
   and a slip to "San Francisco, California" is the one error shape
   that would build a confidently wrong page rather than a thin one.

   ON THE GATE, AND WHY IT DIFFERS FROM RULE 3a

   Company pages, glossary terms and thin months are all built,
   linked and served noindex, because something else on the site
   links them and a click must never dead-end. Nothing links a
   market page except this site's own markup — the place badge on a
   company page and the market index — so there is no dead-end to
   protect against, and a market below the floor is simply not
   built. That is one floor rather than two, and it keeps ~40
   one-and-two-company stubs (Gibraltar, Saint Kitts and Nevis,
   Zambia) off a site whose main quality liability is mass-produced
   thin pages.
   ============================================================ */

/* A market earns a page on both halves of what the page claims: a
   set of companies worth calling a market, and enough coverage to
   show it. Five and twelve are floors, not verdicts — a country
   crosses them as the archive deepens and as profile.js fills in
   the remaining places, on the next build, with no migration. */
const MIN_COMPANIES = 5;
const MIN_STORIES = 12;

/* Page weight guards. The company table is the page's payload and
   its internal-link value, so it runs deep; the coverage list
   below it is a sample, with each company's own page one click
   away for the rest. */
const COMPANY_CAP = 120;
const STORY_CAP = 40;
const DEAL_CAP = 12;

/* Tails that are not a market. A profile that answers "Global" or
   "Europe" is telling us it doesn't know the headquarters, and a
   page called "Insurtech in Global" is the kind of error that only
   ever gets noticed by a reader. */
const SKIP = new Set([
  "global", "worldwide", "international", "remote", "various", "multiple",
  "europe", "asia", "africa", "north america", "south america", "latin america",
  "middle east", "apac", "emea", "n/a", "na", "unknown", "none",
]);

/* Raw tail (lowercased) → the canonical market name. */
const ALIASES = {
  "usa": "United States",
  "us": "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  "united states of america": "United States",
  "america": "United States",
  "uk": "United Kingdom",
  "u.k.": "United Kingdom",
  "great britain": "United Kingdom",
  "britain": "United Kingdom",
  "england": "United Kingdom",
  "scotland": "United Kingdom",
  "wales": "United Kingdom",
  "northern ireland": "United Kingdom",
  "uae": "United Arab Emirates",
  "u.a.e.": "United Arab Emirates",
  "korea": "South Korea",
  "republic of korea": "South Korea",
  "republic of ireland": "Ireland",
  "the netherlands": "Netherlands",
  "holland": "Netherlands",
  "czechia": "Czech Republic",
  "hong kong sar": "Hong Kong",
  "prc": "China",
  "people's republic of china": "China",
};

/* Defensive: a city-and-state answer where a city-and-country one
   was asked for. Never observed; cheap; the alternative is a
   "Insurtech in California" page that reads as authoritative. */
for (const state of [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming",
  "Washington DC", "District of Columbia",
]) {
  ALIASES[state.toLowerCase()] = "United States";
}

/* Names that read as "in the X" rather than "in X". Used for the
   h1, the title and the prose, so "Insurtech in the United
   States" rather than the headline-ese alternative. */
const THE = new Set([
  "United States", "United Kingdom", "United Arab Emirates", "Netherlands",
  "Philippines", "Czech Republic", "Bahamas", "Maldives",
]);

const marketSlug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/* "Gurugram, India" → India; "Bermuda" → Bermuda. The last
   comma-separated segment, canonicalised. Null when the profile
   gave nothing usable, which is a first-class answer: the company
   simply belongs to no market and appears on none. */
function countryOf(place) {
  const tail = String(place || "").split(",").pop().trim().replace(/\.$/, "");
  if (!tail || tail.length < 2) return null;
  const key = tail.toLowerCase();
  if (SKIP.has(key)) return null;
  const name = ALIASES[key] || tail;
  const slug = marketSlug(name);
  if (!slug) return null;
  return { slug, name, the: THE.has(name) };
}

/* "in India" / "in the United States" — one helper so the title,
   the h1, the description and the prose can never disagree. */
const inMarket = (m) => (m.the ? `the ${m.name}` : m.name);

const indexableMarket = (m) =>
  m.companies.length >= MIN_COMPANIES && m.stories >= MIN_STORIES;

module.exports = {
  countryOf,
  marketSlug,
  inMarket,
  indexableMarket,
  MIN_COMPANIES,
  MIN_STORIES,
  COMPANY_CAP,
  STORY_CAP,
  DEAL_CAP,
};
