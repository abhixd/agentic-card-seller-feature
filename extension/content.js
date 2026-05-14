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
    // eBay stores full-res URLs in data-zoom-src or data-src attributes
    const imgs = new Set()

    // Primary image carousel
    document.querySelectorAll('.ux-image-carousel-item img, .filmstrip img, .vi-image-hero img').forEach(img => {
      const src = img.getAttribute('data-zoom-src') || img.getAttribute('data-src') || img.src
      if (src && src.startsWith('http') && !src.includes('s-l64')) {
        imgs.add(src.replace(/s-l\d+\./, 's-l1600.'))
      }
    })

    // Thumbnail strip — grab original resolution equivalents
    document.querySelectorAll('[data-idx] img').forEach(img => {
      const src = img.getAttribute('data-zoom-src') || img.getAttribute('data-src') || img.src
      if (src && src.startsWith('http')) {
        imgs.add(src.replace(/s-l\d+\./, 's-l1600.'))
      }
    })

    // Fallback: all visible listing images
    if (imgs.size === 0) {
      document.querySelectorAll('.vi_main_img_fs img, #icImg').forEach(img => {
        if (img.src && img.src.startsWith('http')) imgs.add(img.src)
      })
    }

    return [...imgs].slice(0, 8) // cap at 8 images
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
      <button id="cga-analyze-btn" title="Analyze grading potential + ROI">
        <span class="cga-icon">🔍</span>
        <span class="cga-label">Analyze Card</span>
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
    setStatus('Sending to analyzer…', 'info')

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
      chrome.runtime.sendMessage({ type: 'ANALYZE_CARD', payload }, (resp) => {
        if (chrome.runtime.lastError) {
          setStatus('Extension error — try reloading.', 'error')
          btn.disabled = false
          return
        }
        setStatus('Analysis started — check the side panel ↗', 'ok')
        setTimeout(() => setStatus(''), 4000)
        btn.disabled = false
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
