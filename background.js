"use strict";
importScripts("lib/jszip.min.js");

// ── Default settings ────────────────────────────────────────────────────────
const DEFAULTS = {
  theme: "light",
  autoClean: false,
  scrollBehavior: true,
  historyEnabled: false,
  filenameTemplate: "{title} - {date}",
  headerFooterStamp: true,
  pdfDefaults: { pageSize: "A4", orientation: "portrait", marginCm: 0.5 },
  scalerPresets: {},
  customSelectors: {}
};

async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

// ── Context menus ───────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "es-clean", title: "Clean this page", contexts: ["page"] });
  chrome.contextMenus.create({ id: "es-add-batch", title: "Add to batch\u2026", contexts: ["page"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "es-clean") {
    await injectClean(tab.id, tab.url);
  } else if (info.menuItemId === "es-add-batch") {
    // Store the URL; the options page batch UI will pick it up
    const pending = (await chrome.storage.session.get("pendingBatchUrl")).pendingBatchUrl || [];
    pending.push({ url: tab.url, title: tab.title });
    await chrome.storage.session.set({ pendingBatchUrl: pending });
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#/batches") });
  }
});

// ── Keyboard shortcuts ──────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (cmd === "clean-page") await injectClean(tab.id, tab.url);
  if (cmd === "export-pdf") {
    await injectClean(tab.id, tab.url);
    const s = await getSettings();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (o) => { window.__ES_SCROLL_OPTS = o; }, args: [{ expandHorizontal: s.scrollBehavior }]
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["preload-images.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (o) => { window.__ES_PDF_SETTINGS = o; }, args: [s.pdfDefaults]
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["printer.js"] });
  }
});

// ── Auto-clean on Scaler pages ──────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  const s = await getSettings();
  if (!s.autoClean) return;
  try {
    const url = new URL(tab.url);
    if (url.hostname.includes("scaler.com")) {
      await injectClean(tabId, tab.url);
    }
  } catch (_) {}
});

// ── Inject cleaner with correct options ─────────────────────────────────────
async function injectClean(tabId, tabUrl) {
  const s = await getSettings();
  const isScaler = tabUrl && tabUrl.includes("scaler.com");
  const cleanOpts = {
    scalerPresets: s.scalerPresets,
    removeHeader: false, removeFooter: false, customSelectors: []
  };
  // Load per-site selectors
  try {
    const host = new URL(tabUrl).hostname;
    if (s.customSelectors[host]?.enabled) {
      cleanOpts.customSelectors = s.customSelectors[host].selectors || [];
    }
  } catch (_) {}

  await chrome.scripting.executeScript({
    target: { tabId }, func: (o) => { window.__ES_CLEAN_OPTS = o; }, args: [cleanOpts]
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["cleaner.js"] });
}

// ── History recording ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "recordHistory") {
    (async () => {
      const s = await getSettings();
      if (!s.historyEnabled) return;
      const { history } = await chrome.storage.local.get("history");
      const list = history || [];
      list.unshift({
        id: "h_" + Date.now(),
        url: msg.url, title: msg.title, format: msg.format,
        timestamp: Date.now()
      });
      // Cap at 500 entries
      if (list.length > 500) list.length = 500;
      await chrome.storage.local.set({ history: list });
    })();
  }

  // ── Batch processing ────────────────────────────────────────────────────
  if (msg.type === "startBatch") {
    processBatch(msg.batchId).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === "retryFailed") {
    retryFailed(msg.batchId).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── Page sizes in inches (for chrome.debugger Page.printToPDF) ──────────────
const SIZES = {
  A4:     { w: 8.27, h: 11.69 },
  A3:     { w: 11.69, h: 16.54 },
  B5:     { w: 6.93, h: 9.84 },
  Letter: { w: 8.5, h: 11 }
};

function getFilename(template, item) {
  const d = new Date();
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5).replace(":", "");
  let domain = "";
  try { domain = new URL(item.url).hostname; } catch (_) {}
  let title = (item.title || "page").replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);
  return (template || "{title} - {date}")
    .replace("{title}", title).replace("{date}", date)
    .replace("{time}", time).replace("{domain}", domain) + ".pdf";
}

