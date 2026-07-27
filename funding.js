/* ============================================================
   Funding tracker — table enhancement.

   Everything this file touches is already in the served HTML: every
   row, every link, the stage breakdown, the date order. It only adds
   two behaviours on top — filter the table to a set of stages, and
   re-sort it by amount or announcement date — so a crawler and a
   reader without JS still get the whole table, just fixed in the
   order the build wrote it.

   The keys come off data-attributes on each <tr> (data-stage,
   data-amount, data-date), never from the rendered cells: "$1.2B" and
   "Jul 3, 2026" are display formats, and re-parsing them here would be
   a second, divergent copy of money() and fullDate().
   ============================================================ */
(function () {
  var table = document.querySelector("[data-deal-table]");
  if (!table || !table.tBodies.length) return;

  var tbody = table.tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var filterBtns = Array.prototype.slice.call(document.querySelectorAll(".stage-filter"));
  var clearBtn = document.querySelector(".stage-clear");
  var status = document.getElementById("deal-status");
  var sortBtns = Array.prototype.slice.call(table.querySelectorAll(".th-sort-btn"));

  /* Tells the stylesheet the controls are live: the caret, the pointer
     cursor and the "select to filter" hint stay hidden until then, so a
     page served without this file never advertises a control it hasn't
     got. */
  document.body.setAttribute("data-dealui", "on");

  var selected = [];
  // null = the order the server rendered (newest first), which is not the
  // same as a date sort the reader asked for — leave it untouched until
  // they do, so no caret claims a state they didn't choose.
  var sortKey = null;
  var sortDir = "desc";

  /* ── Empty state ──────────────────────────────────────────── */
  var emptyRow = document.createElement("tr");
  emptyRow.className = "deal-empty-row";
  var emptyCell = document.createElement("td");
  emptyCell.colSpan = table.tHead ? table.tHead.rows[0].cells.length : 6;
  emptyCell.textContent = "No rounds match the selected stages.";
  emptyRow.appendChild(emptyCell);

  /* ── Sorting ──────────────────────────────────────────────── */
  var keyOf = {
    amount: function (tr) {
      return parseFloat(tr.getAttribute("data-amount")) || 0;
    },
    // ISO dates (YYYY-MM-DD) compare correctly as strings; a missing one
    // sorts to the bottom in either direction rather than jumping to the top.
    date: function (tr) {
      return tr.getAttribute("data-date") || "";
    },
  };

  function sorted(list) {
    if (!sortKey) return list;
    var read = keyOf[sortKey];
    var sign = sortDir === "asc" ? 1 : -1;
    return list
      .map(function (tr, i) {
        return { tr: tr, i: i, v: read(tr) };
      })
      .sort(function (a, b) {
        if (a.v === b.v) return a.i - b.i; // stable: keep the served order
        if (a.v === "" ) return 1;
        if (b.v === "") return -1;
        return a.v > b.v ? sign : -sign;
      })
      .map(function (o) {
        return o.tr;
      });
  }

  function paintSort() {
    sortBtns.forEach(function (btn) {
      var th = btn.closest("th");
      var on = btn.getAttribute("data-sort") === sortKey;
      btn.setAttribute("data-dir", on ? sortDir : "");
      if (th) th.setAttribute("aria-sort", on ? (sortDir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  /* ── Filtering ────────────────────────────────────────────── */
  function matches(tr) {
    if (!selected.length) return true;
    return selected.indexOf(tr.getAttribute("data-stage")) !== -1;
  }

  function paintFilters() {
    filterBtns.forEach(function (btn) {
      var on = selected.indexOf(btn.getAttribute("data-stage")) !== -1;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("active", on);
    });
    if (clearBtn) clearBtn.hidden = !selected.length;
  }

  /* ── Apply ────────────────────────────────────────────────── */
  function apply() {
    var visible = rows.filter(matches);
    var order = sorted(visible);

    // One reflow: build the new body off-document, then swap it in.
    var frag = document.createDocumentFragment();
    order.forEach(function (tr) {
      frag.appendChild(tr);
    });
    tbody.textContent = "";
    tbody.appendChild(frag);
    if (!order.length) tbody.appendChild(emptyRow);

    if (status) {
      if (selected.length) {
        status.textContent =
          "Showing " +
          order.length +
          " of " +
          rows.length +
          " round" +
          (rows.length === 1 ? "" : "s") +
          " — " +
          selected.join(", ");
        status.hidden = false;
      } else {
        status.textContent = "";
        status.hidden = true;
      }
    }

    paintFilters();
    paintSort();
    syncUrl();
  }

  /* ── URL state ────────────────────────────────────────────────
     replaceState only: a filtered view is worth sharing, but it must
     not push history entries the back button has to walk out of, and
     no link on the page ever points at a query string, so nothing new
     becomes crawlable. */
  function syncUrl() {
    if (!window.history || !history.replaceState) return;
    var qs = [];
    if (selected.length) qs.push("stage=" + encodeURIComponent(selected.join("|")));
    if (sortKey) qs.push("sort=" + sortKey + "&dir=" + sortDir);
    history.replaceState(null, "", location.pathname + (qs.length ? "?" + qs.join("&") : ""));
  }

  function readUrl() {
    var params = new URLSearchParams(location.search);
    var stages = params.get("stage");
    if (stages) {
      var known = filterBtns.map(function (b) {
        return b.getAttribute("data-stage");
      });
      selected = stages.split("|").filter(function (s) {
        return known.indexOf(s) !== -1;
      });
    }
    var s = params.get("sort");
    if (s && keyOf[s]) {
      sortKey = s;
      sortDir = params.get("dir") === "asc" ? "asc" : "desc";
    }
  }

  /* ── Wiring ───────────────────────────────────────────────── */
  filterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var stage = btn.getAttribute("data-stage");
      var at = selected.indexOf(stage);
      if (at === -1) selected.push(stage);
      else selected.splice(at, 1);
      apply();
    });
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      selected = [];
      apply();
    });
  }

  sortBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-sort");
      // Re-clicking the active column flips it; a new column starts on the
      // reading people actually want first — biggest rounds, newest dates.
      if (sortKey === key) sortDir = sortDir === "desc" ? "asc" : "desc";
      else {
        sortKey = key;
        sortDir = "desc";
      }
      apply();
    });
  });

  readUrl();
  if (selected.length || sortKey) apply();
  else {
    paintFilters();
    paintSort();
  }
})();
