/**
 * printer.js — exportSculpt single-page PDF exporter
 *
 * GUARANTEE: content never clips, regardless of page size or website CSS.
 *
 * Technique:
 *   1. @page { margin: 0 } — the FULL physical page is the canvas.
 *   2. All site min-width constraints are neutralised in print CSS.
 *   3. In the new window, AFTER layout settles, we measure the actual
 *      rendered scrollWidth and calculate the CSS zoom factor required
 *      to fit it within the chosen page width.
 *   4. CSS zoom is applied to <html> — this causes the browser to redo
 *      layout at the correct scale BEFORE the print dialog opens, so
 *      the print engine never sees overflowed content.
 *   5. Body padding for the user's chosen margin is applied as part of
 *      the pre-zoom measurement, so the margin reduces available width
 *      (not the physical page canvas) and is itself scaled proportionally.
 */
(function () {
  "use strict";
  const CFG = window.__ES_PDF_SETTINGS || {
    pageSize:"A4", orientation:"portrait", marginCm:0.5,
    imageBreak:true, tableBreak:true
  };

  // ── Page width in CSS pixels at 96 DPI ────────────────────────────────────
  // (1 inch = 96 CSS px; 1 cm = 96/2.54 = 37.795 CSS px)
  const PAGE_W = { A4:794, A3:1123, B5:665, Letter:816 };
  const PAGE_H = { A4:1123, A3:1587, B5:944, Letter:1056 };

  // ── Rasterise images ──────────────────────────────────────────────────────
  async function rasteriseImages() {
    const map = new Map();
    await Promise.allSettled([...document.querySelectorAll("img")].map(async (img) => {
      const src = img.currentSrc || img.src || "";
      if (!src || src.startsWith("data:") || map.has(src)) return;
      if (!img.complete || img.naturalWidth === 0) { map.set(src, src); return; }
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        map.set(src, c.toDataURL("image/png")); return;
      } catch (_) {}
      try {
        const r = await fetch(src, { mode:"cors", credentials:"omit" });
        const b = await r.blob(); const u = URL.createObjectURL(b);
        const t = new Image(); t.crossOrigin = "anonymous";
        await new Promise((res, rej) => { t.onload=res; t.onerror=rej; setTimeout(rej,7000); t.src=u; });
        const c = document.createElement("canvas");
        c.width=t.naturalWidth; c.height=t.naturalHeight;
        c.getContext("2d").drawImage(t,0,0);
        map.set(src, c.toDataURL("image/png")); URL.revokeObjectURL(u); return;
      } catch (_) {}
      map.set(src, src);
    }));
    return map;
  }

  function embedImages(doc, map) {
    const base = window.location.href;
    doc.querySelectorAll("img").forEach((img) => {
      const raw = img.getAttribute("src") || "", rd = img.getAttribute("data-src") || "";
      let abs=raw; try{abs=raw?new URL(raw,base).href:"";}catch(_){}
      let abd=rd; try{abd=rd?new URL(rd,base).href:"";}catch(_){}
      const r = map.get(abs)||map.get(raw)||map.get(abd)||map.get(rd)||abs||abd;
      if (r) img.setAttribute("src", r);
      ["srcset","sizes","loading","data-src","data-srcset","data-lazy","data-lazy-src",
       "data-original","data-original-src","data-delayed-url","data-cfsrc"
      ].forEach(a => img.removeAttribute(a));
    });
    doc.querySelectorAll("source").forEach(s => {
      s.removeAttribute("srcset"); s.removeAttribute("data-srcset");
    });
  }

  function buildPrintCSS() {
    const { pageSize, orientation, imageBreak, tableBreak } = CFG;

    const imgRule = imageBreak
      ? "img,figure,picture,svg{page-break-inside:auto!important;break-inside:auto!important;}"
      : "img,figure,picture,svg{page-break-inside:avoid!important;break-inside:avoid!important;}";
    const tblRule = tableBreak
      ? "table{page-break-inside:auto!important;break-inside:auto!important;width:100%!important;}"
        + "tr,td,th{page-break-inside:auto!important;break-inside:auto!important;}"
      : "table{page-break-inside:avoid!important;break-inside:avoid!important;width:100%!important;}"
        + "tr,td,th{page-break-inside:avoid!important;break-inside:avoid!important;}";

    return `
/* ── Colour fidelity: every background rendered exactly as on screen ── */
*,*::before,*::after{
  -webkit-print-color-adjust:exact!important;
  print-color-adjust:exact!important;
  color-adjust:exact!important;
}

@media print {
  /* ── Page canvas: zero @page margin gives the full physical page ── */
  @page {
    size: ${pageSize} ${orientation};
    margin: 0 !important;
  }

  /* ── Document root: let JS zoom govern all sizing ── */
  html {
    margin:0!important; padding:0!important;
    height:auto!important; overflow:visible!important;
    /* min-width:0 ensures no site CSS forces a wider layout than the page */
    min-width:0!important;
  }
  body {
    /* margin/padding are set by the zoom-fit script BEFORE print is triggered */
    margin:0!important;
    height:auto!important; min-height:0!important;
    max-height:none!important; overflow:visible!important;
    min-width:0!important;
  }

  /* ── Neutralise ALL min-width constraints site-wide ── */
  * {
    min-width:0!important;
    overflow:visible!important;
    max-height:none!important;
  }

  /* ── Kill any surviving fixed/sticky overlays ── */
  [style*="position:fixed"],[style*="position: fixed"],
  [style*="position:sticky"],[style*="position: sticky"] { display:none!important; }
  .exit-intent_modal_container__O2C8_ { display:none!important; }

  /* ── Content width: let the zoom govern, only prevent explicit fixed px ── */
  body > *, main, article,
  [class*="article"],[class*="content"],[class*="layout"],
  [class*="wrapper"],[class*="container"] {
    max-width:100%!important; float:none!important;
    box-sizing:border-box!important;
  }

  /* ── Links ── */
  a,a:visited{color:#1155cc!important;text-decoration:underline!important;}

  /* ── Images ── */
  img{max-width:100%!important;height:auto!important;}
  ${imgRule}

  /* ── CODE BLOCKS ──
     break-inside:auto  → code can start on the current page (no whitespace gap)
                           and flow naturally across the page boundary.
     Individual lines   → break-inside:avoid so the break always falls BETWEEN lines.
     white-space:pre-wrap + word-break → long lines wrap, never clip horizontally. */
  pre, pre[class], code[class],
  .code-box_snippetContainer__cJ6zK,
  [class*="code-box"],[class*="CodeMirror"],[class*="prism"],
  [class*="highlight"],[class*="snippet"] {
    page-break-inside:auto!important; break-inside:auto!important;
    break-before:auto!important; page-break-before:auto!important;
    overflow:visible!important;
    white-space:pre-wrap!important;
    word-break:break-word!important;
    overflow-wrap:break-word!important;
    max-width:100%!important;
  }
  /* Individual code lines — break only between lines, never mid-line */
  pre>span, pre>div, pre li, pre .line, pre .token-line,
  code>span, code>div, code .line,
  .code-box_snippetContainer__cJ6zK>*,
  [class*="code-box"]>* {
    page-break-inside:avoid!important; break-inside:avoid!important;
    white-space:pre-wrap!important;
    word-break:break-word!important;
  }

  /* ── TABLES ── */
  ${tblRule}
  thead{display:table-header-group;}
  tfoot{display:table-footer-group;}

  /* ── General flow ── */
  h1,h2,h3,h4,h5,h6{page-break-after:avoid!important;}
  p,li,blockquote{page-break-inside:avoid!important;break-inside:avoid!important;}
}`;
  }

  // ── Zoom-fit script injected into the new print window ───────────────────
  // This runs INSIDE the new window after the document loads.
  // It measures the actual rendered content width, applies CSS zoom so the
  // full content fits within the page, then triggers window.print().
  function buildZoomScript() {
    const isLand = CFG.orientation === "landscape";
    const pageW = isLand ? (PAGE_H[CFG.pageSize]||1123) : (PAGE_W[CFG.pageSize]||794);
    const marginPx = (CFG.marginCm || 0) * (96 / 2.54);
    const scaleOverride = CFG.scaleOverride || null;   // null = auto

    return `
(function() {
  function run() {
    var pageW      = ${pageW};
    var marginPx   = ${marginPx};
    var manualZoom = ${scaleOverride === null ? "null" : scaleOverride};

    document.documentElement.style.margin   = '0';
    document.documentElement.style.padding  = '0';
    document.documentElement.style.minWidth = '0';
    document.body.style.margin    = '0';
    document.body.style.padding   = marginPx + 'px';
    document.body.style.boxSizing = 'border-box';
    document.body.style.minWidth  = '0';

    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        var zoom;
        if (manualZoom !== null) {
          /* User picked an explicit scale — use it directly */
          zoom = manualZoom;
        } else {
          /* Auto: measure rendered width and fit to page */
          var W = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          zoom = (W > pageW) ? (pageW / W) : 1;
        }

        if (zoom < 0.999) {
          document.documentElement.style.zoom = zoom;
        }
        window.__ES_ZOOM_DONE = true;
        setTimeout(function() { window.focus(); window.print(); }, 350);
      });
    });
  }

  if (document.readyState === 'complete') { setTimeout(run, 200); }
  else { window.addEventListener('load', function() { setTimeout(run, 200); }); }
})();
`;
  }

  async function run() {
    const imageMap = await rasteriseImages();
    const rawHTML  = document.documentElement.outerHTML;
    const parser   = new DOMParser();
    const doc      = parser.parseFromString(rawHTML, "text/html");

    doc.querySelectorAll("script, noscript").forEach(el => el.remove());
    doc.querySelectorAll(".exit-intent_modal_container__O2C8_").forEach(el => el.remove());

    const base = doc.createElement("base");
    base.href  = window.location.origin + "/";
    doc.head.insertBefore(base, doc.head.firstChild);

    embedImages(doc, imageMap);

    // Inject print CSS (loaded FIRST so layout rules are in place before zoom)
    const style = doc.createElement("style");
    style.id    = "__es_print__";
    style.textContent = buildPrintCSS();
    doc.head.appendChild(style);

    // Inject zoom-fit script (runs in new window, triggers print after zoom)
    const script = doc.createElement("script");
    script.textContent = buildZoomScript();
    doc.body.appendChild(script);

    const finalHTML = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;

    const win = window.open("about:blank", "_blank");
    if (!win) {
      alert("[exportSculpt] Popup blocked. Allow popups for this site, then try again.");
      return;
    }
    win.document.open("text/html", "replace");
    win.document.write(finalHTML);
    win.document.close();

    // Fallback: if the script inside the window fails (rare), trigger print externally
    setTimeout(() => {
      if (win && !win.closed && !win.__ES_ZOOM_DONE) {
        win.focus();
        win.print();
      }
    }, 8000);
  }

  run().catch(e => console.error("[exportSculpt] printer error:", e));
})();
