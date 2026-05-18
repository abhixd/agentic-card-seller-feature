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
/** URLs that were submitted for the most recent analysis (in selection order). */
let _analyzedUrls = []

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
  _analyzedUrls = [..._selected]   // snapshot URLs before state clears
  const payload = {
    ..._pendingListing,
    image_urls: _analyzedUrls,
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

// ── CV Detectors renderer ──────────────────────────────────────────

function renderCVDetectors(payload) {
  const SEV_CSS   = { none: 'cv-sev--none', light: 'cv-sev--light', moderate: 'cv-sev--moderate', heavy: 'cv-sev--heavy' }
  const SEV_LABEL = { none: 'Clean', light: 'Light', moderate: 'Moderate', heavy: 'Heavy' }

  function setDet(sevId, detailId, result, detailFn) {
    const sev = result?.severity ?? 'none'
    const sevEl = document.getElementById(sevId)
    sevEl.textContent = SEV_LABEL[sev] ?? sev
    sevEl.className = `cv-sev-badge ${SEV_CSS[sev] ?? ''}`
    document.getElementById(detailId).textContent = result ? detailFn(result) : '—'
  }

  setDet('cv-border-sev', 'cv-border-detail', payload.border_irregularity,
    r => `${(r.total_grad_fraction * 100).toFixed(1)}% grad · ${r.component_count} clusters · largest ${r.max_component_area}px`)

  setDet('cv-surface-sev', 'cv-surface-detail', payload.surface_lines,
    r => `diag ${(r.diagonal_energy_fraction * 100).toFixed(0)}% · imbal ${r.energy_imbalance.toFixed(2)} · ${r.confidence} conf`)
}

// ── Analyzed images strip + lightbox ──────────────────────────────

// Zone geometry: [x%, y%, w%, h%] in a 100×100 viewBox
const ZONE_RECTS = {
  'tl-corner':   [0,   0,   20,  22],
  'tr-corner':   [80,  0,   20,  22],
  'bl-corner':   [0,   78,  20,  22],
  'br-corner':   [80,  78,  20,  22],
  'top-edge':    [20,  0,   60,  14],
  'bottom-edge': [20,  86,  60,  14],
  'left-edge':   [0,   22,  14,  56],
  'right-edge':  [86,  22,  14,  56],
  'surface':     [14,  14,  72,  64],
  'centering':   [4,   4,   92,  92],
}

const ZONE_LABELS = {
  'tl-corner':   'Top-Left Corner',
  'tr-corner':   'Top-Right Corner',
  'bl-corner':   'Bottom-Left Corner',
  'br-corner':   'Bottom-Right Corner',
  'top-edge':    'Top Edge',
  'bottom-edge': 'Bottom Edge',
  'left-edge':   'Left Edge',
  'right-edge':  'Right Edge',
  'surface':     'Surface',
  'centering':   'Centering',
}

// Claude zone colours (yellow → orange → red by severity)
const SEV_FILL   = { light: 'rgba(234,179,8,0.35)',  moderate: 'rgba(249,115,22,0.45)', heavy: 'rgba(220,38,38,0.55)' }
const SEV_STROKE = { light: 'rgba(234,179,8,0.90)',  moderate: 'rgba(249,115,22,1.00)', heavy: 'rgba(220,38,38,1.00)' }
const SEV_HEX    = { light: '#eab308',               moderate: '#f97316',               heavy: '#ef4444'              }
const SEV_LABEL  = { light: 'Light',                 moderate: 'Moderate',              heavy: 'Heavy'                }

// CV surface-grid colours (teal — visually distinct from Claude zones)
// Dashed stroke signals "measured, not annotated".
const GRID_FILL   = { light: 'rgba(20,184,166,0.18)', moderate: 'rgba(20,184,166,0.30)', heavy: 'rgba(20,184,166,0.45)' }
const GRID_STROKE = { light: 'rgba(20,184,166,0.60)', moderate: 'rgba(20,184,166,0.80)', heavy: 'rgba(20,184,166,1.00)' }
const GRID_GLARE_FILL   = 'rgba(156,163,175,0.12)'
const GRID_GLARE_STROKE = 'rgba(156,163,175,0.40)'

/**
 * Build solid-teal SVG rects for whitened corners.
 * Solid stroke (vs dashed for grid cells) signals high location confidence —
 * we know exactly which corner patch was scanned.
 */
function buildCornerBoxSVG(cornerBoxes) {
  if (!cornerBoxes || cornerBoxes.length === 0) return null
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               'zone-overlay cv-corner-overlay')
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')

  const CORNER_NAMES = { TL: 'Top-Left', TR: 'Top-Right', BL: 'Bottom-Left', BR: 'Bottom-Right' }

  cornerBoxes.forEach(box => {
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',            String(box.x_pct))
    el.setAttribute('y',            String(box.y_pct))
    el.setAttribute('width',        String(box.w_pct))
    el.setAttribute('height',       String(box.h_pct))
    el.setAttribute('fill',         GRID_FILL[box.severity]   ?? GRID_FILL.light)
    el.setAttribute('stroke',       GRID_STROKE[box.severity] ?? GRID_STROKE.light)
    el.setAttribute('stroke-width', '2')
    el.setAttribute('rx',           '2')
    const title = document.createElementNS(NS, 'title')
    title.textContent = `CV: ${CORNER_NAMES[box.corner] ?? box.corner} corner — ${box.severity} whitening`
    el.appendChild(title)
    svg.appendChild(el)
  })

  return svg
}

