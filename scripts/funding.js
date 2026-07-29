/* ============================================================
   Funding math — shared by the brief writers and the tracker
   ------------------------------------------------------------
   Turns headlines into genuinely-disclosed insurtech rounds.
   Deliberately conservative (the brief says "at least $X"), so it
   would rather undercount than repeat a market-forecast or a
   regional aggregate as if it were a single raise.

   `fundingDeals()` is the one extractor; `fundingStats()` is the
   batch summary the briefs already used, kept as a thin wrapper so
   the wire and /funding/ can never disagree about what a round is.

   Two layers, in that order:

     1. Claude's per-article reading, cached in companies-store.json
        by funding-extract.js and passed in as `opts.facts`. It is
        the primary source when present — headlines say "Prosus pours
        $460M into Alan" and "Investors bet $10M that Laka can fix
        bike coverage", and no list of verbs was ever going to hold
        the line against English.
     2. These regexes, which decide for anything Claude hasn't seen
        (a fresh article on a run where the CLI was rate-limited, a
        local check with no credentials) and which also pick the
        CANDIDATES the extractor is asked about. So they still have
        to be generous: a headline this file can't see at all is one
        Claude is never shown.

   Nothing here is persisted. Deals are re-derived from the store on
   every build, exactly as tags are re-derived in taxonomy.js — so a
   fix to these regexes reaches the whole archive, not just the
   articles that arrive after it.
   ============================================================ */

const { RELEVANCE } = require("./relevance.js");

/* ------------------------------------------------------------------
   Currency
   ------------------------------------------------------------------
   The tracker counts US dollars, and for a long time `amountM` only
   matched a `$`, which meant a round reported in any other currency
   was not converted — it was INVISIBLE. Qover's €10M, Napo's €14.4M,
   Diesta's €3.5M, Fixxy's €1.8M, EdenCare's €250k and Plum's ₹193
   crore were all absent from a table whose whole claim is that it
   sees rounds no single outlet sees.

   Worse, the `$` that WAS matched is not always a US dollar: four
   rows (Quandri, PolicyMe, YouSet, Flora Fertility) were Canadian
   dollars printed by Canadian trade press and filed here at face
   value, ~37% too high.

   So every figure is now read with its currency and converted. Fixed
   reference rates, not live ones: this file is re-run over a
   two-year archive on every build, and a rate that moved between
   builds would silently restate rounds that already published.
   A fixed rate is wrong by a few percent and STAYS wrong by a few
   percent, which is the property that matters for a table whose
   method note calls its totals a floor. Rows converted from another
   currency carry their original figure so a reader can check.

   Reference levels, mid-2026. Update deliberately (and expect the
   archive's totals to shift when you do), never automatically. */
const RATES = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  NZD: 0.60,
  SGD: 0.74,
  HKD: 0.128,
  CHF: 1.12,
  JPY: 0.0067,
  INR: 0.012,
  MYR: 0.23,
  ZAR: 0.055,
  AED: 0.272,
  SAR: 0.267,
  BRL: 0.18,
};

const SYMBOL_CURRENCY = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

/* A `$` on its own means USD, but the local trade press writes "US$70
   million" when it means dollars and "$16.5 million CAD" when it does
   not. Both markers are read, and the trailing one wins: a headline
   that bothers to say CAD after the figure is disambiguating on
   purpose.

   Matched case-SENSITIVELY — see the note on the lookbehind below. */
const DOLLAR_PREFIX = { US: "USD", C: "CAD", CA: "CAD", A: "AUD", AU: "AUD", NZ: "NZD", S: "SGD", SG: "SGD", HK: "HKD", R: "ZAR", RM: "MYR" };

const CODE_CURRENCY = {
  USD: "USD", EUR: "EUR", GBP: "GBP", INR: "INR", CAD: "CAD", AUD: "AUD",
  NZD: "NZD", SGD: "SGD", HKD: "HKD", CHF: "CHF", JPY: "JPY", MYR: "MYR",
  ZAR: "ZAR", AED: "AED", SAR: "SAR", BRL: "BRL",
  RS: "INR", RM: "MYR",
};

const WORD_CURRENCY = {
  euro: "EUR", euros: "EUR", pound: "GBP", pounds: "GBP", sterling: "GBP",
  rupee: "INR", rupees: "INR", ringgit: "MYR", rand: "ZAR", yen: "JPY",
  franc: "CHF", francs: "CHF", real: "BRL", reais: "BRL",
  dirham: "AED", dirhams: "AED", riyal: "SAR", riyals: "SAR",
};

