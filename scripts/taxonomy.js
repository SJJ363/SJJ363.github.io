/* ============================================================
   The category taxonomy — one definition, two readers.

   fetch-news.js tags each article as it arrives; seo.js re-tags the
   persistent store when building the topic hubs, because stored tags
   are frozen at fetch time and would otherwise keep whatever the
   rules said months ago. Order here is the order chips appear.
   ============================================================ */

const TAXONOMY = [
  /* Funding deliberately does NOT match a bare money figure. It used to
     (`\$[\d.]+\s?(m|bn|million|billion)`), which tagged every earnings
     report, acquisition price, catastrophe loss and fraud sentence as a
     funding round: 23 of 57 matches were false, and none of the real
     ones needed it. A raise now has to be a raise — a funding verb, a
     round name, or money that a funding verb is actually reaching for.
     Note "nets? $" is absent on purpose: it matches "net income of $". */
  ["Funding", /(rais(?:e|es|ed|ing)\s+(?:\w+\s+){0,2}(?:[$€£₹]|\d|seed|series|round|funding|capital)|fundrais|funding round|seed funding|seed round|series [a-e]\b|pre-seed|in funding|funding from|funding led|funding to|venture (?:capital|round|funding|debt)|\bVC round\b|valuation|(?:secures?|lands?|closes?|bags?)\s+(?:\w+\s+){0,2}[$€£₹]|investment round|capital raise|backed by)/i],
  ["M&A", /(acquir|acquisition|merg(e|es|er|ing)|buyout|takeover|to buy|snaps up|buys )/i],
  ["Partnerships", /(partner|partnership|teams? up|collaborat|joins forces|alliance|tie-?up|taps |selects |integrat|to distribute|distribution deal|powers )/i],
  ["Product & Launches", /(launch|unveil|rolls? out|introduc|debut|releases?|goes live|new (product|platform|tool|app|solution|feature)|expands? (in)?to|now available)/i],
  ["AI & Automation", /(\bAI\b|artificial intelligence|machine learning|\bML\b|gen(erative)?[ -]?ai|\bLLM\b|automat|chatbot|algorithm|predictive|\bGPT\b|agentic|copilot|no-code)/i],
  ["Embedded", /(embedded insurance|embedded finance|insurance as a service|\bAPI\b|api-first|point[- ]of[- ]sale insurance|bancassurance|at checkout)/i],
  ["Cyber", /(cyber|ransomware|data breach|malware|phishing|cyberattack|cyber risk)/i],
  ["Claims & Underwriting", /(claims?\b|underwrit|pricing|risk assessment|loss adjust|actuar|fraud|\bfnol\b|first notice of loss)/i],
  ["Health & Life", /(health ?insur|life insur|health ?tech|healthcare|medicare|medicaid|employee benefits|group health|disability insur|dental|telehealth|wellness)/i],
  ["Auto & Mobility", /(auto insur|motor insur|car insur|telematics|usage-based|\bUBI\b|fleet|\bEV\b|autonomous|mobility|driver|vehicle)/i],
  ["Property & Cat", /(property insur|homeowners?|property.and.casualty|\bP&C\b|catastrophe|\bcat bond\b|reinsur|climate|flood|wildfire|hurricane|natural disaster|parametric|commercial property)/i],
  ["Regulation", /(regulat|complian|lawsuit|\bcourt\b|department of insurance|licens|sanction|fined|penalty|legislat|\bNAIC\b|policyholder protection)/i],
  ["Leadership", /(appoint|names? (new )?(ceo|cfo|cto|coo|chair|president|head|chief)|hires?\b|joins as|steps down|resign|promot|new ceo|board of directors|expands leadership)/i],
];

const FALLBACK_TAG = "Industry";

function tagArticle(text) {
  const tags = TAXONOMY.filter(([, re]) => re.test(text)).map(([name]) => name);
  return tags.length ? tags : [FALLBACK_TAG];
}

module.exports = { TAXONOMY, FALLBACK_TAG, tagArticle };