/**
 * Build solid-teal SVG rects for anomalous edge bands.
 * Corner areas are excluded so these don't overlap with corner boxes.
 */
function buildEdgeBandSVG(edgeBands) {
  if (!edgeBands || edgeBands.length === 0) return null
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               'zone-overlay cv-edge-overlay')
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')

  edgeBands.forEach(band => {
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',            String(band.x_pct))
    el.setAttribute('y',            String(band.y_pct))
    el.setAttribute('width',        String(band.w_pct))
    el.setAttribute('height',       String(band.h_pct))
    el.setAttribute('fill',         GRID_FILL[band.severity]   ?? GRID_FILL.light)
    el.setAttribute('stroke',       GRID_STROKE[band.severity] ?? GRID_STROKE.light)
    el.setAttribute('stroke-width', '2')
    el.setAttribute('rx',           '2')
    const title = document.createElementNS(NS, 'title')
    title.textContent = `CV: ${band.side} edge — ${band.severity} border irregularity`
    el.appendChild(title)
    svg.appendChild(el)
  })

  return svg
}

/**
 * Build a teal dashed-border SVG overlay from CV surface_grid cells.
 * Grid cells use x_pct/y_pct/w_pct/h_pct (already in 0–100 scale matching viewBox).
 * Glare-masked cells are shown in grey — they hide signal, not confirm cleanliness.
 * Returns null when there are no cells to draw.
 */
function buildSurfaceGridSVG(gridCells) {
  if (!gridCells || gridCells.length === 0) return null
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               'zone-overlay surface-grid-overlay')
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')

  gridCells.forEach(cell => {
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',      String(cell.x_pct))
    el.setAttribute('y',      String(cell.y_pct))
    el.setAttribute('width',  String(cell.w_pct))
    el.setAttribute('height', String(cell.h_pct))
    el.setAttribute('rx',     '2')

    if (cell.glare_masked) {
      el.setAttribute('fill',             GRID_GLARE_FILL)
      el.setAttribute('stroke',           GRID_GLARE_STROKE)
      el.setAttribute('stroke-width',     '1')
      el.setAttribute('stroke-dasharray', '2 2')
    } else {
      el.setAttribute('fill',             GRID_FILL[cell.severity]   ?? GRID_FILL.light)
      el.setAttribute('stroke',           GRID_STROKE[cell.severity] ?? GRID_STROKE.light)
      el.setAttribute('stroke-width',     '1.5')
      el.setAttribute('stroke-dasharray', '3 2')
    }

    const title = document.createElementNS(NS, 'title')
    title.textContent = cell.glare_masked
      ? `CV: row ${cell.row} col ${cell.col} — glare masked (signal hidden)`
      : `CV: row ${cell.row} col ${cell.col} — ${cell.severity} surface anomaly (score ${cell.score})`
    el.appendChild(title)
    svg.appendChild(el)
  })

  return svg
}

/**
 * Build zones from Claude's text issues when Claude didn't return explicit
 * zone data — Haiku may omit the field on clean cards or short responses.
 * Returns zones[] (may be empty on a clean side).
 */
