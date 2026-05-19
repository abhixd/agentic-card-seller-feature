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
  'centering':   [4,   4,   92,  92],   // fallback — see CENTERING_STRIPS below
}


/** Returns the list of [x,y,w,h] rects to draw for a given zone name.
 *  Centering returns [] — the SVG overlay maps to photo edges, not card borders,
 *  so it's misleading. The banner text (e.g. "52/48 L/R") is the right display. */
function _zoneRects(zone) {
  if (zone === 'centering') return []
  const r = ZONE_RECTS[zone]
  return r ? [r] : []
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
    const rects = _zoneRects(zone)
    if (!rects.length) return
    rects.forEach(([x, y, w, h]) => {
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
    _zoneRects(zone).forEach(([x, y, w, h]) => {
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
  })

  // Focused zone — bright fill + animated stroke (supports multi-rect zones like centering)
  const sev = focusedSeverity ?? 'moderate'
  _zoneRects(focusedZone).forEach(([x, y, w, h], i) => {
    const el = document.createElementNS(NS, 'rect')
    el.setAttribute('x',            String(x))
    el.setAttribute('y',            String(y))
    el.setAttribute('width',        String(w))
    el.setAttribute('height',       String(h))
    el.setAttribute('fill',         SEV_FILL[sev]   ?? SEV_FILL.moderate)
    el.setAttribute('stroke',       SEV_STROKE[sev] ?? SEV_STROKE.moderate)
    el.setAttribute('stroke-width', '3')
    el.setAttribute('rx',           '3')
    if (i === 0) el.setAttribute('class', 'zone-focused-rect')  // animate first strip
    svg.appendChild(el)
  })

  return svg
}

// ── Lightbox ───────────────────────────────────────────────────────

let _lightboxItems = []   // [{url, zones, label, centering?, ...}]
let _lightboxIndex = 0
// Mode: 'normal' (clean image + tappable zone list) | 'focused' (issue investigation)
// | 'centering' (centering inspection — outer + inner frame overlay with T/B/L/R labels)
let _lightboxMode = 'normal'
let _lightboxFocusedZone = null   // populated in 'focused' mode
let _lightboxFocusedNote = null
let _lightboxFocusedSev  = null

// Human-readable strings for the centering interpretation buckets returned by the backend
const CENTERING_INTERPRETATION_TEXT = {
  well_centered:  'Well-centered',
  slightly_off:   'Slightly off-center',
  noticeably_off: 'Noticeably off-center',
  severely_off:   'Severely off-center',
  unavailable:    'Centering measurement unavailable',
}

function openLightbox(index) {
  _lightboxMode        = 'normal'
  _lightboxFocusedZone = null
  _lightboxFocusedNote = null
  _lightboxFocusedSev  = null
  _lightboxIndex = Math.max(0, Math.min(index, _lightboxItems.length - 1))
  resetZoom()
  renderLightboxFrame()
  document.getElementById('thumb-lightbox').classList.remove('hidden')
}

/** Open lightbox focused on a specific issue zone — the "Show" button entry point. */
function openLightboxFocused(thumbIndex, zone, issueText, severity) {
  _lightboxMode        = 'focused'
  _lightboxFocusedZone = zone
  _lightboxFocusedNote = issueText
  _lightboxFocusedSev  = severity ?? 'moderate'
  _lightboxIndex = Math.max(0, Math.min(thumbIndex, _lightboxItems.length - 1))
  resetZoom()
  renderLightboxFrame()
  document.getElementById('thumb-lightbox').classList.remove('hidden')
}

/**
 * Open lightbox in centering inspection mode — shows outer card + inner frame
 * overlay with T/B/L/R margin labels. Falls back gracefully when measurement
 * is null (no card bounds detected) or inner frame is null (borderless card).
 */
function openLightboxCenteringMode(thumbIndex) {
  _lightboxMode        = 'centering'
  _lightboxFocusedZone = null
  _lightboxFocusedNote = null
  _lightboxFocusedSev  = null
  _lightboxIndex = Math.max(0, Math.min(thumbIndex, _lightboxItems.length - 1))
  resetZoom()
  renderLightboxFrame()
  document.getElementById('thumb-lightbox').classList.remove('hidden')
}

function closeLightbox() {
  document.getElementById('thumb-lightbox').classList.add('hidden')
  resetZoom()
}

/**
 * When a Claude zone is focused, show the matching CV evidence SVG underneath —
 * corner box for corner zones, edge band for edge zones, grid cells for surface.
 * Returns null when no matching CV data exists (e.g. clean card, CV found nothing).
 */
function buildCVEvidenceSVG(item, focusedZone) {
  if (!focusedZone) return null
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               'zone-overlay cv-evidence-overlay')
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')
  let hasContent = false

  const CORNER_KEY = { 'tl-corner': 'TL', 'tr-corner': 'TR', 'bl-corner': 'BL', 'br-corner': 'BR' }
  const EDGE_KEY   = { 'top-edge': 'top', 'bottom-edge': 'bottom', 'left-edge': 'left', 'right-edge': 'right' }

  const ck = CORNER_KEY[focusedZone]
  const ek = EDGE_KEY[focusedZone]

  if (ck) {
    const box = (item.cornerBoxes ?? []).find(b => b.corner === ck)
    if (box) {
      const el = document.createElementNS(NS, 'rect')
      el.setAttribute('x',            String(box.x_pct))
      el.setAttribute('y',            String(box.y_pct))
      el.setAttribute('width',        String(box.w_pct))
      el.setAttribute('height',       String(box.h_pct))
      el.setAttribute('fill',         'rgba(20,184,166,0.22)')
      el.setAttribute('stroke',       'rgba(20,184,166,0.90)')
      el.setAttribute('stroke-width', '2')
      el.setAttribute('rx',           '2')
      const t = document.createElementNS(NS, 'title')
      t.textContent = `CV confirmed: ${box.severity} whitening`
      el.appendChild(t)
      svg.appendChild(el)
      hasContent = true
    }
  } else if (ek) {
    const band = (item.edgeBands ?? []).find(b => b.side === ek)
    if (band) {
      const el = document.createElementNS(NS, 'rect')
      el.setAttribute('x',            String(band.x_pct))
      el.setAttribute('y',            String(band.y_pct))
      el.setAttribute('width',        String(band.w_pct))
      el.setAttribute('height',       String(band.h_pct))
      el.setAttribute('fill',         'rgba(20,184,166,0.18)')
      el.setAttribute('stroke',       'rgba(20,184,166,0.80)')
      el.setAttribute('stroke-width', '2')
      el.setAttribute('rx',           '2')
      const t = document.createElementNS(NS, 'title')
      t.textContent = `CV confirmed: ${band.severity} border irregularity`
      el.appendChild(t)
      svg.appendChild(el)
      hasContent = true
    }
  } else if (focusedZone === 'surface') {
    const hotCells = (item.gridCells ?? []).filter(c => !c.glare_masked)
    hotCells.forEach(cell => {
      const el = document.createElementNS(NS, 'rect')
      el.setAttribute('x',            String(cell.x_pct))
      el.setAttribute('y',            String(cell.y_pct))
      el.setAttribute('width',        String(cell.w_pct))
      el.setAttribute('height',       String(cell.h_pct))
      el.setAttribute('fill',         GRID_FILL[cell.severity]   ?? GRID_FILL.light)
      el.setAttribute('stroke',       GRID_STROKE[cell.severity] ?? GRID_STROKE.light)
      el.setAttribute('stroke-width', '1.5')
      el.setAttribute('stroke-dasharray', '3 2')
      el.setAttribute('rx',           '2')
      svg.appendChild(el)
      hasContent = true
    })
  }

  return hasContent ? svg : null
}

function exitFocusedMode() {
  _lightboxMode        = 'normal'
  _lightboxFocusedZone = null
  _lightboxFocusedNote = null
  _lightboxFocusedSev  = null
  renderLightboxFrame()
}

/** Exit centering inspection mode back to the clean browse view. */
function exitCenteringMode() {
  _lightboxMode = 'normal'
  renderLightboxFrame()
}

/**
 * Render the centering inspection banner. Three states:
 *  1. No measurement at all (image missing / bounds undetected)
 *  2. Borderless / full-art card — outer detected, inner not
 *  3. Full measurement — ratios + interpretation
 */
function renderCenteringBanner(banner, measurement) {
  banner.classList.remove('hidden')
  banner.classList.add('lightbox-centering-banner')
  banner.innerHTML = ''

  const headerRow = document.createElement('div')
  headerRow.className = 'centering-banner-header'

  const badge = document.createElement('span')
  badge.className = 'lz-badge lz-badge--moderate centering-badge'
  badge.textContent = 'Centering'
  headerRow.appendChild(badge)

  // Build the headline based on what we have
  let headline = ''
  let interpretation = ''
  let helper = ''

  if (!measurement) {
    headline       = 'Card not isolated'
    interpretation = 'Centering measurement unavailable'
    helper         = 'The card could not be cropped from the photo — overlay disabled.'
  } else if (!measurement.inner_frame_bbox_pct || !measurement.margins_pct) {
    headline       = 'Outer card detected'
    interpretation = CENTERING_INTERPRETATION_TEXT[measurement.interpretation] ?? 'Centering measurement unavailable'
    helper         = measurement.fallback_reason === 'borderless_card'
      ? 'Inner frame not detected — common for full-art / borderless cards.'
      : 'Inner frame could not be measured reliably for this image.'
  } else {
    const r = measurement.ratios
    headline       = `${r.top_bottom} T/B  ·  ${r.left_right} L/R`
    interpretation = CENTERING_INTERPRETATION_TEXT[measurement.interpretation] ?? ''
    helper         = 'Measured from outer card edge to inner print frame.'
  }

  const headlineEl = document.createElement('span')
  headlineEl.className = 'centering-headline'
  headlineEl.textContent = headline
  headerRow.appendChild(headlineEl)

  const back = document.createElement('button')
  back.className = 'lz-back-btn'
  back.textContent = '← All issues'
  back.addEventListener('click', exitCenteringMode)
  headerRow.appendChild(back)

  banner.appendChild(headerRow)

  if (interpretation) {
    const interp = document.createElement('p')
    interp.className = 'centering-interpretation'
    interp.textContent = interpretation
    banner.appendChild(interp)
  }

  if (helper) {
    const help = document.createElement('p')
    help.className = 'centering-helper'
    help.textContent = helper
    banner.appendChild(help)
  }
}

/**
 * Build the centering inspection SVG: thin-stroke outer card boundary
 * (blue), thin-stroke inner printed frame (yellow), and four T/B/L/R
 * margin labels positioned just outside the inner frame.
 *
 * The SVG is rendered inside #lightbox-svg-slot which is positioned by
 * _positionSvgSlot() to cover only the card region of the photo. As a
 * result, the SVG viewBox (0–100) maps to the card region — so the
 * outer card boundary is at (0,0,100,100) and inner_frame_bbox_pct
 * (already in card-fraction space) is scaled up by 100.
 *
 * Returns null when card bounds are unavailable — caller is responsible
 * for displaying the appropriate fallback message in the banner.
 */
function buildCenteringSVG(measurement) {
  if (!measurement) return null
  const NS  = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class',               'centering-overlay')
  svg.setAttribute('viewBox',             '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')

  // ── Outer card boundary (blue, thin stroke, inset 0.4 so the stroke
  // sits inside the viewBox rather than half-clipped at the edges) ──
  const OUTER_INSET = 0.4
  const outer = document.createElementNS(NS, 'rect')
  outer.setAttribute('x',            String(OUTER_INSET))
  outer.setAttribute('y',            String(OUTER_INSET))
  outer.setAttribute('width',        String(100 - 2 * OUTER_INSET))
  outer.setAttribute('height',       String(100 - 2 * OUTER_INSET))
  outer.setAttribute('fill',         'none')
  outer.setAttribute('stroke',       '#5fa8ff')
  outer.setAttribute('stroke-width', '0.5')
  outer.setAttribute('class',        'centering-outer-rect')
  const outerTitle = document.createElementNS(NS, 'title')
  outerTitle.textContent = 'Outer card edge'
  outer.appendChild(outerTitle)
  svg.appendChild(outer)

  // ── Inner frame (yellow, thin stroke) — only when detected ──
  const inner = measurement.inner_frame_bbox_pct
  if (inner) {
    const ix = inner.x * 100
    const iy = inner.y * 100
    const iw = inner.w * 100
    const ih = inner.h * 100

    const innerRect = document.createElementNS(NS, 'rect')
    innerRect.setAttribute('x',            String(ix))
    innerRect.setAttribute('y',            String(iy))
    innerRect.setAttribute('width',        String(iw))
    innerRect.setAttribute('height',       String(ih))
    innerRect.setAttribute('fill',         'none')
    innerRect.setAttribute('stroke',       '#ffd84a')
    innerRect.setAttribute('stroke-width', '0.5')
    innerRect.setAttribute('class',        'centering-inner-rect')
    const innerTitle = document.createElementNS(NS, 'title')
    innerTitle.textContent = 'Inner printed frame'
    innerRect.appendChild(innerTitle)
    svg.appendChild(innerRect)

    // ── T/B/L/R margin labels — only when margins were computed ──
    const m = measurement.margins_pct
    if (m) {
      // Label positions: each label sits inside the gap between the inner
      // frame edge and the outer card edge, centered on the relevant axis.
      // We render labels with a dark stroke for legibility on any background.
      const labelDefs = [
        // T: above inner top, centered horizontally on inner rect
        { text: `T: ${m.top}`,    x: ix + iw / 2, y: iy / 2,              anchor: 'middle', baseline: 'middle' },
        // B: below inner bottom
        { text: `B: ${m.bottom}`, x: ix + iw / 2, y: iy + ih + (100 - iy - ih) / 2, anchor: 'middle', baseline: 'middle' },
        // L: left of inner left, centered vertically on inner rect
        { text: `L: ${m.left}`,   x: ix / 2,                              y: iy + ih / 2, anchor: 'middle', baseline: 'middle' },
        // R: right of inner right
        { text: `R: ${m.right}`,  x: ix + iw + (100 - ix - iw) / 2,       y: iy + ih / 2, anchor: 'middle', baseline: 'middle' },
      ]

      labelDefs.forEach(({ text, x, y, anchor, baseline }) => {
        const t = document.createElementNS(NS, 'text')
        t.setAttribute('x',                 String(x))
        t.setAttribute('y',                 String(y))
        t.setAttribute('text-anchor',       anchor)
        t.setAttribute('dominant-baseline', baseline)
        t.setAttribute('class',             'centering-margin-label')
        t.textContent = text
        svg.appendChild(t)
      })
    }
  }

  return svg
}

/**
 * Compute the actual rendered rect of an <img> with object-fit:contain
 * within a container of known dimensions. Returns {x, y, w, h} in px.
 */
function _containedImageRect(imgEl, containerW, containerH) {
  const iw = imgEl.naturalWidth
  const ih = imgEl.naturalHeight
  if (!iw || !ih) return { x: 0, y: 0, w: containerW, h: containerH }
  const containerAspect = containerW / containerH
  const imageAspect = iw / ih
  if (imageAspect > containerAspect) {
    // Image wider relative to container: fit to width, letterbox top/bottom
    const h = containerW / imageAspect
    return { x: 0, y: (containerH - h) / 2, w: containerW, h }
  } else {
    // Image taller relative to container: fit to height, pillarbox left/right
    const w = containerH * imageAspect
    return { x: (containerW - w) / 2, y: 0, w, h: containerH }
  }
}

/**
 * Position #lightbox-svg-slot to cover only the card region within the
 * displayed image, using the normalized card bounds returned by the backend.
 * Falls back to full-area when bounds are null (card fills frame, or detection failed).
 */
function _positionSvgSlot(svgSlot, imgEl, bounds) {
  if (!bounds) {
    svgSlot.style.cssText = ''   // revert to CSS inset:0
    return
  }
  const inner = _zInner()
  if (!inner) { svgSlot.style.cssText = ''; return }

  const apply = () => {
    const W = inner.clientWidth
    const H = inner.clientHeight
    if (!W || !H) return
    const r = _containedImageRect(imgEl, W, H)
    const cardX = r.x + bounds.x * r.w
    const cardY = r.y + bounds.y * r.h
    const cardW = bounds.w * r.w
    const cardH = bounds.h * r.h
    svgSlot.style.position = 'absolute'
    svgSlot.style.left   = `${cardX}px`
    svgSlot.style.top    = `${cardY}px`
    svgSlot.style.width  = `${cardW}px`
    svgSlot.style.height = `${cardH}px`
    svgSlot.style.right  = 'auto'
    svgSlot.style.bottom = 'auto'
  }

  if (imgEl.complete && imgEl.naturalWidth > 0) {
    apply()
  } else {
    imgEl.addEventListener('load', apply, { once: true })
  }
}

function renderLightboxFrame() {
  const item = _lightboxItems[_lightboxIndex]
  if (!item) return

  const isFocused   = _lightboxMode === 'focused'
  const isCentering = _lightboxMode === 'centering'

  // ── Image ────────────────────────────────────────────────────────
  const imgEl = document.getElementById('lightbox-img')
  imgEl.src = item.url
  imgEl.alt = item.label
  // The img element has pointer-events:none (zoom wrap owns all pointer events),
  // so we wire the focused-mode exit click onto lightbox-zoom-inner instead.
  // Guard against drag: _zDragged is true if the pointer moved > 3px (pan gesture).
  const zInner = document.getElementById('lightbox-zoom-inner')
  if (isFocused || isCentering) {
    zInner.style.cursor = _zs <= 1.005 ? 'pointer' : ''
    zInner.onclick = (e) => {
      if (_zDragged) { _zDragged = false; return }
      if (isCentering) exitCenteringMode()
      else             exitFocusedMode()
    }
  } else {
    zInner.style.cursor = ''
    zInner.onclick = null
  }

  // ── Label ────────────────────────────────────────────────────────
  const sideLabel = _lightboxItems.length > 1
    ? `${item.label}  ·  ${_lightboxIndex + 1} / ${_lightboxItems.length}`
    : item.label
  document.getElementById('lightbox-label').textContent = sideLabel

  // ── SVG overlays — mode-driven ──────────────────────────────────
  // Normal:    clean image (no overlay noise)
  // Focused:   CV evidence + Claude zone highlight
  // Centering: outer card boundary + inner frame + T/B/L/R labels
  const svgSlot = document.getElementById('lightbox-svg-slot')
  svgSlot.innerHTML = ''
  if (isFocused) {
    const cvSvg = buildCVEvidenceSVG(item, _lightboxFocusedZone)
    if (cvSvg) svgSlot.appendChild(cvSvg)
    svgSlot.appendChild(buildZoneSVGFocused(item.zones, _lightboxFocusedZone, _lightboxFocusedSev))
  } else if (isCentering) {
    const centeringSvg = buildCenteringSVG(item.centering ?? null)
    if (centeringSvg) svgSlot.appendChild(centeringSvg)
  }

  // Position the SVG slot over the actual card region (not the full eBay photo)
  _positionSvgSlot(svgSlot, imgEl, item.cardBounds ?? null)

  // ── Banner ───────────────────────────────────────────────────────
  const banner = document.getElementById('lightbox-focused-banner')
  if (isCentering) {
    renderCenteringBanner(banner, item.centering ?? null)
  } else if (isFocused) {
    const sevClass = `lz-badge--${_lightboxFocusedSev ?? 'moderate'}`
    banner.innerHTML =
      `<span class="lz-badge ${sevClass}">${ZONE_LABELS[_lightboxFocusedZone] ?? _lightboxFocusedZone}</span>` +
      `<span class="lightbox-focused-note">${_lightboxFocusedNote ?? ''}</span>` +
      `<button class="lz-back-btn">← All issues</button>`
    banner.classList.remove('hidden')
    banner.querySelector('.lz-back-btn').addEventListener('click', exitFocusedMode)
  } else if (item.zones.length > 0) {
    banner.innerHTML = `<span class="lz-hint">Tap an issue below to locate it on the card</span>`
    banner.classList.remove('hidden')
  } else {
    banner.classList.add('hidden')
  }

  // ── Zone list — hidden in centering mode (banner is the whole UI) ──
  const list = document.getElementById('lightbox-zones-list')
  if (isCentering) {
    list.classList.add('hidden')
    list.innerHTML = ''
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
        const isActive = isFocused && zone === _lightboxFocusedZone
        const li = document.createElement('li')
        li.className = `lz-item lz-item--tappable${isActive ? ' lz-item--active' : ''}`

        const badge = document.createElement('span')
        badge.className = `lz-badge lz-badge--${severity}`
        badge.textContent = ZONE_LABELS[zone] ?? zone

        const txt = document.createElement('span')
        txt.className = 'lz-note'
        txt.textContent = note

        const arrow = document.createElement('span')
        arrow.className = 'lz-locate-arrow'
        arrow.textContent = isActive ? '✕' : '→'

        li.appendChild(badge)
        li.appendChild(txt)
        li.appendChild(arrow)

        li.addEventListener('click', () => {
          if (isActive) {
            exitFocusedMode()
          } else if (zone === 'centering') {
            // Centering has its own dedicated inspection mode — don't try to
            // render it as a generic zone overlay (which would draw nothing,
            // since _zoneRects('centering') returns []).
            openLightboxCenteringMode(_lightboxIndex)
          } else {
            _lightboxMode        = 'focused'
            _lightboxFocusedZone = zone
            _lightboxFocusedNote = note
            _lightboxFocusedSev  = severity
            renderLightboxFrame()
          }
        })

        list.appendChild(li)
      })
    }
  }

  // ── Prev / next navigation ───────────────────────────────────────
  const nav = document.getElementById('lightbox-nav')
  nav.classList.toggle('hidden', _lightboxItems.length <= 1)
  document.getElementById('lightbox-prev').disabled = _lightboxIndex === 0
  document.getElementById('lightbox-next').disabled = _lightboxIndex === _lightboxItems.length - 1
}

