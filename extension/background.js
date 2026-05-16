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
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {})

// ── One-time stale-state cleanup ─────────────────────────────────
// Wipe any persisted setOptions(enabled:false) or path-less state from
// previous buggy builds. The `path` is REQUIRED — without it, Chrome
// throws "No active side panel for tabId" even when enabled is true.
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[CGA] onInstalled — resetting side-panel options')
  // Reset the default (all tabs without specific overrides)
  chrome.sidePanel
    .setOptions({ enabled: true, path: 'sidepanel.html' })
    .catch(() => {})
  // Reset every known tab individually (override persisted per-tab state)
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.sidePanel
          .setOptions({ tabId: tab.id, enabled: true, path: 'sidepanel.html' })
          .catch(() => {})
      }
    }
    console.log(`[CGA] reset ${tabs.length} tabs`)
  } catch (e) {
    console.warn('[CGA] tabs.query failed:', e)
  }
})

// ── Tab-change notifications for UI context only ─────────────────
// (No setOptions here — we never disable per-tab. The panel UI shows
// "Not on an eBay listing" instead of being hidden.)
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => ({}))
  broadcast({ type: 'TAB_CHANGED', payload: { url: tab.url ?? '' } })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    broadcast({ type: 'TAB_CHANGED', payload: { url: changeInfo.url } })
  }
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