function inferZonesFromIssues(sideAnalysis) {
  if (!sideAnalysis || sideAnalysis.assessable === false) return []
  // Prefer Claude's explicit zones
  if (Array.isArray(sideAnalysis.zones) && sideAnalysis.zones.length > 0) return sideAnalysis.zones

  const zones = []
  const issues = sideAnalysis.issues ?? {}

  function sev(texts) {
    const j = texts.join(' ').toLowerCase()
    return j.includes('heavy') || j.includes('major') || j.includes('severe') || j.includes('significant')
      ? 'heavy' : j.includes('moderate') ? 'moderate' : 'light'
  }

  function push(zone, severity, note) {
    if (!zones.find(z => z.zone === zone)) zones.push({ zone, severity, note: note.slice(0, 60) })
  }

  if (issues.centering?.length)
    push('centering', sev(issues.centering), issues.centering[0])

  ;(issues.corners ?? []).forEach(text => {
    const t = text.toLowerCase()
    const zone =
      t.includes('top-left')  || t.includes(' tl') ? 'tl-corner' :
      t.includes('top-right') || t.includes(' tr') ? 'tr-corner' :
      t.includes('bottom-left')  || t.includes(' bl') ? 'bl-corner' :
      t.includes('bottom-right') || t.includes(' br') ? 'br-corner' :
      t.includes('top')    ? 'tr-corner' :   // default top → tr (most common PSA corner)
      t.includes('bottom') ? 'bl-corner' : 'tl-corner'
    push(zone, sev([text]), text)
  })

  ;(issues.edges ?? []).forEach(text => {
    const t = text.toLowerCase()
    const zone =
      t.includes('top')    ? 'top-edge'    :
      t.includes('bottom') ? 'bottom-edge' :
      t.includes('left')   ? 'left-edge'   :
      t.includes('right')  ? 'right-edge'  : 'top-edge'
    push(zone, sev([text]), text)
  })

  if (issues.surface?.length)
    push('surface', sev(issues.surface), issues.surface[0])

  return zones
}

/**
 * Map an issue category + text to its card zone name.
 * Returns null for 'other' issues that can't be located spatially.
 */
function getZoneForIssue(category, text) {
  if (category === 'centering') return 'centering'
  if (category === 'surface')   return 'surface'
  if (category === 'other')     return null   // no reliable location

  const t = text.toLowerCase()

  if (category === 'corners') {
    if (t.includes('top-left')     || t.match(/\btl\b/)) return 'tl-corner'
    if (t.includes('top-right')    || t.match(/\btr\b/)) return 'tr-corner'
    if (t.includes('bottom-left')  || t.match(/\bbl\b/)) return 'bl-corner'
    if (t.includes('bottom-right') || t.match(/\bbr\b/)) return 'br-corner'
    // Ambiguous — pick the most common PSA problem corner
    if (t.includes('top'))    return 'tr-corner'
    if (t.includes('bottom')) return 'bl-corner'
    return 'tl-corner'
  }

  if (category === 'edges') {
    if (t.includes('top'))    return 'top-edge'
    if (t.includes('bottom')) return 'bottom-edge'
    if (t.includes('left'))   return 'left-edge'
    if (t.includes('right'))  return 'right-edge'
    return 'top-edge'
  }

  return null
}

/** Build a reusable SVG element with coloured zone rects. */
function buildZoneSVG(zones, extraClass) {
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               ['zone-overlay', extraClass].filter(Boolean).join(' '))
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')

  zones.forEach(({ zone, severity, note }) => {
    const r = ZONE_RECTS[zone]
    if (!r) return
    const [x, y, w, h] = r
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',            String(x))
    el.setAttribute('y',            String(y))
    el.setAttribute('width',        String(w))
    el.setAttribute('height',       String(h))
    el.setAttribute('fill',         SEV_FILL[severity]   ?? SEV_FILL.light)
    el.setAttribute('stroke',       SEV_STROKE[severity] ?? SEV_STROKE.light)
    el.setAttribute('stroke-width', '2.5')
    el.setAttribute('rx',           '3')
    const title = document.createElementNS(NS, 'title')
    title.textContent = note
    el.appendChild(title)
    svg.appendChild(el)
  })

  return svg
}

/**
 * Build an SVG where `focusedZone` is highlighted at full intensity
 * and every other zone in `allZones` is drawn as a faint ghost outline —
 * giving spatial context without stealing attention from the active zone.
 */
