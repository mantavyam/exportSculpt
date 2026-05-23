/**
 * printer.js — exportSculpt single-page PDF exporter
 *
 * PDF CLIPPING FIX:
 *   Previous approach: @page { margin: Xcm } — this clips content inward.
 *   New approach: @page { margin: 0 } ALWAYS, then body { padding: Xcm }
 *   for visual margins. Content is laid out at full page width first,
 *   padding adds whitespace around it without ever clipping.
 *   If content is still wider than the page, we scale the body down.
 */
(function () {
  "use strict";
  const CFG = window.__ES_PDF_SETTINGS || { pageSize:"A4", orientation:"portrait", marginCm:0.5 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Page dimensions in CSS units for overflow detection
  const PAGE_SIZES_MM = {
    A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 },
    B5: { w: 176, h: 250 }, Letter: { w: 216, h: 279 }
  };

  // ── Rasterise images to data-URLs ─────────────────────────────────────────
  async function rasteriseImages() {
    const map = new Map();
    const imgs = [...document.querySelectorAll("img")];
    await Promise.allSettled(imgs.map(async (img) => {
      const src = img.currentSrc || img.src || "";
      if (!src || src.startsWith("data:") || map.has(src)) return;
      if (!img.complete || img.naturalWidth === 0) { map.set(src, src); return; }
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        map.set(src, c.toDataURL("image/png"));
        return;
      } catch (_) {}
      try {
        const r = await fetch(src, { mode: "cors", credentials: "omit" });
        const b = await r.blob(); const u = URL.createObjectURL(b);
        const t = new Image(); t.crossOrigin = "anonymous";
        await new Promise((res, rej) => { t.onload=res; t.onerror=rej; setTimeout(rej,7000); t.src=u; });
        const c = document.createElement("canvas");
        c.width=t.naturalWidth; c.height=t.naturalHeight;
        c.getContext("2d").drawImage(t,0,0);
        map.set(src, c.toDataURL("image/png"));
        URL.revokeObjectURL(u); return;
      } catch (_) {}
      map.set(src, src);
    }));
    return map;
  }

  function embedImages(doc, map) {
    const base = window.location.href;
    doc.querySelectorAll("img").forEach((img) => {
      const raw = img.getAttribute("src") || "";
      const rd = img.getAttribute("data-src") || "";
      let abs = raw; try { abs = raw ? new URL(raw, base).href : ""; } catch(_){}
      let abd = rd;  try { abd = rd  ? new URL(rd,  base).href : ""; } catch(_){}
      const resolved = map.get(abs) || map.get(raw) || map.get(abd) || map.get(rd) || abs || abd;
      if (resolved) img.setAttribute("src", resolved);
      ["srcset","sizes","loading","data-src","data-srcset","data-lazy",
       "data-lazy-src","data-original","data-original-src","data-delayed-url","data-cfsrc"
      ].forEach((a) => img.removeAttribute(a));
    });
    doc.querySelectorAll("source").forEach((s) => {
      s.removeAttribute("srcset"); s.removeAttribute("data-srcset");
    });
  }

  function buildPrintCSS() {
    const { pageSize, orientation, marginCm } = CFG;
    return `
*, *::before, *::after {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}
@media print {
  @page {
    size: ${pageSize} ${orientation};
    margin: 0 !important;
  }
  html {
    margin: 0 !important; padding: 0 !important;
    width: 100% !important; height: auto !important;
    overflow: visible !important;
  }
  body {
    margin: 0 !important;
    padding: ${marginCm}cm !important;
    width: 100% !important; max-width: 100% !important;
    height: auto !important; min-height: 0 !important;
    max-height: none !important; overflow: visible !important;
    box-sizing: border-box !important;
  }
  * {
    overflow: visible !important;
    max-height: none !important;
  }
  [style*="position:fixed"],[style*="position: fixed"],
  [style*="position:sticky"],[style*="position: sticky"] {
    display: none !important;
  }
  body > *, main, article,
  [class*="article"],[class*="content"],[class*="layout"],
  [class*="wrapper"],[class*="container"] {
    width: 100% !important; max-width: 100% !important;
    float: none !important; margin-left: 0 !important; margin-right: 0 !important;
    box-sizing: border-box !important;
  }
  a, a:visited { color: #1155cc !important; text-decoration: underline !important; }
  img { max-width: 100% !important; height: auto !important; }
  pre {
    page-break-inside: auto !important; break-inside: auto !important;
    overflow: visible !important; white-space: pre-wrap !important;
    word-break: break-word !important;
  }
  pre > *, pre .line, pre > span, pre > div, pre li,
  code > *, code .line, code > span {
    page-break-inside: avoid !important; break-inside: avoid !important;
  }
  table {
    page-break-inside: auto !important; break-inside: auto !important;
    width: 100% !important;
  }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr, td, th { page-break-inside: avoid !important; break-inside: avoid !important; }
  h1,h2,h3,h4,h5,h6 { page-break-after: avoid !important; }
  p, li, blockquote, figure { page-break-inside: avoid !important; break-inside: avoid !important; }
}`;
  }

  async function run() {
    // Images already preloaded by preload-images.js — just rasterise
    const imageMap = await rasteriseImages();
    const rawHTML = document.documentElement.outerHTML;
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHTML, "text/html");

    doc.querySelectorAll("script, noscript").forEach((el) => el.remove());

    const base = doc.createElement("base");
    base.href = window.location.origin + "/";
    doc.head.insertBefore(base, doc.head.firstChild);

    embedImages(doc, imageMap);

    const style = doc.createElement("style");
    style.id = "__es_print__";
    style.textContent = buildPrintCSS();
    doc.head.appendChild(style);

    // Scale script: runs in the new window to shrink body if it overflows
    const scaleScript = doc.createElement("script");
    scaleScript.textContent = `
      window.addEventListener('load', function() {
        setTimeout(function() {
          var bw = document.body.scrollWidth;
          var pw = document.documentElement.clientWidth || window.innerWidth;
          if (bw > pw + 2) {
            var scale = pw / bw;
            document.body.style.transformOrigin = 'top left';
            document.body.style.transform = 'scale(' + scale + ')';
            document.body.style.width = (100 / scale) + '%';
          }
        }, 200);
      });
    `;
    doc.body.appendChild(scaleScript);

    const finalHTML = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
    const win = window.open("about:blank", "_blank");
    if (!win) {
      alert("[exportSculpt] Popup blocked. Allow popups for this site, then try again.");
      return;
    }
    win.document.open("text/html", "replace");
    win.document.write(finalHTML);
    win.document.close();

    let fired = false;
    function go() { if (fired) return; fired = true; win.focus(); setTimeout(() => win.print(), 600); }
    win.addEventListener("load", go);
    setTimeout(go, 7000);
  }

  run().catch((e) => console.error("[exportSculpt] printer error:", e));
})();
