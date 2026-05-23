/**
 * cleaner.js — exportSculpt DOM cleaner
 * Injected via popup, context menu, keyboard shortcut, or auto-clean.
 *
 * Reads window.__ES_CLEAN_OPTS (set by caller) for:
 *   - scalerPresets: object of preset name → boolean (which Scaler selectors to run)
 *   - removeHeader: boolean (non-Scaler: delete <header>)
 *   - removeFooter: boolean (non-Scaler: delete <footer>)
 *   - customSelectors: string[] (per-site custom selectors)
 */
(function () {
  "use strict";

  const opts = window.__ES_CLEAN_OPTS || {};
  const isScaler = location.hostname.includes("scaler.com");

  // ── Scaler-specific selectors mapped to preset names ──────────────────────
  const SCALER_MAP = {
    "Header":          "div.Header_header_container__uchwV",
    "Sidebar":         "div.view_right_section__M6YCz",
    "Author widget":   "div:has(> .articleWidget_articleWidget__heading___Kzbi)",
    "Author byline":   "div.article-author_tooltipContainer__LSaMQ",
    "Article meta":    "div.article-author_article_time_detail__SHs2n",
    "Quiz":            "div:has(> .quiz_quiz_container__UxcM5)",
    "Placement card":  "div.styles_container__Xpr6p",
    "Challenge":       "div.quiz_quiz_container_wrapper__HPjaU",
    "Content footer":  "div.contentFooter_footer__tOsSU",
    "Explore list":    "div.styles_explore_list__QDwsT",
    "Nav arrows":      "div.view_navStep__TE_SH",
    "Engagement bar":  "div.engagement-panel-desktop_engagement_bar__y0urM",
    "Video banner":    "div:has(> .articleWidget_banner_heading___leIS)",
    "Row spacer":      "div.row.space-between.m-b-xxs",
    "Callback strip":  "div.rcb_widget",
    "Site footer":     "footer"
  };

  // ── Build the active selector list ────────────────────────────────────────
  const selectors = [];

  if (isScaler) {
    const presets = opts.scalerPresets || {};
    // If no presets provided, enable everything by default
    const hasPresets = Object.keys(presets).length > 0;
    for (const [name, sel] of Object.entries(SCALER_MAP)) {
      if (!hasPresets || presets[name] !== false) selectors.push(sel);
    }
  } else {
    // Non-Scaler: optional universal header/footer
    if (opts.removeHeader) selectors.push("header");
    if (opts.removeFooter) selectors.push("footer");
  }

  // Custom selectors (per-site, from options)
  if (Array.isArray(opts.customSelectors)) {
    opts.customSelectors.forEach((s) => { if (s.trim()) selectors.push(s.trim()); });
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────
  let total = 0;
  function sweep() {
    selectors.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((el) => { el.remove(); total++; });
      } catch (e) {
        console.warn("[exportSculpt] Bad selector:", sel, e);
      }
    });
  }

  sweep();

  const obs = new MutationObserver(sweep);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);

  window.__ES_CLEANED = true;
  return total;
})();
