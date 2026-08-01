/* ============================================================
   The glossary — terms, matching, and the coverage gate
   ------------------------------------------------------------
   One definition, three readers: glossary-write.js asks Claude for
   each term's explainer, seo.js builds /glossary/ + /glossary/<slug>/
   from the same list, and both agree about which stories belong to a
   term because the matching lives here and nowhere else.

   WHY THE LIST IS SHORT, AND WHY IT IS GATED

   The obvious version of this feature is a hundred-plus insurance
   terms, which is what a glossary usually is. Measured against this
   archive, that version does not survive:

     · Only ~7% of stored articles carry a summary, so a term can only
       be matched against the HEADLINE. Trade headlines say "Acme
       raises $10M", not "quota share" — 37 of 86 candidate terms had
       zero coverage in 3,068 stories and 61 had fewer than three.
     · The terms with the most coverage are the ones a topic hub
       already owns. Embedded insurance appears in 104 headlines and
       has /topic/embedded/; cyber insurance has /topic/cyber/. A
       glossary page for either competes with the hub for one query,
       which is the duplication collectMonths() and PERIOD_DEAL_CAP
       exist to prevent one directory over.

   What is left is the part that is actually differentiated: a term
   this site can define AND show live coverage of, which is the pair
   Investopedia and the III cannot produce. So TERMS holds only terms
   that no hub owns, and a page earns indexing on MIN_STORIES of its
   own coverage (see indexableTerm()). Everything else is built,
   linked and noindex, exactly as a thin company page is under rule 3a
   — the visible list stays complete, the crawler-facing one is gated.

   The gate is a floor, not a verdict. A term crosses it as the archive
   deepens and its page becomes indexable on the next build, with no
   redirect and no migration — the same self-scaling property the
   company gate has.

   ON THE PATTERNS

   Curated and hand-checked, like CANON_LIST and SPLIT_LIST in
   companies.js, and for the same reason: every loose pattern here
   files a story under a term it does not belong to, and the page
   asserts that story is an example of the term. Two live traps this
   list has already hit — a bare /\bmarine\b/ matches Tokio Marine on
   every one of its stories, and a bare /\bcaptive\b/ matches "captive
   market". Neither is findable except by reading the matches.
   ============================================================ */

const { admits } = require("./relevance");

/* A term page is indexable on its own coverage at this floor. Three,
   like PAGE_MIN_STORIES, and for the identical argument: below it the
   page is a definition with a token example beside it, which is a
   dictionary entry competing with reference sites that have thousands
   of them. Above it the coverage is the reason to be here. */
const MIN_STORIES = 3;

/* How many stories a term page lists. Well under the hubs' STORY_CAP
   of 60: a term page is an explainer with evidence attached, not an
   archive, and the hub is one click away for the full run. */
const STORY_CAP = 24;

/* slug   — the URL segment, and the cache key in companies-store.json
   term   — the h1 and the DefinedTerm name; how the query is typed
   full   — spelled-out form when the term is an abbreviation, else null
   re     — hand-checked; matched against the headline
   topic  — the hub to send a reader to for the running coverage, by
            TAXONOMY name so a rename is caught by the build */
