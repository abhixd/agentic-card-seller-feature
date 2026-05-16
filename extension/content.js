/**
 * content.js — eBay item page content script
 *
 * Responsibilities:
 *  - Extract listing data (title, price, shipping, image URLs)
 *  - Inject "Analyze Card" button near the price block
 *  - Send ANALYZE_CARD message to background on button click
 */

'use strict'

;(function () {
  // Only run once per page
  if (document.getElementById('cga-analyze-btn')) return

  // ── Data extraction ─────────────────────────────────────────────

  function getTitle() {
    const el =
      document.querySelector('h1.x-item-title__mainTitle span') ||
      document.querySelector('h1[itemprop="name"]') ||
      document.querySelector('.x-item-title__mainTitle') ||
      document.querySelector('h1')
    return el ? el.textContent.trim() : document.title
  }

  function parsePrice(str) {
    if (!str) return 0
    const m = str.replace(/,/g, '').match(/[\d.]+/)
    return m ? parseFloat(m[0]) : 0
  }

  function getPrice() {
    const el =
      document.querySelector('.x-price-primary .ux-textspans') ||
      document.querySelector('[itemprop="price"]') ||
      document.querySelector('.notranslate[id*="prcIsum"]')
    if (!el) return 0
    return parsePrice(el.getAttribute('content') || el.textContent)
  }

  function getShipping() {
    const el =
      document.querySelector('.ux-labels-values--shipping .ux-textspans--BOLD') ||
      document.querySelector('#fshippingCost .notranslate') ||
      document.querySelector('[data-testid="ux-labels-values__values-content"] .ux-textspans--BOLD')
    if (!el) return 0
    const txt = el.textContent.toLowerCase()
    if (txt.includes('free')) return 0
    return parsePrice(txt)
  }

  function getImageUrls() {
    const imgs = new Set()

    // ── 1. Thumbnail filmstrip (always loaded eagerly by eBay) ─────
    // Modern eBay (2023+) renders thumbnails with several possible selectors.
    // We collect every thumbnail src and upscale to s-l1600 by replacing the
    // size token (s-l64, s-l140, s-l500, etc.) — this gives us ALL images
    // regardless of which one is currently visible in the hero carousel.
    const thumbSelectors = [
      '.ux-image-filmstrip-item img',   // current eBay redesign
      '.ux-image-carousel-item img',    // some listing layouts
      '[data-idx] img',                 // older eBay layout
      '.filmstrip img',                 // legacy
      '.tdThumb img',                   // very old layout
    ]
    thumbSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(img => {
        // Prefer data-src / data-zoom-src if set; fall back to visible src
        const raw = img.getAttribute('data-zoom-src')
                 || img.getAttribute('data-src')
                 || img.src
        if (raw && raw.startsWith('http')) {
          // Upscale: replace any s-l<number> size token with s-l1600
          imgs.add(raw.replace(/s-l\d+/g, 's-l1600'))
        }
      })
    })

    // ── 2. Hero / main image (catches the currently zoomed image) ──
    document.querySelectorAll('.vi-image-hero img, #icImg, .vi_main_img_fs img').forEach(img => {
      const raw = img.getAttribute('data-zoom-src') || img.getAttribute('data-src') || img.src
      if (raw && raw.startsWith('http')) {
        imgs.add(raw.replace(/s-l\d+/g, 's-l1600'))
      }
    })

    // ── 3. Filter out obvious non-card images ──────────────────────
    // eBay sometimes injects icon/sprite URLs into carousel containers.
    const filtered = [...imgs].filter(url =>
      !url.includes('s.yimg.com') &&
      !url.includes('ir.ebaystatic.com') &&
      !url.includes('svgs.ebayimg.com')
    )

    return filtered.slice(0, 8) // cap at 8 — Claude accepts up to 20, but 8 is plenty
  }

  function buildPayload() {
    return {
      listing_url:   window.location.href,
      title:         getTitle(),
      price:         getPrice(),
      shipping:      getShipping(),
      image_urls:    getImageUrls(),
      marketplace:   'ebay',
    }
  }

  // ── Button injection ────────────────────────────────────────────

  function injectButton() {
    // Find a good anchor — the "Buy It Now" price block or the bid section
    const anchor =
      document.querySelector('.x-price-primary') ||
      document.querySelector('.u-price-full-block') ||
      document.querySelector('#prcIsum_bidPrice') ||
      document.querySelector('.vi-price')

    if (!anchor) {
      // Retry in 1 s — page may still be rendering
      setTimeout(injectButton, 1000)
      return
    }

    if (document.getElementById('cga-analyze-btn')) return

    const wrapper = document.createElement('div')
    wrapper.id = 'cga-wrapper'
    wrapper.innerHTML = `
      <button id="cga-analyze-btn" title="Select images and analyze grading potential + ROI">
        <span class="cga-icon">🖼</span>
        <span class="cga-label">Select &amp; Analyze</span>
      </button>
      <div id="cga-status"></div>
    `

    anchor.parentElement.insertBefore(wrapper, anchor.nextSibling)

    document.getElementById('cga-analyze-btn').addEventListener('click', onAnalyzeClick)
  }

  function setStatus(text, type = '') {
    const el = document.getElementById('cga-status')
    if (!el) return
    el.textContent = text
    el.className = type ? `cga-status--${type}` : ''
  }

  async function onAnalyzeClick() {
    const btn = document.getElementById('cga-analyze-btn')
    if (!btn) return

    btn.disabled = true
    setStatus('Opening image picker…', 'info')

    const payload = buildPayload()

    if (!payload.title) {
      setStatus('Could not read listing title.', 'error')
      btn.disabled = false
      return
    }
    if (!payload.image_urls.length) {
      setStatus('No card images found on page.', 'error')
      btn.disabled = false
      return
    }

    try {
      chrome.runtime.sendMessage({ type: 'CARD_IMAGES_READY', payload }, (resp) => {
        if (chrome.runtime.lastError) {
          setStatus('Extension error — try reloading.', 'error')
          btn.disabled = false
          return
        }
        setStatus('Select images in the side panel ↗', 'ok')
        setTimeout(() => { setStatus(''); btn.disabled = false }, 3000)
      })
    } catch (err) {
      setStatus('Could not reach extension background.', 'error')
      btn.disabled = false
    }
  }

  // ── Init ────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton)
  } else {
    injectButton()
  }

  // Re-inject if eBay does a soft navigation (SPA-style page swap)
  const _observer = new MutationObserver(() => {
    if (!document.getElementById('cga-analyze-btn')) injectButton()
  })
  _observer.observe(document.body, { childList: true, subtree: false })
})()
