/**
 * preload-images.js — exportSculpt image preloader
 * Injected before PDF generation to ensure every image is loaded.
 * Also expands horizontally-scrolled areas if enabled.
 *
 * Reads window.__ES_SCROLL_OPTS for:
 *   - expandHorizontal: boolean (expand overflow-x areas)
 */
(async function () {
  "use strict";
  const opts = window.__ES_SCROLL_OPTS || { expandHorizontal: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 1. Scroll vertically to trigger lazy loaders ──────────────────────────
  const totalH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const savedY = window.scrollY;
  for (let y = 0; y <= totalH; y += 280) { window.scrollTo(0, y); await sleep(25); }
  window.scrollTo(0, savedY);
  await sleep(300);

  // ── 2. Fix lazy-load attributes ───────────────────────────────────────────
  document.querySelectorAll("img").forEach((img) => {
    img.removeAttribute("loading");
    const lazySrc = img.dataset.src || img.dataset.lazySrc || img.dataset.original ||
      img.dataset.lazy || img.getAttribute("data-original-src") ||
      img.getAttribute("data-delayed-url") || img.getAttribute("data-cfsrc");
    if (lazySrc && (!img.src || img.naturalWidth === 0)) img.src = lazySrc;
    const lazySS = img.dataset.srcset || img.getAttribute("data-srcset");
    if (lazySS && !img.srcset) img.srcset = lazySS;
  });
  document.querySelectorAll("source").forEach((s) => {
    const ls = s.dataset.srcset || s.getAttribute("data-srcset");
    if (ls && !s.srcset) s.srcset = ls;
  });

  // ── 3. Wait for all images to load ────────────────────────────────────────
  const imgs = [...document.querySelectorAll("img")];
  await Promise.allSettled(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 9000); });
  }));

  // ── 4. Expand horizontally-scrolled areas ─────────────────────────────────
  if (opts.expandHorizontal) {
    document.querySelectorAll("*").forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowX === "hidden") {
          el.style.overflow = "visible";
          el.style.maxWidth = "none";
          el.style.width = el.scrollWidth + "px";
        }
      }
    });
  }

  // ── 5. Scroll any horizontal scroll containers to the end and back ────────
  if (opts.expandHorizontal) {
    const scrollEls = [...document.querySelectorAll("*")].filter(
      (el) => el.scrollWidth > el.clientWidth + 2
    );
    for (const el of scrollEls) {
      el.scrollLeft = el.scrollWidth;
      await sleep(20);
      el.scrollLeft = 0;
    }
  }

  return true;
})();
