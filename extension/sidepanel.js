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
const STATES = ['idle', 'select', 'loading', 'result', 'error']

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

// ── Image selection ────────────────────────────────────────────────

/** Holds the current listing payload while the user picks images. */
let _pendingListing = null
/** Set of selected image URLs. */
const _selected = new Set()

const thumbGrid       = document.getElementById('thumb-grid')
const selCountEl      = document.getElementById('sel-count')
const analyzeSelBtn   = document.getElementById('analyze-selected-btn')
const selectTitleEl   = document.getElementById('select-title')
const selectAllBtn    = document.getElementById('select-all-btn')
const clearSelBtn     = document.getElementById('clear-sel-btn')

function refreshSelectionUI() {
  const n = _selected.size
  selCountEl.textContent = n
  analyzeSelBtn.disabled = n === 0
  // Dim un-selected once something is chosen
  thumbGrid.classList.toggle('has-selection', n > 0)
  // Sync item borders
  thumbGrid.querySelectorAll('.thumb-item').forEach(item => {
    item.classList.toggle('selected', _selected.has(item.dataset.url))
  })
}

function buildThumbGrid(imageUrls) {
  thumbGrid.innerHTML = ''
  _selected.clear()

  imageUrls.forEach((url, i) => {
    const item = document.createElement('div')
    item.className = 'thumb-item'
    item.dataset.url = url
    item.title = `Image ${i + 1}`

    const img = document.createElement('img')
    img.alt = `Card image ${i + 1}`
    img.loading = 'lazy'
    // Show a small preview (s-l300) for fast load; full-res s-l1600 URL is
    // stored in item.dataset.url and sent to the backend for analysis.
    img.src = url.replace(/s-l\d+/g, 's-l300')
    img.onerror = () => {
      img.remove()
      const err = document.createElement('div')
      err.className = 'thumb-err'
      err.textContent = '🖼'
      item.appendChild(err)
    }

    item.appendChild(img)
    item.addEventListener('click', () => {
      if (_selected.has(url)) {
        _selected.delete(url)
      } else {
        _selected.add(url)
      }
      refreshSelectionUI()
    })

    thumbGrid.appendChild(item)
  })

  refreshSelectionUI()
}

selectAllBtn.addEventListener('click', () => {
  thumbGrid.querySelectorAll('.thumb-item').forEach(item => _selected.add(item.dataset.url))
  refreshSelectionUI()
})

clearSelBtn.addEventListener('click', () => {
  _selected.clear()
  refreshSelectionUI()
})

