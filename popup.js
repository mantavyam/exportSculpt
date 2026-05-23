"use strict";

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = (s) => document.getElementById(s);
const statusEl = $("status"), statusText = $("status-text");
const btnClean = $("btn-clean"), btnPdf = $("btn-pdf");
const btnMd = $("btn-md"), btnHtml = $("btn-html"), btnClip = $("btn-clip");
const modeChip = $("mode-chip"), modeIcon = $("mode-icon"), modeText = $("mode-text");
const genOpts = $("general-opts");
const mSlider = $("m-slider"), mLabel = $("m-label");

const MARGINS = [
  { l:"None", cm:0 }, { l:"Compact", cm:0.4 },
  { l:"Comfortable", cm:0.8 }, { l:"Standard", cm:1.3 }, { l:"Wide", cm:2.0 }
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function setStatus(msg, type) {
  statusText.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
function segVal(id) {
  return document.querySelector(`#${id} .seg.on`)?.dataset.v ?? "";
}
function enableExports() {
  [btnPdf, btnMd, btnHtml, btnClip].forEach((b) => (b.disabled = false));
  btnClean.disabled = true;
}
function getSettings() {
  const idx = parseInt(mSlider.value, 10);
  return {
    pageSize: segVal("sg-size") || "A4",
    orientation: segVal("sg-orient") || "portrait",
    marginCm: MARGINS[idx].cm
  };
}

// ── Init: detect mode + check if already cleaned ────────────────────────────
let isScaler = false;
(async () => {
  try {
    const tab = await activeTab();
    const url = new URL(tab.url);
    isScaler = url.hostname.includes("scaler.com");

    if (isScaler) {
      modeChip.className = "mode scaler";
      modeIcon.textContent = "\u2713";
      modeText.textContent = "Scaler Mode";
      genOpts.style.display = "none";
    } else {
      genOpts.style.display = "";
    }

    // Check if page was already cleaned
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => window.__ES_CLEANED === true
    });
    if (r?.result) { enableExports(); setStatus("Page already cleaned \u2014 ready to export.", "ok"); }
  } catch (_) {}

  // Load theme
  const { theme } = await chrome.storage.local.get("theme");
  if (theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme:dark)").matches))
    document.documentElement.dataset.theme = "dark";
})();

// ── Segmented controls ──────────────────────────────────────────────────────
document.querySelectorAll(".seg-group").forEach((g) => {
  g.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      g.querySelectorAll(".seg").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
    });
  });
});

// ── Margin slider ───────────────────────────────────────────────────────────
function updateM() { mLabel.textContent = MARGINS[parseInt(mSlider.value, 10)].l; }
mSlider.addEventListener("input", updateM); updateM();

// ── Clean button ────────────────────────────────────────────────────────────
btnClean.addEventListener("click", async () => {
  btnClean.disabled = true;
  setStatus("Scanning and removing elements\u2026", "info");
  try {
    const tab = await activeTab();
    // Build clean options
    const cleanOpts = { removeHeader: false, removeFooter: false, customSelectors: [] };
    if (!isScaler) {
      cleanOpts.removeHeader = $("chk-header").checked;
      cleanOpts.removeFooter = $("chk-footer").checked;
    }
    // Load settings for presets + custom selectors
    const stored = await chrome.storage.local.get(["scalerPresets", "customSelectors"]);
    if (stored.scalerPresets) cleanOpts.scalerPresets = stored.scalerPresets;
    // Load per-site selectors
    const url = new URL(tab.url);
    const siteKey = url.hostname;
    if (stored.customSelectors && stored.customSelectors[siteKey]) {
      const site = stored.customSelectors[siteKey];
      if (site.enabled) cleanOpts.customSelectors = site.selectors || [];
    }

    // Inject options then cleaner
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (o) => { window.__ES_CLEAN_OPTS = o; }, args: [cleanOpts]
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, files: ["cleaner.js"]
    });
    const count = res?.result ?? 0;
    if (count === 0) {
      setStatus("No targeted elements found on this page.", "");
      btnClean.disabled = false;
    } else {
      setStatus(`Done \u2014 ${count} element${count === 1 ? "" : "s"} removed.`, "ok");
      enableExports();
      // Record to history if enabled
      chrome.runtime.sendMessage({ type: "recordHistory", url: tab.url, title: tab.title, format: "clean" });
    }
  } catch (e) {
    console.error(e);
    setStatus("Cannot access this page. Navigate to an http/https page.", "err");
    btnClean.disabled = false;
  }
});

