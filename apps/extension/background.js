/**
 * background.js — Card Seller OS Chrome Extension service worker
 *
 * Responsibilities:
 *  - Open side panel when toolbar icon is clicked
 *  - Auto-open side panel when navigating to an eBay listing
 *  - Relay listing data between content.js and sidepanel.js
 *  - Forward grade requests to the Next.js API or Python backend
 */

const NEXTJS_BASE_DEFAULT = "http://localhost:3000";
// Grading backend (Railway). Override per-install via chrome.storage `pythonBase`
// (e.g. set to http://127.0.0.1:8000 for local development).
const PYTHON_BASE_DEFAULT = "https://card-grader-api-production.up.railway.app";

// ── Side panel setup ───────────────────────────────────────────────────────
// Clicking the toolbar icon opens the side panel. Asserted at the top level so
// it re-applies on EVERY service-worker activation (not just install/update) —
// this fixes the panel failing to open after an extension reload or SW restart.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("[sidePanel] setPanelBehavior failed:", e));

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// When the toolbar icon is clicked, request listing data from the active tab
// (sidePanel.setPanelBehavior already handles opening; this seeds the listing)
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  // Ask the content script (if present) for latest listing data
  try {
    const { listing } = await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_LISTING" });
    if (listing) {
      await chrome.storage.local.set({ pendingListing: listing });
    }
  } catch {
    // Not an eBay page or content script not injected — that's fine
  }
});

// Track eBay navigation so pendingListing stays fresh even if panel is closed
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  const isListing = /^https?:\/\/(www\.)?ebay\.com\/itm\//.test(tab.url);
  if (!isListing) return;

  // Small delay — give the content script time to extract the listing
  setTimeout(async () => {
    try {
      const { listing } = await chrome.tabs.sendMessage(tabId, { type: "REQUEST_LISTING" });
      if (listing) {
        await chrome.storage.local.set({ pendingListing: listing });
        // If panel is open, push the update
        chrome.runtime.sendMessage({ type: "LISTING_READY", listing }).catch(() => {});
      }
    } catch { /* not injected yet */ }
  }, 1500);
});

// ── Message bus ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Content script → background: new eBay listing detected
    case "LISTING_DETECTED":
      chrome.storage.local.set({ pendingListing: msg.listing });
      // Notify any open side panel (best-effort — panel may not be open yet)
      chrome.runtime.sendMessage({ type: "LISTING_READY", listing: msg.listing }).catch(() => {});
      sendResponse({ ok: true });
      break;

    // Side panel → background: return cached listing from storage
    case "GET_CURRENT_LISTING":
      chrome.storage.local.get("pendingListing", (data) => {
        sendResponse({ listing: data.pendingListing || null });
      });
      return true;

    // Side panel → background: run full grade analysis
    case "ANALYZE_LISTING":
      analyzeListing(msg.listing, msg.options)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;

    // Content script (in-page "Grade card" button) → open the side panel.
    // Called within the button's click gesture so chrome.sidePanel.open is allowed.
    case "OPEN_PANEL":
      if (sender.tab?.id) {
        chrome.sidePanel.open({ tabId: sender.tab.id })
          .catch((e) => console.warn("[sidePanel] open failed:", e.message));
      }
      return false;

    // Side panel → background: inject content.js into a tab on demand (used when
    // the script wasn't auto-injected because the tab predated an extension reload)
    case "INJECT_CONTENT":
      injectContent(msg.tabId)
        .then(()    => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    // Side panel → background: persist a boundary correction for YOLO retraining
    case "SAVE_ADJUSTMENT":
      saveAdjustment(msg.record)
        .then((res)  => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    // Side panel → background: run YOLO+Claude detailed grading (Python backend)
    case "GRADE_IMAGE":
      gradeImage({ url: msg.imageUrl, b64: msg.imageData }, null, null)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err)   => sendResponse({ ok: false, error: err.message }));
      return true;

    // Health checks
    case "HEALTH_CHECK_NEXTJS":
      checkHealth(NEXTJS_BASE_DEFAULT + "/api/health")
        .then((ok) => sendResponse({ ok }));
      return true;

    case "HEALTH_CHECK_PYTHON":
      checkHealth(PYTHON_BASE_DEFAULT + "/health")
        .then((ok) => sendResponse({ ok }));
      return true;

    case "GET_CONFIG":
      chrome.storage.local.get(["apiBase", "pythonBase"], (cfg) => {
        sendResponse({
          apiBase:    cfg.apiBase    || NEXTJS_BASE_DEFAULT,
          pythonBase: cfg.pythonBase || PYTHON_BASE_DEFAULT,
        });
      });
      return true;
  }
});

