/* ============================================================
   M&A math — the tracker's second dataset
   ------------------------------------------------------------
   Turns headlines into insurance acquisitions, the way funding.js
   turns them into rounds. Same architecture on purpose: Claude's
   per-article reading is primary and cached; these regexes are the
   candidate net and the fallback; nothing is persisted, so a fix
   here retroactively corrects the whole archive (taxonomy.js's
   contract with tags, one dataset over).

   It exists because the archive already holds the deals and had
   nowhere to put them. 247 admitted stories carry acquisition
   vocabulary — Allianz/HSBC Life Singapore at $2.1bn, Mapfre/Safety
   at $1.54bn, Duck Creek/Send, Igloo/Eazy Digital, Gen/Trellis — and
   no outlet covers more than the deals it reports itself, so a table
   deduplicated across all of them is information that exists nowhere
   else. That is `/funding/`'s argument (rule 3c-i), and it is the
   only argument this site accepts for a new page type.

   FOUR THINGS DIFFER FROM funding.js, and each is load-bearing:

   1. THE AMOUNT IS OPTIONAL. Most acquisition prices are never
      disclosed, and a row is complete without one: acquirer, target
      and date are the deal. A funding round with no figure is not a
      row here (the tracker counts disclosed capital and says so);
      an acquisition with no figure is the normal case, and dropping
      those would discard most of the dataset to protect a total
      nobody promised.

   2. THERE IS NO CAP. `CAP_M` exists next door because a $2.1bn
      brokerage recapitalisation buries a table whose median row is
      $13.6M — and those recaps are acquisitions, which is to say
      they belong HERE. Allianz buying HSBC's Singapore life arm is
      the largest kind of thing this table is read for, not noise in
      it. The deals CAP_M turns away were never wrong, only filed
      under the wrong heading.

   3. A DEAL HAS TWO SIDES, so attribution is a pair and the dedup
      key is the pair. Next door a round belongs to one company and
      the extractor's hard case is telling the raiser from the
      investor (rule 3c-vi); here both parties are named by
      construction and the hard case is telling which is which, plus
      not counting the same deal twice as it moves through
      announcement, regulatory approval and completion.

   4. MINORITY STAKES ARE NOT ACQUISITIONS. "Tokio Marine takes
      minority stake in Igloo" and "mea lands $50m minority stake
      from SEP" are investments — the other side of a funding round,
      and the funding tracker's business. A controlling or majority
      stake is a change of ownership and belongs here: Wipro going
      to 80% of Aggne Global for $28.5M is an acquisition whatever
      the headline calls it. The line is control, not vocabulary.
   ============================================================ */

const { RELEVANCE } = require("./relevance.js");
const { amountOf, RATES } = require("./funding.js");

/* ------------------------------------------------------------------
   What is NOT a deal
   ------------------------------------------------------------------
   Every pattern here was written against a real match in the archive.
   The false positives an M&A tracker attracts are not the ones a
   funding tracker attracts, and two of them are severe:

   • "Acquisition" is a marketing word. "How to rethink acquisition
     KPIs in insurance", "customer acquisition cost", "reveals juicy
     acquisition plans after Stockport move" — the noun without a
     transaction under it. A tracker that files those is not a
     tracker.
   • "Buy" is a stock-tip word and a consumer word. "5 Multiline
     Insurers to Buy Amid Inflation, Softening Pricing" is a
     listicle; "Jubilee Health Wants Kenyans to Buy Insurance Where
     They Already Transact" is a story about consumers buying
     policies. Both parse perfectly as "X to buy Y". ── */

/* The noun with no transaction under it. `\b(?:cost|kpi|...)` is
   anchored to the word so "acquisition costs" goes and "acquisition
   of Cegid Assurex Solutions" stays. */
const SOFT_ACQUISITION =
  /\b(?:customer|client|user|talent|data|land|policyholder|member|patient|subscriber)\s+acquisition|\bacquisition\s+(?:cost|kpi|strateg|plan|target|pipeline|spend|marketing|channel|funnel)/i;

/* A deal that has not happened. The tracker's whole promise is that
   a row is a deal, so anything conditional, exploratory or reported
   second-hand is out — the same judgment `resolveRound()` makes next
   door when it prefers the closed figure to the rumoured one, made
   earlier because here there is no figure to arbitrate between.

   "Eyes" earned its place on "EFU Life Eyes Waada Digital
   Acquisition"; "could" on "Insurers could get a green light to
   acquire banks under proposed EU capital fix", which is a story
   about EU capital rules and not about any deal at all. */
