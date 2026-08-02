/* ============================================================
   Contextual internal links — glossary terms inside our own prose
   ------------------------------------------------------------
   WHY THIS EXISTS

   The glossary and the topic hubs are the only page types here aimed
   at a query that does not decay: "what is an MGA" is asked at the
   same rate every month, where "<company> funding" is asked once and
   "insurtech funding August 2025" decays to nothing. They are also
   the two smallest page types on the site — 16 and 14 pages out of
   ~774 indexable URLs — and, before this file, they were starved of
   internal links. Measured on the build of 2026-08-01:

     /glossary/mga/  →  9 inbound internal links, sitewide

   Every one of the 1,358 company pages linked to /glossary/ (the
   footer index) and to all fourteen topic hubs, and to no term at
   all. So ~90% of the site's internal link equity pooled in company
   pages, which are the weakest thing here — a name, a profile and
   somebody else's headlines — and the strongest pages sat two clicks
   deep behind a footer link.

   Meanwhile the site was already writing the anchors and discarding
   them. Across the prose we generate ourselves:

     684 company profiles   → 269 term mentions (broker 94,
                              reinsurance 50, MGA 37, annuity 13)
      14 topic briefs       →  32 term mentions
      16 glossary bodies    → each other

   That is ~300 exact-match contextual links available at render time,
   onto 16 pages holding ~9 each. No new pages, no new prose, no
   Claude calls — and because it is a render-time change it applies to
   the whole archive on the next build, the same contract collectDeals()
   has with the funding regexes.

   WHY IT LINKS ONLY OUR OWN SENTENCES

   Headlines and coverage lists are other outlets' words, quoted. We
   do not edit them, and inserting our links into them would make a
   quotation into a thing we wrote. Only three surfaces are linked,
   all of them prose this site authored: companyProfileBlock(),
   topicBriefBlock() and the glossary bodies.

   WHY THE PATTERNS ARE NOT NEW

   The matching is TERMS[].re from glossary.js — hand-checked, already
   load-bearing for which stories a term page claims as examples, and
   already carrying the two traps that list documents (a bare
   /\bmarine\b/ matches Tokio Marine; a bare /\bcaptive\b/ matches
   "captive market"). A second, looser pattern set for linking would
   drift from the one deciding coverage, and the page would link a
   term it does not list stories for. One pattern set, two readers.

   THE CAPS ARE THE WHOLE DESIGN

   `insurance-broker` matches /\bbrokers?\b|brokerage/i, which fires
   on 94 of 684 profiles and several times within some of them. A
   paragraph peppered with the same anchor reads as spam to a person
   and as a doorway to a crawler, and the second link to a URL passes
   nothing the first did not. So:

     · one link per paragraph        (one call to link() = one anchor)
     · at most PAGE_MAX per page     (a 500-word hub brief, not a farm)
     · first mention only            (`used`, page-scoped)
     · never to the page you are on  (`self`)

   A linker is therefore stateful and must be built once per page, not
   once per build — see the call sites in seo.js.
   ============================================================ */

/* Links per page, across every paragraph handed to one linker. Five
   is what a ~500-word topic brief carries without the prose starting
   to read like a directory; a company profile is one paragraph and so
   is capped at one by construction. */
const PAGE_MAX = 5;

/* Companies are capped looser than terms, because they are a different
   kind of link. A glossary term is an aside — the reader probably knows
   what a broker is and the link is there for the one who doesn't — so
   one per paragraph is generous. A company named in a brief is the
   SUBJECT of the sentence, and the daily brief's "What's happening"
   paragraph routinely names five or six; capping that at one would
   link Mapfre and leave Tuio, Gallagher and Arch as dead text in the
   same clause, which reads like a bug rather than restraint.

   Six rather than four because four was measured against a real brief
   and cut one: the 2026-08-01 "What's happening" names Meta, Mapfre,
   Tuio, Gallagher and Arch, and stopping at four dropped Arch alone
   for no reason a reader could see. The page cap is what actually
   bounds this — a brief is two paragraphs — so the paragraph cap only
   has to stop a pathological one, not ration a normal one. */
const CO_PARA_MAX = 6;
const CO_PAGE_MAX = 8;