function buildZoneSVGFocused(allZones, focusedZone, focusedSeverity) {
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               'zone-overlay')
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')

  // Ghost pass — all other zones from this side, very dim
  allZones.forEach(({ zone }) => {
    if (zone === focusedZone) return
    const r = ZONE_RECTS[zone]
    if (!r) return
    const [x, y, w, h] = r
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',            String(x))
    el.setAttribute('y',            String(y))
    el.setAttribute('width',        String(w))
    el.setAttribute('height',       String(h))
    el.setAttribute('fill',         'rgba(255,255,255,0.04)')
    el.setAttribute('stroke',       'rgba(255,255,255,0.18)')
    el.setAttribute('stroke-width', '1')
    el.setAttribute('rx',           '3')
    svg.appendChild(el)
  })

  // Focused zone — bright fill + animated stroke
  const fr = ZONE_RECTS[focusedZone]
  if (fr) {
    const sev = focusedSeverity ?? 'moderate'
    const [x, y, w, h] = fr
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',            String(x))
    el.setAttribute('y',            String(y))
    el.setAttribute('width',        String(w))
    el.setAttribute('height',       String(h))
    el.setAttribute('fill',         SEV_FILL[sev]   ?? SEV_FILL.moderate)
    el.setAttribute('stroke',       SEV_STROKE[sev] ?? SEV_STROKE.moderate)
    el.setAttribute('stroke-width', '3')
    el.setAttribute('rx',           '3')
    el.setAttribute('class',        'zone-focused-rect')
    svg.appendChild(el)
  }

  return svg
}

// ── Lightbox ───────────────────────────────────────────────────────

let _lightboxItems = []   // [{url, zones, label}]
let _lightboxIndex = 0
let _lightboxFocusedZone = null   // null = normal browse; string = investigation mode
let _lightboxFocusedNote = null
let _lightboxFocusedSev  = null

function openLightbox(index) {
  _lightboxFocusedZone = null
  _lightboxFocusedNote = null
  _lightboxFocusedSev  = null
  _lightboxIndex = Math.max(0, Math.min(index, _lightboxItems.length - 1))
  renderLightboxFrame()
  document.getElementById('thumb-lightbox').classList.remove('hidden')
}

/** Open lightbox focused on a specific issue zone — the "Show" button entry point. */
function openLightboxFocused(thumbIndex, zone, issueText, severity) {
  _lightboxFocusedZone = zone
  _lightboxFocusedNote = issueText
  _lightboxFocusedSev  = severity ?? 'moderate'
  _lightboxIndex = Math.max(0, Math.min(thumbIndex, _lightboxItems.length - 1))
  renderLightboxFrame()
  document.getElementById('thumb-lightbox').classList.remove('hidden')
}

function closeLightbox() {
  document.getElementById('thumb-lightbox').classList.add('hidden')
}

