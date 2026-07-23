/* ============================================================
   Your Name — interactions
   ============================================================ */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Footer year
document.getElementById("year").textContent = new Date().getFullYear();

/* --- Cursor spotlight (throttled with rAF) --- */
if (!reduceMotion && window.matchMedia("(pointer: fine)").matches) {
  const root = document.documentElement;
  let tx = 50, ty = 20, raf = null;

  window.addEventListener("mousemove", (e) => {
    tx = (e.clientX / window.innerWidth) * 100;
    ty = (e.clientY / window.innerHeight) * 100;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        root.style.setProperty("--mx", tx + "%");
        root.style.setProperty("--my", ty + "%");
        raf = null;
      });
    }
  });
}

/* --- Nav: solidify on scroll --- */
const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 24);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* --- Scroll reveal --- */
const revealEls = document.querySelectorAll(".reveal");
if (reduceMotion || !("IntersectionObserver" in window)) {
  revealEls.forEach((el) => el.classList.add("in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  revealEls.forEach((el) => io.observe(el));
}