/* Company names that are ordinary English words, hand-checked against
   the index. Case-sensitive matching already rejects "chapter" and
   "income" in mid-sentence, but not a sentence that OPENS with one —
   "Today's insurers…", "Root causes remain…", "Stand-alone cyber…" —
   and a brief that links the first word of a sentence to a company
   page nobody was talking about is exactly the failure this whole
   file's caps and gates exist to prevent.

   Curated and hand-verified, on the same reasoning CANON_LIST and
   SPLIT_LIST carry: any rule general enough to derive this set from
   the names alone would eventually reject a real company. The cost of
   a miss is one unlinked mention; the cost of a false link is a reader
   sent to the wrong company's page from our own prose.

   Names NOT on this list on purpose: Arch, Marsh, Meta, Chase, Mercury,
   Guardian, Nirvana. Each is a word, but not one that opens an
   insurance sentence, and each is a real company the briefs do name —
   "Arch saying it prefers buybacks" is the link a reader wants. */
const AMBIGUOUS = new Set([
  "Today", "Sure", "Stand", "Advance", "Root", "Covered", "Income",
  "Chapter", "United", "Mission", "Pace", "Loop", "Brace", "Grace",
  "Honey", "Leaf", "Tree", "Neat", "Ripe", "Slide", "Blend", "Beam",
  "Pit", "Terminal", "Foundry", "Fabric", "Ledger", "Haven", "Carrot",
  "Rainbow", "Emerald", "Indigo", "Kiwi", "Bolt", "Digit", "Epic",
  "Gamma", "Owen", "Victor", "Swan", "Integrity", "Momentum",
  "Landmark", "Radiant", "Assured", "Vigil", "Sentry", "Naked",
  "Pineapple", "Wave", "Flock", "Jerry", "Kettle",
]);

/* A name has to be distinctive enough that a whole-word, case-sensitive
   hit is evidence rather than coincidence. Two rules, both about how
   much signal the string itself carries:

     · under 3 characters is an initialism a sentence can produce by
       accident, and
     · an all-lowercase one-word name under 5 characters ("mea",
       "itel", "arqu") reads as a typo of an ordinary word, and
       case-sensitivity buys nothing when there is no case to match.

   bolttech, wefox and easypaisa clear the second rule on length, which
   is the intent — they are brands a reader would recognise. */
function linkableName(name) {
  if (!name || name.length < 3) return false;
  if (AMBIGUOUS.has(name)) return false;
  if (!/[A-Z]/.test(name) && !/\s/.test(name) && name.length < 5) return false;
  return true;
}

const RE_META = /[.*+?^${}()|[\]\\]/g;
const escRe = (s) => s.replace(RE_META, "\\$&");

/* Characters that continue a word for the purposes of growing a match
   out to its whole word. Deliberately excludes the hyphen: several
   patterns already span one ("pay-as-you-drive", "non-admitted"), and
   including it would let a match on "parametric" swallow the "non-"
   in "non-parametric" and assert the opposite of what the page says. */
const WORD = /[A-Za-z0-9]/;

/* Grow [start,end) out to whole words.

   The patterns are written to decide whether a story is ABOUT a term,
   so several match a stem rather than a word: /\breinsur/ is enough to
   file a headline, but anchoring the literal match would put a link on
   the text "reinsur" inside "reinsurance". Anchor text is the strongest
   signal a link carries and a truncated stem wastes it. */
function expand(s, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && WORD.test(s[a - 1])) a--;
  while (b < s.length && WORD.test(s[b])) b++;
  return [a, b];
}

/* terms — the LIVE glossary terms, i.e. the ones a page was actually
            built for (see glossaryLive() in seo.js). Linking a term
            with no definition is a link to a 404: pages are built only
            where a definition exists.
   self   — slug of the term whose page this is, or null. A page must
            not link to itself; the anchor goes nowhere and reads as a
            mistake.
   esc    — the caller's HTML escaper. Passed in rather than duplicated
            so there is one escaping rule on the site, and so this file
            never has to require seo.js back.

   Returns link(text) -> html. It escapes as well as links, so a call
   site swaps `esc(text)` for `link(text)` rather than nesting the two —
   nesting would either escape the anchor we just inserted or match
   patterns against text with entities already in it. */
/* The engine both linkers are built on.

   targets  — [{ key, re, href, grow }]. `key` is what "first mention
              only" is keyed on, `grow` says whether a match should be
              expanded to whole words (true for the glossary's stem
              patterns, false for exact company names).
   paraMax  — anchors per call, i.e. per paragraph.
   pageMax  — anchors per linker, i.e. per page.
   cls      — the anchor's class, so the two link kinds can be styled
              and counted apart.
   esc      — the caller's HTML escaper. Passed in rather than
              duplicated so there is one escaping rule on the site, and
              so this file never has to require seo.js back.

   Returns link(text) -> html. It escapes as well as links, so a call
   site swaps `esc(text)` for `link(text)` rather than nesting the two —
   nesting would either escape the anchor we just inserted or match
   patterns against text with entities already in it. */
function makeLinker({ targets, paraMax, pageMax, cls, esc }) {
  const used = new Set();
  let budget = pageMax;

  return function link(text) {
    const s = String(text == null ? "" : text);
    if (!s || budget <= 0) return esc(s);

    /* Collect non-overlapping hits left to right. Earliest match wins,
       longest breaks a tie: earliest because the first mention is the
       one a reader meets while still deciding what the paragraph is
       about, longest because where two patterns start together the
       more specific one is the better anchor ("Wave Claims" over
       "Wave"). */
    const hits = [];
    let cursor = 0;
    let room = Math.min(paraMax, budget);
    while (room > 0) {
      let best = null;
      for (const t of targets) {
        if (used.has(t.key)) continue;
        // Strip g/y: a sticky or global regex carries lastIndex between
        // calls, so the same pattern would silently stop matching on
        // the second paragraph of a page.
        const re = new RegExp(t.re.source, t.re.flags.replace(/[gy]/g, ""));
        const m = re.exec(s.slice(cursor));
        if (!m) continue;
        const from = cursor + m.index;
        const [a, b] = t.grow
          ? expand(s, from, from + m[0].length)
          : [from, from + m[0].length];
        if (!best || a < best.a || (a === best.a && b - a > best.b - best.a)) {
          best = { t, a, b };
        }
      }
      if (!best) break;
      hits.push(best);
      used.add(best.t.key);
      budget--;
      room--;
      cursor = best.b;
    }
    if (!hits.length) return esc(s);

    let out = "";
    let at = 0;
    for (const h of hits) {
      out +=
        esc(s.slice(at, h.a)) +
        `<a class="${cls}" href="${h.t.href}">` +
        esc(s.slice(h.a, h.b)) +
        `</a>`;
      at = h.b;
    }
    return out + esc(s.slice(at));
  };
}

/* terms — the LIVE glossary terms, i.e. the ones a page was actually
            built for (see glossaryLive() in seo.js). Linking a term
            with no definition is a link to a 404: pages are built only
            where a definition exists.
   self   — slug of the term whose page this is, or null. A page must
            not link to itself; the anchor goes nowhere and reads as a
            mistake. */
function linker({ terms = [], self = null, esc }) {
  return makeLinker({
    targets: terms
      .filter((t) => t && t.slug && t.slug !== self && t.re)
      .map((t) => ({ key: t.slug, re: t.re, href: `/glossary/${t.slug}/`, grow: true })),
    paraMax: 1,
    pageMax: PAGE_MAX,
    cls: "gl-link",
    esc,
  });
}

/* companies — [{ slug, name }], ALREADY resolved against the finished
                company index by the caller (rule 3c-iv) and already
                gated to the ones this brief was written from (rule
                3b-vi). This function does not decide which companies a
                brief may link; it only finds their names in the prose.

   Matching is case-SENSITIVE and whole-word, and longer names are
   tried first so "Wave Claims" wins over "Wave". Case-sensitivity is
   the cheap half of the ambiguity guard (it rejects "brokerage chapter"
   for the company Chapter); AMBIGUOUS and linkableName() are the half
   that catches a sentence opening on one. */
function companyLinker({ companies = [], esc }) {
  const targets = companies
    .filter((c) => c && c.slug && linkableName(c.name))
    .slice()
    .sort((a, b) => b.name.length - a.name.length)
    .map((c) => ({
      key: c.slug,
      // No `i` flag, deliberately. Lookaround rather than \b so a name
      // ending in punctuation ("Zurich's", "AXA.") still matches while
      // "Rootstock" does not.
      re: new RegExp(`(?<![A-Za-z0-9])${escRe(c.name)}(?![A-Za-z0-9])`),
      href: `/company/${c.slug}/`,
      grow: false,
    }));
  return makeLinker({
    targets,
    paraMax: CO_PARA_MAX,
    pageMax: CO_PAGE_MAX,
    cls: "co-inline",
    esc,
  });
}

/* A linker that does nothing, for the paths where there is nothing to
   link — a fresh checkout with no glossary cached, or a brief with no
   stamped companies. The call sites then need no `if`: they always
   hold a linker. */
const plainLinker = (esc) => (text) => esc(text == null ? "" : String(text));

module.exports = {
  linker,
  companyLinker,
  plainLinker,
  expand,
  linkableName,
  AMBIGUOUS,
  PAGE_MAX,
  CO_PARA_MAX,
  CO_PAGE_MAX,
};