// ── API calls ──────────────────────────────────────────────────────────────
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiBase", "pythonBase"], (cfg) => {
      resolve({
        apiBase:    cfg.apiBase    || NEXTJS_BASE_DEFAULT,
        pythonBase: cfg.pythonBase || PYTHON_BASE_DEFAULT,
      });
    });
  });
}

// Fetch an image as base64 from the page context (eBay CDN is reliably reachable
// there; the service worker sometimes isn't). Returns null on failure.
async function fetchImageB64ViaTab(url) {
  if (!url) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const resp = await chrome.tabs
      .sendMessage(tab.id, { type: "FETCH_IMAGE_DATA", url })
      .catch(() => null);
    return resp?.data ?? null;
  } catch {
    return null;
  }
}

async function analyzeListing(listing, _options = {}) {
  // Primary grading path = the notebook pipeline (YOLO OBB detect -> perspective
  // warp -> palette centering -> Claude Sonnet multicrop) on the Python server.
  // The user-chosen Front (and optional Back) are graded.
  const frontUrl = listing.front_url || listing.image_urls?.[0];
  if (!frontUrl) throw new Error("Listing has no images to grade");
  const backUrl = listing.back_url || null;

  const frontB64 = await fetchImageB64ViaTab(frontUrl);
  const backB64  = backUrl ? await fetchImageB64ViaTab(backUrl) : null;

  return gradeImage(
    { url: frontB64 ? null : frontUrl, b64: frontB64 },
    backUrl ? { url: backB64 ? null : backUrl, b64: backB64 } : null,
    { title: listing.title ?? "", price: listing.price ?? 0, shipping: listing.shipping ?? 0 },
  );
}

async function imgToBlob(img) {
  if (img?.b64) return base64ToBlob(img.b64);
  const r = await fetch(img.url);
  return r.blob();
}

// front/back: { url?, b64? } (back may be null). meta drives eBay comps + ROI.
async function gradeImage(front, back, meta = null) {
  const { pythonBase } = await getConfig();

  const form = new FormData();
  form.append("image", await imgToBlob(front), "front.jpg");
  if (back && (back.url || back.b64)) {
    form.append("image_back", await imgToBlob(back), "back.jpg");
  }
  if (meta) {
    form.append("title",    String(meta.title ?? ""));
    form.append("price",    String(meta.price ?? 0));
    form.append("shipping", String(meta.shipping ?? 0));
  }

  // stability=1: the grader also grades a perturbed copy (concurrently) and MIN-combines the test–retest
  // stability into centering.confidence — same as the web app, so both surfaces report identical confidence.
  const res  = await fetch(`${pythonBase}/grade?stability=1`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || `Server error ${res.status}`);
  return data;
}

async function fetchImagesAsBase64(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const r   = await fetch(url, { mode: "cors" });
      const buf = await r.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      results.push(b64);
    } catch {
      results.push(null);
    }
  }
  return results;
}

function base64ToBlob(b64) {
  const bytes = atob(b64);
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: "image/jpeg" });
}

async function injectContent(tabId) {
  if (!tabId) throw new Error("No tabId");
  // content.js guards against double-init, so re-injection is safe.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return true;
}

async function saveAdjustment(record) {
  const { pythonBase } = await getConfig();
  const res = await fetch(`${pythonBase}/feedback`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(record),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Feedback API ${res.status}`);
  return data;
}

async function checkHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