/* Units are listed longest-first, and that ordering is load-bearing.
   Alternation is leftmost-first, so with `b` ahead of `billion` the regex
   matched "$2 b" out of "$2 billion" and left "illion valuation in US IPO"
   as the trailing text. The *value* still came out right — b and bn both
   mean billion — so this hid in plain sight while blinding the guard
   below: VALUATION_AFTER is anchored to the figure's edge, and it never
   saw the word "valuation" because "illion" sat in front of it. That is
   how "Exzeo eyes $2 billion valuation in US IPO" reached the tracker as
   a $2B round. Keep mn before m, bn before b, and the spelled-out words
   before either. */
const MULTIPLIERS = {
  trillion: 1e6, billion: 1e3, million: 1, thousand: 1e-3,
  crore: 10, lakh: 0.1,             // ×1e7 and ×1e5 rupees, expressed in millions
  cr: 10, mn: 1, bn: 1e3, k: 1e-3, m: 1, b: 1e3,
};

/* One figure: an optional currency marker, a number, an optional
   multiplier, an optional trailing currency word or code.

   A bare number is NOT a figure. Requiring a currency signal is what
   keeps "raises stake to 80%", "24m underprotected small businesses"
   and "16-slide pitch deck" out of the amount column — the cost is
   that a headline which names no currency at all names no amount
   here either, which is the correct answer for a table of dollars. */
const FIGURE = new RegExp(
  [
    "(?:\\b(USD|EUR|GBP|INR|CAD|AUD|NZD|SGD|HKD|CHF|JPY|MYR|ZAR|AED|SAR|BRL|Rs|RM)\\.?\\s*)?", // 1 leading code
    "([$€£₹¥])?",                                                                              // 2 symbol
    "\\s*(\\d[\\d,]*(?:\\.\\d+)?)",                                                            // 3 number
    "[\\s\\u00a0-]*",
    "(trillion|billion|million|thousand|crore|lakh|cr|mn|bn|[kmb])?\\b",                       // 4 multiplier
    "(?:[\\s\\u00a0-]*(euros?|pounds?|sterling|rupees?|ringgit|rand|yen|francs?|reais|real|dirhams?|riyals?|dollars?|USD|EUR|GBP|INR|CAD|AUD|NZD|SGD|HKD|CHF|JPY|MYR|ZAR|AED|SAR|BRL)\\b)?", // 5 trailing
  ].join(""),
  "gi"
);

/* Which currency a matched figure is in.

   The `$`-prefix lookbehind is case-SENSITIVE on purpose. Under /i,
   "raises a $5M round" reads the article "a" as the AUD marker and
   files an Australian round; "its $20M Series B" reads "s" as SGD.
   Case is the only thing separating a currency prefix from an
   ordinary English word here, exactly as it is in leadInvestor(). */
function currencyOf(text, m) {
  const trailing = (m[5] || "").toLowerCase().replace(/s$/, "");
  if (trailing && trailing !== "dollar") {
    const w = WORD_CURRENCY[trailing] || WORD_CURRENCY[trailing + "s"];
    if (w) return w;
    const c = CODE_CURRENCY[(m[5] || "").toUpperCase()];
    if (c) return c;
  }
  const unit = (m[4] || "").toLowerCase();
  if (unit === "crore" || unit === "lakh" || unit === "cr") return "INR";

  const lead = CODE_CURRENCY[(m[1] || "").toUpperCase()];
  if (lead) return lead;

  const sym = SYMBOL_CURRENCY[m[2]];
  if (sym === "USD") {
    // "US$70 million", "C$5m", "A$12 million" — the marker sits immediately
    // before the symbol and is always upper case where it is a marker.
    const before = text.slice(Math.max(0, m.index), m.index + m[0].indexOf("$"));
    const pre = before.match(/([A-Z]{1,2})\s?$/);
    if (pre && DOLLAR_PREFIX[pre[1]]) return DOLLAR_PREFIX[pre[1]];
    // The same marker can also arrive detached: "$3.5-million CAD" is
    // caught above by the trailing group; "15 million euros" likewise.
  }
  return sym || (m[5] ? "USD" : null); // trailing "dollars" with no symbol
}

