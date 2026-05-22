/**
 * cleaner.js — injected into the active tab.
 *
 * Each selector targets the *outermost* wrapper of a distracting block so the
 * entire subtree is deleted in one shot.  :has() is used for wrappers whose
 * own element has no distinguishing class but whose first meaningful child does.
 *
 * All matches are removed via el.remove() — not hidden, not collapsed, gone.
 */

(function () {
  "use strict";

  // ── Selectors derived from the provided outer-HTML snippets ────────────────
  const TARGETS = [
    // Top navigation / article header bar
    "div.Header_header_container__uchwV",

    // Right-column sidebar (ads, related links, etc.)
    "div.view_right_section__M6YCz",

    // Author widget (first variant) — outer <div> identified by its direct child
    "div:has(> .articleWidget_articleWidget__heading___Kzbi)",

    // Author tooltip / byline (second variant — "By Ayush Kumar" strip)
    "div.article-author_tooltipContainer__LSaMQ",

    // Article metadata row (read time, last updated, view count)
    "div.article-author_article_time_detail__SHs2n",

    // Inline quiz block — outer <div> identified by its direct child
    "div:has(> .quiz_quiz_container__UxcM5)",

    // Placement / statistics card
    "div.styles_container__Xpr6p",

    // End-of-article challenge block
    "div.quiz_quiz_container_wrapper__HPjaU",

    // Article content footer (rating widget, tags, collaborators)
    "div.contentFooter_footer__tOsSU",

    // "Explore" link list below the article
    "div.styles_explore_list__QDwsT",

    // Prev / Next navigation bar between articles
    "div.view_navStep__TE_SH",

    // Left-side engagement panel (scroll progress, reactions, share)
    "div.engagement-panel-desktop_engagement_bar__y0urM",

    // Embedded video course banner — outer <div> identified by its direct child
    "div:has(> .articleWidget_banner_heading___leIS)",

    // Empty row spacer div
    "div.row.space-between.m-b-xxs",

    // Callback / career-counselling floating strip
    "div.rcb_widget",

    // Site-wide footer
    "footer",
  ];

  let total = 0;

  function sweep() {
    TARGETS.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          el.remove();
          total++;
        });
      } catch (err) {
        // A bad selector (e.g. :has() unsupported in very old builds) should
        // not abort the whole sweep.
        console.warn("[Page Cleaner] Skipping selector:", selector, err);
      }
    });
  }

  // First pass — catches everything already in the DOM
  sweep();

  // Second pass — catches elements injected by JS after the first pass
  const observer = new MutationObserver(sweep);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Stop watching after 15 s; the page is almost certainly done loading by then
  setTimeout(() => observer.disconnect(), 15000);

  // Stamp the page so the popup knows it is already clean on next open
  window.__PC_CLEANED = true;

  // Return the count so popup.js can display it
  return total;
})();
