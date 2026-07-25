/* ============================================================
   Story clustering — groups near-identical headlines into threads.

   The wire carries the same event from many outlets. `buildAdjacency`
   finds which headlines describe the same story; `assignClusters` turns
   that graph into disjoint groups so the UI can fold a thread down to
   one headline plus a "+N more outlets" disclosure.

   Shared by fetch-news.js (which also uses the adjacency for the
   corroboration term in its prominence score) so the notion of "same
   story" is defined exactly once.
   ============================================================ */

const STOP = new Set(
  ("the a an and or for to of in on at with from by is are as it its their new this that has have will its than into over amid insurtech insurance tech technology company companies firm firms report reports says announce announces announced launch launches " +
   // Market-research boilerplate. Without these, syndicated "…Market Size,
   // Share & Growth, 2034" headlines about entirely different markets look
   // near-identical to each other and falsely merge.
   "market markets size share growth trends analysis forecast industry global outlook segment segments revenue statistics"
  ).split(/\s+/)
);

function keywordSet(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

// Two headlines are "the same story" when they share at least 2 content
// words and their Jaccard overlap clears 0.4. Deliberately strict — a false
// merge hides a distinct story, which is worse than showing a near-dupe.
const MIN_SHARED = 2;
const MIN_JACCARD = 0.4;

function similar(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  if (inter < MIN_SHARED) return false;
  const union = a.size + b.size - inter;
  return union > 0 && inter / union >= MIN_JACCARD;
}

// adjacency[i] = Set of indices whose headline matches article i.
function buildAdjacency(articles) {
  const kw = articles.map((a) => keywordSet(a.title));
  const adj = articles.map(() => new Set());
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      if (similar(kw[i], kw[j])) { adj[i].add(j); adj[j].add(i); }
    }
  }
  return adj;
}

/* Assign every article to exactly one thread.

   Leader-based rather than transitive: articles are visited strongest-first,
   each unassigned one claims its still-unassigned neighbours, and membership
   is never chained through a third headline. Plain connected components would
   let A~B, B~C snowball unrelated stories into one blob when a generic
   headline bridges them; requiring similarity to the leader itself caps that.

   Sets on each article:
     clusterId — thread key, stable within a payload
     cluster   — distinct outlets in the thread (what the UI reports)
*/
function assignClusters(articles, adj = buildAdjacency(articles)) {
  const order = articles.map((_, i) => i).sort((x, y) =>
    (articles[y].score || 0) - (articles[x].score || 0) ||
    (articles[y].timestamp || 0) - (articles[x].timestamp || 0) ||
    x - y
  );

  const leaderOf = new Array(articles.length).fill(-1);
  for (const i of order) {
    if (leaderOf[i] !== -1) continue;
    leaderOf[i] = i;
    for (const j of adj[i]) if (leaderOf[j] === -1) leaderOf[j] = i;
  }

  // Thread ids follow the article order (recency) so they read predictably.
  const idOf = new Map();
  articles.forEach((_, i) => {
    const leader = leaderOf[i];
    if (!idOf.has(leader)) idOf.set(leader, "t" + (idOf.size + 1));
  });

  const outlets = new Map();
  articles.forEach((a, i) => {
    const leader = leaderOf[i];
    if (!outlets.has(leader)) outlets.set(leader, new Set());
    outlets.get(leader).add(a.source);
  });

  articles.forEach((a, i) => {
    const leader = leaderOf[i];
    a.clusterId = idOf.get(leader);
    a.cluster = outlets.get(leader).size;
  });

  return articles;
}

module.exports = { keywordSet, buildAdjacency, assignClusters, similar };