function renderLightboxFrame() {
  const item = _lightboxItems[_lightboxIndex]
  if (!item) return

  const isFocused = _lightboxFocusedZone !== null

  // Image
  document.getElementById('lightbox-img').src = item.url
  document.getElementById('lightbox-img').alt = item.label

  // Label
  const sideLabel = _lightboxItems.length > 1
    ? `${item.label}  ·  ${_lightboxIndex + 1} / ${_lightboxItems.length}`
    : item.label
  document.getElementById('lightbox-label').textContent = isFocused
    ? `${item.label}  ·  ${ZONE_LABELS[_lightboxFocusedZone] ?? _lightboxFocusedZone}`
    : sideLabel

  // Zone SVG — layered: CV grid (bottom, teal dashed) → Claude zones (top, solid)
  // In focused/investigation mode, Claude zones switch to ghost+highlight; grid stays.
  const svgSlot = document.getElementById('lightbox-svg-slot')
  svgSlot.innerHTML = ''

  // CV layers — always shown as ambient evidence in both normal and focused mode
  const gridSvg   = buildSurfaceGridSVG(item.gridCells   ?? [])
  const cornerSvg = buildCornerBoxSVG(item.cornerBoxes   ?? [])
  const edgeSvg   = buildEdgeBandSVG(item.edgeBands      ?? [])
  if (gridSvg)   svgSlot.appendChild(gridSvg)    // Layer 1: surface grid (dashed)
  if (cornerSvg) svgSlot.appendChild(cornerSvg)  // Layer 2: corner boxes (solid)
  if (edgeSvg)   svgSlot.appendChild(edgeSvg)    // Layer 3: edge bands  (solid)

  // Layer 4 (top): Claude named zones
  if (isFocused) {
    svgSlot.appendChild(buildZoneSVGFocused(item.zones, _lightboxFocusedZone, _lightboxFocusedSev))
  } else if (item.zones.length > 0) {
    svgSlot.appendChild(buildZoneSVG(item.zones))
  }

  // Focused-issue banner (investigation mode)
  const banner = document.getElementById('lightbox-focused-banner')
  if (isFocused) {
    const sevClass = `lz-badge--${_lightboxFocusedSev ?? 'moderate'}`
    banner.innerHTML =
      `<span class="lz-badge ${sevClass}">${ZONE_LABELS[_lightboxFocusedZone] ?? _lightboxFocusedZone}</span>` +
      `<span class="lightbox-focused-note">${_lightboxFocusedNote ?? ''}</span>`
    banner.classList.remove('hidden')
  } else {
    banner.classList.add('hidden')
  }

  // Zone list — show in normal mode; hide in focused mode
  const list = document.getElementById('lightbox-zones-list')
  if (isFocused) {
    list.classList.add('hidden')
  } else {
    list.classList.remove('hidden')
    list.innerHTML = ''
    if (item.zones.length === 0) {
      const li = document.createElement('li')
      li.className = 'lz-clean'
      li.textContent = '✓ No defects detected on this side'
      list.appendChild(li)
    } else {
      item.zones.forEach(({ zone, severity, note }) => {
        const li    = document.createElement('li')
        li.className = 'lz-item'
        const badge = document.createElement('span')
        badge.className = `lz-badge lz-badge--${severity}`
        badge.textContent = ZONE_LABELS[zone] ?? zone
        const txt = document.createElement('span')
        txt.className = 'lz-note'
        txt.textContent = note
        li.appendChild(badge)
        li.appendChild(txt)
        list.appendChild(li)
      })
    }
  }

  // Prev / next navigation
  const nav = document.getElementById('lightbox-nav')
  nav.classList.toggle('hidden', _lightboxItems.length <= 1)
  document.getElementById('lightbox-prev').disabled = _lightboxIndex === 0
  document.getElementById('lightbox-next').disabled = _lightboxIndex === _lightboxItems.length - 1
}

document.getElementById('lightbox-close').addEventListener('click', closeLightbox)
document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox)
document.getElementById('lightbox-prev').addEventListener('click', () => {
  if (_lightboxIndex > 0) { _lightboxIndex--; renderLightboxFrame() }
})
document.getElementById('lightbox-next').addEventListener('click', () => {
  if (_lightboxIndex < _lightboxItems.length - 1) { _lightboxIndex++; renderLightboxFrame() }
})

// ── Strip renderer ─────────────────────────────────────────────────

/**
 * Render the analyzed-images strip.
 *
 * allZones:      ZoneAnnotation[][] — one zone array per image (from Claude)
 * cvSurfaceGrid: SurfaceGridCell[]  — hot cells from Detector C (front image only)
 * cvCornerBoxes: CornerBox[]        — whitened corners (front image only)
 * cvEdgeBands:   EdgeBand[]         — anomalous edge bands (front image only)
 *
 * Layer order (bottom → top):
 *   1. CV surface grid  — teal dashed (uncertain surface regions)
 *   2. CV corner boxes  — teal solid  (precise whitened corners)
 *   3. CV edge bands    — teal solid  (precise anomalous edges)
 *   4. Claude zones     — yellow/orange/red solid (textual annotations)
 */
