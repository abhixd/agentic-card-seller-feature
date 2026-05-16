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

// ── Side panel behaviour ─────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {})

// ── Restrict panel to eBay listing tabs ──────────────────────────
//
// Rules:
//  • Only disable when we KNOW the URL is non-eBay (url is a non-empty
//    string that doesn't match). If url is unavailable, leave state alone.
//  • Use changeInfo.url in onUpdated (always the real new URL).
//  • Use chrome.tabs.get in onActivated for the just-activated tab.
//  • handleImagesReady never touches setOptions — calling open() directly
//    is sufficient; there is no race because content.js only runs on
//    ebay.com/itm/* pages so the tab is always a valid listing.

function isEbayListing(url) {
  return typeof url === 'string' && url.includes('ebay.com/itm/')
}

async function syncPanelForTab(tabId, url) {
  if (!url) return                          // unknown URL — don't touch state
  try {
    await chrome.sidePanel.setOptions({ tabId, enabled: isEbayListing(url) })
  } catch {}
}

// User switches tabs
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => ({}))
  syncPanelForTab(tabId, tab.url)           // tab.url readable via host_permissions
})

// Tab navigates — use changeInfo.url (never undefined when key is present)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    syncPanelForTab(tabId, changeInfo.url)
  }
})

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
  // Do NOT call setOptions here — syncPanelForTab already enabled this tab
  // when onUpdated fired for the ebay.com/itm/* URL. Touching setOptions
  // here would create a race window where another onUpdated call could
  // re-disable the tab before open() completes.
  try { await chrome.sidePanel.open({ tabId }) } catch (e) {
    console.warn('[CGA] sidePanel.open failed:', e)
  }
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