// ── PDF Export ───────────────────────────────────────────────────────────────
btnPdf.addEventListener("click", async () => {
  btnPdf.disabled = true;
  setStatus("Preloading images \u2014 scrolling page\u2026", "info");
  try {
    const tab = await activeTab();
    const settings = getSettings();
    // Inject scroll opts
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (o) => { window.__ES_SCROLL_OPTS = o; },
      args: [{ expandHorizontal: true }]
    });
    // Preload images
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["preload-images.js"] });
    // Inject PDF settings
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => { window.__ES_PDF_SETTINGS = s; }, args: [settings]
    });
    // Run printer
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["printer.js"] });
    setTimeout(() => {
      setStatus("PDF tab opened. In print dialog, choose 'Save as PDF'.", "ok");
      btnPdf.disabled = false;
      chrome.runtime.sendMessage({ type: "recordHistory", url: tab.url, title: tab.title, format: "pdf" });
    }, 1000);
  } catch (e) {
    console.error(e); setStatus("PDF export failed. Check popup permissions.", "err"); btnPdf.disabled = false;
  }
});

// ── Markdown Export ──────────────────────────────────────────────────────────
btnMd.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const main = document.querySelector("article") || document.querySelector("[class*='article']")
          || document.querySelector("main") || document.body;
        function toMd(el) {
          let md = "";
          el.childNodes.forEach((n) => {
            if (n.nodeType === 3) { md += n.textContent; return; }
            if (n.nodeType !== 1) return;
            const tag = n.tagName.toLowerCase();
            if (["script","style","noscript"].includes(tag)) return;
            if (/^h[1-6]$/.test(tag)) { md += "\n" + "#".repeat(+tag[1]) + " " + n.textContent.trim() + "\n\n"; return; }
            if (tag === "p") { md += n.textContent.trim() + "\n\n"; return; }
            if (tag === "pre" || tag === "code") { md += "\n```\n" + n.textContent + "\n```\n\n"; return; }
            if (tag === "a") { md += "[" + n.textContent + "](" + n.href + ")"; return; }
            if (tag === "img") { md += "![" + (n.alt||"") + "](" + n.src + ")\n\n"; return; }
            if (tag === "li") { md += "- " + n.textContent.trim() + "\n"; return; }
            if (tag === "br") { md += "\n"; return; }
            if (tag === "strong" || tag === "b") { md += "**" + n.textContent + "**"; return; }
            if (tag === "em" || tag === "i") { md += "*" + n.textContent + "*"; return; }
            md += toMd(n);
          });
          return md;
        }
        return toMd(main).replace(/\n{3,}/g, "\n\n").trim();
      }
    });
    const md = r?.result || "";
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (tab.title || "page") + ".md"; a.click();
    URL.revokeObjectURL(url);
    setStatus("Markdown file downloaded.", "ok");
  } catch (e) { console.error(e); setStatus("Markdown export failed.", "err"); }
});

// ── HTML Export ──────────────────────────────────────────────────────────────
btnHtml.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => "<!DOCTYPE html>\n" + document.documentElement.outerHTML
    });
    const html = r?.result || "";
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (tab.title || "page") + ".html"; a.click();
    URL.revokeObjectURL(url);
    setStatus("HTML file downloaded.", "ok");
  } catch (e) { console.error(e); setStatus("HTML export failed.", "err"); }
});

// ── Copy Text ────────────────────────────────────────────────────────────────
btnClip.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const main = document.querySelector("article") || document.querySelector("[class*='article']")
          || document.querySelector("main") || document.body;
        return main.innerText;
      }
    });
    await navigator.clipboard.writeText(r?.result || "");
    setStatus("Text copied to clipboard.", "ok");
  } catch (e) { console.error(e); setStatus("Copy failed.", "err"); }
});

// ── Footer links ─────────────────────────────────────────────────────────────
$("link-settings").addEventListener("click", (e) => {
  e.preventDefault(); chrome.runtime.openOptionsPage();
});
$("link-batches").addEventListener("click", (e) => {
  e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL("options.html#/batches") });
});
$("link-history").addEventListener("click", (e) => {
  e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL("options.html#/history") });
});