function renderAnalyzedImages(urls, allZones, cvSurfaceGrid, cvCornerBoxes, cvEdgeBands) {
  const strip   = document.getElementById('analyzed-images-strip')
  const section = strip.closest('.analyzed-images-section')

  section.querySelector('.zone-legend')?.remove()
  strip.innerHTML = ''
  _lightboxItems  = []

  if (!urls || urls.length === 0) { section.classList.add('hidden'); return }
  section.classList.remove('hidden')

  const LABELS = ['Front', 'Back']

  urls.forEach((url, i) => {
    const label     = LABELS[i] ?? `Image ${i + 1}`
    const zones     = allZones?.[i] ?? []
    // CV overlays only apply to the front image — CV runs on the first buffer
    const gridCells   = i === 0 ? (cvSurfaceGrid  ?? []) : []
    const cornerBoxes = i === 0 ? (cvCornerBoxes  ?? []) : []
    const edgeBands   = i === 0 ? (cvEdgeBands    ?? []) : []
    _lightboxItems.push({ url, zones, label, gridCells, cornerBoxes, edgeBands })

    const item = document.createElement('div')
    item.className = 'analyzed-thumb'
    item.dataset.index = String(i)

    const wrap = document.createElement('div')
    wrap.className = 'analyzed-thumb-wrap'

    const img = document.createElement('img')
    img.alt     = label
    img.loading = 'lazy'
    img.src     = url.replace(/s-l\d+/g, 's-l300')
    img.onerror = () => {
      img.remove()
      const err = document.createElement('div')
      err.className = 'analyzed-thumb-err'
      err.textContent = '🖼'
      wrap.appendChild(err)
    }
    wrap.appendChild(img)

    // Layer 1: CV surface grid — teal dashed (broad surface regions)
    const gridSvg = buildSurfaceGridSVG(gridCells)
    if (gridSvg) wrap.appendChild(gridSvg)

    // Layer 2: CV corner boxes — teal solid (precise whitened corners)
    const cornerSvg = buildCornerBoxSVG(cornerBoxes)
    if (cornerSvg) wrap.appendChild(cornerSvg)

    // Layer 3: CV edge bands — teal solid (precise anomalous edges)
    const edgeSvg = buildEdgeBandSVG(edgeBands)
    if (edgeSvg) wrap.appendChild(edgeSvg)

    // Layer 4 (top): Claude named zones — solid coloured rects
    if (zones.length > 0) wrap.appendChild(buildZoneSVG(zones))

    const lbl = document.createElement('span')
    lbl.className = 'analyzed-thumb-label'
    lbl.textContent = label

    item.appendChild(wrap)
    item.appendChild(lbl)
    item.addEventListener('click', () => openLightbox(i))
    strip.appendChild(item)
  })

  // Severity legend
  const legend = document.createElement('div')
  legend.className = 'zone-legend'
  let legendHasEntries = false

  // Claude zone severity entries
  const allSevs = [...new Set((allZones ?? []).flat().map(z => z.severity))]
    .sort((a, b) => ['light','moderate','heavy'].indexOf(a) - ['light','moderate','heavy'].indexOf(b))
  allSevs.forEach(sev => {
    const entry = document.createElement('span')
    entry.className = 'zone-legend-entry'
    entry.innerHTML =
      `<span class="zone-legend-pip" style="background:${SEV_HEX[sev]}"></span>` +
      `<span class="zone-legend-txt">${SEV_LABEL[sev]}</span>`
    legend.appendChild(entry)
    legendHasEntries = true
  })

  // CV overlay legend entries — one combined "CV measured" pip covers all three CV layers
  const hasCVCorners = (cvCornerBoxes ?? []).length > 0
  const hasCVEdges   = (cvEdgeBands   ?? []).length > 0
  const hasHotGrid   = (cvSurfaceGrid ?? []).some(c => !c.glare_masked)
  const hasGlare     = (cvSurfaceGrid ?? []).some(c =>  c.glare_masked)

  if (hasCVCorners || hasCVEdges || hasHotGrid) {
    const entry = document.createElement('span')
    entry.className = 'zone-legend-entry'
    const parts = [
      hasCVCorners && 'corners',
      hasCVEdges   && 'edges',
      hasHotGrid   && 'surface',
    ].filter(Boolean).join(', ')
    entry.innerHTML =
      `<span class="zone-legend-pip zone-legend-pip--cv"></span>` +
      `<span class="zone-legend-txt">CV: ${parts}</span>`
    legend.appendChild(entry)
    legendHasEntries = true
  }
  if (hasGlare) {
    const entry = document.createElement('span')
    entry.className = 'zone-legend-entry'
    entry.innerHTML =
      `<span class="zone-legend-pip zone-legend-pip--glare"></span>` +
      `<span class="zone-legend-txt">Glare hidden</span>`
    legend.appendChild(entry)
    legendHasEntries = true
  }

  if (legendHasEntries) section.appendChild(legend)
}

