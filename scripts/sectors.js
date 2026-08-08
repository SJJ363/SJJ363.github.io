/* ============================================================
   SECTORS — the line-of-business axis, /sector/<slug>/
   ------------------------------------------------------------
   Every other URL on this site slices the archive by company, by
   subject, by date or by country. None of those is "what kind of
   insurance does this company actually sell", which is how the
   sector is asked about more than any of them: "pet insurance
   companies", "workers comp insurtech", "parametric insurance
   startups", "travel insurance providers". Those are directory
   queries, they are evergreen in the way /glossary/ and the topic
   hubs are, and nothing here answered them — the companies index
   is 1,440 names sorted by recency, and a topic hub is a news page
   with a fourteen-name badge list bolted to the side.

   THE DATA WAS ALREADY BEING THROWN AWAY, AGAIN

   This is /market/'s story a second time. profile.js has written a
   factual sentence about what every company does since profiles
   existed (rule 3a-ii), and seo.js rendered it as a paragraph and
   used it for one meta description. `place` became fourteen market
   pages for no Claude spend; the sentence itself is the richer
   half, because what a company SELLS is in it and is in nothing
   else here. The taxonomy tags stories, not companies, and it tags
   them by event — Funding, M&A, Partnerships — so no existing
   field answers "is this a pet insurer".

   WHY IT PASSES THE TEST THESE PAGES HAVE TO PASS

   The same test collectQuarters(), /funding/companies/ and
   /market/ pass: the page leads with an aggregate that is in no
   round table, on no other page here, and in nobody else's free
   reporting — how many companies this archive tracks in a line of
   business, what they are, where they are, and what they have
   disclosed between them. A page that merely re-listed the same
   headlines under a heading would be the duplication
   PERIOD_DEAL_CAP and collectMonths() exist to prevent.

   ON OVERLAPPING A GLOSSARY TERM

   Ten of these have a glossary page — workers' compensation,
   title, marine, parametric, annuity, E&S, D&O and so on — and
   rule 3e's exclusion rule has to be answered here too. It comes
   out the same way as the hub case and for the same reason: the
   glossary page is a DEFINITION with headlines attached, this is a
   COMPANY DIRECTORY with money attached. "What is workers'
   compensation" and "workers comp insurance companies" are two
   questions, and the pair is worth more than either alone — which
   is the argument rule 3e itself makes for pairing a definition
   with live coverage, one axis over.

   So they cross-link rather than compete, the way /topic/funding/
   points at /funding/ (rule 3c-i): the glossary page is the
   background, this page is who is in the business. `term` below
   names the glossary slug where one exists, and the link is only
   rendered where that page was actually built.

   ON OVERLAPPING A TOPIC HUB

   Five sectors have a hub covering related ground (/topic/cyber/,
   /topic/auto-and-mobility/, and so on), and rule 3e's argument
   about glossary terms a hub already owns has to be answered
   rather than waved at. It comes out differently here, because the
   pages are different SHAPES aimed at different queries: a hub is
   a story list answering "cyber insurance news", this is a company
   directory answering "cyber insurance companies", and the hub's
   own explainer already holds the definitional query between them.
   The glossary case failed that test — a definition page for
   "embedded insurance" was the same shape and the same query as
   the hub. This one doesn't. Where a hub exists the two link each
   other explicitly, the way /topic/funding/ points at /funding/,
   so both readers and crawlers are told which is which.

   ON THE PATTERNS

   Curated and hand-checked, like CANON_LIST and SPLIT_LIST in
   companies.js and TERMS in glossary.js, and for the same reason:
   this page asserts that a company IS in a line of business, and a
   loose pattern makes that claim falsely. Every pattern below was
   read against its full match list before it was committed. Three
   traps that came out of doing that:

     · /\blife insur/ matches "non-life insurer" — the \b sits in
       the hyphen — and filed Balcia and TPL, both explicitly
       non-life, as life insurers. A pattern that asserts the
       OPPOSITE of the sentence it matched is the worst failure
       available here, and it is the same hyphen bug autolink.js's
       expand() documents from the other direction.

       The obvious repair is a veto on the whole profile, and it is
       wrong: nine of the seventeen profiles saying "non-life" say
       "life AND non-life" — Ageas, Helvetia, Triglav, Sony
       Financial, RMA — and those are life insurers. So the fix is
       a lookbehind INSIDE the pattern, refusing the match only
       where "non" is what precedes it, plus an explicit branch for
       the joint phrasing. A veto would have traded two wrong
       companies for nine missing ones.
     · A bare /\bmedical\b/ or /\bbenefits\b/ catches any company
       that mentions employee perks; the health pattern requires
       the insurance word next to it.
     · A bare /\bmarine\b/ matches Tokio Marine on every story, the
       same trap glossary.js already records. Marine is matched
       only with a line-of-business word attached.

   MATCHING IS ON THE PROFILE, NOT ON HEADLINES

   glossary.js matches headlines because a term page claims stories
   as examples of a term. This page claims COMPANIES, so it reads
   the one sentence on this site that describes a company — its
   profile. That also means membership inherits the profile's own
   judgment for free: a company with no profile, an unrecognised
   one, or one placed outside the market entirely simply has no
   sentence to match, and appears on no sector page.

   ON THE GATE

   The same one /market/ uses, and not rule 3a's: nothing links a
   sector page except this site's own markup, so there is no
   dead-end to protect against and a sector below the floor is not
   built at all rather than built noindex. Both halves of what the
   page claims have to clear — a set of companies worth calling a
   sector, and enough coverage to show it. Marine (4 companies) and
   title (2) sit under it today and are carried here anyway: they
   cost nothing, they self-gate, and they start building themselves
   the run after the archive deepens, with no migration.
   ============================================================ */

