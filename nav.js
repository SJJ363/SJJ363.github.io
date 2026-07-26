/* ============================================================
   Nav — the Topics dropdown is a <details>, so opening, closing and
   keyboard access all work with this file absent. It only adds the
   two behaviours a native <details> has no opinion about: dismiss on
   Escape, and dismiss when the tap lands somewhere else.
   ============================================================ */
(function () {
  var drop = document.querySelector(".nav-drop");
  if (!drop) return;

  function close() {
    drop.open = false;
  }

  document.addEventListener("click", function (e) {
    if (drop.open && !drop.contains(e.target)) close();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !drop.open) return;
    close();
    var summary = drop.querySelector("summary");
    if (summary) summary.focus();
  });

  /* Crossing the breakpoint with the menu open leaves it anchored to
     the wrong box for a frame — cheaper to just shut it. */
  var mq = window.matchMedia("(max-width: 620px)");
  var onChange = function () {
    close();
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
})();