// ── Lightbox zoom engine ───────────────────────────────────────────
//
// State: scale + translate(tx, ty) with transform-origin 0 0.
// Transform applied as: translate(tx, ty) scale(scale)
// A point (px, py) in wrap-space maps to inner-space as: ((px-tx)/s, (py-ty)/s)
// Zooming toward cursor: newTx = px - (newS/s) * (px - tx)

let _zs = 1      // current zoom scale
let _ztx = 0     // current translate X (px, wrap coords)
let _zty = 0     // current translate Y (px, wrap coords)

// Pan drag state
let _zPanActive = false
let _zPanX0 = 0, _zPanY0 = 0   // pointer start
let _zTx0   = 0, _zTy0   = 0   // translate at drag start
let _zDragged = false           // true once pointer moves > threshold

// Pinch state
let _zPinchDist0  = 0
let _zPinchScale0 = 1
let _zPinchTx0    = 0, _zPinchTy0 = 0
let _zPinchMx     = 0, _zPinchMy  = 0  // midpoint in wrap coords

function _zWrap() { return document.getElementById('lightbox-img-wrap') }
function _zInner() { return document.getElementById('lightbox-zoom-inner') }

function resetZoom() {
  _zs = 1; _ztx = 0; _zty = 0
  _zPanActive = false
  _zDragged   = false
  _applyZoom()
}

