"use strict";

// ── DOM refs ───────────────────────────────────────────────────────────────
const statusEl     = document.getElementById("status");
const statusText   = document.getElementById("status-text");
const btnClean     = document.getElementById("btn-clean");
const btnPdf       = document.getElementById("btn-pdf");
const marginSlider = document.getElementById("margin-slider");
const marginLabel  = document.getElementById("margin-label");

// ── Margin presets ─────────────────────────────────────────────────────────
const MARGINS = [
  { label: "None",        cm: 0.15 },
  { label: "Compact",     cm: 0.5  },
  { label: "Comfortable", cm: 1.0  },
  { label: "Standard",    cm: 1.5  },
  { label: "Wide",        cm: 2.2  },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function setStatus(msg, type = "") {
  statusText.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Enable PDF button and lock Clean button when the page is known-clean
function enterCleanedState() {
  btnPdf.disabled   = false;
  btnClean.disabled = true;
}

// ── On popup open: check whether this page was already cleaned ─────────────
// cleaner.js stamps window.__PC_CLEANED = true directly on the page so the
// flag survives the popup closing and reopening. We read it here immediately.
(async () => {
  try {
    const tab = await activeTab();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => window.__PC_CLEANED === true,
    });
    if (result?.result === true) {
      enterCleanedState();
      setStatus("This page is already clean — ready to export as PDF.", "success");
    }
  } catch (_) {
    // Not an accessible page (e.g. edge:// URL) — stay in default idle state
  }
})();

// ── Segmented controls ─────────────────────────────────────────────────────
function initSegGroup(groupId) {
  const group = document.getElementById(groupId);
  group.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      group.querySelectorAll(".seg").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
}
initSegGroup("size-group");
initSegGroup("orient-group");

function segValue(groupId) {
  return document.querySelector(`#${groupId} .seg.active`)?.dataset.val ?? "";
}

// ── Margin slider ──────────────────────────────────────────────────────────
function updateMarginLabel() {
  marginLabel.textContent = MARGINS[parseInt(marginSlider.value, 10)].label;
}
marginSlider.addEventListener("input", updateMarginLabel);
updateMarginLabel();

// ── Read current settings from UI ─────────────────────────────────────────
function getSettings() {
  return {
    pageSize:    segValue("size-group")   || "A4",
    orientation: segValue("orient-group") || "portrait",
    marginCm:    MARGINS[parseInt(marginSlider.value, 10)].cm,
  };
}

// ── Clean button ───────────────────────────────────────────────────────────
btnClean.addEventListener("click", async () => {
  btnClean.disabled = true;
  setStatus("Scanning and removing elements...", "info");

  try {
    const tab = await activeTab();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["cleaner.js"],
    });

    const count = result?.result ?? 0;

    if (count === 0) {
      setStatus(
        "No targeted elements found. Page may already be clean, " +
        "or this is not a Scaler article page.",
        ""
      );
      btnClean.disabled = false;
    } else {
      setStatus(`Done — ${count} element${count === 1 ? "" : "s"} removed.`, "success");
      enterCleanedState();
    }
  } catch (err) {
    console.error(err);
    setStatus(
      "Cannot access this page. Navigate to a regular http/https article first.",
      "error"
    );
    btnClean.disabled = false;
  }
});

// ── Export PDF button ──────────────────────────────────────────────────────
btnPdf.addEventListener("click", async () => {
  btnPdf.disabled = true;
  setStatus("Scrolling page to load all images — this takes a few seconds...", "info");

  try {
    const tab      = await activeTab();
    const settings = getSettings();

    // Inject settings into the page's window scope first
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   (s) => { window.__PC_SETTINGS = s; },
      args:   [settings],
    });

    // Then inject printer.js which reads window.__PC_SETTINGS
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["printer.js"],
    });

    setTimeout(() => {
      setStatus(
        "PDF tab opened. In Edge's print dialog set Destination to 'Save as PDF'.",
        "success"
      );
      btnPdf.disabled = false;
    }, 1000);
  } catch (err) {
    console.error(err);
    setStatus("Could not start the PDF export. Check popup permissions.", "error");
    btnPdf.disabled = false;
  }
});
