/**
 * content.js — Card Seller OS content script (eBay listing pages only)
 *
 * Extracts: title, price, shipping, image URLs from the current eBay listing
 * and sends to background.js for the side panel to display.
 *
 * Runs at document_idle on https://www.ebay.com/itm/* pages.
 */

(function () {
  "use strict";

  let navObserver = null;   // declared first — assigned by observeNavigation()

  // Guard against double-injection. content.js auto-injects at document_idle, but
  // the side panel can also inject it on demand (chrome.scripting) when a tab
  // predated an extension reload. Without this guard we'd attach duplicate
  // message listeners and navigation observers.
  if (window.__cardSellerOsInjected) {
    extractAndSend();   // refresh the stored listing, but don't re-wire listeners
    return;
  }
  window.__cardSellerOsInjected = true;

  // Run once the page is loaded; retry on SPA nav
  extractAndSend();
  injectFab();
  observeNavigation();

  // eBay can finish rendering price/images shortly after document_idle — retry a
  // few times so the listing is detected and the floating button appears.
  [600, 1500, 3000].forEach((d) => setTimeout(() => { extractAndSend(); injectFab(); }, d));

  // chrome.runtime.id becomes undefined once the extension is reloaded/updated;
  // any sendMessage from this stale content script then throws "Extension context
  // invalidated". Guard against it and stop reacting so we don't spam the console.
  function contextValid() {
    return !!(chrome.runtime && chrome.runtime.id);
  }
  function teardown() {
    try { navObserver && navObserver.disconnect(); } catch { /* noop */ }
    navObserver = null;
  }
  function safeSend(msg) {
    if (!contextValid()) { teardown(); return; }
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      teardown();   // context invalidated mid-call (extension reloaded)
    }
  }

  function extractAndSend() {
    const listing = extractListing();
    if (!listing) return;
    safeSend({ type: "LISTING_DETECTED", listing });
  }

  // ── Floating "Grade card" button ──────────────────────────────────────────
  // Chrome (MV3) can't auto-open the side panel on navigation, so we inject an
  // in-page button that appears on every card page. Clicking it is the user
  // gesture that lets the background open the side panel.
  function injectFab() {
    if (document.getElementById("cardseller-fab")) return;
    if (!extractListing()) return;   // only show on real item pages

    const btn = document.createElement("button");
    btn.id = "cardseller-fab";
    btn.type = "button";
    btn.textContent = "🃏 Grade card";
    Object.assign(btn.style, {
      position: "fixed", right: "18px", top: "42%", zIndex: "2147483647",
      padding: "11px 16px", background: "#388bfd", color: "#fff",
      border: "none", borderRadius: "10px", fontSize: "13px", fontWeight: "700",
      fontFamily: "system-ui, -apple-system, sans-serif", cursor: "pointer",
      boxShadow: "0 3px 12px rgba(0,0,0,0.35)",
    });
    btn.addEventListener("mouseenter", () => { btn.style.background = "#58a6ff"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#388bfd"; });
    btn.addEventListener("click", () => {
      // The click provides the user gesture; background opens the side panel.
      safeSend({ type: "OPEN_PANEL" });
    });
    document.body.appendChild(btn);
  }

  // ── Extraction helpers ────────────────────────────────────────────────────

  function extractListing() {
    const title    = extractTitle();
    const price    = extractPrice();
    const shipping = extractShipping();
    const images   = extractImages();
    if (!title || !price || images.length === 0) return null;

    return {
      url:        window.location.href,
      title,
      price,
      shipping,
      image_urls: images,
      extracted_at: Date.now(),
    };
  }

  function extractTitle() {
    // eBay's main title element (multiple possible selectors across page variants)
    const selectors = [
      "h1.x-item-title__mainTitle span",
      "h1.x-item-title__mainTitle",
      "#itemTitle",
      "h1[data-testid='x-item-title']",
      ".x-item-title__mainTitle",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return null;
  }

  function extractPrice() {
    // Primary price (not "buy it now shipping" or "was" price)
    const selectors = [
      ".x-price-primary .ux-textspans",
      ".x-price-primary",
      "#prcIsum",
      "[data-testid='x-price-section'] .ux-textspans",
      ".u-flL.vi-price",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.textContent.replace(/[^0-9.]/g, "");
      const val  = parseFloat(text);
      if (val > 0) return val;
    }
    return null;
  }

  function extractShipping() {
    const selectors = [
      "#fshippingCost",
      ".ux-labels-values__values .ux-textspans",
      "[data-testid='ux-labels-values'] .ux-textspans",
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent.toLowerCase();
        if (text.includes("free")) return 0;
        if (text.includes("ship") || text.includes("+")) {
          const val = parseFloat(el.textContent.replace(/[^0-9.]/g, ""));
          if (val >= 0) return val;
        }
      }
    }
    return 0;
  }

  function extractImages() {
    const seen = new Set();
    const urls = [];

    // eBay image carousel — largest variants
    const imgEls = document.querySelectorAll(
      ".ux-image-carousel-item img, " +
      ".ux-image-magnify__image--original, " +
      ".img[data-zoom-src], " +
      "#icImg"
    );

    for (const img of imgEls) {
      // Prefer zoom/large src over thumbnail
      const src = img.getAttribute("data-zoom-src")
        || img.getAttribute("data-src")
        || img.src
        || "";

      if (!src || src.startsWith("data:")) continue;

      // Upgrade to s-l1600 for max resolution
      const large = src
        .replace(/s-l\d+/, "s-l1600")
        .replace(/s-l\d+\.jpg/, "s-l1600.jpg");

      if (!seen.has(large) && large.includes("ebayimg.com")) {
        seen.add(large);
        urls.push(large);
      }
    }

    // Fallback: meta og:image
    if (urls.length === 0) {
      const og = document.querySelector('meta[property="og:image"]');
      if (og && og.content) urls.push(og.content);
    }

    return urls.slice(0, 24); // eBay allows up to 24 photos per listing
  }

  // ── SPA navigation observer ───────────────────────────────────────────────
  // eBay uses pushState for navigation — observe URL changes

  let lastUrl = location.href;

  function observeNavigation() {
    navObserver = new MutationObserver(() => {
      if (!contextValid()) { teardown(); return; }
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => { extractAndSend(); injectFab(); }, 1200); // wait for React render
      }
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Message listener (from side panel) ───────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "REQUEST_LISTING") {
      sendResponse({ listing: extractListing() });
    }
    if (msg.type === "FETCH_IMAGE_DATA") {
      fetchImageAsBase64(msg.url)
        .then((data) => sendResponse({ data }))
        .catch(() => sendResponse({ data: null }));
      return true;
    }
  });

  async function fetchImageAsBase64(url) {
    const img    = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.90).split(",")[1];
  }
})();