// Headlines that quote a dollar figure but are NOT a company raise:
// market-size forecasts, research reports, and period/regional roundups.
const MARKET_NOISE = new RegExp(
  [
    "market (size|share|report|research|value|outlook|forecast)",
    "to (reach|exceed|hit|surpass|touch|cross) \\$",
    "\\bforecast(ed)?\\b", "\\bcagr\\b", "projected", "estimated to",
    "expected to (reach|grow|hit|exceed|rise)", "anticipated to",
    "by 20\\d\\d",                     // "... $X billion by 2035"
    "halv(e|ed|es|ing)", "rebound", "\\bdrop(ped|s)?\\b", "\\bfell\\b", "\\brose\\b",
    "\\b[1-4]H\\d\\d\\b", "\\b[1-4]Q\\d\\d\\b", "\\bH[12]\\b", "\\bQ[1-4]\\b", // period stats
    "full[- ]year", "year[- ]on[- ]year", "quarterly", "annual(ly)?",

    /* Multi-company roundups: "A total of $570m was raised across 26
       FinTech deals this week". The figure is real and the window is
       real, so nothing above rejects it — it just belongs to a dozen
       companies at once, and filed as one row it becomes the tracker's
       largest "round" and inflates the disclosed total.

       Every pattern here needs a COUNT or an explicit aggregate phrase,
       because the loose reading of this shape is what genuine rounds look
       like too. "across" alone would drop Fulcrum's $25M ("to scale AI
       automation across US insurance brokers") and SehaTech's seed
       ("across Egypt"); "total" alone would drop Camber's Series B
       ("bringing total funding to $50M"). Hence `across \d+` and
       `a total of $`, not the bare words. */
    "as many as",
    "a total of\\s*\\$",
    "raised across",
    "across \\d+",
    "\\b\\d+\\s+(?:[A-Za-z]+\\s+)?(?:startups|deals|companies|rounds)\\b",

    // Same shape, different verb: "InsurTech funding tops $1bn in February".
    "\\btops?\\s*\\$",

    /* The roundup with no count and no "total" — the SECTOR is the
       subject of the verb. "LatAm insurtech funding reaches $199m" and
       "InsurTech funding reaches $420m in January" are quarterly tallies
       across dozens of companies, and "Insurtech Draws US$1.63bn As AI &
       Digital Risks Converge" is a year's worth. Filed as rows they were
       the tracker's largest three "rounds".

       Anchored to the sector nouns rather than the verbs, because the
       verbs ("draws", "attracts", "reaches") are ones genuine rounds use
       too — it is the subject that gives it away, never the verb. */
    "\\b(?:funding|investment|deal (?:activity|volume)|deals)\\s+(?:reach(?:es|ed)?|hits?|total(?:s|led)?|stood|climb(?:s|ed)?|jump(?:s|ed)?|surge[sd]?|slid|slump(?:s|ed)?|grew|dipped)",
    "\\b(?:insurtech|fintech|insurance|sector|market|ecosystem|industry)\\s+(?:draws|drew|attracts?|attracted|sees|saw|records?|pulls? in|posts?)\\s+(?:[A-Z]{0,2}[$€£₹]|\\d)",

    /* An IPO is a real raise but not a *round*, and this table has a Stage
       column reading Seed/Series A/… — listing Ethos's $211M float beside a
       seed cheque is a category error, and the two IPO headlines that also
       quote a valuation were the worst offenders. Excluded whether or not
       the float has happened, so "hopes to raise … in IPO" and "raises $168
       million in US IPO" are treated alike. Placings and registered direct
       offerings are the same thing on a smaller scale: money raised from
       the public market by an already-listed company, not a venture round. */
    "\\bIPO\\b", "\\bresult of placing\\b", "\\bregistered direct offering\\b",
    "\\bgross proceeds\\b", "\\brights issue\\b",

    /* A fund vehicle is not a company round: "Stone Point raises $610.5m in
       first close of new Insurance Solutions Fund" is an investor raising
       money TO deploy, the other side of the table from the startups here.
       Same principle as investors-are-not-companies in companies.js.

       Matched on terms of art rather than a trailing "Fund", which would
       drop genuine rows — "InsuranceDekho raises $70 million led by Beams
       Fintech Fund" ends in exactly that word, and "Kshema raises $20 mn
       from Green Climate Fund" names its backer. The distinguishing mark
       is a fund being RAISED or NUMBERED, not merely mentioned.

       So the fund has to be the OBJECT of the raise, and the tempered
       run below is what enforces that. A first attempt matched any
       "fund" within 45 characters of a raise verb and threw away both
       rows above, where the fund is the BACKER. The run now stops dead
       at led/from/by/with/backed — the words that mark the other side
       of the cheque. */
    "first close", "investible capital",
    "\\bfund (?:I{1,3}|IV|VI{0,3}|IX|X)\\b",                      // "Fund III"
    "(?:venture|vc|investment|growth|debt|insurtech|fintech) fund\\b",
    "\\bfund (?:trio|family|vehicle)\\b",
    "\\b(?:rais|clos|secur|announc|launch|unveil|open)\\w*\\s+(?:(?!\\b(?:led|from|by|with|backed|and)\\b)[^,;])*?\\bfund\\b(?!ing|ed|s\\b)",
    "\\bboosts? .{0,20}\\bfund\\b", "\\bexpands? .{0,25}\\bfund\\b",

    /* Money moving the OTHER way, or not moving at all. A tracker of
       rounds raised has no row for a company spending its own money
       ("Insurity invests $50M in AI and R&D", "Plum commits Rs 200 crore
       to expand healthcare vertical"), for underwriting capacity, which
       is not equity at all ("Kita secures £22.5m capacity boost"), or for
       debt being rolled over ("Wefox closes €170m refinancing deal"). */
    "\\bcommits?\\s+(?:[A-Z]{0,2}[$€£₹¥]|Rs\\.?\\s*\\d|\\d)",
    /* Money raised in order to buy INTO someone else: "JVP raises $290M
       from TPG to boost stake in insurtech unicorn Earnix" is a fund
       topping up a holding, and it sat third on the most-funded ranking.
       Anchored to the buying verbs, so "mea lands $50m minority stake
       from SEP" — where the stake is what the investor took in return
       for the round — is untouched. */
    "\\b(?:boost|increase|up|expand|grow|acquire|buy)\\w*\\s+(?:its\\s+)?(?:[\\w-]+\\s+){0,2}stake\\b",
    "\\binvests?\\s+[^,;]{0,25}\\bin\\s+(?:AI\\b|R&D|its\\s|new\\s|tech(?:nology)?\\b|digital\\b|expansion|growth|infrastructure)",
    "\\bcapacity\\b", "\\brefinanc", "\\bloan repayment\\b",

    /* A rumour is not a round. "InsuranceDekho could secure up to $100m"
       closed at $70M, and for three months the tracker showed both — the
       larger of them a number nobody ever raised. The tracker's promise
       is disclosed, closed rounds; anything still in the conditional
       waits for the report that says it happened. */
    "\\bcould (?:secure|raise|land|close|net|get|bag)\\b",
    "\\bin talks (?:to|for|over|with)\\b", "\\bnearing\\b", "\\bnears\\b",
    "\\b(?:seeks?|seeking|plans?|planning|hopes?|hoping|aims?|aiming|eyes?|eyeing|targets?|targeting|set|poised|expected|looking)\\s+(?:to\\s+)?(?:raise|secure|close|land)\\b",
    "\\beyes?\\s+(?:a\\s+|an\\s+|up\\s+to\\s+)?[$€£₹]",
    "\\breportedly (?:rais|seek|near|in talks)",
    "\\bup to\\s*[$€£₹]",
    "\\bmay raise\\b", "\\bwould raise\\b", "\\bto raise\\b",
    "\\bto invest\\b",                                  // "Plum to invest $23m"
    "\\btargets?\\s+(?:[A-Z]{0,2}[$€£₹¥]|Rs\\.?\\s*\\d|₹|\\d)",

  ].join("|"),
  "i"
);