function _clampPan(w, h) {
  // Element is (s*w) × (s*h); keep it from drifting outside the wrap
  _ztx = Math.min(0, Math.max((1 - _zs) * w, _ztx))
  _zty = Math.min(0, Math.max((1 - _zs) * h, _zty))
}

function _applyZoom() {
  const inner = _zInner()
  const wrap  = _zWrap()
  if (!inner || !wrap) return

  const zoomed = _zs > 1.005
  inner.style.transform = `translate(${_ztx}px,${_zty}px) scale(${_zs})`
  wrap.style.cursor = zoomed ? (_zPanActive ? 'grabbing' : 'grab') : 'zoom-in'

  const badge = document.getElementById('lightbox-zoom-badge')
  const hint  = document.getElementById('lightbox-zoom-hint')
  if (badge) {
    badge.textContent = `${Math.round(_zs * 100)}%`
    badge.classList.toggle('hidden', !zoomed)
  }
  if (hint) hint.classList.toggle('hidden', !zoomed)
}

// ── Wheel zoom ─────────────────────────────────────────────────────
function _onWheel(e) {
  e.preventDefault()
  const wrap = _zWrap()
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()

  const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12)
  const newS   = Math.min(8, Math.max(1, _zs * factor))
  if (newS === _zs) return

  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const r  = newS / _zs
  _ztx = px - r * (px - _ztx)
  _zty = py - r * (py - _zty)
  _zs  = newS

  if (_zs <= 1.005) { _zs = 1; _ztx = 0; _zty = 0 }
  else _clampPan(rect.width, rect.height)
  _applyZoom()
}