/* A sector earns a page on both halves of what it claims. Five and
   twelve, the same floors /market/ uses and for the same argument —
   they are floors, not verdicts, and a sector crosses them as
   profile.js fills in the rest of the archive. */
const MIN_COMPANIES = 5;
const MIN_STORIES = 12;

/* Page weight guards, mirroring markets.js. The company table is the
   payload and the internal-link value, so it runs deep; the coverage
   list below it is a sample with each company's own page one click
   away. */
const COMPANY_CAP = 120;
const STORY_CAP = 40;
const DEAL_CAP = 12;

/* ── Enumerations, and why a second pattern is needed ──────────
   Trade prose describes a multiline insurer as a LIST, and only the
   last item touches the head noun: Lemonade "sells renters,
   homeowners, pet, life and car insurance". Adjacency patterns
   match one item in five — Lemonade landed on auto insurance alone
   and was missing from pet, home and life, which is precisely the
   silent-miss failure rule 3c-v documents for the funding
   extractor. A miss here is invisible: a company that simply isn't
   on a page nobody knows to check.

   Widening the strict patterns is the wrong repair — /\blife\b/
   near /insur/ files "improving quality of life for insurance
   customers" as a life insurer. So the list form is its own test:
   the word has to be an ITEM in an enumeration that ENDS at an
   insurance head noun.

   That means the structure is checked, not merely the distance.
   The first version allowed any run of letters and spaces between
   the word and the head noun, and "Tokio Marine is a Japanese
   insurance group that underwrites property, casualty and life
   insurance" sailed through it — the run wandered across a whole
   clause to reach a comma, and filed the company under marine
   insurance on the strength of its own NAME. That is the trap
   glossary.js records for a bare /\bmarine\b/, re-entered by a
   different door, and distance alone will never catch it.

   So what follows the word must be either a list separator or the
   head noun itself, with nothing in between: zero or more ", X" /
   "and X" items, then the noun. "Marine is a Japanese…" offers
   neither and is rejected. The ITEMS are capped at two words each
   and five deep, because that is what an enumeration looks like.

   The optional-zero-items case is the LAST item in a list, which
   has punctuation only before it: "motor, property and travel
   cover" leaves travel sitting directly on the noun. That is plain
   adjacency, as safe as the strict patterns, and it is what
   catches the head-noun spellings they omit ("travel cover",
   "health cover").

   It also fixes the hyphen compounds for free, and they were real:
   "title-loan lending" (a Thai lender, not title insurance) and
   "health-tech company". A hyphen is neither a separator nor a
   head noun, so the match dies at it.

   The words below are only ever the bare line-of-business noun.
   Anything needing more context belongs in the strict pattern.

   ON THE HEAD NOUNS, WHICH ARE THE OTHER HALF OF RECALL

   The first version ended these lists at insurance|cover|policy and
   nothing else, and that quietly cost 68 memberships across 40
   companies — Arch, Swiss Re, Lloyd's, Beazley, RGA, Hannover Re,
   MetLife, SCOR. Trade prose does not always end the sentence on
   "insurance": it ends on what the book is made of. "Underwrites
   specialty property, casualty, cyber and mortgage RISKS", "life,
   health and pension PRODUCTS", "property, casualty and life
   REINSURANCE". Four of the largest names in the archive were on no
   sector page at all for that reason, and like every miss here it
   was silent.

   Each addition was measured on its own and every one of the 68 new
   memberships was read: zero false positives, which is what a corpus
   made entirely of insurance companies should produce — "risks" in
   these sentences can hardly mean anything else. Contributions were
   risks 37, products 17, reinsurance 11, underwriting 2, book 1.

   Two rules came out of that measurement and both are about what was
   LEFT OUT.

   `reinsurer`, `treaty`, `treaties` and `premiums` matched nothing.
   They are not harmless: vocabulary with no evidence behind it is
   untested surface that fires for the first time on some future
   profile, with no match list ever having been read. Dropped.

   `business` is the one judgement call rather than a measurement.
   It matched cleanly today — one company, VIG, whose only sentence
   is "writing property, casualty and life business" — but it is the
   most ambiguous noun available: "travel business", "health
   business", "the insurance business" are all ordinary phrases that
   say nothing about a line being underwritten, and this archive
   grows. One company is a thin return for a word that will keep
   firing. Dropped deliberately, with VIG as the known and accepted
   cost; `book` was kept over it on exactly this axis, being insurance
   jargon rather than a general noun. Re-measure before adding it. */
