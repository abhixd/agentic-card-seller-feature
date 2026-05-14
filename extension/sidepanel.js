/**
 * sidepanel.js — Side panel UI logic
 *
 * States: idle → loading → result | error
 * Listens for messages from background.js:
 *   ANALYSIS_START    → show loading
 *   ANALYSIS_PROGRESS → update step text
 *   ANALYSIS_RESULT   → render results
 *   ANALYSIS_ERROR    → show error
 */

'use strict'

// ── State ──────────────────────────────────────────────────────────
const STATES = ['idle', 'loading', 'result', 'error']

function showState(name) {
  STATES.forEach(s => {
    const el = document.getElementById(`state-${s}`)
    if (el) el.classList.toggle('hidden', s !== name)
  })
}

// ── Settings ───────────────────────────────────────────────────────
const settingsPanel  = document.getElementById('settings-panel')
const settingsBtn    = document.getElementById('settings-btn')
const saveSettingsBtn   = document.getElementById('save-settings-btn')
const cancelSettingsBtn = document.getElementById('cancel-settings-btn')
const backendUrlInput   = document.getElementById('backend-url-input')
const settingsMsg       = document.getElementById('settings-msg')

function openSettings() {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
    backendUrlInput.value = resp?.backendUrl ?? 'http://localhost:3000'
  })
  settingsPanel.classList.remove('hidden')
}

function closeSettings() {
  settingsPanel.classList.add('hidden')
  settingsMsg.textContent = ''
}

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.contains('hidden') ? openSettings() : closeSettings()
})

cancelSettingsBtn.addEventListener('click', closeSettings)

saveSettingsBtn.addEventListener('click', () => {
  const url = backendUrlInput.value.trim()
  if (!url) return
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: { backendUrl: url } }, () => {
    settingsMsg.textContent = 'Saved!'
    setTimeout(() => { settingsMsg.textContent = ''; closeSettings() }, 1200)
  })
})

// ── Helpers ────────────────────────────────────────────────────────

function fmt(n) {
  if (n === null || n === undefined) return '—'
  return '$' + Number(n).toFixed(0)
}

function pct(n) {
  return (n * 100).toFixed(0) + '%'
}

const BUCKET_LABELS = {
  poor:      'Poor (1–3)',
  vg:        'VG (4–5)',
  excellent: 'Excellent (6)',
  nm:        'NM (7–8)',
  mint:      'Mint (9–10)',
}

const DECISION_META = {
  buy:   { emoji: '✅', css: 'buy' },
  maybe: { emoji: '🤔', css: 'maybe' },
  skip:  { emoji: '❌', css: 'skip' },
}

// ── Render results ─────────────────────────────────────────────────