// ── Double-click: zoom 2× toward click, or reset if already zoomed ──
function _onDblClick(e) {
  e.preventDefault()
  const wrap = _zWrap()
  if (!wrap) return
  if (_zs > 1.005) {
    resetZoom()
    return
  }
  const rect = wrap.getBoundingClientRect()
  const px   = e.clientX - rect.left
  const py   = e.clientY - rect.top
  const newS = 2.5
  const r    = newS / _zs
  _ztx = px - r * (px - _ztx)
  _zty = py - r * (py - _zty)
  _zs  = newS
  _clampPan(rect.width, rect.height)
  _applyZoom()
}

// ── Pointer drag (pan when zoomed) ─────────────────────────────────
function _onPointerDown(e) {
  if (e.button !== 0 || _zs <= 1.005) return
  e.preventDefault()
  _zPanActive = true
  _zDragged   = false
  _zPanX0     = e.clientX
  _zPanY0     = e.clientY
  _zTx0       = _ztx
  _zTy0       = _zty
  _applyZoom()
  window.addEventListener('pointermove', _onPointerMove, { passive: false })
  window.addEventListener('pointerup',   _onPointerUp)
}

function _onPointerMove(e) {
  if (!_zPanActive) return
  const dx = e.clientX - _zPanX0
  const dy = e.clientY - _zPanY0
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _zDragged = true
  const wrap = _zWrap()
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  _ztx = _zTx0 + dx
  _zty = _zTy0 + dy
  _clampPan(rect.width, rect.height)
  _applyZoom()
}

