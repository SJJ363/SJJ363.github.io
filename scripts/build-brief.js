/* ============================================================
   Briefing generator — "What's happening and why it matters"
   ------------------------------------------------------------
   Turns each fresh batch of articles into a short, thematic
   editor's brief: what the wire is saying right now, and the
   second-order effects worth watching. Deterministic, template-
   driven, dependency-free — runs in the same Node build as the
   fetcher, so it needs no API keys and updates every refresh.

   It reads THEMES, not individual stories: it ranks the dominant
   categories, sizes up the money moving, finds the story the most
   outlets are chasing, and stitches those signals into prose.
   ============================================================ */

const { fundingStats } = require("./funding");

/* ---- grammar helpers ---- */
function oxford(list) {
  const a = list.filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}
const plural = (n, one, many) => (n === 1 ? one : many);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function money(millions) {
  if (millions >= 1000) {
    const bn = millions / 1000;
    return `$${bn >= 10 ? Math.round(bn) : bn.toFixed(1)} billion`;
  }
  return `$${Math.round(millions)} million`;
}

// Clean a headline into a tidy clause we can quote mid-sentence.
// Sources sometimes hand us titles already truncated with "…", so we
// strip trailing ellipsis/punctuation, cap the length at a word boundary,
// and never leave a dangling connector word at the end.
const DANGLERS = /\s+(for|to|and|with|of|in|on|at|by|a|an|the|as|its?|from|that|this|will|amid|after|over|into|but|or)$/i;
function cleanTitle(t) {
  let s = t.replace(/\s+/g, " ").trim().replace(/[\s.…,;:]+$/g, "");
  if (s.length > 100) {
    s = s.slice(0, 97).replace(/\s+\S*$/, "");
  }
  // Strip a dangling connector, possibly more than one (e.g. "… based in").
  let prev;
  do { prev = s; s = s.replace(DANGLERS, ""); } while (s !== prev);
  return s.replace(/[\s.…,;:]+$/g, "");
}

/* ---- theme intelligence ----
   For each category: a short "what's happening" fragment (data
   fills the count), and a "why it matters" second-order take. */
const THEME = {
  "Funding": {
    word: "fresh funding",
    happening: (n) => `capital is moving again, with ${n} funding ${plural(n, "story", "stories")} on the wire`,
    matters:
      "Money rarely sits still: today's raises bankroll tomorrow's hiring sprees, sharper pricing and the next wave of acquisitions — so a busy funding week tends to echo for quarters.",
  },
  "M&A": {
    word: "dealmaking",
    happening: (n) => `consolidation is in the air, with ${n} ${plural(n, "acquisition or merger", "acquisitions and mergers")} in play`,
    matters:
      "Every deal narrows the field and hands the survivors more pricing power and reach — watch for smaller players to either pair up or get squeezed out.",
  },
  "Partnerships": {
    word: "new partnerships",
    happening: (n) => `distribution is where the energy is, with ${n} ${plural(n, "partnership", "partnerships")} and tie-ups announced`,
    matters:
      "Distribution is quietly becoming the whole game: these alliances decide whose product reaches the customer at the exact moment they're buying — and increasingly that's not the traditional carrier.",
  },
  "Product & Launches": {
    word: "product launches",
    happening: (n) => `builders are shipping, with ${n} ${plural(n, "launch", "launches")} and rollouts`,
    matters:
      "A wave of launches signals a land grab — companies are racing to plant a flag before a category standardizes and the window to differentiate closes.",
  },
  "AI & Automation": {
    word: "AI and automation",
    happening: (n) => `AI keeps dominating the conversation, threaded through ${n} ${plural(n, "story", "stories")}`,
    matters:
      "AI is moving from pilot to plumbing. As it settles into underwriting and claims, the cost advantage compounds — and carriers still running on manual, legacy workflows will feel the margin squeeze first.",
  },
  "Embedded": {
    word: "embedded insurance",
    happening: (n) => `embedded insurance is spreading, surfacing in ${n} ${plural(n, "story", "stories")}`,
    matters:
      "Embedded keeps blurring the line between buying a product and buying its protection. Whoever owns the checkout increasingly owns the customer — a structural threat to anyone who sells cover the old-fashioned way.",
  },
  "Cyber": {
    word: "cyber risk",
    happening: (n) => `cyber risk is back in focus across ${n} ${plural(n, "story", "stories")}`,
    matters:
      "Cyber is the fastest-moving line in the book: losses are volatile and hard to model, so tightening capacity and rising rates here tend to be a leading indicator for the whole market's risk appetite.",
  },
  "Claims & Underwriting": {
    word: "claims and underwriting",
    happening: (n) => `the core machinery — claims and underwriting — is in play across ${n} ${plural(n, "story", "stories")}`,
    matters:
      "Claims and underwriting are where insurers actually make or lose money. Small gains in speed and accuracy here compound straight to the loss ratio, which is why so much capital chases them.",
  },
  "Health & Life": {
    word: "health and life",
    happening: (n) => `health and life cover is drawing attention in ${n} ${plural(n, "story", "stories")}`,
    matters:
      "Health and life sit at the intersection of demographics and data — aging populations and richer health signals are reshaping who gets covered, at what price, and how.",
  },
  "Auto & Mobility": {
    word: "auto and mobility",
    happening: (n) => `auto and mobility risk is shifting, across ${n} ${plural(n, "story", "stories")}`,
    matters:
      "As telematics and eventually autonomy rewrite how driving risk is priced, the auto book — long the industry's bread and butter — is being redrawn faster than almost any other line.",
  },
  "Property & Cat": {
    word: "property and catastrophe risk",
    happening: (n) => `property and catastrophe exposure is front of mind, in ${n} ${plural(n, "story", "stories")}`,
    matters:
      "Climate volatility is rewriting the risk models in real time. Where capacity retreats and reinsurance gets pricier, whole regions can quietly become harder — or impossible — to insure.",
  },
  "Regulation": {
    word: "regulation",
    happening: (n) => `regulators are making themselves felt, in ${n} ${plural(n, "story", "stories")}`,
    matters:
      "Regulation sets the guardrails everyone builds inside. Where it tightens, product roadmaps and go-to-market timelines quietly bend to follow — a cost that lands hardest on the smallest players.",
  },
  "Leadership": {
    word: "leadership moves",
    happening: (n) => `the executive suite is reshuffling, with ${n} leadership ${plural(n, "move", "moves")}`,
    matters:
      "Leadership changes are a tell: new chiefs bring new strategies, and a cluster of them often front-runs a wider shift in where the industry thinks the growth is.",
  },
  "Industry": {
    word: "broader industry moves",
    happening: (n) => `the broader market is busy, with ${n} ${plural(n, "story", "stories")} across the industry`,
    matters:
      "Taken together, the week's moves point to an industry still remaking itself — where technology, capital and risk keep trading places at the center of the story.",
  },
};