// ── Side analysis renderer ─────────────────────────────────────────
// Module-level (not nested inside renderResult) to avoid V8 hoisting the
// function declaration above const variables in renderResult's TDZ scope.
//
// thumbIndex: 0 = front image, 1 = back image (aligns with _lightboxItems)
// sideZones:  inferred zones for this side, used to look up "Show" severity

const ISSUE_CATEGORY_LABELS = {
  centering: 'Centering',
  corners:   'Corners',
  edges:     'Edges',
  surface:   'Surface',
  other:     'Other',
}

function renderSideAnalysis(side, prefix, thumbIndex, sideZones) {
  const notAvailEl  = document.getElementById(`${prefix}-not-available`)
  const centeringEl = document.getElementById(`${prefix}-centering`)
  const issuesEl    = document.getElementById(`${prefix}-issues-list`)

  if (!side || side.assessable === false) {
    notAvailEl.classList.remove('hidden')
    centeringEl.classList.add('hidden')
    issuesEl.classList.add('hidden')
    return
  }

  notAvailEl.classList.add('hidden')
  issuesEl.innerHTML = ''
  let hasIssue = false

  if (side.centering) {
    centeringEl.textContent = `Centering: ${side.centering}`
    centeringEl.classList.remove('hidden')
  } else {
    centeringEl.classList.add('hidden')
  }

  const sideIssues = side.issues ?? {}
  Object.entries(ISSUE_CATEGORY_LABELS).forEach(([key, label]) => {
    const items = sideIssues[key]
    if (!Array.isArray(items) || items.length === 0) return
    hasIssue = true

    const header = document.createElement('li')
    header.className = 'issue-category-header'
    header.textContent = label
    issuesEl.appendChild(header)

    items.forEach(issueText => {
      const zone = getZoneForIssue(key, issueText)

      const li  = document.createElement('li')
      li.className = 'issue-item'

      const txt = document.createElement('span')
      txt.className = 'issue-text'
      txt.textContent = issueText
      li.appendChild(txt)

      // "Show" button — only when the issue can be located on the card image
      if (zone !== null && thumbIndex < _lightboxItems.length) {
        const matchedZone = sideZones?.find(z => z.zone === zone)
        const severity    = matchedZone?.severity ?? 'moderate'

        const btn = document.createElement('button')
        btn.className = 'issue-locate-btn'
        btn.textContent = 'Show'
        btn.title = `Locate on card: ${ZONE_LABELS[zone] ?? zone}`
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          openLightboxFocused(thumbIndex, zone, issueText, severity)
        })
        li.appendChild(btn)
      }

      issuesEl.appendChild(li)
    })
  })

  if (!hasIssue) {
    const li = document.createElement('li')
    li.className = 'no-issues'
    li.textContent = '✓ No issues detected'
    li.style.listStyle = 'none'
    issuesEl.appendChild(li)
  }

  issuesEl.classList.remove('hidden')
}

// ── Render results ─────────────────────────────────────────────────

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

  const caveats    = grading_decision.caveats ?? []
  const caveatsList = document.getElementById('gd-caveats')
  caveatsList.innerHTML = ''
  if (caveats.length > 0) {
    caveats.forEach(c => {
      const li = document.createElement('li')
      li.textContent = c
      caveatsList.appendChild(li)
    })
    caveatsList.classList.remove('hidden')
  } else {
    caveatsList.classList.add('hidden')
  }

  // ── Front / Back analysis ───────────────────────────────────────
  const frontZones = inferZonesFromIssues(payload.front_analysis)
  const backZones  = inferZonesFromIssues(payload.back_analysis)

  renderSideAnalysis(payload.front_analysis, 'front', 0, frontZones)
  renderSideAnalysis(payload.back_analysis,  'back',  1, backZones)

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

  renderCVDetectors(payload)
  // CV overlay data — all apply to the front image only (CV runs on first buffer)
  const cvSurfaceGrid  = Array.isArray(payload.surface_grid) ? payload.surface_grid  : null
  const cvCornerBoxes  = Array.isArray(payload.corner_boxes) ? payload.corner_boxes  : null
  const cvEdgeBands    = Array.isArray(payload.edge_bands)   ? payload.edge_bands    : null
  renderAnalyzedImages(_analyzedUrls, [frontZones, backZones], cvSurfaceGrid, cvCornerBoxes, cvEdgeBands)
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