const SPECULATIVE =
  /\b(?:eyes?|eyeing|in talks|talks to|could|might|may|would|explor(?:e|es|ing)|rumou?r|mulls?|weighs?|weighing|considers?|considering|nears?|nearing|set to explore|reportedly|is said to|approach(?:es|ed|ing)|bids? for|bidding|interested in|open to|potential|possible|plans? to|looking to|seeks?|seeking|proposed?)\b/i;

/* Buying a policy, not a company. "Uinsure accelerates AI investment
   in support of vision 'to change the way insurance is bought in the
   UK'" parses as an acquisition of "in the UK" without this. */
const CONSUMER_PURCHASE =
  /\bbuy(?:s|ing)?\s+(?:more\s+|their\s+|a\s+|an\s+)?(?:insurance|polic|cover|protection|annuit)|\binsurance is bought\b|\bbought\s+(?:insurance|polic|cover)/i;

/* A stock-picking listicle. These are common on the broad financial
   feeds and every one of them is "N <adjective> Insurers to Buy". */
const STOCK_TIP =
  /^\s*\d+\s+\S.*\bto\s+buy\b|\b(?:stocks?|shares?)\s+to\s+buy\b|\bto\s+buy\s+(?:now|amid|before|in\s+20\d\d)\b|\bbuy\s+rating\b|\bzacks\b/i;

/* Money raised in order to go shopping is a FUNDING round, and it is
   already a row on the other tracker. "American Growth Insurance
   raises $70 mn to buy U.S. brokerages and rebuild operations with AI
   agents" is one deal, and it is not an acquisition of anything yet —
   there is no target. Counting it here would double-count the event
   across two datasets, which is worse than missing it in one. */
const RAISED_TO_BUY =
  /\b(?:rais(?:e|es|ed|ing)|secur(?:e|es|ed)|closes?|lands?|nets?|bags?)\b[^.;:]{0,60}?\bto\s+(?:buy|acquire|fund acquisitions?)\b/i;

/* A minority position is an investment, not a change of ownership —
   see the file header. "Majority", "controlling" and a stated stake
   over 50% are the exception and stay. */
const MINORITY_STAKE = /\bminority\s+(?:stake|investment|interest|position)|\btakes?\s+(?:an?\s+)?equity\s+stakes?\b/i;
const CONTROL_STAKE =
  /\b(?:majority|controlling|control)\s+(?:stake|interest|shareholding|position)|\bstake\s+(?:in|to)\s+\S+\s+to\s+(?:5[1-9]|[6-9]\d|100)%|\bto\s+(?:5[1-9]|[6-9]\d|100)%/i;

/* A stated percentage settles it where the vocabulary doesn't, and
   the archive is full of them: Mapfre's "38.9% stake in Spanish
   insurtech Tuio" never says "minority" and is one, while Wipro
   going "to 80%" of Aggne Global never says "majority" and is a
   change of control. So the number decides — under 50% is an
   investment and belongs to the funding tracker, 50% or over is an
   acquisition. Read only from a figure actually attached to the word
   "stake", so a headline's other percentages ("boosting purchase
   decision 44%") can't be mistaken for one. */
const STAKE_PCT =
  /(\d{1,3}(?:\.\d+)?)\s*(?:%|per\s?cent)\s+(?:stake|interest|shareholding|holding)|\bstakes?\s+(?:in|of)\b[^.;]{0,40}?\bto\s+(\d{1,3}(?:\.\d+)?)\s*(?:%|per\s?cent)/i;

function stakePct(text) {
  const m = String(text).match(STAKE_PCT);
  if (!m) return null;
  const n = parseFloat(m[1] || m[2]);
  return isFinite(n) ? n : null;
}

/* True when the headline describes a position that does NOT change
   control — checked on both paths, like STALE_RECORD. */
function isMinorityDeal(text) {
  const pct = stakePct(text);
  if (pct !== null) return pct < 50;
  return MINORITY_STAKE.test(text) && !CONTROL_STAKE.test(text);
}

