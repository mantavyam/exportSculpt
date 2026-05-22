/**
 * printer.js — Page Cleaner PDF exporter
 *
 * Execution order:
 *   1. Scroll the live page end-to-end to trigger every lazy-load observer.
 *   2. Patch common lazy-load data-src attributes so un-swapped images get src.
 *   3. Wait for every <img> to reach naturalWidth > 0.
 *   4. Rasterise each image to a data-URL via canvas (GIFs → static PNG frame).
 *      Falls back to fetch-then-canvas for cross-origin CDN images.
 *      Ultimate fallback: keep the absolute URL so the new window fetches it.
 *   5. Snapshot document.documentElement.outerHTML (already cleaned by cleaner.js).
 *   6. DOMParser → detached document for safe manipulation.
 *   7. Strip all <script>/<noscript> so deleted elements cannot be re-injected.
 *   8. Insert <base href="origin/"> so every relative URL still resolves.
 *   9. Embed the rasterised images; strip srcset/sizes/lazy attrs.
 *  10. Inject a single print override <style> that:
 *        • forces print-color-adjust:exact → code block colours preserved
 *        • un-collapses the site's print-media height/overflow rules → full page
 *        • applies user-selected @page size, orientation, margins
 *        • configures code/table pagination (break-inside per-line / per-row)
 *  11. Serialise → open about:blank → document.write → trigger window.print().
 */