/* Provenance, not semantics — and the difference is the whole reason this
   is a separate list.

   FinTech Global's feed re-serves its own archive pages and the RSS stamps
   them with today's date. "Hippo Insurance raises $100m in Series D –
   Digital Wealth & CX Tech Forum – Virtual" arrived dated 2025-07-24 for a
   round that closed in 2018; "Shift Technology accelerates growth drive
   following $60m Series C – Digital Insurance & CX Tech Forum 2022" for
   one that closed in 2021. The headline is true and the date is fiction,
   and a funding row is a dated claim.

   MARKET_NOISE above is about what a headline MEANS, so the extractor
   overrides it — that is the point of having a reader. This is about
   whether the record can be trusted at all, which the extractor cannot
   judge: shown that Hippo headline it correctly answers "yes, a Series D",
   because nothing in the text says the date is wrong. So STALE_RECORD is
   applied on BOTH paths. A guard encoding something the model cannot see
   must not be one the model can overrule. */
const STALE_RECORD = /(?:digital (?:insurance|wealth)|cx tech)\s+forum/i;

/* The tracker counts venture-scale rounds, and this is where that scale
   ends. Anything larger is either an aggregate figure that got past
   MARKET_NOISE or a deal of a different kind entirely.

   It sat at $2000M and the difference mattered. Private-equity
   recapitalisations of brokerage rollups are real, disclosed raises by
   insurance companies — Acrisure's $2.1bn led by Bain Capital, HUB
   International's $1.6bn at a $29bn valuation — and they are not what
   anyone reads this table for. On a page whose median row is $13.6M and
   whose largest genuine venture round is Alan's $518.4M Series G, a
   single $2.1bn recap is a third of the disclosed total and buries
   everything the tracker exists to show.

   $1000M rather than something tighter because the job is to exclude a
   different *kind* of deal, and size is a blunt proxy for kind: the cut
   should fall in empty space, not next to a real row. It leaves ~1.8x
   headroom over the largest survivor and nothing in the archive lands
   between $550M and $1.6bn. Note what this does NOT do — Highstreet
   Insurance's $550M "in new capital" is the same species of deal and
   passes on size alone. Excluding that one needs the deal type read, not
   a lower number; lowering the cap far enough to catch it would sit
   $30M from Alan's Series G. */
