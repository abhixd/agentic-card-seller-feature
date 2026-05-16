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
// Wipe any persisted setOptions(enabled:false) from previous buggy builds.
// Runs on install/update; best-effort, no permissions beyond what we have.
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[CGA] onInstalled — resetting side-panel options')
  // Reset the default (all tabs without specific overrides)
  chrome.sidePanel.setOptions({ enabled: true }).catch(() => {})
  // Reset every known tab individually (override persisted per-tab state)
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true }).catch(() => {})
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
  // CRITICAL PATH: sidePanel.open MUST be in the synchronous portion of
  // the message handler so the user-gesture token from the content-script
  // click survives the IPC hop.
  if (msg.type === 'CARD_IMAGES_READY' && sender.tab?.id != null) {
    const tabId = sender.tab.id
    console.log('[CGA] CARD_IMAGES_READY tab', tabId)

    // Fire setOptions → open in a .then() chain. The chain runs in
    // microtasks (not macrotasks), preserving user-gesture context.
    chrome.sidePanel
      .setOptions({ tabId, enabled: true })
      .then(() => chrome.sidePanel.open({ tabId }))
      .then(() => {
        console.log('[CGA] side panel opened')
        sendResponse({ ok: true })
      })
      .catch((e) => {
        console.error('[CGA] open failed:', e)
        sendResponse({ ok: false, error: String(e) })
      })

    // Send the payload to the panel after a short delay (lets DOM mount)
    setTimeout(() => {
      broadcast({ type: 'IMAGES_LOADED', payload: msg.payload })
    }, 400)

    return true // tells Chrome we'll call sendResponse asynchronously
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