function _onPointerUp() {
  _zPanActive = false
  window.removeEventListener('pointermove', _onPointerMove)
  window.removeEventListener('pointerup',   _onPointerUp)
  _applyZoom()
}

// ── Touch pinch-to-zoom ────────────────────────────────────────────
function _touchDist(t) { return Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY) }

function _onTouchStart(e) {
  if (e.touches.length !== 2) return
  e.preventDefault()
  const wrap = _zWrap()
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  _zPinchDist0  = _touchDist(e.touches)
  _zPinchScale0 = _zs
  _zPinchTx0    = _ztx
  _zPinchTy0    = _zty
  _zPinchMx     = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
  _zPinchMy     = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
}

function _onTouchMove(e) {
  if (e.touches.length !== 2) return
  e.preventDefault()
  const wrap = _zWrap()
  if (!wrap) return
  const rect  = wrap.getBoundingClientRect()
  const dist  = _touchDist(e.touches)
  const newS  = Math.min(8, Math.max(1, _zPinchScale0 * (dist / _zPinchDist0)))
  const r     = newS / _zPinchScale0
  _ztx = _zPinchMx - r * (_zPinchMx - _zPinchTx0)
  _zty = _zPinchMy - r * (_zPinchMy - _zPinchTy0)
  _zs  = newS
  if (_zs <= 1.005) { _zs = 1; _ztx = 0; _zty = 0 }
  else _clampPan(rect.width, rect.height)
  _applyZoom()
}