const CAP_M = 1000;

// Generic funding vocabulary — ignored when deciding whether two headlines
// describe the SAME raise, so only distinctive tokens (company names) count.
const GENERIC = new Set(
  ("insurtech insurance fintech funding fund raises raise raised round rounds series " +
   "million billion invest investment investor capital startup startups secures secured " +
   "lands bags closes closed announces announced announce venture preseed seed extends " +
   "extension backs backed valuation firm company").split(/\s+/)
);

/* Wording that makes a dollar figure a company's *valuation* rather than
   the money it raised. The two are an order of magnitude apart and both
   sit in the same headline — "Ominimo reaches $1.6 bn valuation after
   Series B" filed a $22.5M round as a $1.6B one, which is the single
   worst thing a funding tracker can get wrong.

   Deliberately narrow: only phrasing that attaches to a figure. "Unicorn"
   is left out on purpose — it describes the company, not the number, so
   testing for it would throw away the genuine raise in "X becomes a
   unicorn after $50M round".

   A valuation phrase between two figures belongs to exactly one of them,
   and which one is a matter of direction: "$1.6B valuation" points back
   at the figure it follows, "valued at $1.6B" points forward at the one
   it precedes. So both patterns are anchored to the figure's edge —
   testing for the bare word anywhere nearby condemns the raise as well
   as the valuation in "raises $30M, bringing its valuation to $1.2B". */
// The trailing lookahead keeps a phrase that only *reads* as trailing from
// claiming the figure behind it: in "secures $30M — market cap of $1.2B",
// "market cap of" is pointing forward at the next number, not back at this one.
const VALUATION_AFTER =
  /^[\s,;:–—-]*(?:(?:post|pre)[- ]?money\s+)?(?:valuation|market cap)\b(?!\s+(?:of|at|to)\b)/i;
/* The verb form needs its own arm: "could value HO insurtech at $2bn+"
   puts the company between "value" and "at", so the adjacency the rest of
   this pattern relies on doesn't hold. Bounded to 40 characters and
   stopped at a `$` so it can only reach across a company name, never back
   past an earlier figure.

   `at $X` on its own joined the list for "Prosus pours $460M into Alan at
   $6.3B" — a construction that names the round and the valuation with no
   word between them but the preposition. It is bounded to the 25
   characters after the previous figure so it can only reach across a
   company name, and it cannot fire on the first figure in a headline. */
const VALUATION_BEFORE =
  /(?:valued(?:\s+at)?|valuation\s+(?:of|at|to)|\bworth|market cap\s+of|\bvalue[sd]?\s+[^$]{0,40}?\bat)\s+(?:a|an|about|roughly|nearly|around|some|over|almost)?\s*$/i;
const VALUATION_AT = /^[^$€£₹]{0,25}\bat\s+(?:a\s+|an\s+)?$/i;

function toMillions(m, currency) {
  const n = parseFloat(String(m[3]).replace(/,/g, ""));
  if (!isFinite(n)) return 0;
  const unit = (m[4] || "").toLowerCase();
  const mult = MULTIPLIERS[unit] !== undefined ? MULTIPLIERS[unit] : 1; // bare number = millions
  const native = n * mult;
  const rate = RATES[currency] !== undefined ? RATES[currency] : 1;
  return { native, usd: native * rate };
}

/* The raise in a headline (best-effort): the first figure that isn't a
   valuation. Returns the amount in USD millions, the figure as printed,
   and the currency it was printed in.

   Each figure is read with the text on either side of it, clipped at the
   neighbouring figures so no number is judged on wording that belongs to
   the one next to it.

   A headline whose only number is a valuation returns 0 and so isn't a
   deal at all — undercounting is the contract here, and a valuation
   printed in the amount column is worse than a missing row. */
