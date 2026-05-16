/**
 * background.js — Manifest V3 service worker
 *
 * Responsibilities:
 *  - Open side panel when user clicks the extension action icon
 *  - Receive ANALYZE_CARD messages from content script
 *  - POST to /api/grade/analyze on the configured backend
 *  - Broadcast ANALYSIS_RESULT / ANALYSIS_ERROR to the side panel
 */

'use strict'

const DEFAULT_BACKEND = 'https://agentic-card-seller-os.vercel.app'

// ── Side panel: restrict to eBay listing pages ──────────────────
//
// Chrome side panels are window-level by default — once opened they
// persist across every tab. We use per-tab setOptions({ enabled })
// so the panel is only available (and visible) on ebay.com/itm/* pages.
//
// host_permissions already cover ebay.com, so tab.url is readable
// for eBay tabs without needing the broad "tabs" permission.
// For non-eBay tabs tab.url is undefined → isEbayListing() → false.

function isEbayListing(url) {
  return typeof url === 'string' && url.startsWith('https://www.ebay.com/itm/')
}

async function syncPanelForTab(tabId, url) {
  try {
    await chrome.sidePanel.setOptions({ tabId, enabled: isEbayListing(url) })
  } catch {}
}

// User switches tabs — enable/disable panel for the newly active tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => ({}))
  syncPanelForTab(tabId, tab.url)
})

// Tab navigates — react the moment the URL changes (before page load)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined) {
    syncPanelForTab(tabId, tab.url)
  }
})

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {})

// ── Message router ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script sends all extracted images → open panel, show picker
  if (msg.type === 'CARD_IMAGES_READY') {
    handleImagesReady(msg.payload, sender.tab?.id)
    sendResponse({ ok: true })
  }
  // Side panel sends user-selected images → run grading
  if (msg.type === 'ANALYZE_SELECTED') {
    handleAnalyze(msg.payload)
    sendResponse({ ok: true })
  }
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['backendUrl'], (data) => {
      sendResponse({ backendUrl: data.backendUrl ?? DEFAULT_BACKEND })
    })
    return true // async
  }
  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ backendUrl: msg.payload.backendUrl })
    sendResponse({ ok: true })
  }
})

// ── Step 1: Images extracted — open panel and show picker ────────
async function handleImagesReady(listing, tabId) {
  // Explicitly enable the panel for this tab before opening.
  // This guards against any earlier setOptions({ enabled: false }) call
  // (e.g. from onActivated firing before tab.url was readable after a
  // service-worker restart). Content.js is only injected on eBay listing
  // pages, so enabling here is always correct.
  try { await chrome.sidePanel.setOptions({ tabId, enabled: true }) } catch {}
  try { await chrome.sidePanel.open({ tabId }) } catch {}
  // Give the panel DOM time to mount before we broadcast
  await sleep(350)
  broadcast({ type: 'IMAGES_LOADED', payload: listing })
}

// ── Step 2: User selected images — run grading ───────────────────
async function handleAnalyze(listing) {
  broadcast({ type: 'ANALYSIS_START', payload: { title: listing.title } })

  const { backendUrl = DEFAULT_BACKEND } = await chrome.storage.local.get('backendUrl')
  const endpoint = `${backendUrl.replace(/\/$/, '')}/api/grade/analyze`

  try {
    broadcast({ type: 'ANALYSIS_PROGRESS', payload: { step: 'Running CV detectors…' } })

    const resp = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(listing),
    })

    if (!resp.ok) {
      const txt = await resp.text()
      throw new Error(`Server error ${resp.status}: ${txt.slice(0, 200)}`)
    }

    const result = await resp.json()
    broadcast({ type: 'ANALYSIS_PROGRESS', payload: { step: 'Computing ROI…' } })
    await sleep(200)
    broadcast({ type: 'ANALYSIS_RESULT', payload: result })

  } catch (err) {
    broadcast({
      type: 'ANALYSIS_ERROR',
      payload: {
        message: err.message ?? 'Unknown error',
        hint:    endpoint.includes('localhost')
          ? 'Make sure the grading backend is running locally.'
          : null,
      },
    })
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {})
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