/* The idiom, which has nothing to do with equity. "Why embedded
   insurance is becoming table stakes for travel companies". */
const IDIOM_STAKES = /\btable stakes\b|\bstakes are high\b|\bhigh[- ]stakes\b/i;

/* Corporate-action noise that reads as a purchase: employee share
   plans, buybacks, and the regulatory-filing prefixes the LSE feed
   carries ("REG - Ondo InsurTech PLC - Share Incentive Plan
   Purchase"). */
const SHARE_ADMIN =
  /\bshare\s+(?:incentive|buy-?back|repurchase|option|award)|\bbuy-?back\b|\brepurchase\s+program|^\s*REG\s*[-–]/i;

function isNoise(text) {
  return (
    SOFT_ACQUISITION.test(text) ||
    CONSUMER_PURCHASE.test(text) ||
    STOCK_TIP.test(text) ||
    RAISED_TO_BUY.test(text) ||
    IDIOM_STAKES.test(text) ||
    SHARE_ADMIN.test(text)
  );
}

/* ------------------------------------------------------------------
   Insurance relevance
   ------------------------------------------------------------------
   INSURANCE_ROUND's argument (funding.js), applied to acquisitions:
   RELEVANCE alone wants the word "insur-", and an insurtech deal
   headline often doesn't carry it — "Wrisk acquires Atto for enhanced
   embedded insurance offering" does, "iCapital buys insurance tech
   firm Hexure" does, but "Igloo acquires Eazy Digital to expand
   insurtech stack in Thailand" leans on "insurtech" and a broker
   rollup leans on "brokerage". This is the fallback's test only; the
   extractor is asked to judge relevance by reading the sentence. */
const INSURANCE_DEAL = new RegExp(
  RELEVANCE.source +
    "|" +
    /\bbroker(?:s|age)?\b|\bunderwrit|\bclaims?\b|\bpremiums?\b|\bMGA\b|\bcarriers?\b|\bactuar|\badjust(?:er|ing)\b|\breinsur|\bannuit|\bpolicyholder/
      .source,
  "i"
);

/* ------------------------------------------------------------------
   Reading the pair out of a headline
   ------------------------------------------------------------------
   Deterministic, and deliberately conservative: this is the fallback,
   so a pair it cannot read confidently is better left unread than
   guessed. The extractor handles the rest by reading the sentence,
   which is the only thing that copes with "Income sells digital
   insurance platform to Embed Financial" (a seller, an asset and a
   buyer, in that order) or "CCP approves Jazz-backed acquisition of
   TPL insurance in phase-I merger review" (a regulator, an acquirer
   named as an adjective, and a target).

   Ordered most-specific first. Each returns { acquirer, target }. ── */