function amountOf(text) {
  text = String(text);
  const none = { usdM: 0, nativeM: 0, currency: null };
  const hits = [...text.matchAll(FIGURE)].filter((m) => m[3]);
  for (let i = 0; i < hits.length; i++) {
    const m = hits[i];
    const currency = currencyOf(text, m);
    if (!currency) continue;                       // a bare number is not an amount
    const from = i === 0 ? 0 : hits[i - 1].index + hits[i - 1][0].length;
    const to = i === hits.length - 1 ? text.length : hits[i + 1].index;
    const before = text.slice(from, m.index);
    if (VALUATION_BEFORE.test(before)) continue;
    if (i > 0 && VALUATION_AT.test(before)) continue;
    if (VALUATION_AFTER.test(text.slice(m.index + m[0].length, to))) continue;
    const { native, usd } = toMillions(m, currency);
    if (usd > 0) return { usdM: usd, nativeM: native, currency };
  }
  return none;
}

// Back-compat shim: USD millions only. Kept because write-brief.js and the
// tests read it, and because a second copy of the walk above is a second
// place for the valuation guards to drift.
function amountM(text) {
  return amountOf(text).usdM;
}

function distinctiveWords(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !GENERIC.has(w))
  );
}

/* Round stage, in priority order — first match wins, so the specific
   patterns ("pre-seed", "seed extension") come before the general one.
   Unmatched is left blank rather than guessed: an empty cell in the
   tracker is honest, "Seed" on a growth round is not.

   The `pre-` forms need their own rows ahead of the letters they
   contain: "Bang Jamin raises $4m pre-series A" and "The Policy
   Exchange Raises $1.5 Million in Pre Series B Funding" were both
   filed as the full round. A pre-A is not an A — it is the bridge
   raised because the A hasn't happened. */
const STAGES = [
  ["Pre-seed", /pre[-\s]?seed/i],
  ["Pre-Series A", /pre[-\s]?series[-\s]?a\b/i],
  ["Pre-Series B", /pre[-\s]?series[-\s]?b\b/i],
  ["Pre-Series C", /pre[-\s]?series[-\s]?c\b/i],
  ["Seed", /\bseed\b/i],
  ["Series A", /series[-\s]?a\b/i],
  ["Series B", /series[-\s]?b\b/i],
  ["Series C", /series[-\s]?c\b/i],
  ["Series D", /series[-\s]?d\b/i],
  ["Series E+", /series[-\s]?[e-z]\b/i],
  ["Venture debt", /venture debt|debt (facility|financing|round)|credit facility/i],
  ["Growth", /growth (round|equity|capital|financing|investment)|late[- ]stage/i],
  ["Strategic", /strategic (investment|round|funding|stake)/i],
];

function stageOf(text) {
  const hit = STAGES.find(([, re]) => re.test(text));
  return hit ? hit[0] : "";
}

/* Lead investor — only from an explicit "led by", and only while the
   words stay Title Case. Anything looser ("backed by", "from") drags in
   sentence fragments and the raiser's own name, and a wrong investor is
   worse in a tracker than a blank. Trailing connectives are trimmed so
   "led by Foo Ventures and Bar" yields "Foo Ventures". */
function leadInvestor(text) {
  // "led by" is matched case-insensitively (headlines title-case it as
  // "Funding Led By"), but the name that follows is matched case-SENSITIVELY
  // — the Title Case run is the only thing marking where the name ends.
  const at = text.search(/\bled by\b/i);
  if (at < 0) return "";
  const rest = text.slice(at).replace(/^led by\s+/i, "");
  const m = rest.match(
    /^(?:[A-Z0-9][\w&.'’-]*)(?:\s+(?:[A-Z0-9][\w&.'’-]*|of|de|van|del|und|för))*/
  );
  if (!m) return "";
  let name = m[0].replace(/[\s,;:.]+$/, "").replace(/\s+(?:and|with|to|in|for|as|at)$/i, "").trim();

  /* A wholly Title Case headline defeats the Title Case run: in "Plum
     Raises $20 Mn Led By Peak XV To Expand Insurance Platform" every
     word qualifies, and the lead investor cell read "Peak XV To Expand
     Insurance Platform". So the run is cut at the first word that is
     doing grammar rather than naming — an infinitive marker, a
     preposition, a conjunction — regardless of how it is capitalised,
     and then capped. Four words is longer than any real investor name
     in the archive ("Beams Fintech Fund", "Stellaris Venture Partners")
     and shorter than any of these sentence fragments. */
  const STOP = /^(?:To|As|For|In|On|At|With|And|After|Amid|That|Its|The|A|An|From|Over|Into|While|Which|Following|Bringing|Ahead|Aiming|Backed)$/;
  const words = [];
  for (const w of name.split(/\s+/)) {
    if (words.length && STOP.test(w)) break;
    words.push(w);
    if (words.length === 4) break;
  }
  return words.join(" ").replace(/[\s,;:.]+$/, "").trim();
}

