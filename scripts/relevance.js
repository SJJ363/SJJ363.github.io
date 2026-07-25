/* ============================================================
   What counts as an insurtech story.

   Shared because two things ask the question and must agree:
   fetch-news.js decides what reaches the wire, and seo.js decides
   what reaches the topic hubs, which are built from the persistent
   store — an archive that still holds everything admitted under
   older, looser rules.
   ============================================================ */

// The insurance half. Deliberately not tested against the source
// name: a publisher called "Insurance Journal" matches this on its
// own, which would wave through everything it files.
const RELEVANCE = /insur|underwrit|reinsur|actuar|policyholder/i;

// The technology half. Also the gate for feeds marked strict, where
// a technology angle is required rather than merely sufficient.
const TECH_ANGLE =
  /insurtech|fintech|technolog|platform|digital|software|\bapp\b|\bAPI\b|\bAI\b|artificial intelligence|machine learning|\bLLM\b|algorithm|automat|data|analytics|cyber|embedded|telematics|\bSaaS\b|startup|start-up|venture|funding|raise[sd]?\b|inves(?:t|tment)|acqui|partner|launch/i;

// Technology proper. Note what is missing: launch, partner, acquire,
// funding, invest. Those belong in TECH_ANGLE, where the story is
// already known to be about insurance and they mark the deal type. As a
// *substitute* for insurance relevance they match any business story
// going — "Tesla expands robotaxi service … beyond its initial launch
// market" qualified on the word "launch" alone.
const TECH_CORE =
  /insurtech|fintech|technolog|platform|digital|software|\bapp\b|\bAPI\b|\bAI\b|artificial intelligence|machine learning|\bLLM\b|algorithm|automat|analytics|cyber|embedded|telematics|\bSaaS\b|no-code|chatbot|startup|start-up|scale-?up/i;

/* Either half qualifies. Insurance-only catches "Zurich launches cover
   for shadow authorities"; technology-only catches "How Travelers
   measures ROI for its in-house LLM", which never says insurance but is
   squarely the beat. Requiring insurance wording alone silently drops
   the second kind — the whole reason insurtech-native outlets are worth
   carrying. Junk fails both: an earthquake, a lettuce recall, mortgage
   rates, a robotaxi rollout. */
function onTopic(text = "") {
  return RELEVANCE.test(text) || TECH_CORE.test(text);
}

module.exports = { RELEVANCE, TECH_ANGLE, TECH_CORE, onTopic };