(function () {
  "use strict";

  // Settings injected by popup.js before this file runs
  const CFG = window.__PC_SETTINGS || {
    pageSize:    "A4",
    orientation: "portrait",
    marginCm:    1.0
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 1. Scroll to trigger IntersectionObserver-based lazy loaders ──────────
  async function triggerLazyLoad() {
    const totalH = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const savedY = window.scrollY;
    for (let y = 0; y <= totalH; y += 280) {
      window.scrollTo(0, y);
      await sleep(28);
    }
    window.scrollTo(0, savedY);
    await sleep(350);
  }

  // ── 2. Force every known lazy-src pattern onto img.src ───────────────────
  function fixLazyAttributes() {
    document.querySelectorAll("img").forEach((img) => {
      img.removeAttribute("loading");

      const lazySrc =
        img.dataset.src        ||
        img.dataset.lazySrc    ||
        img.dataset.original   ||
        img.dataset.lazy       ||
        img.getAttribute("data-original-src")  ||
        img.getAttribute("data-delayed-url")   ||
        img.getAttribute("data-cfsrc");        // Cloudflare lazy variant

      if (lazySrc && (!img.src || img.naturalWidth === 0)) {
        img.src = lazySrc;
      }

      const lazySrcset = img.dataset.srcset || img.getAttribute("data-srcset");
      if (lazySrcset && !img.srcset) img.srcset = lazySrcset;
    });

    document.querySelectorAll("source").forEach((src) => {
      const lazy = src.dataset.srcset || src.getAttribute("data-srcset");
      if (lazy && !src.srcset) src.srcset = lazy;
    });
  }

  // ── 3. Wait until every img reports complete + naturalWidth > 0 ──────────
  async function waitForImages() {
    const imgs = [...document.querySelectorAll("img")];
    await Promise.allSettled(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((res) => {
          img.onload  = res;
          img.onerror = res;
          setTimeout(res, 9000);   // 9 s hard cap
        });
      })
    );
  }

  // ── 4. Rasterise every loaded image → data-URL ───────────────────────────
  // Returns Map<absoluteSrc, dataURL|absoluteSrc>
  async function rasteriseImages() {
    const map  = new Map();
    const base = window.location.href;
    const imgs = [...document.querySelectorAll("img")];

    await Promise.allSettled(
      imgs.map(async (img) => {
        const src = img.currentSrc || img.src || "";
        if (!src)                      return;
        if (src.startsWith("data:"))   { map.set(src, src); return; }
        if (map.has(src))              return;   // already processed
        if (!img.complete || img.naturalWidth === 0) { map.set(src, src); return; }

        // ── Try A: direct canvas draw ──────────────────────────────────────
        try {
          const c = document.createElement("canvas");
          c.width  = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          // toDataURL throws SecurityError if canvas is tainted by CORS
          const dataUrl = c.toDataURL("image/png");
          map.set(src, dataUrl);
          return;
        } catch (_) { /* canvas tainted — fall through */ }

        // ── Try B: fetch → blob → fresh Image → canvas ────────────────────
        try {
          const resp = await fetch(src, { mode: "cors", credentials: "omit" });
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);

          const tmp = new Image();
          await new Promise((res, rej) => {
            tmp.onload  = res;
            tmp.onerror = rej;
            setTimeout(rej, 7000);
            tmp.crossOrigin = "anonymous";
            tmp.src = blobUrl;
          });

          const c = document.createElement("canvas");
          c.width  = tmp.naturalWidth  || img.naturalWidth;
          c.height = tmp.naturalHeight || img.naturalHeight;
          c.getContext("2d").drawImage(tmp, 0, 0);
          const dataUrl = c.toDataURL("image/png");
          URL.revokeObjectURL(blobUrl);
          map.set(src, dataUrl);
          return;
        } catch (_) { /* CORS hard-blocked — keep absolute URL */ }

        map.set(src, src);   // fallback: will load from network in the new tab
      })
    );

    return map;
  }

  // ── 5. Apply data-URLs into a DOMParser document ─────────────────────────
  function embedImages(doc, map) {
    const base = window.location.href;

    doc.querySelectorAll("img").forEach((img) => {
      const rawSrc  = img.getAttribute("src")       || "";
      const rawData = img.getAttribute("data-src")  || "";

      // Resolve the raw attribute to an absolute URL for map lookup
      let absSrc = rawSrc;
      try { absSrc = rawSrc  ? new URL(rawSrc,  base).href : ""; } catch (_) {}

      let absData = rawData;
      try { absData = rawData ? new URL(rawData, base).href : ""; } catch (_) {}

      const resolved =
        map.get(absSrc)  ||
        map.get(rawSrc)  ||
        map.get(absData) ||
        map.get(rawData) ||
        absSrc || absData || rawSrc || rawData;

      if (resolved) img.setAttribute("src", resolved);

      // Remove ALL responsive / lazy attributes — our embedded src is canonical
      [
        "srcset","sizes","loading",
        "data-src","data-srcset","data-lazy","data-lazy-src",
        "data-original","data-original-src","data-delayed-url","data-cfsrc"
      ].forEach((a) => img.removeAttribute(a));
    });

    // Also clear <source> srcset so <picture> falls through to the <img> src
    doc.querySelectorAll("source").forEach((s) => {
      s.removeAttribute("srcset");
      s.removeAttribute("data-srcset");
    });
  }

  // ── 6. Build the print override stylesheet ────────────────────────────────
  function buildPrintCSS() {
    const { pageSize, orientation, marginCm } = CFG;
    return /* css */`
/* ════════════════════════════════════════════════════════════════
   PAGE CLEANER — Print Override
   Injected last in <head> so cascade order guarantees it wins.
   !important beats both the site's @media print rules AND inline
   style attributes that would otherwise collapse the layout.
════════════════════════════════════════════════════════════════ */

/* ─── Colour fidelity ────────────────────────────────────────────
   Tells the browser to render ALL background-colors / background-
   images exactly as on screen.  This is the fix for code-snippet
   blocks appearing with white backgrounds in print mode.          */
*, *::before, *::after {
  -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
              color-adjust: exact !important;  /* legacy alias      */
}

@media print {
  /* ─── Page geometry ─────────────────────────────────────────── */
  @page {
    size: ${pageSize} ${orientation};
    margin: ${marginCm}cm;
  }

  /* ─── Un-collapse the document ──────────────────────────────────
     The site's own @media print CSS sets height/overflow values
     that clip the page to exactly one viewport tall.  These rules
     override all of that.                                          */
  html, body {
    height:     auto      !important;
    min-height: 0         !important;
    max-height: none      !important;
    overflow:   visible   !important;
    width:      100%      !important;
    margin:     0         !important;
    padding:    0         !important;
  }

  /* Every container: no clipping */
  * {
    overflow:   visible !important;
    max-height: none    !important;
  }

  /* ─── Kill lingering fixed / sticky overlays ─────────────────── */
  [style*="position:fixed"],  [style*="position: fixed"],
  [style*="position:sticky"], [style*="position: sticky"] {
    display: none !important;
  }

  /* ─── Let the article column span the full printable width ──────
     The sidebar was already deleted by cleaner.js.  These rules
     ensure the remaining column expands to fill the vacated space. */
  body > *,
  main, article,
  [class*="article"],
  [class*="content"],
  [class*="layout"],
  [class*="wrapper"],
  [class*="container"] {
    width:     100%  !important;
    max-width: 100%  !important;
    float:     none  !important;
    margin-left:  0  !important;
    margin-right: 0  !important;
  }

  /* ─── Links remain blue and clickable in the PDF ─────────────── */
  a, a:visited {
    color:           #1155cc   !important;
    text-decoration: underline !important;
  }

  /* ─── Images ─────────────────────────────────────────────────── */
  img {
    max-width: 100% !important;
    height:    auto !important;
  }

  /* ════════════════════════════════════════════════════════════════
     CODE BLOCKS
     Strategy:
       • The <pre> container is allowed to break across pages
         (break-inside: auto) so long code is never truncated.
       • Individual lines inside the <pre> use break-inside: avoid
         so the break always falls BETWEEN lines, never mid-line.
       • white-space: pre-wrap ensures lines wrap rather than
         overflow (which would be cut off at the page edge).
  ════════════════════════════════════════════════════════════════ */
  pre {
    page-break-inside: auto !important;
    break-inside:      auto !important;
    overflow:          visible !important;
    white-space:       pre-wrap !important;
    word-break:        break-word !important;
  }
  pre > *,
  pre .line,
  pre > span,
  pre > div,
  pre li,
  code > *,
  code .line,
  code > span {
    page-break-inside: avoid !important;
    break-inside:      avoid !important;
  }

  /* ════════════════════════════════════════════════════════════════
     TABLES
       • The <table> itself breaks across pages (auto).
       • <thead> is declared table-header-group so it reprints at
         the top of every continuation page.
       • Individual <tr> cells never split mid-row.
  ════════════════════════════════════════════════════════════════ */
  table {
    page-break-inside: auto !important;
    break-inside:      auto !important;
    width:             100% !important;
  }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr, td, th {
    page-break-inside: avoid !important;
    break-inside:      avoid !important;
  }

  /* ─── General flow ───────────────────────────────────────────── */
  h1, h2, h3, h4, h5, h6 {
    page-break-after: avoid !important;
    break-after:      avoid !important;
  }
  p, li, blockquote, figure {
    page-break-inside: avoid !important;
    break-inside:      avoid !important;
  }
}
`;
  }

  // ── MAIN ──────────────────────────────────────────────────────────────────
  async function run() {
    // Steps 1-3 — ensure every image in the live DOM is fully loaded
    await triggerLazyLoad();
    fixLazyAttributes();
    await waitForImages();

    // Step 4 — rasterise every image to a data-URL (GIFs become static PNG)
    const imageMap = await rasteriseImages();

    // Step 5 — snapshot the already-cleaned live DOM
    const rawHTML = document.documentElement.outerHTML;

    // Step 6 — parse into a detached document
    const parser = new DOMParser();
    const doc    = parser.parseFromString(rawHTML, "text/html");

    // Strip scripts — the new window must stay in the exact cleaned state
    doc.querySelectorAll("script, noscript").forEach((el) => el.remove());

    // Base tag (first child of head) — relative URLs resolve against live site
    const base = doc.createElement("base");
    base.href  = window.location.origin + "/";
    doc.head.insertBefore(base, doc.head.firstChild);

    // Embed images (data-URLs replace src; lazy attrs removed)
    embedImages(doc, imageMap);

    // Inject print CSS — appended last so cascade order guarantees it wins
    const style = doc.createElement("style");
    style.id    = "__pc_print__";
    style.textContent = buildPrintCSS();
    doc.head.appendChild(style);

    // Serialise
    const finalHTML = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;

    // Open a new same-origin blank window and write the snapshot into it
    const win = window.open("about:blank", "_blank");
    if (!win) {
      alert(
        "[Page Cleaner]\n\n" +
        "Edge blocked the popup.\n\n" +
        "Click the popup-blocked icon in the address bar, choose " +
        "'Always allow popups from this site', then try again."
      );
      return;
    }

    win.document.open("text/html", "replace");
    win.document.write(finalHTML);
    win.document.close();

    // Trigger print once fully loaded (with generous fallback timer)
    let fired = false;
    function go() {
      if (fired) return;
      fired = true;
      win.focus();
      setTimeout(() => win.print(), 500);
    }
    win.addEventListener("load", go);
    setTimeout(go, 7000);
  }

  run().catch((err) => console.error("[Page Cleaner] printer error:", err));
})();