/* ISO-week-ish window for treating two headlines as the same raise. The
   token test alone is amount-plus-vocabulary, which is fine inside one
   batch (every article is hours old) but wrong across an archive: a
   company that raises $10M twice a year would have the second round
   silently swallowed by the first. */
const SAME_RAISE_DAYS = 45;

const daysApart = (a, b) => {
  const x = new Date(a), y = new Date(b);
  if (isNaN(x) || isNaN(y)) return 0; // undated — fall back to the token test alone
  return Math.abs(x - y) / 86400000;
};

/* Headlines worth ASKING Claude about.

   Cast wide and cheaply: this is a pre-filter, not a verdict. Anything it
   misses is never extracted and so can only be found by the regexes, which
   is how "Prosus pours $460M into Alan" was lost in the first place — the
   old Funding tag needed a verb from a fixed list, and "pours" wasn't on
   it. Here a currency figure alone is enough, and so is funding vocabulary
   with no figure at all (the amount may be in the summary).

   Insurance relevance is NOT required at this stage: the extractor is
   asked to judge that too, and pre-filtering on it would hide exactly the
   borderline cases worth a second opinion. */
const MONEY_HINT =
  /[$€£₹¥]\s?\d|\b\d[\d,.]*\s?(?:million|billion|trillion|thousand|mn|bn|crore|lakh|[kmb])\b|\b(?:USD|EUR|GBP|INR|CAD|AUD|SGD|Rs)\.?\s?\d/i;
const ROUND_HINT =
  /rais(?:e|es|ed|ing)|fundrais|funding|\bfunds?\b|\bround\b|\bseed\b|series [a-z]\b|\binvest|\bback(?:s|ed|ing)\b|\bsecur(?:e|es|ed)\b|\bclos(?:e|es|ed)\b|\blands?\b|\bbags?\b|\bnets?\b|\bnabs?\b|\bpours?\b|\bpockets?\b|\bcommits?\b|\bfinanc(?:e|es|ed|ing)\b|\bcapital\b|\bvaluation\b|\bstake\b|\bcheque\b|\bticket\b|\bvaluat/i;

function isFundingCandidate(article) {
  const text = (article.title || "") + " " + (article.summary || "");
  return MONEY_HINT.test(text) || ROUND_HINT.test(text);
}

/* The tracker is a table of INSURANCE rounds, and the store admits a
   technology-only story from an insurtech-native feed (relevance.js).
   That is right for the wire and wrong here: Blitzy's $200M for AI
   coding, Adfin's $18M for business finance, Cake's $13M for
   open-source AI and Sardine's $70M for fraud tooling were four of the
   largest rows on a page about insurtech funding, none of them an
   insurance company.

   RELEVANCE alone is too tight for this one job, though. It wants the
   word "insur-", and an insurtech's own funding headline routinely
   doesn't carry it — "Cara raises $8m seed to build AI platform for
   brokers", "Angle Health Secures $134M to Grow Benefits Platform",
   "Armilla AI raises $25m to expand AI liability coverage". Those are
   the trade's own vocabulary for the same industry, so they join it
   here and nowhere else. None of them re-admits the four above.

   Note this is the FALLBACK's test. The extractor decides the same
   question by reading the headline, which is the only way to place
   "Pano AI secures $44m to fight wildfires" — a company whose customers
   are insurers and whose headline says nothing at all. */
const INSURANCE_ROUND = new RegExp(
  RELEVANCE.source + "|" +
  /\bbroker(?:s|age)?\b|\bcoverage\b|\bclaims?\b|\bpremiums?\b|\bMGA\b|\bcarriers?\b|\bemployee benefits\b|\bbenefits platform\b|\bcat bond\b|\bactuar/.source,
  "i"
);

/* One row, from Claude's reading of the headline.

   The extractor answers the questions the regexes answer badly: is this
   a company raising money at all (as opposed to a fund, an acquisition,
   a market forecast, a rumour), how much and in what currency, and which
   company is raising. `null` means "not a round" and is a real answer —
   it is how Blitzy's AI-coding raise and JVP's fund leave the table. */