/* ---- headline templates, keyed on the dominant theme ---- */
function makeHeadline(topName, counts, fundTotal) {
  switch (topName) {
    case "Funding":
      return fundTotal >= 1
        ? `Capital comes back to insurtech`
        : `Investors reopen their wallets`;
    case "M&A":
      return `A consolidation wave gathers pace`;
    case "Partnerships":
      return `The distribution land-grab intensifies`;
    case "AI & Automation":
      return `AI moves from pilot to plumbing`;
    case "Embedded":
      return `Insurance keeps disappearing into the checkout`;
    case "Product & Launches":
      return `A busy season for new launches`;
    case "Property & Cat":
      return `Climate risk reshapes the map`;
    case "Cyber":
      return `Cyber risk pushes back to the top`;
    case "Regulation":
      return `Regulators tighten the guardrails`;
    default:
      return `Where insurtech is moving now`;
  }
}

/* ============================================================ */
function buildBriefing(articles, taxonomy) {
  if (!articles || articles.length === 0) return null;

  const total = articles.length;
  const sources = new Set(articles.map((a) => a.source)).size;

  // Rank themes by count, keeping only ones we have copy for.
  // "Industry" is the generic catch-all tag — useful for a count, but it
  // shouldn't drive the headline or the analysis, so keep it out of ranking.
  const ranked = (taxonomy || [])
    .filter((t) => THEME[t.name] && t.name !== "Industry")
    .slice()
    .sort((a, b) => b.count - a.count);
  if (ranked.length === 0) return null;

  const counts = Object.fromEntries((taxonomy || []).map((t) => [t.name, t.count]));

  // Money in play — disclosed rounds only (no forecasts/aggregates/dupes).
  const funding = fundingStats(articles);

  // The story the most outlets are chasing (corroboration = signal).
  const mostCovered = articles
    .slice()
    .sort((a, b) => (b.cluster || 1) - (a.cluster || 1) || (b.score || 0) - (a.score || 0))[0];

  // ---- Build "What's happening" ----
  const top = ranked.slice(0, 3);
  const lead = top[0];
  const rest = top.slice(1);

  const openers = [
    `Across ${total} stories from ${sources} outlets this cycle,`,
    `${total} stories moved from ${sources} outlets this cycle, and`,
    `Scanning ${total} stories from ${sources} outlets,`,
  ];
  const opener = openers[total % openers.length];

  let whatParts = [];
  whatParts.push(`${opener} ${THEME[lead.name].happening(lead.count)}.`);

  if (rest.length) {
    const restFrag = oxford(rest.map((t) => THEME[t.name].word));
    whatParts.push(`Close behind, the wire is thick with ${restFrag}.`);
  }

  if (funding.total >= 5 && funding.count >= 2) {
    whatParts.push(
      `By our count that's at least ${money(funding.total)} in disclosed funding changing hands across ${funding.count} ${plural(funding.count, "deal", "deals")}.`
    );
  }

  if (mostCovered && (mostCovered.cluster || 1) >= 2) {
    whatParts.push(
      `The story drawing the widest coverage — picked up by ${mostCovered.cluster} outlets — is “${cleanTitle(mostCovered.title)}.”`
    );
  }

  const whatsHappening = whatParts.join(" ");

  // ---- Build "Why it matters" ---- (second-order takes)
  const matterThemes = [...top];
  // If AI or Embedded are present anywhere prominent, make sure the
  // structural take gets a voice even if it's not strictly top-3.
  ["AI & Automation", "Embedded"].forEach((k) => {
    if (counts[k] >= Math.max(3, total * 0.08) && !matterThemes.find((t) => t.name === k)) {
      matterThemes.push({ name: k, count: counts[k] });
    }
  });

  const whyParts = matterThemes.slice(0, 2).map((t) => THEME[t.name].matters);
  // Closing synthesis line.
  whyParts.push(
    `The through-line: capital, technology and risk keep swapping places at the center of the story — and the gap between the operators adapting to that and the ones waiting it out widens with every cycle.`
  );
  const whyItMatters = whyParts.join(" ");

  const headline = makeHeadline(lead.name, counts, funding.total);
  const teaser = `${cap(THEME[lead.name].word)}${rest.length ? `, ${THEME[rest[0].name].word}` : ""} and what it sets in motion.`;

  return {
    headline,
    teaser,
    whatsHappening,
    whyItMatters,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildBriefing };
