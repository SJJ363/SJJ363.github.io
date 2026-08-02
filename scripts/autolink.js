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
function linker({ terms = [], self = null, esc }) {
  const targets = terms.filter((t) => t && t.slug && t.slug !== self && t.re);
  const used = new Set();
  let budget = PAGE_MAX;

  return function link(text) {
    const s = String(text == null ? "" : text);
    if (!s || budget <= 0) return esc(s);

    /* Earliest match wins, longest breaks a tie. Earliest because the
       first mention is the one a reader meets while still deciding
       what the paragraph is about; longest because where two patterns
       start together the more specific one is the better anchor. */
    let best = null;
    for (const t of targets) {
      if (used.has(t.slug)) continue;
      // Strip g/y: a sticky or global regex carries lastIndex between
      // calls, so the same pattern would silently stop matching on the
      // second paragraph of a page.
      const re = new RegExp(t.re.source, t.re.flags.replace(/[gy]/g, ""));
      const m = re.exec(s);
      if (!m) continue;
      const [a, b] = expand(s, m.index, m.index + m[0].length);
      if (!best || a < best.a || (a === best.a && b - a > best.b - best.a)) {
        best = { t, a, b };
      }
    }
    if (!best) return esc(s);

    used.add(best.t.slug);
    budget--;
    return (
      esc(s.slice(0, best.a)) +
      `<a class="gl-link" href="/glossary/${best.t.slug}/">` +
      esc(s.slice(best.a, best.b)) +
      `</a>` +
      esc(s.slice(best.b))
    );
  };
}

/* A linker that does nothing, for the paths where no glossary exists
   yet (a fresh checkout, or a store with no definitions cached). The
   call sites then need no `if` — they always hold a linker. */
const plainLinker = (esc) => (text) => esc(text == null ? "" : String(text));

module.exports = { linker, plainLinker, expand, PAGE_MAX };