function renderResult(payload) {
  const {
    card_identity   = {},
    grade_estimate  = {},
    issues          = [],
    economics       = {},
    decision        = {},
    _meta           = {},
  } = payload

  // Card identity
  document.getElementById('res-title').textContent =
    card_identity.name || payload.title || 'Unknown card'
  document.getElementById('res-set').textContent  = card_identity.set  || ''
  document.getElementById('res-year').textContent = card_identity.year || ''
  const numStr = card_identity.number ? `#${card_identity.number}` : ''
  document.getElementById('res-num').textContent = numStr

  // Decision banner
  const dec    = decision.label ?? 'skip'
  const meta   = DECISION_META[dec] ?? DECISION_META.skip
  const banner = document.getElementById('decision-banner')
  banner.className = `decision-banner ${meta.css}`
  document.getElementById('dec-emoji').textContent  = meta.emoji
  document.getElementById('dec-label').textContent  = dec.toUpperCase()
  document.getElementById('dec-reason').textContent = decision.reason ?? ''

  // Grade estimate
  const dist       = grade_estimate.distribution ?? {}
  const gradeRange = grade_estimate.grade_range   ?? '?'
  const confidence = grade_estimate.confidence    ?? 'unknown'

  document.getElementById('res-grade-range').textContent = gradeRange
  document.getElementById('res-grade-conf').textContent  = `(${confidence} confidence)`

  // Probability bars — support both numeric PSA keys ("1"–"10") and legacy bucket names
  const barsContainer = document.getElementById('grade-bars')
  barsContainer.innerHTML = ''

  const isNumeric = Object.keys(dist).some(k => !isNaN(Number(k)))

  if (isNumeric) {
    // Claude Vision: show PSA 10 → 1 (highest first)
    for (let g = 10; g >= 1; g--) {
      const prob = dist[String(g)] ?? 0
      const row = document.createElement('div')
      row.className = 'grade-bar-row'
      row.innerHTML = `
        <span class="grade-bar-label">PSA ${g}</span>
        <div class="grade-bar-track">
          <div class="grade-bar-fill" style="width:${Math.round(prob * 100)}%"></div>
        </div>
        <span class="grade-bar-pct">${pct(prob)}</span>
      `
      barsContainer.appendChild(row)
    }
  } else {
    // Legacy bucket names from Python backend
    const bucketOrder = ['poor', 'vg', 'excellent', 'nm', 'mint']
    bucketOrder.forEach(bucket => {
      const prob = dist[bucket] ?? 0
      const row = document.createElement('div')
      row.className = 'grade-bar-row'
      row.innerHTML = `
        <span class="grade-bar-label">${BUCKET_LABELS[bucket] ?? bucket}</span>
        <div class="grade-bar-track">
          <div class="grade-bar-fill" style="width:${Math.round(prob * 100)}%"></div>
        </div>
        <span class="grade-bar-pct">${pct(prob)}</span>
      `
      barsContainer.appendChild(row)
    })
  }

  // Issues
  const issuesList = document.getElementById('issues-list')
  issuesList.innerHTML = ''
  if (issues.length === 0) {
    const li = document.createElement('li')
    li.className = 'no-issues'
    li.textContent = '✓ No significant issues detected'
    li.style.listStyle = 'none'
    issuesList.appendChild(li)
  } else {
    issues.forEach(issue => {
      const li = document.createElement('li')
      li.textContent = issue
      issuesList.appendChild(li)
    })
  }

  // Prices
  document.getElementById('price-raw').textContent   = fmt(economics.raw_estimate)
  document.getElementById('price-psa8').textContent  = fmt(economics.psa8_estimate)
  document.getElementById('price-psa9').textContent  = fmt(economics.psa9_estimate)
  document.getElementById('price-psa10').textContent = fmt(economics.psa10_estimate)

  // ROI table
  document.getElementById('roi-listing').textContent   = fmt(economics.listing_price)
  document.getElementById('roi-grade-fee').textContent = fmt(economics.grading_fee)
  document.getElementById('roi-ev').textContent        = fmt(economics.expected_value)
  document.getElementById('roi-max9').textContent      = fmt(economics.max_buy_price_for_psa9_target)
  document.getElementById('roi-max8').textContent      = fmt(economics.max_buy_price_for_psa8_target)

  // Comps source
  const compsNote = document.getElementById('comps-note')
  if (_meta.comps_source && _meta.comps_source !== 'none') {
    compsNote.textContent = `Prices from: ${_meta.comps_source}`
  } else {
    compsNote.textContent = 'Prices: estimated (no live comps)'
  }

  showState('result')
}

// ── Message listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {

    case 'ANALYSIS_START': {
      const title = msg.payload?.title ?? ''
      document.getElementById('loading-title').textContent =
        title.length > 60 ? title.slice(0, 57) + '…' : title
      document.getElementById('loading-step').textContent = 'Starting…'
      showState('loading')
      break
    }

    case 'ANALYSIS_PROGRESS': {
      const step = msg.payload?.step ?? ''
      document.getElementById('loading-step').textContent = step
      break
    }

    case 'ANALYSIS_RESULT': {
      renderResult(msg.payload ?? {})
      break
    }

    case 'ANALYSIS_ERROR': {
      document.getElementById('error-message').textContent =
        msg.payload?.message ?? 'An unknown error occurred.'
      document.getElementById('error-hint').textContent =
        msg.payload?.hint ?? ''
      showState('error')
      break
    }
  }
})

// ── Reset button ───────────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', () => showState('idle'))
document.getElementById('error-retry-btn').addEventListener('click', () => showState('idle'))

// ── Init ───────────────────────────────────────────────────────────
showState('idle')
