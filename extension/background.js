/**
 * background.js — Manifest V3 service worker
 *
 * Side-panel-opening notes:
 *  • chrome.sidePanel.open() requires a user-gesture context.
 *  • Gesture context propagates from content-script messages into
 *    chrome.runtime.onMessage handlers IF open() is called inside the
 *    synchronous portion of the handler (no awaits before it).
 *  • chrome.sidePanel.setOptions({tabId, enabled}) is PERSISTED across
 *    extension reloads. A previous build that mistakenly set enabled:false
 *    for a tab will keep that state until we explicitly re-enable it.
 *  • onInstalled clears stale per-tab options to recover from past bugs.
 */

'use strict'

const DEFAULT_BACKEND = 'https://agentic-card-seller-os.vercel.app'

// ── Side panel default behaviour ─────────────────────────────────
// IMPORTANT: openPanelOnActionClick is false.
// The toolbar icon must NOT open the panel directly — if it did, users
// could open the panel on any tab and bypass our per-tab gating.
// The panel only opens via chrome.sidePanel.open() from our message
// handler when the "Select & Analyze" button is clicked on an eBay tab.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {})

// ── Per-tab panel restriction ────────────────────────────────────
//
// Side panels in Chrome are window-level by default — once opened in
// any tab, they show across every tab in that window. To make the
// panel tab-scoped, we use setOptions({ tabId, enabled }) so Chrome
// shows it only for tabs we've enabled.
//
// Rules learned from earlier bugs:
//  • `path: 'sidepanel.html'` MUST be included alongside enabled:true
//    or Chrome throws "No active side panel for tabId".
//  • Use changeInfo.url in onUpdated — it's always the real new URL
//    when defined. tab.url can be transiently undefined for the eBay
//    tab itself, which would false-disable it.
//  • For non-eBay URLs, changeInfo.url is undefined (we lack host
//    permission). onActivated picks up those tabs instead.

function isEbayListing(url) {
  return typeof url === 'string' && url.includes('ebay.com/itm/')
}

function syncPanelForTab(tabId, url) {
  if (isEbayListing(url)) {
    chrome.sidePanel
      .setOptions({ tabId, enabled: true, path: 'sidepanel.html' })
      .catch(() => {})
  } else {
    // url is either undefined (non-eBay we can't read — host_permissions
    // would surface it otherwise) or a known non-listing URL.
    //
    // Two-pronged disable: enabled:false stops the toolbar icon from
    // opening the panel; path:'blank.html' ensures that if Chrome
    // chooses to keep the panel slot visible across the tab switch
    // (a quirk in some Chrome versions when a panel was already open
    // in the window) the user sees an empty dark area instead of the
    // sidepanel.html "Not on an eBay listing" message.
    chrome.sidePanel
      .setOptions({ tabId, enabled: false, path: 'blank.html' })
      .catch(() => {})
  }
}

// On install/update: sync every existing tab so stale state from
// previous builds (any persisted enabled:false / path-less options)
// is corrected based on the tab's current URL.
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[CGA] onInstalled — syncing per-tab panel state')
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (tab.id != null) syncPanelForTab(tab.id, tab.url ?? '')
    }
    console.log(`[CGA] synced ${tabs.length} tabs`)
  } catch (e) {
    console.warn('[CGA] tabs.query failed:', e)
  }
})

// User switches tabs — enable for eBay, disable otherwise
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url ?? ''
    syncPanelForTab(tabId, url)
    broadcast({ type: 'TAB_CHANGED', payload: { url } })
  } catch {}
})

// Tab navigates — only fires for URLs we have permission to read
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return
  syncPanelForTab(tabId, changeInfo.url)
  broadcast({ type: 'TAB_CHANGED', payload: { url: changeInfo.url } })
})

// ── Message router ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CRITICAL: sidePanel.open() MUST be invoked synchronously in this
  // handler — NOT inside a .then() callback. A .then() runs in a
  // microtask after the handler returns, and Chrome strips the
  // user-gesture token at that point ("may only be called in response
  // to a user gesture" error).
  //
  // Pattern: fire setOptions and open both synchronously, side by side.
  // Chrome processes extension IPCs in order, so setOptions(enabled:true)
  // is applied before open() is evaluated on the browser side.
  if (msg.type === 'CARD_IMAGES_READY' && sender.tab?.id != null) {
    const tabId = sender.tab.id
    console.log('[CGA] CARD_IMAGES_READY tab', tabId)

    // Both calls fired synchronously, side by side — no chaining.
    // `path` is required: Chrome throws "No active side panel for tabId"
    // if the tab has setOptions state without an explicit path.
    chrome.sidePanel
      .setOptions({ tabId, enabled: true, path: 'sidepanel.html' })
      .catch(() => {})
    const openPromise = chrome.sidePanel.open({ tabId })

    openPromise
      .then(() => {
        console.log('[CGA] side panel opened')
        sendResponse({ ok: true })
      })
      .catch((e) => {
        console.error('[CGA] open failed:', e)
        sendResponse({ ok: false, error: String(e) })
      })

    // Push the listing payload to the panel after the DOM mounts
    setTimeout(() => {
      broadcast({ type: 'IMAGES_LOADED', payload: msg.payload })
    }, 400)

    return true // async sendResponse
  }

  if (msg.type === 'ANALYZE_SELECTED') {
    handleAnalyze(msg.payload)
    sendResponse({ ok: true })
    return
  }

  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['backendUrl'], (data) => {
      sendResponse({ backendUrl: data.backendUrl ?? DEFAULT_BACKEND })
    })
    return true
  }

  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ backendUrl: msg.payload.backendUrl })
    sendResponse({ ok: true })
    return
  }
})

// ── Grading flow ─────────────────────────────────────────────────
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