// ── Batch processor ─────────────────────────────────────────────────────────
async function processBatch(batchId) {
  const { batches } = await chrome.storage.session.get("batches");
  if (!batches?.[batchId]) throw new Error("Batch not found");
  const batch = batches[batchId];
  batch.status = "processing";
  await saveBatches(batches);

  const s = await getSettings();
  const pdfs = [];

  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    if (item.status === "done") continue; // skip already-done
    item.status = "processing";
    await saveBatches(batches);
    notifyBatchUpdate(batchId);

    let tab;
    try {
      tab = await chrome.tabs.create({ url: item.url, active: false });
      await waitForTab(tab.id);
      await new Promise((r) => setTimeout(r, 1500));

      // Clean
      await injectClean(tab.id, item.url);
      await new Promise((r) => setTimeout(r, 500));

      // Preload images
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (o) => { window.__ES_SCROLL_OPTS = o; }, args: [{ expandHorizontal: s.scrollBehavior }]
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["preload-images.js"] });
      await new Promise((r) => setTimeout(r, 2000));

      // Get title
      const [titleRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: () => document.title
      });
      item.title = titleRes?.result || item.title || "page";

      // PDF via debugger
      const itemSettings = item.overrides || batch.settings || s.pdfDefaults;
      const sz = SIZES[itemSettings.pageSize] || SIZES.A4;
      const isLand = itemSettings.orientation === "landscape";

      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.printToPDF", {
        landscape: isLand,
        paperWidth: isLand ? sz.h : sz.w,
        paperHeight: isLand ? sz.w : sz.h,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        printBackground: true,
        preferCSSPageSize: false,
        scale: 1
      });
      await chrome.debugger.detach({ tabId: tab.id });

      pdfs.push({ filename: getFilename(s.filenameTemplate, item), data: result.data });
      item.status = "done";
    } catch (e) {
      item.status = "failed"; item.error = e.message;
      try { if (tab) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {}); } catch (_) {}
    }

    try { if (tab) await chrome.tabs.remove(tab.id); } catch (_) {}
    await saveBatches(batches);
    notifyBatchUpdate(batchId);
  }

  // Zip and download
  if (pdfs.length > 0) {
    const zip = new JSZip();
    pdfs.forEach((p) => zip.file(p.filename, p.data, { base64: true }));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url, filename: (batch.name || "batch") + ".zip", saveAs: true
    });
    URL.revokeObjectURL(url);
  }

  batch.status = "done";
  await saveBatches(batches);
  notifyBatchUpdate(batchId);

  // Record to history
  if (s.historyEnabled) {
    const { history } = await chrome.storage.local.get("history");
    const list = history || [];
    batch.items.forEach((it) => {
      list.unshift({
        id: "h_" + Date.now() + Math.random(), url: it.url,
        title: it.title, format: "batch-pdf", timestamp: Date.now(), batchName: batch.name
      });
    });
    if (list.length > 500) list.length = 500;
    await chrome.storage.local.set({ history: list });
  }
}

async function retryFailed(batchId) {
  const { batches } = await chrome.storage.session.get("batches");
  if (!batches?.[batchId]) return;
  batches[batchId].items.forEach((it) => {
    if (it.status === "failed") { it.status = "queued"; it.error = null; }
  });
  batches[batchId].status = "idle";
  await saveBatches(batches);
  await processBatch(batchId);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function saveBatches(batches) {
  await chrome.storage.session.set({ batches });
}

function notifyBatchUpdate(batchId) {
  chrome.runtime.sendMessage({ type: "batchUpdate", batchId }).catch(() => {});
}

function waitForTab(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
  });
}