function fromFact(article, fact) {
  if (!fact || !fact.round) return null;
  if (STALE_RECORD.test(article.title || "")) return null;
  const currency = RATES[fact.currency] !== undefined ? fact.currency : "USD";
  const native = Number(fact.amountM);
  if (!isFinite(native) || native <= 0) return null;
  const usd = native * RATES[currency];
  if (usd <= 0 || usd > CAP_M) return null;
  return {
    title: article.title,
    amountM: usd,
    nativeM: native,
    currency,
    link: article.link || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    stage: fact.stage || "",
    lead: fact.lead || "",
    raiser: fact.company || "",
    by: "claude",
    words: distinctiveWords(article.title || ""),
    alsoReportedBy: [],
  };
}

/* The same row, from the regexes. Used for anything the extractor hasn't
   seen — and for every row at all when there are no cached facts, which
   is what a local `node scripts/seo.js` does. */
function fromRegex(article) {
  const title = article.title || "";
  if (!(article.tags || []).includes("Funding")) return null;
  if (MARKET_NOISE.test(title) || STALE_RECORD.test(title)) return null;
  if (!INSURANCE_ROUND.test(title + " " + (article.summary || ""))) return null;
  const { usdM, nativeM, currency } = amountOf(title);
  if (usdM <= 0 || usdM > CAP_M) return null;
  return {
    title,
    amountM: usdM,
    nativeM,
    currency,
    link: article.link || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    stage: stageOf(title),
    lead: leadInvestor(title),
    raiser: "",
    by: "regex",
    words: distinctiveWords(title),
    alsoReportedBy: [],
  };
}

/* Every genuine, disclosed round in `articles`, newest first, with the
   same raise reported by five outlets collapsed to one row. Each row
   keeps the article it came from so the tracker can cite a source.

   `opts.facts` is the per-link extraction cache written by
   funding-extract.js. When a link is in it, its verdict stands — that
   includes a verdict of "not a round", which is how the false positives
   leave. When it isn't, the regexes decide. */
function fundingDeals(articles, opts = {}) {
  const facts = opts.facts || {};
  const sorted = (articles || [])
    .slice()
    .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));

  const kept = [];
  for (const a of sorted) {
    const fact = facts[a.link];
    const row = fact ? fromFact(a, fact) : fromRegex(a);
    if (!row) continue;

    // Same raise if the amount matches, the headlines share ≥2 distinctive
    // tokens, and they were published close enough together to be one event.
    const dup = kept.find(
      (k) =>
        Math.round(k.amountM) === Math.round(row.amountM) &&
        [...row.words].filter((w) => k.words.has(w)).length >= 2 &&
        daysApart(k.publishedAt, row.publishedAt) <= SAME_RAISE_DAYS
    );
    if (dup) {
      // The duplicate is still evidence: keep the outlet, and let a later
      // headline fill in a stage or lead the first one didn't name.
      if (row.source && !dup.alsoReportedBy.includes(row.source)) dup.alsoReportedBy.push(row.source);
      if (!dup.stage) dup.stage = row.stage;
      if (!dup.lead) dup.lead = row.lead;
      if (!dup.raiser) dup.raiser = row.raiser;
      continue;
    }
    kept.push(row);
  }

  return kept.map((k) => ({
    title: k.title,
    amountM: k.amountM,
    nativeM: k.nativeM,
    currency: k.currency,
    link: k.link,
    source: k.source,
    publishedAt: k.publishedAt,
    stage: k.stage,
    lead: k.lead,
    raiser: k.raiser,
    by: k.by,
    alsoReportedBy: k.alsoReportedBy,
  }));
}

/* The cached verdicts, read straight off the store.

   The brief writers run BEFORE funding-extract.js — they share one
   subscription budget and the brief has first call on it (rule 3b-i) —
   so today's stories will not be in here when they ask, and they fall
   back to the regexes for exactly those. Older stories in the same batch
   do get the extractor's reading, which is the point: "the wire and the
   tracker can never disagree about what a round is" has to survive the
   tracker gaining a better reader, and the only way it does is if both
   consult the same cache. */
function cachedFacts() {
  try {
    const p = require("path").join(__dirname, "..", "data", "companies-store.json");
    return JSON.parse(require("fs").readFileSync(p, "utf8")).funding || {};
  } catch {
    return {};
  }
}

// Sum disclosed round sizes across genuine raises, de-duplicating the same
// raise reported by multiple outlets. Returns { total (in $M), count }.
function fundingStats(articles, opts = { facts: cachedFacts() }) {
  const deals = fundingDeals(articles, opts);
  return {
    total: deals.reduce((s, d) => s + d.amountM, 0),
    count: deals.length,
    deals: deals.map((d) => ({ title: d.title, amountM: d.amountM })),
  };
}

module.exports = {
  amountM, amountOf, fundingStats, fundingDeals, stageOf, leadInvestor,
  isFundingCandidate, cachedFacts, RATES, CAP_M,
};