const PAIR_PATTERNS = [
  // "X acquired by Y" / "X to be acquired by Y" — reversed order.
  {
    re: /^(.+?)\s+(?:is\s+|to\s+be\s+|has\s+been\s+)?acquired\s+by\s+(.+)$/i,
    map: (m) => ({ acquirer: m[2], target: m[1] }),
  },
  // "X sells Y to Z" — the acquirer is last, and the seller is not a party
  // to file the deal under.
  {
    re: /^(.+?)\s+sells\s+(.+?)\s+to\s+(.+)$/i,
    map: (m) => ({ acquirer: m[3], target: m[2], seller: m[1] }),
  },
  /* "X to acquire Y" — an announced deal, which is a deal.

     THIS MUST COME BEFORE THE ACTIVE FORMS. The active pattern's lazy
     `(.+?)` will happily stop one word early and let "to" sit at the
     end of the acquirer: "MAPFRE to Acquire Safety Insurance" parsed
     as acquirer "MAPFRE to", and did so for eight rows including the
     two largest deals in the archive. Ordering fixes it at the
     source; the trailing-"to" strip in cleanAcquirer() is the belt to
     this braces, because the same shape recurs with any verb added
     later. */
  {
    re: /^(.+?)\s+to\s+(?:acquire|buy|purchase|take\s+over)\s+(.+)$/i,
    map: (m) => ({ acquirer: m[1], target: m[2] }),
  },
  // "X completes acquisition of Y" / "X announces acquisition of Y" /
  // "X's acquisition of Y".
  {
    re: /^(.+?)(?:'s|’s)?\s+(?:completes?d?|announces?d?|finalis|closes?d?)?\s*(?:the\s+)?acquisition\s+of\s+(.+)$/i,
    map: (m) => ({ acquirer: m[1], target: m[2] }),
  },
  // The common active forms.
  {
    re: /^(.+?)\s+(?:has\s+|have\s+)?(?:acquires?|acquired|buys|bought|snaps?\s+up|picks?\s+up|takes?\s+over|absorbs?)\s+(.+)$/i,
    map: (m) => ({ acquirer: m[1], target: m[2] }),
  },
];

/* Descriptors the trade press hangs on a company name. Stripped from
   the FRONT of a target only — "Duck Creek acquires London-based
   insurtech Send Technology" is a deal for Send Technology, not for
   "London-based insurtech Send Technology". Left on the acquirer,
   where the name comes first and a leading descriptor is rare. */
const TARGET_PREFIX =
  /^(?:the\s+)?(?:(?:uk|us|u\.s\.|british|american|german|french|dutch|spanish|italian|swiss|indian|singapore(?:an)?|thai|australian|canadian|japanese|irish|nordic|european|asian|african|london|new york|[a-z]+)[- ]based\s+)?(?:ai[- ](?:powered|driven|native)\s+|digital\s+|embedded\s+|specialist\s+|leading\s+|fellow\s+|rival\s+|real[- ]estate\s+|health(?:care)?\s+|life\s+|auto\s+|pet\s+|cyber\s+|travel\s+|commercial\s+)*(?:insurtech|insure?tech|insurance\s+tech(?:nology)?|insurance|insurer|broker(?:age)?|mga|tpa|adjuster|platform|startup|start-up|firm|company|group|provider|specialist|business|arm|unit|division|software|saas)\s+(?=[A-Z0-9])/i;

/* Everything after a target that is commentary rather than the name.
   Trade headlines almost always continue: "... to Expand MGA Platform
   and Distribution Network", "... for £80m", "... in $2.1 Billion
   Deal", "... amid shareholder probe". Cut at the first of them.

   The `;` and `:` arms matter more than they look — aggregator
   headlines chain unrelated stories ("Beazley acquires kWh Analytics;
   Aon names North America CEO: Insurtech news"), and without the cut
   the target becomes the whole rest of the bulletin. */
const TARGET_TAIL =
  /\s+(?:to\s+(?:expand|strengthen|grow|build|boost|add|accelerate|create|enhance|scale|bolster|extend|deepen|drive|support|form|launch|enter|target|serve|offer|improve|advance|broaden|complete|further|power)|for\s+(?:[$€£₹¥]|\d|an?\s|about|around|nearly|roughly|over|up\s+to)|in\s+(?:an?\s+)?[$€£₹¥\d][^,;]*?\bdeal\b|in\s+(?:an?\s+)?(?:all-cash|cash|stock|cash-and-stock)\b|amid\b|as\s+it\b|after\b|following\b|despite\b|while\b|which\b|that\b|and\s+(?:series|announces|names|appoints|launches|raises)\b|By\s+[A-Z])/i;

/* Where a chained headline stops being about this deal at all. */
const CHAIN_CUT = /[;:—–]|\s+\|\s+|\s+-\s+(?=[A-Z])/;

const LEGAL_SUFFIX =
  /[,\s]+(?:inc\.?|llc|ltd\.?|limited|plc|corp\.?|corporation|co\.?|gmbh|ag|sa|s\.a\.|nv|n\.v\.|bv|ab|as|oy|pty|pte|srl|spa)\s*$/i;

/* Which side of a chained headline the name is on depends on which
   side of the verb it sits.

   A trailing chain belongs to another story ("Beazley acquires kWh
   Analytics; Aon names North America CEO"), so a TARGET keeps the
   first segment. A leading chain is a kicker the desk put in front of
   the sentence ("Rent costs: Gallagher acquires tenant specialist
   Canadian digital broker"), so an ACQUIRER keeps the last — taking
   the first filed that deal under a buyer called "Rent costs". */
function cleanName(raw, keep = "first") {
  if (!raw) return "";
  const parts = String(raw).split(CHAIN_CUT);
  let s = keep === "last" ? parts[parts.length - 1] : parts[0];
  const tail = s.match(TARGET_TAIL);
  if (tail) s = s.slice(0, tail.index);
  s = s
    .replace(/^[\s,'"“”‘’(-]+/, "")
    .replace(/[\s,'"“”‘’).!?-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/* "a 38.9% stake in Spanish insurtech Tuio", "remaining stake in
   S-RM", "Etiqa stake" — the target is the company, not the holding.
   Run before the descriptor strip so what it hands over is a name. */
const STAKE_IN = /^.*?\bstakes?\s+(?:in|of)\s+/i;
const STAKE_TRAIL = /\s+stakes?$/i;

function cleanTarget(raw) {
  let s = cleanName(raw);
  s = s.replace(STAKE_IN, "").replace(STAKE_TRAIL, "").trim();

  /* Applied after the tail cut, so a descriptor is only stripped from
     what is actually the name.

     The guard is the important half. `TARGET_PREFIX` ends in
     `insurance|insurer|broker|...`, and those words START real company
     names — "Mile Auto Acquires Insurance House" was filed as a deal
     for "House", which is glossary.js's bare-`/\bmarine\b/` trap
     entered by another door (rule 3e). Over-stripping invents a wrong
     name; under-stripping leaves a verbose but recognisable one, and
     wrong is worse. So a strip has to be evidently safe: either the
     descriptor is several words ("insurance tech firm Hexure" →
     Hexure) or what remains is several ("insurtech Wave Claims" →
     Wave Claims). One generic word in front of one bare word is
     exactly the ambiguous case, and it is left alone. */
  const stripped = s.replace(TARGET_PREFIX, "").trim();
  if (stripped && stripped !== s) {
    const descriptorWords = s.slice(0, s.length - stripped.length).trim().split(/\s+/).length;
    const remainingWords = stripped.split(/\s+/).length;
    if (descriptorWords >= 2 || remainingWords >= 2) s = stripped;
  }
  return s;
}

function cleanAcquirer(raw) {
  let s = cleanName(raw, "last");
  // Leading press-release furniture: "Press Release: VEON and
  // JazzWorld Acquire TPL Insurance" arrives with the prefix already
  // cut by CHAIN_CUT, but the bare forms below survive it.
  s = s.replace(/^(?:press release|exclusive|breaking|update|report|reg)\s*[-–—:]?\s*/i, "");
  s = s.replace(/^(?:\d+\.\s*)/, "");
  // The belt to PAIR_PATTERNS' ordering: any future verb added to the
  // active forms can strand an infinitive marker here the same way.
  s = s.replace(/\s+(?:to|will|has|have|is|are|and)$/i, "");
  return s.trim();
}

/* An "acquirer" that is really a clause. The acquisition-of pattern
   is the one that attracts this — "Mapfre Expands US Footprint with
   Strategic Acquisition of Safety Insurance Group" hands back
   everything before "Acquisition", which is six words and passes a
   pure length test. A company name does not contain a finite verb, so
   testing for one separates the two where counting words cannot. */
const CLAUSE_VERB =
  /\b(?:expands?|announces?|completes?|strengthens?|moves?|wants?|adds?|grows?|boosts?|launches?|enters?|reveals?|confirms?|eyes?|plans?|sets?|makes?|gets?|sees?|says?|reports?|extends?|deepens?|backs?|names?|appoints?|unveils?|marks?|targets?|accelerates?|bolsters?|broadens?|drives?|builds?|creates?|opens?|returns?|continues?|explores?)\b/i;

/* A name that is really a description. The pair patterns will happily
   return "Insurers could get a green light" as an acquirer, so a
   candidate has to look like a company: short, and not a sentence.
   Length is the whole distinction, exactly as PREFIX_SLACK is next
   door (rule 3c-vi). */
const NAME_MAX_WORDS = 7;
const NAME_MAX_CHARS = 60;

function looksLikeName(s) {
  if (!s) return false;
  if (s.length > NAME_MAX_CHARS) return false;
  const words = s.split(/\s+/);
  if (words.length > NAME_MAX_WORDS) return false;
  if (CLAUSE_VERB.test(s)) return false;
  /* Must carry a capital somewhere. Anchoring it to the start of a
     token looks stricter and is simply wrong for this industry's
     names: iCapital, eHealth and mea all begin lowercase, and
     "iCapital buys insurance tech firm Hexure" was rejected outright.
     The discrimination against sentence fragments is done by
     CLAUSE_VERB and the length bounds above; this only has to reject
     an all-lowercase run. */
  return /[A-Z]/.test(s);
}

function readPair(title) {
  for (const p of PAIR_PATTERNS) {
    const m = title.match(p.re);
    if (!m) continue;
    const raw = p.map(m);
    const acquirer = cleanAcquirer(raw.acquirer);
    const target = cleanTarget(raw.target);
    if (!looksLikeName(acquirer) || !looksLikeName(target)) continue;
    if (acquirer.toLowerCase() === target.toLowerCase()) continue;
    return { acquirer, target, seller: raw.seller ? cleanName(raw.seller) : "" };
  }
  return null;
}

/* ------------------------------------------------------------------
   Deal type
   ------------------------------------------------------------------
   Blank is not an option the way a blank funding stage is: every row
   here is one of these, and "Acquisition" is the honest default for
   an outright purchase. Ordered specific-first. */
const TYPES = [
  ["Merger", /\bmerge[sr]?\b|\bmerger\b|\bmerging\b|\ball-stock merger\b/i],
  ["Majority stake", /\b(?:majority|controlling|control)\s+(?:stake|interest|shareholding)/i],
  ["Asset purchase", /\b(?:portfolio|book of business|renewal rights|assets|platform|business unit)\b/i],
  ["Acquisition", /./],
];

function typeOf(text) {
  for (const [name, re] of TYPES) if (re.test(text)) return name;
  return "Acquisition";
}

/* ------------------------------------------------------------------
   Candidates
   ------------------------------------------------------------------
   Wide and cheap, for isFundingCandidate()'s reason: a headline this
   misses is one Claude is never shown, and the misses are silent. Any
   deal vocabulary at all qualifies — the noise filters run later,
   where a verdict can overrule them. */
const DEAL_HINT =
  /\bacquir|\bacquisition|\bbuys?\b|\bbought\b|\bto buy\b|\bmerge|\bmerger|\btakeover|\btakes? over|\bsnaps? up|\bpicks? up|\bsells?\b|\bsale of\b|\bdivest|\bstake\b|\bpurchase|\bdeal\b/i;

function isDealCandidate(article) {
  const text = (article.title || "") + " " + (article.summary || "");
  return DEAL_HINT.test(text);
}

/* ------------------------------------------------------------------
   Rows
   ------------------------------------------------------------------ */

/* One row from Claude's reading. `null` is a real answer and the
   whole point of the pass — it is how "How to rethink acquisition
   KPIs" and "5 Multiline Insurers to Buy" leave the table.

   STALE_RECORD's lesson from rule 3c-v applies here and is checked on
   BOTH paths: FinTech Global re-serves its back catalogue stamped
   with today's date, and an acquisition is a dated claim exactly as a
   round is. `announcedYear` is the model's own answer and drops a row
   filed more than STALE_YEARS behind it. */
const STALE_RECORD = /(?:digital (?:insurance|wealth)|cx tech)\s+forum/i;
const STALE_YEARS = 2;

function yearOf(iso) {
  const d = new Date(iso);
  return isNaN(d) ? null : d.getUTCFullYear();
}

function fromFact(article, fact) {
  if (!fact || !fact.deal) return null;
  if (STALE_RECORD.test(article.title || "")) return null;

  const acquirer = String(fact.acquirer || "").trim();
  const target = String(fact.target || "").trim();
  // A deal needs both sides. One-sided is not a row: "Acme acquires a
  // brokerage" cannot be filed under a target, linked to a company
  // page, or deduplicated against the outlet that names it.
  if (!acquirer || !target) return null;

  const filed = yearOf(article.publishedAt);
  if (fact.announcedYear && filed && filed - Number(fact.announcedYear) > STALE_YEARS) return null;

  const currency = RATES[fact.currency] !== undefined ? fact.currency : "USD";
  const native = Number(fact.amountM);
  const hasAmount = isFinite(native) && native > 0;

  return {
    title: article.title,
    acquirer,
    target,
    seller: String(fact.seller || "").trim(),
    // Undisclosed is the normal case — see the file header.
    amountM: hasAmount ? native * RATES[currency] : 0,
    nativeM: hasAmount ? native : 0,
    currency: hasAmount ? currency : null,
    type: fact.type || typeOf(article.title || ""),
    link: article.link || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    by: "claude",
    alsoReportedBy: [],
  };
}

/* The same row from the regexes, for anything the extractor hasn't
   seen — a fresh article on a rate-limited run, or a local build with
   no credentials. Stricter than fromFact() by design: it cannot read
   the sentence, so it declines everything it is not sure of. */
function fromRegex(article) {
  const title = article.title || "";
  const text = title + " " + (article.summary || "");
  if (STALE_RECORD.test(title)) return null;
  if (isNoise(text)) return null;
  if (SPECULATIVE.test(title)) return null;
  if (isMinorityDeal(title)) return null;
  if (!INSURANCE_DEAL.test(text)) return null;

  const pair = readPair(title);
  if (!pair) return null;

  const { usdM, nativeM, currency } = amountOf(title);
  return {
    title,
    acquirer: pair.acquirer,
    target: pair.target,
    seller: pair.seller || "",
    amountM: usdM > 0 ? usdM : 0,
    nativeM: usdM > 0 ? nativeM : 0,
    currency: usdM > 0 ? currency : null,
    type: typeOf(title),
    link: article.link || "",
    source: article.source || "",
    publishedAt: article.publishedAt || "",
    by: "regex",
    alsoReportedBy: [],
  };
}

/* ------------------------------------------------------------------
   Dedup
   ------------------------------------------------------------------
   The key is the PAIR, not the amount — which is the substantive
   difference from funding.js's dedup and the reason this file has its
   own. Next door, two outlets reporting one round agree on the
   company and may disagree on the figure, so the amount is what has
   to be bounded. Here most rows have no figure at all, and the same
   deal is reported three or four times as it moves through
   announcement, regulatory clearance and completion — the TPL
   Insurance deal appears nine times in this archive across four
   phases and six outlets, with the price stated in two of them.

   So: same acquirer and same target inside the window is one deal,
   whatever the headline calls it and whether or not it names a
   figure. The window is wider than funding's 45 days because a deal's
   announcement-to-close span routinely exceeds a quarter — Allianz
   and HSBC ran from announcement to completion across five months. */
const SAME_DEAL_DAYS = 180;

const daysApart = (a, b) => {
  const x = new Date(a), y = new Date(b);
  if (isNaN(x) || isNaN(y)) return 0;
  return Math.abs(x - y) / 86400000;
};

/* Names are compared loosely, because the same company is written
   several ways across outlets ("VEON and JazzWorld", "VEON
   Subsidiary JazzWorld", "Jazz International"). Loose enough to
   collapse those, strict enough not to collapse two real companies:
   one side must contain the other after normalisation, and the
   contained side must be substantial rather than a stray word. */
const NAME_NOISE =
  /\b(?:the|and|group|holdings?|international|subsidiary|company|corp|inc|ltd|limited|plc|llc|sa|ag|gmbh|nv|bv|pte|pty)\b/gi;

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(NAME_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MIN_OVERLAP = 4;

/* A consortium is named in whatever order the desk felt like. Optio
   was bought by "La Caisse and Cinven" in one report and "Cinven and
   La Caisse" in another, on the same day, and stood as two rows —
   containment cannot see through a reordering. So a multi-party name
   is compared as a SET of parties rather than as a string. */
function partySet(s) {
  return new Set(
    String(s || "")
      .split(/\s*(?:,|;|\band\b|&|\+)\s*/i)
      .map(normName)
      .filter((p) => p.length >= MIN_OVERLAP)
  );
}

function sameParty(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= MIN_OVERLAP && long.includes(short)) return true;

  const px = partySet(a), py = partySet(b);
  if (px.size > 1 && px.size === py.size) {
    return [...px].every((p) => py.has(p));
  }
  return false;
}

/* Containment is not enough on the target side, and the archive says
   so loudly: one Gallagher deal arrived as "Canada's Apollo Insurance
   Solutions", "Vancouver-based digital tenant insurance broker Apollo"
   and "Canadian digital insurance broker By Investing.com", and stood
   as three rows. Allianz/HSBC stood as two ("HSBC Life Singapore" vs
   "HSBC's Singapore Insurer"), Inszone/Chelf as two, Optio as two.
   None of those pairs contains the other.

   What they do share is a distinctive word. So two rows with the same
   acquirer are the same deal when their targets share one — which is
   funding.js's `distinctiveWords` test, moved to the side of the deal
   that varies. It is safe HERE and would not be next door, because
   the acquirer has already had to match: this only ever compares two
   targets of the same buyer inside the same window, and a company
   buying two different firms whose names share a distinctive word in
   one six-month window is a shape the archive does not contain. */
const TARGET_NOISE = new Set(
  ("insurance insurer insurers insurtech insuretech tech technology technologies " +
   "broker brokers brokerage brokers agency agencies group holdings platform " +
   "solutions services business businesses firm company digital specialist " +
   "based north south east west american canadian british european five its " +
   "assets portfolio unit division arm").split(/\s+/)
);

function targetWords(s) {
  return new Set(
    normName(s).split(/\s+/).filter((w) => w.length > 3 && !TARGET_NOISE.has(w))
  );
}

function sameTarget(a, b) {
  if (sameParty(a, b)) return true;
  const x = targetWords(a), y = targetWords(b);
  if (!x.size || !y.size) return false;
  return [...x].some((w) => y.has(w));
}

/* Every deal in `articles`, newest first, one row per deal.

   `opts.facts` is the per-link cache written by ma-extract.js. When a
   link is in it the verdict stands, including a verdict of "not a
   deal" — that is how the false positives leave and why a negative
   has to be cached (rule 3c-v). When it isn't, the regexes decide. */
function maDeals(articles, opts = {}) {
  const facts = opts.facts || {};
  const sorted = (articles || [])
    .slice()
    .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));

  const kept = [];
  for (const a of sorted) {
    const fact = facts[a.link];
    const row = fact ? fromFact(a, fact) : fromRegex(a);
    if (!row) continue;

    /* Two tests, and the window applies to only one of them.

       An acquisition happens ONCE: a company does not buy the same
       company twice, which is the structural difference from a round
       (where the same company raises again and again, and the window
       is what keeps the second Series from being swallowed by the
       first). So when BOTH sides match by name, that is the same deal
       however far apart the two reports are — and they are routinely
       far apart, because an insurance deal takes about a year to
       clear: Radian/Inigo was reported at announcement and again at
       completion 316 days later, Majesco/Vitech 248 days, Munich
       Re/NEXT 199. All three stood as duplicate rows under a flat
       180-day window, and widening that window would only move the
       problem to the next slow deal.

       The window stays on the FUZZY arm, where the targets merely
       share a distinctive word. That match is loose enough to catch
       two different companies with a word in common, and the date is
       what keeps it honest. */
    const dup = kept.find((k) => {
      if (!sameParty(k.acquirer, row.acquirer)) return false;
      if (sameParty(k.target, row.target)) return true;
      return (
        sameTarget(k.target, row.target) &&
        daysApart(k.publishedAt, row.publishedAt) <= SAME_DEAL_DAYS
      );
    });
    if (dup) {
      // The duplicate is still evidence: keep the outlet, and let a
      // report that named a figure fill one the first didn't.
      if (row.source && !dup.alsoReportedBy.includes(row.source)) {
        dup.alsoReportedBy.push(row.source);
      }
      if (!dup.amountM && row.amountM) {
        dup.amountM = row.amountM;
        dup.nativeM = row.nativeM;
        dup.currency = row.currency;
        // The row must cite a source that printed the figure it shows —
        // resolveRound()'s rule (rule 3c-i), which is why the link moves
        // with the amount rather than staying on the earliest report.
        dup.amountLink = row.link;
        dup.amountSource = row.source;
      }
      if (!dup.seller && row.seller) dup.seller = row.seller;
      continue;
    }
    kept.push(row);
  }
  return kept;
}

function cachedFacts() {
  try {
    const p = require("path").join(__dirname, "..", "data", "companies-store.json");
    return JSON.parse(require("fs").readFileSync(p, "utf8")).ma || {};
  } catch {
    return {};
  }
}

module.exports = {
  maDeals,
  isDealCandidate,
  isMinorityDeal,
  stakePct,
  cachedFacts,
  readPair,
  typeOf,
  isNoise,
  sameParty,
  sameTarget,
  normName,
  SPECULATIVE,
  MINORITY_STAKE,
  CONTROL_STAKE,
  INSURANCE_DEAL,
  SAME_DEAL_DAYS,
};