const LIST_ITEM = "[a-z][\\w'&-]*(?:\\s+[a-z][\\w'&-]*)?";
const LIST_SEP = "(?:\\s*,\\s*(?:and\\s+|or\\s+)?|\\s+and\\s+|\\s+or\\s+)";
const LIST_HEAD =
  "(?:insurance|insurer|reinsurance|coverage|cover|policies|policy|lines|underwriting|risks?|products?|book)";
const LIST_TAIL = `(?=(?:${LIST_SEP}${LIST_ITEM}){0,5}\\s*\\b${LIST_HEAD}\\b)`;

/* `head` is a regex SOURCE rather than a RegExp so the tail can be
   appended — which is also what lets the life entry carry the same
   non-life lookbehinds its strict pattern does. Built here once so
   fourteen sectors cannot each get the composition slightly wrong. */
const listRe = (head) => new RegExp(head + LIST_TAIL, "i");

/* slug    — the URL segment
   name    — the short label, for badges and the company page chip
   subject — the line of business as the query is typed. The h1 is this
             plus "companies", so it has to read straight into that
             word: "Life insurance" and not "Life insurance and
             annuities", with the rest of the scope carried by the
             blurb. The directory query is "<subject> companies" and
             the h1 is the largest heading on the page, so this is the
             one string that has to match it exactly (rule 3d-i's
             argument for SUBJECTS, one axis over).
   blurb   — one hand-written sentence saying what the line of business
             IS. Written here rather than asked of a model: fourteen
             sentences written once is not worth a seventh Claude step
             (rule 3g's closing note), and it is the publisher's copy in
             the same way /about/ and METHOD_NOTE are. It deliberately
             DEFINES rather than restates the name, so it reads as
             prose and so proseLinker() rarely spends this page's link
             budget pointing at the term the page is already about.
   re      — hand-checked against the full match list; matched against
             the company's profile summary
   list    — optional second test for the enumerated form (see above),
             built by listRe() from the bare line-of-business noun
   topic   — the hub covering related news, by TAXONOMY name so a
             rename is caught by the build rather than by a reader
   term    — the glossary slug defining this line of business, where one
             exists; linked only where that page was built */