// ── Wire zoom events to the wrap ───────────────────────────────────
;(function attachZoomListeners() {
  const wrap = _zWrap()
  if (!wrap) return
  wrap.addEventListener('wheel',       _onWheel,      { passive: false })
  wrap.addEventListener('dblclick',    _onDblClick)
  wrap.addEventListener('pointerdown', _onPointerDown)
  wrap.addEventListener('touchstart',  _onTouchStart, { passive: false })
  wrap.addEventListener('touchmove',   _onTouchMove,  { passive: false })
})()

// ── Reset zoom when lightbox opens / navigates ─────────────────────
// (called from openLightbox, openLightboxFocused, and nav buttons)

document.getElementById('lightbox-close').addEventListener('click', closeLightbox)
document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox)
document.getElementById('lightbox-prev').addEventListener('click', () => {
  if (_lightboxIndex > 0) { _lightboxIndex--; resetZoom(); renderLightboxFrame() }
})
document.getElementById('lightbox-next').addEventListener('click', () => {
  if (_lightboxIndex < _lightboxItems.length - 1) { _lightboxIndex++; resetZoom(); renderLightboxFrame() }
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
function renderAnalyzedImages(urls, allZones, cvSurfaceGrid, cvCornerBoxes, cvEdgeBands, cardBoundsPct, centeringData) {
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
    const cardBounds = cardBoundsPct?.[i] ?? null
    const centering  = centeringData?.[i] ?? null
    _lightboxItems.push({ url, zones, label, gridCells, cornerBoxes, edgeBands, cardBounds, centering })

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

    // Thumbnails are kept clean — no overlay noise.
    // A small severity dot signals "issues found; tap to explore in lightbox."
    const worstSev =
      zones.find(z => z.severity === 'heavy')    ? 'heavy'    :
      cornerBoxes.find(b => b.severity === 'heavy')   ? 'heavy'    :
      zones.find(z => z.severity === 'moderate') ? 'moderate' :
      cornerBoxes.find(b => b.severity === 'moderate') ? 'moderate' :
      edgeBands.find(b => b.severity === 'moderate')   ? 'moderate' :
      zones.length > 0 || cornerBoxes.length > 0 || edgeBands.length > 0 ||
        gridCells.some(c => !c.glare_masked) ? 'light' : null

    if (worstSev) {
      const dot = document.createElement('div')
      dot.className = `thumb-issue-dot thumb-issue-dot--${worstSev}`
      dot.title = 'Issues detected — tap to explore'
      wrap.appendChild(dot)
    }

    const lbl = document.createElement('span')
    lbl.className = 'analyzed-thumb-label'
    lbl.textContent = label

    item.appendChild(wrap)
    item.appendChild(lbl)
    item.addEventListener('click', () => openLightbox(i))
    strip.appendChild(item)
  })

  // No always-on legend — interaction happens in the lightbox.
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
          if (zone === 'centering') {
            // Centering has its own inspection mode — outer + inner frame
            // overlay with T/B/L/R margin labels, not a generic zone highlight.
            openLightboxCenteringMode(thumbIndex)
          } else {
            openLightboxFocused(thumbIndex, zone, issueText, severity)
          }
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
  const cardBoundsPct = Array.isArray(payload.card_bounds_pct) ? payload.card_bounds_pct : null
  const centeringData = Array.isArray(payload.centering)       ? payload.centering       : null
  renderAnalyzedImages(_analyzedUrls, [frontZones, backZones], cvSurfaceGrid, cvCornerBoxes, cvEdgeBands, cardBoundsPct, centeringData)
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