const TERMS = [
  {
    slug: "mga",
    term: "MGA",
    full: "Managing general agent",
    re: /\bMGAs?\b|managing general agent/i,
    topic: "Industry",
  },
  {
    slug: "reinsurance",
    term: "Reinsurance",
    full: null,
    re: /\breinsur/i,
    topic: "Property & Cat",
  },
  {
    slug: "parametric-insurance",
    term: "Parametric insurance",
    full: null,
    re: /parametric/i,
    topic: "Property & Cat",
  },
  {
    slug: "insurance-broker",
    term: "Insurance broker",
    full: null,
    re: /\bbrokers?\b|brokerage/i,
    topic: "Industry",
  },
  {
    slug: "insurance-fraud",
    term: "Insurance fraud",
    full: null,
    re: /\bfraud\b|fraudulent/i,
    topic: "Claims & Underwriting",
  },
  {
    slug: "takaful",
    term: "Takaful",
    full: "Islamic cooperative insurance",
    re: /takaful/i,
    topic: "Industry",
  },
  {
    slug: "insurance-linked-securities",
    term: "Insurance-linked securities",
    full: null,
    // ILS as an initialism, plus the instrument it usually means. "cat
    // bond" is spelled out in headlines far more often than "ILS" is.
    re: /insurance[- ]linked securit|\bILS\b|\bcat bonds?\b|catastrophe bonds?/i,
    topic: "Property & Cat",
  },
  {
    slug: "annuity",
    term: "Annuity",
    full: null,
    re: /\bannuit(?:y|ies)\b/i,
    topic: "Health & Life",
  },
  {
    slug: "microinsurance",
    term: "Microinsurance",
    full: null,
    re: /micro-?insurance/i,
    topic: "Industry",
  },
  {
    slug: "protection-gap",
    term: "Protection gap",
    full: null,
    re: /protection gap|under-?insur/i,
    topic: "Industry",
  },
  {
    slug: "excess-and-surplus-lines",
    term: "Excess and surplus lines",
    full: "E&S / non-admitted insurance",
    re: /excess (?:and|&) surplus|\bE&S\b|surplus lines|non-?admitted/i,
    topic: "Industry",
  },
  {
    slug: "workers-compensation",
    term: "Workers' compensation insurance",
    full: null,
    re: /workers.{0,2} comp/i,
    topic: "Industry",
  },
  {
    slug: "telematics",
    term: "Telematics insurance",
    full: "Usage-based motor insurance",
    re: /telematics|usage[- ]based insur|pay[- ]as[- ]you[- ]drive|pay[- ]how[- ]you[- ]drive/i,
    topic: "Auto & Mobility",
  },
  {
    slug: "bancassurance",
    term: "Bancassurance",
    full: null,
    re: /bancassurance/i,
    topic: "Embedded",
  },
  {
    slug: "premium-finance",
    term: "Premium finance",
    full: null,
    re: /premium financ/i,
    topic: "Industry",
  },
  {
    /* NOT /\bmarine\b/: that matches Tokio Marine, which has more
       stories here than marine insurance does. The qualifier is the
       whole pattern. */
    slug: "marine-insurance",
    term: "Marine insurance",
    full: null,
    re: /marine (?:insur|cargo|hull|underwrit)|cargo insur|hull (?:and|&) machinery/i,
    topic: "Industry",
  },
  {
    /* "captive" alone matches "captive market" and "captive audience". */
    slug: "captive-insurance",
    term: "Captive insurance",
    full: null,
    re: /captive insur|\bcaptives?\b(?!\s+(?:market|audience|customer))/i,
    topic: "Industry",
  },
  {
    slug: "crop-insurance",
    term: "Crop insurance",
    full: null,
    re: /crop insur|agricultur(?:al|e) insur|\bcrop cover/i,
    topic: "Property & Cat",
  },
  {
    slug: "trade-credit-insurance",
    term: "Trade credit insurance",
    full: null,
    re: /trade credit insur|credit insurance/i,
    topic: "Industry",
  },
  {
    slug: "directors-and-officers",
    term: "Directors and officers insurance",
    full: "D&O",
    re: /\bD&O\b|directors and officers/i,
    topic: "Industry",
  },
  {
    slug: "professional-indemnity",
    term: "Professional indemnity insurance",
    full: "E&O / professional liability",
    re: /\bE&O\b|errors and omissions|professional indemnity|professional liability/i,
    topic: "Industry",
  },
  {
    slug: "title-insurance",
    term: "Title insurance",
    full: null,
    re: /title insurance/i,
    topic: "Property & Cat",
  },
  {
    slug: "third-party-administrator",
    term: "Third-party administrator",
    full: "TPA",
    re: /third[- ]party administrator|\bTPAs?\b/i,
    topic: "Health & Life",
  },
  {
    slug: "stop-loss-insurance",
    term: "Stop-loss insurance",
    full: null,
    re: /stop[- ]loss|self[- ](?:funded|insured) (?:health|plan|employer)|level[- ]funded/i,
    topic: "Health & Life",
  },
  {
    slug: "fronting-carrier",
    term: "Fronting carrier",
    full: null,
    re: /\bfronting\b|\bfronted (?:paper|program)/i,
    topic: "Industry",
  },
  {
    slug: "surety-bond",
    term: "Surety bond",
    full: null,
    re: /\bsurety\b/i,
    topic: "Industry",
  },
  {
    slug: "extended-warranty",
    term: "Extended warranty",
    full: null,
    re: /extended warrant|warranty (?:insur|provider|program|cover)/i,
    topic: "Embedded",
  },
  {
    slug: "gap-insurance",
    term: "GAP insurance",
    full: "Guaranteed asset protection",
    re: /\bGAP insurance\b|guaranteed asset protection/i,
    topic: "Auto & Mobility",
  },
];

/* The store as every reader of it sees the archive — relevance gate
   re-applied on the way out (rule 3c-ii), because a term must not
   present a story the hubs and the tracker have already refused. */
function storeArticles(store) {
  return Object.entries(store.seen || {})
    .map(([link, v]) => ({ link, ...v }))
    .filter((a) => a && a.title && a.publishedAt)
    .filter(admits);
}

/* The HEADLINE only, deliberately, even though ~7% of stories carry a
   summary that could be read too.

   A term page does not merely list stories, it asserts they are
   examples of the term — so a match has to be about what the story is
   about, and a summary match is usually about what the story mentions.
   Reading summaries put a Travelers quarterly-earnings report on
   "surety bond" (a line item in a segment table) and an executive
   appointment on "annuity" (the carrier's business, not the news).
   Both are honest matches for a search index and wrong for a page
   whose claim is "here is this term in practice".

   The recall given up is small — a summary exists on one story in
   fourteen — and the terms it would add are exactly the incidental
   ones. Precision is the whole differentiator here; a glossary that
   cites the wrong evidence is worse than one that cites less. */
const haystack = (a) => a.title || "";

function collectTerms(store) {
  const arts = storeArticles(store);
  return TERMS.map((t) => {
    const articles = arts
      .filter((a) => t.re.test(haystack(a)))
      .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
    return { ...t, n: articles.length, articles };
  });
}

/* Indexable on coverage, exactly like a company page: the definition
   alone is the part anyone could write, the coverage is the part only
   this archive has. A term below the floor still gets a built, linked
   page — the glossary index must not dead-end — it is simply kept out
   of sitemap.xml and served noindex, follow. */
const indexableTerm = (t) => t.n >= MIN_STORIES;

module.exports = { TERMS, collectTerms, indexableTerm, storeArticles, MIN_STORIES, STORY_CAP };