const SECTORS = [
  {
    slug: "health-insurance",
    name: "Health",
    subject: "Health insurance",
    blurb:
      "Cover for medical costs, sold to individuals or to employers as a group benefit, and the technology that prices, administers and pays those claims.",
    re: /\bhealth insur|health plan|health benefit|health cover|health payer|healthcare payer|\bmedicare\b|\bmedicaid\b|\bmedical insur|dental (?:and vision )?insur|employee benefit/i,
    list: listRe("\\bhealth\\b"),
    topic: "Health & Life",
  },
  {
    slug: "life-and-annuities",
    name: "Life",
    subject: "Life insurance",
    blurb:
      "Policies that pay out on death or on a fixed term, and the savings and retirement products sold alongside them.",
    /* The lookbehinds cover "non-life", "non life" and "nonlife";
       the life[,\s]+…non-life branch puts back the insurers that sell
       both and say so in one breath. See the header. */
    re: /(?<!non)(?<!non-)(?<!non )\blife insur|\bannuit|whole life\b|term life\b|\blife[,\s]+(?:and\s+)?non-?\s?life|life and (?:health|pension|savings)|life assurance|funeral (?:cover|insur)|final expense/i,
    list: listRe("(?<!non)(?<!non-)(?<!non )\\blife\\b"),
    topic: "Health & Life",
    term: "annuity",
  },
  {
    slug: "auto-insurance",
    name: "Auto",
    subject: "Auto insurance",
    blurb:
      "Cover for cars, motorcycles and commercial fleets, including the driving data that increasingly prices it.",
    re: /\bauto insur|car insur|motor insur|vehicle insur|telematics|usage-based insur|fleet insur|driver behaviou?r|rideshare insur/i,
    list: listRe("\\b(?:car|motor|auto|vehicle)\\b"),
    topic: "Auto & Mobility",
    term: "telematics",
  },
  {
    slug: "home-and-property-insurance",
    name: "Property",
    subject: "Home and property insurance",
    blurb:
      "Cover for buildings and their contents — homeowners, renters, landlords and commercial property.",
    /* "property and casualty" is the industry's own name for the
       non-life book and every carrier writing it writes property, so
       it belongs here. The hyphenated spelling has to be explicit:
       the list form treats a hyphen as neither separator nor head
       noun (deliberately — that is what kills "title-loan"), so
       "property-casualty coverage" reaches this pattern or nothing. */
    re: /\bhome(?:owner)?s?'? insur|renters? insur|property insur|landlord insur|household insur|contents insur|home warranty|property[\s-]?(?:and[\s-]?)?casualty|\bP&C\b/i,
    list: listRe("\\b(?:home|homeowners?|renters?|property|contents|landlord)\\b"),
    topic: "Property & Cat",
  },
  {
    slug: "commercial-insurance",
    name: "Commercial",
    subject: "Commercial insurance",
    blurb:
      "Cover sold to businesses rather than to consumers, from sole traders to large corporates.",
    re: /\bcommercial insur|small.business insur|business insurance|commercial lines|commercial P&C|\bSMEs?\b|\bSMBs?\b/i,
    list: listRe("\\bcommercial\\b"),
    topic: "Industry",
  },
  {
    slug: "specialty-insurance",
    name: "Specialty",
    subject: "Specialty insurance",
    blurb:
      "Niche and hard-to-place risks that standard carriers decline, written on surplus lines or specialty paper.",
    re: /\bspecialty (?:insur|lines|risk)|excess and surplus|surplus lines|\bE&S\b/i,
    list: listRe("\\bspecialty\\b"),
    topic: "Industry",
    term: "excess-and-surplus-lines",
  },
  {
    slug: "parametric-and-climate-insurance",
    name: "Parametric",
    subject: "Parametric insurance",
    blurb:
      "Cover that pays on a measured trigger rather than an assessed loss, and the catastrophe and climate models behind it.",
    re: /\bparametric|crop insur|climate risk|catastrophe (?:risk|model|insur)|flood insur|wildfire|weather risk|\bnat cat\b/i,
    list: listRe("\\b(?:parametric|flood|crop|catastrophe)\\b"),
    topic: "Property & Cat",
    term: "parametric-insurance",
  },
  {
    slug: "cyber-insurance",
    name: "Cyber",
    subject: "Cyber insurance",
    blurb:
      "Cover for data breaches, ransomware and business interruption from an attack, usually sold with security monitoring attached.",
    re: /\bcyber insur|cyber risk|cyber cover|cyber liabilit|cyber-?securit.{0,30}insur/i,
    list: listRe("\\bcyber\\b"),
    topic: "Cyber",
  },
  {
    slug: "liability-insurance",
    name: "Liability",
    subject: "Liability insurance",
    blurb:
      "Cover for harm a business or professional causes to someone else — general liability, professional indemnity and directors' cover.",
    re: /\bliabilit(?:y|ies) insur|general liabilit|\bD&O\b|directors and officers|professional indemnit|\bE&O\b|errors and omissions|malpractice/i,
    list: listRe("\\bliability\\b"),
    topic: "Industry",
    term: "directors-and-officers",
  },
  {
    slug: "travel-insurance",
    name: "Travel",
    subject: "Travel insurance",
    blurb:
      "Cover bought for a trip — cancellation, delay, baggage and medical treatment abroad — most of it sold at the point of booking.",
    re: /\btravel insur|travel protection|trip (?:cancellation|protection)|travel medical|flight delay (?:cover|insur)/i,
    list: listRe("\\btravel\\b"),
    topic: "Embedded",
  },
  {
    slug: "pet-insurance",
    name: "Pet",
    subject: "Pet insurance",
    blurb:
      "Cover for veterinary treatment of cats, dogs and other animals, sold direct to owners and increasingly bundled with preventive care.",
    re: /\bpet insur|pet health (?:plan|cover|insur)|pet healthcare|veterinar/i,
    list: listRe("\\bpet\\b"),
    topic: "Product & Launches",
  },
  {
    slug: "workers-compensation",
    name: "Workers' comp",
    subject: "Workers' compensation insurance",
    blurb:
      "Cover an employer carries for injuries to its own staff, priced on payroll and claims history and, increasingly, on workplace safety data.",
    re: /workers.{0,3}comp/i,
    topic: "Claims & Underwriting",
    term: "workers-compensation",
  },
  {
    slug: "marine-and-aviation-insurance",
    name: "Marine",
    subject: "Marine and aviation insurance",
    blurb:
      "Cover for ships, aircraft and the cargo they carry — among the oldest lines in the market and among the last to be digitised.",
    re: /\bmarine (?:insur|cargo|risk)|cargo insur|shipping insur|hull and machinery|aviation insur/i,
    list: listRe("\\b(?:marine|aviation|cargo)\\b"),
    topic: "Industry",
    term: "marine-insurance",
  },
  {
    slug: "title-insurance",
    name: "Title",
    subject: "Title insurance",
    blurb:
      "Cover protecting a property buyer or lender against defects in ownership of the title, bought once at closing.",
    re: /\btitle insur/i,
    list: listRe("\\btitle\\b"),
    topic: "Property & Cat",
    term: "title-insurance",
  },
];

/* Every sector a company's profile places it in. A company can be in
   several and usually should be — a multiline insurer really does sell
   home, motor and life, and a page that pretended otherwise would be
   picking one arbitrarily. Null profile, unknown company, or nothing
   matched all come back empty, which is a first-class answer. */
function sectorsOf(summary) {
  const text = String(summary || "");
  if (!text) return [];
  return SECTORS.filter((s) => s.re.test(text) || (s.list && s.list.test(text)));
}

const indexableSector = (s) =>
  s.companies.length >= MIN_COMPANIES && s.stories >= MIN_STORIES;

module.exports = {
  SECTORS,
  sectorsOf,
  indexableSector,
  MIN_COMPANIES,
  MIN_STORIES,
  COMPANY_CAP,
  STORY_CAP,
  DEAL_CAP,
};