analyzeSelBtn.addEventListener('click', () => {
  if (!_pendingListing || _selected.size === 0) return
  const payload = {
    ..._pendingListing,
    image_urls: [..._selected],
  }
  chrome.runtime.sendMessage({ type: 'ANALYZE_SELECTED', payload })
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

const ISSUE_CATEGORY_LABELS = {
  centering: 'Centering',
  corners:   'Corners',
  edges:     'Edges',
  surface:   'Surface',
  other:     'Other',
}

const GD_META = {
  yes:   { emoji: '✅', css: 'gd-yes',   label: 'Gradable' },
  maybe: { emoji: '🤔', css: 'gd-maybe', label: 'Possibly Gradable' },
  no:    { emoji: '❌', css: 'gd-no',    label: 'Not Recommended' },
}

const IQ_CHIP_DEFS = [
  { key: 'front_present',     label: 'Front' },
  { key: 'back_present',      label: 'Back' },
  { key: 'centering_visible', label: 'Centering' },
  { key: 'corners_visible',   label: 'Corners' },
  { key: 'edges_visible',     label: 'Edges' },
  { key: 'surface_visible',   label: 'Surface' },
]

function renderResult(payload) {
  const {
    analysis_mode   = 'front_only',
    card_identity   = {},
    image_quality   = {},
    grade_estimate  = {},
    issues          = {},
    grading_decision = {},
    economics       = {},
    decision        = {},
    _meta           = {},
  } = payload

  // ── Card identity + mode badge ──────────────────────────────────
  document.getElementById('res-title').textContent =
    card_identity.name || payload.title || 'Unknown card'
  document.getElementById('res-set').textContent  = card_identity.set    ?? ''
  document.getElementById('res-year').textContent = card_identity.year   ?? ''
  document.getElementById('res-num').textContent  = card_identity.number ? `#${card_identity.number}` : ''

  const modeEl = document.getElementById('res-mode')
  modeEl.textContent = analysis_mode === 'front_back' ? 'FRONT + BACK' : 'FRONT ONLY'
  modeEl.className   = `mode-badge mode-badge--${analysis_mode === 'front_back' ? 'full' : 'partial'}`

  const idConf = card_identity.confidence ?? null
  const idConfEl = document.getElementById('res-id-conf')
  if (idConf && idConf !== 'high') {
    idConfEl.textContent = `ID: ${idConf} confidence`
    idConfEl.className = 'tag tag--id-conf'
  } else {
    idConfEl.textContent = ''
  }

  // ── Image quality chips + warnings ─────────────────────────────
  const iqChips = document.getElementById('iq-chips')
  iqChips.innerHTML = ''
  IQ_CHIP_DEFS.forEach(({ key, label }) => {
    const val = image_quality[key]
    if (val === undefined) return
    const chip = document.createElement('span')
    chip.className = `iq-chip ${val ? 'iq-chip--ok' : 'iq-chip--warn'}`
    chip.textContent = `${val ? '✓' : '✗'} ${label}`
    iqChips.appendChild(chip)
  })

  const iqWarnings = document.getElementById('iq-warnings')
  iqWarnings.innerHTML = ''
  const warnings = image_quality.warnings ?? []
  warnings.forEach(w => {
    const li = document.createElement('li')
    li.textContent = w
    iqWarnings.appendChild(li)
  })
  iqWarnings.classList.toggle('hidden', warnings.length === 0)

  // ── Economic decision banner ────────────────────────────────────
  const dec    = decision.label ?? 'skip'
  const decMeta = DECISION_META[dec] ?? DECISION_META.skip
  const banner  = document.getElementById('decision-banner')
  banner.className = `decision-banner ${decMeta.css}`
  document.getElementById('dec-emoji').textContent  = decMeta.emoji
  document.getElementById('dec-label').textContent  = dec.toUpperCase()
  document.getElementById('dec-reason').textContent = decision.reason ?? ''

  // ── Grading candidate banner (Claude visual viability) ─────────
  const gdc   = grading_decision.gradable_candidate ?? 'maybe'
  const gdMeta = GD_META[gdc] ?? GD_META.maybe
  const gdBanner = document.getElementById('grading-decision-banner')
  gdBanner.className = `grading-decision-banner ${gdMeta.css}`
  document.getElementById('gd-emoji').textContent  = gdMeta.emoji
  document.getElementById('gd-label').textContent  = gdMeta.label
  document.getElementById('gd-reason').textContent = grading_decision.reason ?? ''

  // ── Grade estimate ──────────────────────────────────────────────
  const dist       = grade_estimate.distribution ?? {}
  const gradeRange = grade_estimate.grade_range   ?? '?'
  const confidence = grade_estimate.confidence    ?? 'unknown'

  document.getElementById('res-grade-range').textContent = gradeRange
  document.getElementById('res-grade-conf').textContent  = `(${confidence} confidence)`

  const barsContainer = document.getElementById('grade-bars')
  barsContainer.innerHTML = ''
  for (let g = 10; g >= 1; g--) {
    const prob = dist[String(g)] ?? 0
    const row  = document.createElement('div')
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

  // ── Issues (categorized) ────────────────────────────────────────
  const issuesList = document.getElementById('issues-list')
  issuesList.innerHTML = ''
  let hasAnyIssue = false

  if (issues && typeof issues === 'object' && !Array.isArray(issues)) {
    Object.entries(ISSUE_CATEGORY_LABELS).forEach(([key, label]) => {
      const items = issues[key]
      if (!Array.isArray(items) || items.length === 0) return
      hasAnyIssue = true

      const header = document.createElement('li')
      header.className = 'issue-category-header'
      header.textContent = label
      issuesList.appendChild(header)

      items.forEach(issue => {
        const li = document.createElement('li')
        li.className = 'issue-item'
        li.textContent = issue
        issuesList.appendChild(li)
      })
    })
  }

  if (!hasAnyIssue) {
    const li = document.createElement('li')
    li.className = 'no-issues'
    li.textContent = '✓ No significant issues detected'
    li.style.listStyle = 'none'
    issuesList.appendChild(li)
  }

  // ── Economics ───────────────────────────────────────────────────
  document.getElementById('price-raw').textContent   = fmt(economics.raw_estimate)
  document.getElementById('price-psa8').textContent  = fmt(economics.psa8_estimate)
  document.getElementById('price-psa9').textContent  = fmt(economics.psa9_estimate)
  document.getElementById('price-psa10').textContent = fmt(economics.psa10_estimate)

  document.getElementById('roi-listing').textContent   = fmt(economics.listing_price)
  document.getElementById('roi-grade-fee').textContent = fmt(economics.grading_fee)
  document.getElementById('roi-ev').textContent        = fmt(economics.expected_value)
  document.getElementById('roi-max9').textContent      = fmt(economics.max_buy_price_for_psa9_target)
  document.getElementById('roi-max8').textContent      = fmt(economics.max_buy_price_for_psa8_target)

  const compsNote = document.getElementById('comps-note')
  compsNote.textContent = (_meta.comps_source && _meta.comps_source !== 'none')
    ? `Prices from: ${_meta.comps_source}`
    : 'Prices: estimated (no live comps)'

  showState('result')
}

// ── Message listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {

    case 'TAB_CHANGED': {
      const url = msg.payload?.url ?? ''
      const onEbay = url.startsWith('https://www.ebay.com/itm/')
      // Only reset to idle if we're not already showing a result/analysis
      const currentlyActive = !document.getElementById('state-idle').classList.contains('hidden') ||
                              !document.getElementById('state-select').classList.contains('hidden')
      if (!onEbay && currentlyActive) {
        document.getElementById('idle-heading').textContent = 'Not on an eBay listing'
        document.getElementById('idle-sub').innerHTML =
          'Navigate to an eBay Pokémon listing and click <strong>Select &amp; Analyze</strong> to get started.'
        showState('idle')
      } else if (onEbay) {
        document.getElementById('idle-heading').textContent = 'Ready to analyze'
        document.getElementById('idle-sub').innerHTML =
          'Click <strong>Select &amp; Analyze</strong> on the listing to pick images.'
      }
      break
    }

    case 'IMAGES_LOADED': {
      const listing = msg.payload ?? {}
      _pendingListing = listing
      // Populate header
      const t = listing.title ?? ''
      selectTitleEl.textContent = t.length > 80 ? t.slice(0, 77) + '…' : t
      // Build thumbnail grid
      buildThumbGrid(listing.image_urls ?? [])
      showState('select')
      break
    }

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

// ── Reset / back buttons ───────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', () => {
  // Return to picker if we still have images loaded, else idle
  showState(_pendingListing ? 'select' : 'idle')
})

document.getElementById('error-retry-btn').addEventListener('click', () => {
  showState(_pendingListing ? 'select' : 'idle')
})

// ── Init ───────────────────────────────────────────────────────────
showState('idle')
