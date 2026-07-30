/* ============================================================
   Brief window — what has landed since the last briefing
   ------------------------------------------------------------
   The wire keeps a 45-day batch, so a briefing written from
   `news.json` wholesale is written from six weeks of stories that
   were mostly already covered — which is why consecutive briefs kept
   circling the same themes. The brief is a *daily* piece of writing,
   so it should be written from the stories that arrived since the
   previous one was published, and nothing else.

   Two questions, and they are separate:

     1. When was the last brief published?  The archive
        (data/briefs.json) holds only Claude's writing (rule 3b), so
        the newest entry *before* today is the last briefing a reader
        actually saw. A day that fell back has no entry and therefore
        widens the window to cover it — which is the right answer, not
        a bug: nothing was published that day.

     2. When did each story land?  Not the same as when it was
        published. `store.seen[link].firstSeen` is the run that first
        carried it, which is the honest answer; for anything stored
        before that field existed we fall back to the publish date,
        and an article the store has never seen arrived on this run.

   Failure is soft in one direction only: when the window is too thin
   to write from — a quiet cycle, an empty archive, a missing store —
   it widens to the newest FLOOR_STORIES and says so, and the prompt
   tells the model the window was widened so it knows some of what it
   is reading may already have been covered.
   ============================================================ */

const MIN_STORIES = 8;        // below this a window is too thin to write from
const FLOOR_STORIES = 16;     // what a widened window falls back to
const MAX_LOOKBACK_DAYS = 7;  // never reach further back than this

const ms = (v) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
};

/* When this article reached us. `seen` is the fact store's per-link
   metadata; `hasStore` says whether it is trustworthy at all (an empty
   or missing store would otherwise make every article look brand new). */
function landedAt(a, seen, hasStore, now) {
  if (hasStore) {
    const meta = seen[a.link];
    if (!meta) return now;                       // never stored ⇒ arrived this run
    if (meta.firstSeen) return ms(meta.firstSeen) ?? now;
  }
  return a.timestamp || ms(a.publishedAt) || 0;
}

/* The last briefing a reader saw, before `date`. Archive entries are
   newest-first, but don't rely on that — pick the max explicitly. */
function previousBrief(briefs, date) {
  let best = null;
  for (const b of briefs || []) {
    if (!b || !b.date || (date && b.date >= date)) continue;
    if (!best || b.date > best.date) best = b;
  }
  return best;
}

/* ------------------------------------------------------------
   articles : this run's batch (news.json `articles`)
   opts.briefs : data/briefs.json entries
   opts.seen   : companies-store.json `seen`
   opts.date   : the brief's own Central date (so a retry later the
                 same day still measures from *yesterday's* brief)
   ------------------------------------------------------------ */
function briefWindow(articles, opts = {}) {
  const all = articles || [];
  const now = opts.now ? +new Date(opts.now) : Date.now();
  const seen = opts.seen || {};
  const hasStore = Object.keys(seen).length > 0;
  const floorAt = now - MAX_LOOKBACK_DAYS * 864e5;

  const prior = previousBrief(opts.briefs, opts.date);
  const priorAt = prior ? ms(prior.generatedAt) : null;
  // Clamp: an archive that is empty, or stale after a run of fallbacks,
  // must not turn "since the last brief" into "since the store began".
  const since = priorAt === null ? null : Math.max(priorAt, floorAt);

  const stamped = all.map((a) => ({ a, at: landedAt(a, seen, hasStore, now) }));
  stamped.sort((x, y) => y.at - x.at);

  const fresh = since === null ? [] : stamped.filter((s) => s.at > since);

  let widened = null;
  let picked = fresh;
  if (since === null) {
    widened = prior
      ? `no timestamp on the ${prior.date} briefing`
      : "no previous briefing on file";
  } else if (priorAt !== null && priorAt < floorAt) {
    widened = `the last briefing (${prior.date}) is more than ${MAX_LOOKBACK_DAYS} days old`;
  } else if (fresh.length < MIN_STORIES) {
    widened = `only ${fresh.length} ${fresh.length === 1 ? "story has" : "stories have"} landed since the ${prior.date} briefing`;
  }
  if (widened) picked = stamped.slice(0, Math.max(FLOOR_STORIES, fresh.length));

  return {
    articles: picked.map((s) => s.a),
    since: since === null ? null : new Date(since).toISOString(),
    priorDate: prior ? prior.date : null,
    widened,                     // null when the window held; else why it didn't
    freshCount: fresh.length,    // what strictly landed after the last brief
    batchCount: all.length,
  };
}

module.exports = { briefWindow, landedAt, previousBrief, MIN_STORIES, FLOOR_STORIES, MAX_LOOKBACK_DAYS };
