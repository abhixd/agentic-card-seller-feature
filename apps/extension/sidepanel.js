/**
 * sidepanel.js — Card Seller OS side panel logic
 *
 * State machine:
 *   idle → listing → loading → results | error
 *
 * Talks to background.js via chrome.runtime.sendMessage.
 * Background holds the listing state in chrome.storage.local.
 */

"use strict";

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const VIEWS = ["idle", "listing", "loading", "error", "results", "detail", "offline"];

// ── State ─────────────────────────────────────────────────────────────────
let currentListing = null;
let currentResult  = null;   // last analysis result — used by detail views
let loadingTimer   = null;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await checkServer();
  await restoreState();
  wireEvents();

  // Listen for listing updates from background
  chrome.runtime.onMessage.addListener(onMessage);

  // Storage change (listing updated while panel is open)
  chrome.storage.onChanged.addListener(onStorageChange);
});

// ── Server health ─────────────────────────────────────────────────────────
// The grading backend is now the Python grading_server (YOLO + Claude pipeline).
async function checkServer() {
  const { ok } = await sendBg({ type: "HEALTH_CHECK_PYTHON" });
  const dot = $("status-dot");
  dot.className = `dot ${ok ? "dot-ok" : "dot-error"}`;
  dot.title = ok
    ? "Grading server running"
    : "Grading server offline — run grading_server (uvicorn server:app --port 8000)";
  return ok;
}

// ── State restore ─────────────────────────────────────────────────────────
async function restoreState() {
  const { pendingListing, lastResult } = await chrome.storage.local.get([
    "pendingListing",
    "lastResult",
  ]);

  // 1. Detect the listing on the CURRENTLY-open tab first (auto-injects the
  //    content script if the tab predated an extension reload). This takes
  //    priority so a stale result from a previous session never hides the card
  //    the user is actually looking at.
  let liveListing = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) liveListing = await requestListingFromTab(tab.id);
  } catch { /* not an eBay tab */ }

  // 2. Show a cached result ONLY if it's for the same card (or we can't detect a
  //    live one). Otherwise the user moved to a new card → show its analyze view.
  if (lastResult?.result) {
    const cached = lastResult.listing;
    const sameCard = liveListing && cached &&
      (cached.url === liveListing.url || cached.title === liveListing.title);
    if (sameCard || !liveListing) {
      currentListing = cached || liveListing || pendingListing || null;
      if (isPsaShape(lastResult.result)) renderPSAResult(lastResult.result, currentListing);
      else renderResults(lastResult.result, currentListing);
      show("results");
      return;
    }
  }

  // 3. Show the analyze view for the live (or last cached) listing.
  const listing = liveListing || pendingListing;
  if (listing) {
    currentListing = listing;
    await chrome.storage.local.set({ pendingListing: listing });
    populateListingView(listing);
    show("listing");
    return;
  }

  // 4. Nothing found — idle with instructions.
  show("idle");
}

// ── Message handler ───────────────────────────────────────────────────────
function onMessage(msg) {
  if (msg.type === "LISTING_READY" && msg.listing) {
    currentListing = msg.listing;
    chrome.storage.local.remove("lastResult");
    populateListingView(msg.listing);
    show("listing");
  }
}

function onStorageChange(changes) {
  if (changes.pendingListing?.newValue) {
    const listing = changes.pendingListing.newValue;
    currentListing = listing;
    populateListingView(listing);
    const loadingEl = document.getElementById("view-loading");
    const isLoading = loadingEl && !loadingEl.classList.contains("hidden");
    if (!isLoading) {
      chrome.storage.local.remove("lastResult");
      show("listing");
    }
  }
}

// ── Populate listing view ─────────────────────────────────────────────────
// ── Front/back image selection ─────────────────────────────────────────────
let selFront = 0;          // index into the listing's image_urls (graded image)
let selBack  = null;       // index, or null
let gallerySig = null;     // url of the listing the current selection applies to

function populateListingView(listing) {
  // Reset the front/back selection when a different card is loaded.
  if (gallerySig !== listing.url) {
    gallerySig = listing.url;
    selFront = 0;
    selBack  = listing.image_urls.length > 1 ? 1 : null;
  }

  $("listing-title").textContent    = listing.title;
  $("listing-price").textContent    = `$${listing.price.toFixed(2)}`;
  $("listing-shipping").textContent = listing.shipping
    ? `+ $${listing.shipping.toFixed(2)} shipping`
    : "Free shipping";
  $("listing-imgs").textContent     = `${listing.image_urls.length} image${listing.image_urls.length !== 1 ? "s" : ""} found`;

  renderGallery(listing);
}

// Render every thumbnail with Front/Back role badges. The big thumb mirrors the
// chosen front image.
function renderGallery(listing) {
  const thumb = $("listing-thumb");
  const frontUrl = listing.image_urls[selFront] ?? listing.image_urls[0];
  if (frontUrl) {
    thumb.src = frontUrl;
    thumb.style.display = "";
    thumb.onerror = () => { thumb.style.display = "none"; };
  }

  const gallery = $("listing-gallery");
  gallery.innerHTML = "";
  listing.image_urls.forEach((url, i) => {
    const cell = document.createElement("div");
    cell.className = "thumb-cell";
    cell.dataset.idx = String(i);
    if (i === selFront) cell.classList.add("is-front");
    if (i === selBack)  cell.classList.add("is-back");

    const img = document.createElement("img");
    img.className = "thumb-img";
    img.src = url;
    img.loading = "lazy";
    img.onerror = () => { cell.style.display = "none"; };
    cell.appendChild(img);

    // Hover to see the photo large (so front vs back is easy to tell apart).
    cell.addEventListener("mouseenter", () => showGalleryPreview(url));
    cell.addEventListener("mouseleave", hideGalleryPreview);

    if (i === selFront || i === selBack) {
      const badge = document.createElement("div");
      badge.className = `thumb-badge ${i === selFront ? "tb-front" : "tb-back"}`;
      badge.textContent = i === selFront ? "Front" : "Back";
      cell.appendChild(badge);
    }
    gallery.appendChild(cell);
  });
}

// Large hover preview so small thumbnails are legible (front vs back).
function showGalleryPreview(url) {
  let el = document.getElementById("gallery-preview");
  if (!el) {
    el = document.createElement("div");
    el.id = "gallery-preview";
    el.className = "gallery-preview";
    const img = document.createElement("img");
    el.appendChild(img);
    document.body.appendChild(el);
  }
  el.querySelector("img").src = url;
  el.classList.add("visible");
}
function hideGalleryPreview() {
  document.getElementById("gallery-preview")?.classList.remove("visible");
}

// Intent-based selection: first tap → Front, next different tap → Back, tapping
// an already-selected photo deselects it, a further tap replaces Front.
function onGalleryClick(e) {
  const cell = e.target.closest(".thumb-cell");
  if (!cell || !currentListing) return;
  const i = Number(cell.dataset.idx);

  if (i === selFront)        selFront = null;
  else if (i === selBack)    selBack = null;
  else if (selFront === null) { selFront = i; }
  else if (selBack === null)  { selBack = i; }
  else                        { selFront = i; }   // both set → replace front

  renderGallery(currentListing);
}

// ── Events ────────────────────────────────────────────────────────────────
function wireEvents() {
  $("btn-analyze").addEventListener("click", runAnalysis);
  $("listing-gallery").addEventListener("click", onGalleryClick);

  $("btn-reload-listing").addEventListener("click", async () => {
    $("btn-reload-listing").textContent = "⏳ Loading…";
    $("btn-reload-listing").disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");
      const listing = await requestListingFromTab(tab.id);
      if (listing) {
        currentListing = listing;
        await chrome.storage.local.set({ pendingListing: listing });
        populateListingView(listing);
        show("listing");
      } else {
        $("btn-reload-listing").textContent = "⚠️ No listing found — are you on an eBay item page?";
      }
    } catch (err) {
      $("btn-reload-listing").textContent = `⚠️ ${err.message}`;
    } finally {
      setTimeout(() => {
        if ($("btn-reload-listing")) {
          $("btn-reload-listing").textContent = "🔄 Load current eBay listing";
          $("btn-reload-listing").disabled = false;
        }
      }, 3000);
    }
  });

  $("btn-retry").addEventListener("click",   () => { show(currentListing ? "listing" : "idle"); });
  $("btn-new").addEventListener("click",     () => {
    chrome.storage.local.remove("lastResult");
    show(currentListing ? "listing" : "idle");
  });
  $("btn-recheck").addEventListener("click", async () => {
    const ok = await checkServer();
    if (ok) show(currentListing ? "listing" : "idle");
  });
  $("upload-input").addEventListener("change", onUpload);
  $("btn-feedback-good").addEventListener("click", () => sendFeedback(true));
  $("btn-feedback-bad").addEventListener("click",  () => sendFeedback(false));
  $("btn-close-panel").addEventListener("click", () => window.close());          // done grading → close the panel
  $("btn-adjust-borders").addEventListener("click", () => openPillarDetail("centering"));  // manual centering correction

  // Pillar drill-down — event delegation so it survives re-renders
  document.addEventListener("click", (e) => {
    const pillar = e.target.closest(".pillar-clickable");
    if (pillar) openPillarDetail(pillar.dataset.pillar);
  });

  $("btn-back-summary").addEventListener("click", () => show("results"));
}

// ── Run analysis ──────────────────────────────────────────────────────────
async function runAnalysis() {
  if (!currentListing) return;

  show("loading");
  startLoadingAnimation();

  const options = { category: "pokemon" };

  // Order images so the chosen Front is graded first, Back second, rest after.
  const urls  = currentListing.image_urls;
  const front = urls[selFront] ?? urls[0];
  const back  = (selBack != null) ? urls[selBack] : null;
  const ordered = [
    front,
    ...(back ? [back] : []),
    ...urls.filter((u) => u !== front && u !== back),
  ];
  const listingForGrade = {
    ...currentListing,
    image_urls: ordered,
    front_url: front,
    back_url: back,
  };

  try {
    const { ok, result, error } = await sendBg({
      type:    "ANALYZE_LISTING",
      listing: listingForGrade,
      options,
    }, 150_000); // Claude Vision + CV detectors can take 30-90 s

    stopLoadingAnimation();

    if (!ok) throw new Error(error || "No response from background (check chrome://extensions Service Worker console)");

    // Persist result
    await chrome.storage.local.set({
      lastResult: { listing: currentListing, result, timestamp: Date.now() },
    });

    renderPSAResult(result, currentListing);
    show("results");
  } catch (err) {
    stopLoadingAnimation();
    $("error-msg").textContent = err.message;
    show("error");
  }
}

// ── Upload mode ───────────────────────────────────────────────────────────
async function onUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (ev) => {
    const dataUrl = ev.target.result;
    const b64     = dataUrl.split(",")[1];

    show("loading");
    $("loading-step").textContent = "Card detection + CV grading…";

    try {
      const { ok, result, error } = await sendBg({
        type:        "GRADE_IMAGE",
        imageData:   b64,
      }, 150_000); // seg detection + CV feature extraction
      if (!ok) throw new Error(error || "Grade failed");
      renderPSAResult(result);
      show("results");
    } catch (err) {
      $("error-msg").textContent = err.message;
      show("error");
    }
  };
  reader.readAsDataURL(file);
}

// ── Loading animation ─────────────────────────────────────────────────────
const STEPS = ["step-1", "step-2", "step-3"];
const STEP_LABELS = [
  "Detecting & cropping card (seg)…",
  "Perspective warp + centering…",
  "Grading pillars (CV model)…",
];

function startLoadingAnimation() {
  let i = 0;
  STEPS.forEach((id) => $( id).className = "step");
  $("step-1").classList.add("active");
  $("loading-step").textContent = STEP_LABELS[0];

  loadingTimer = setInterval(() => {
    if (i < STEPS.length) {
      $( STEPS[i]).classList.remove("active");
      $( STEPS[i]).classList.add("done");
      $( STEPS[i]).textContent = `✓ ${$( STEPS[i]).textContent.replace("✓ ", "")}`;
    }
    i++;
    if (i < STEPS.length) {
      $( STEPS[i]).classList.add("active");
      $("loading-step").textContent = STEP_LABELS[i];
    }
  }, 5000);
}

function stopLoadingAnimation() {
  if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
}

// ── Render results (from /api/grade/analyze) ──────────────────────────────
function renderResults(r, listing) {
  currentResult  = r;
  currentListing = listing || currentListing;
  // Decision banner
  const dec     = r.decision ?? {};
  const banner  = $("decision-banner");
  const label   = dec.label ?? "skip";
  banner.className = `decision-banner ${label}`;
  $("decision-label").textContent  = label.toUpperCase();
  $("decision-reason").textContent = dec.reason ?? "";

  // Card images (trust anchor — show what was analyzed)
  const imgContainer = $("result-images");
  imgContainer.innerHTML = "";
  const urls = listing?.image_urls ?? [];
  urls.slice(0, 4).forEach((url, i) => {
    const wrap  = document.createElement("div"); wrap.className = "img-wrap";
    const img   = document.createElement("img"); img.className = "result-img";
    const lbl   = document.createElement("div"); lbl.className = "result-img-label";
    img.src = url; img.alt = `Image ${i + 1}`;
    img.onerror = () => wrap.remove();
    lbl.textContent = i === 0 ? "Front" : i === 1 ? "Back" : `#${i + 1}`;
    wrap.appendChild(img); wrap.appendChild(lbl); imgContainer.appendChild(wrap);
  });

  // Grade estimate (legacy path — hide the PSA reveal elements, show the classic band row)
  $("grade-reveal").classList.add("hidden");
  $("verdict-banner").classList.add("hidden");
  $("btn-adjust-borders").classList.add("hidden");
  document.querySelector(".grade-row").classList.remove("hidden");
  const ge = r.grade_estimate ?? {};
  $("grade-band").textContent     = ge.grade_range ?? "—";
  const conf = ge.confidence ?? "low";
  const confEl = $("grade-conf");
  confEl.textContent = conf.charAt(0).toUpperCase() + conf.slice(1);
  confEl.className   = `grade-conf ${conf}`;

  // Card identity
  const ci = r.card_identity ?? {};
  const nameParts = [ci.name, ci.set, ci.number].filter(Boolean);
  $("card-name").textContent = nameParts.join(" · ") || "";

  // Grade distribution bar chart
  renderGradeDist(ge.distribution ?? {});

  // Limiting factor
  const lf = ge.limiting_factor;
  const lfEl = $("grade-limiting");
  if (lf) {
    const lfText = {
      front_only:     "⚠ Front-only — back not assessed",
      image_quality:  "⚠ Limited by image quality",
      visible_damage: "⚠ Visible damage noted",
    };
    lfEl.textContent = lfText[lf] ?? `⚠ ${lf}`;
    lfEl.classList.remove("hidden");
  } else {
    lfEl.classList.add("hidden");
  }

  // 4 Pillars
  const issues = r.issues ?? {};
  renderPillarIssues("centering", issues.centering);
  renderPillarIssues("corners",   issues.corners);
  renderPillarIssues("edges",     issues.edges);
  renderPillarIssues("surface",   issues.surface);

  // Economics
  renderEconomics(r.economics ?? {}, listing);

  // AI Reasoning
  const fa = r.front_analysis ?? {};
  const ba = r.back_analysis  ?? {};
  $("reasoning-front").textContent = fa.observations ?? fa.notes ?? "";
  $("reasoning-back").textContent  = ba.observations ?? ba.notes ?? "";
  if (!$("reasoning-front").textContent && !$("reasoning-back").textContent) {
    document.querySelector(".reasoning-details").style.display = "none";
  }

  // Caveats
  const caveats = r.grading_decision?.caveats ?? [];
  const caveatEl = $("caveats-list");
  if (caveats.length) {
    caveatEl.innerHTML = caveats.map((c) =>
      `<div class="caveat">${c}</div>`
    ).join("");
    caveatEl.classList.remove("hidden");
  } else {
    caveatEl.classList.add("hidden");
  }
}

function renderGradeDist(dist) {
  const container = $("grade-dist");
  container.innerHTML = "";
  if (!Object.keys(dist).length) return;

  const grades = ["1","2","3","4","5","6","7","8","9","10"];
  const maxP   = Math.max(...Object.values(dist));

  for (const g of grades) {
    const p = dist[g] ?? 0;
    const wrap  = document.createElement("div"); wrap.className = "grade-dist-bar-wrap";
    const bar   = document.createElement("div");
    bar.className = `grade-dist-bar${p === maxP && p > 0 ? " peak" : ""}`;
    bar.style.height = `${Math.max(2, Math.round((p / Math.max(maxP, 0.01)) * 32))}px`;
    const lbl = document.createElement("div"); lbl.className = "grade-dist-label";
    lbl.textContent = g;
    wrap.appendChild(bar); wrap.appendChild(lbl); container.appendChild(wrap);
  }
}

function renderPillarIssues(name, items) {
  const el = $(`issues-${name}`);
  if (!items || items.length === 0) {
    el.innerHTML = `<span class="issue-clean">✓ Clean</span>`;
    return;
  }
  const combined = items.join(" ").toLowerCase();
  let label, cls;
  if (combined.includes("heavy") || combined.includes("bent") || combined.includes("severe")) {
    label = "⚠ Heavy"; cls = "issue-bad";
  } else if (combined.includes("moderate") || combined.includes("chip")) {
    label = "⚠ Moderate"; cls = "issue-warn";
  } else {
    label = "⚠ Minor"; cls = "issue-warn";
  }
  const n = items.length;
  el.innerHTML = `<span class="${cls}">${label}</span><span class="pillar-count">${n} finding${n !== 1 ? "s" : ""}</span>`;
}

function renderEconomics(econ, listing) {
  const rows = $("economics-rows");
  rows.innerHTML = "";

  const price    = listing?.price ?? econ.listing_price ?? 0;
  const shipping = listing?.shipping ?? 0;
  const fee      = econ.grading_fee ?? 25;

  const items = [
    { label: "Listing + shipping", value: price + shipping, format: "$" },
    { label: "PSA grading fee",    value: fee,              format: "$" },
    null, // divider
    { label: "Raw value",  value: econ.raw_estimate,  format: "$", fallback: "—" },
    { label: "PSA 8 est.", value: econ.psa8_estimate,  format: "$", fallback: "—" },
    { label: "PSA 9 est.", value: econ.psa9_estimate,  format: "$", fallback: "—" },
    { label: "PSA 10 est.",value: econ.psa10_estimate, format: "$", fallback: "—" },
    null,
    { label: "Expected value", value: econ.expected_value, format: "$", highlight: true },
    { label: "Max buy (PSA 9 target)",
      value: econ.max_buy_price_for_psa9_target, format: "$", fallback: "—" },
  ];

  for (const item of items) {
    if (item === null) {
      const div = document.createElement("div"); div.className = "econ-divider";
      rows.appendChild(div);
      continue;
    }
    const row = document.createElement("div");
    row.className = `econ-row${item.highlight ? " highlight" : ""}`;
    const lbl = document.createElement("span"); lbl.className = "econ-label";
    const val = document.createElement("span"); val.className = "econ-value";
    lbl.textContent = item.label;
    if (item.value != null) {
      val.textContent = `$${item.value.toFixed(2)}`;
      if (item.highlight) {
        const total = price + shipping + fee;
        val.classList.add(item.value > total ? "positive" : "negative");
      }
    } else {
      val.textContent = item.fallback ?? "—";
    }
    row.appendChild(lbl); row.appendChild(val); rows.appendChild(row);
  }
}

// ── Render PSA result (from Python YOLO+Claude grading_server pipeline) ─────
// Result shape: { centering{score,left_right,top_bottom,content_region,notes},
//                 corners{score,top_left,...}, edges{score,top,...},
//                 surface{score,scratches,...}, overall_score, psa_equivalent,
//                 summary, _warped_jpeg_b64, _corner_crops_b64, _card_boundary }
function renderPSAResult(r, listing) {
  currentResult  = r;
  currentListing = listing ?? currentListing;

  // When both sides were graded, the server sends a combined (worst-side) grade.
  const combined = r._combined || null;
  const overall  = (combined?.overall_score ?? r.overall_score) ?? 0;
  const psaEquiv = combined?.psa_equivalent ?? r.psa_equivalent;

  // Decision banner — prefer the eBay/ROI buy/maybe/skip decision when present,
  // otherwise fall back to a grade-tier banner.
  const banner = $("decision-banner");
  if (r.decision?.label) {
    banner.className = `decision-banner ${r.decision.label}`;
    $("decision-label").textContent  =
      r.decision.label === "unknown" ? "NO DATA" : r.decision.label.toUpperCase();
    $("decision-reason").textContent = r.decision.reason ?? r.summary ?? "";
  } else {
    const tier = overall >= 9 ? "buy" : overall >= 7 ? "maybe" : "skip";
    banner.className = `decision-banner ${tier}`;
    $("decision-label").textContent  = psaEquiv ?? `Score ${overall.toFixed(1)}`;
    $("decision-reason").textContent = r.summary ?? "";
  }

  // Trust anchors — show the perspective-corrected card(s) that were graded. The FIRST warp carries
  // the grade badge overlay (slab-label style), consistent with the web reveal.
  const imgContainer = $("result-images");
  imgContainer.innerHTML = "";
  const gradeNum = Math.max(1, Math.min(10, Math.round(overall || 0)));
  const addWarped = (b64, label, withBadge) => {
    if (!b64) return;
    const wrap = document.createElement("div"); wrap.className = "img-wrap";
    const img  = document.createElement("img"); img.className = "result-img";
    img.src = `data:image/jpeg;base64,${b64}`;
    img.alt = label;
    const lbl = document.createElement("div"); lbl.className = "result-img-label";
    lbl.textContent = label;
    wrap.appendChild(img); wrap.appendChild(lbl);
    if (withBadge && overall) {
      const badge = document.createElement("div");
      badge.className = `grade-badge-overlay ${psaScoreClass(overall)}`;
      badge.innerHTML = `<span class="gb-num">${gradeNum}</span><span class="gb-word">${badgeWord(gradeNum)}</span>`;
      wrap.appendChild(badge);
    }
    imgContainer.appendChild(wrap);
  };
  addWarped(r._warped_jpeg_b64, r._back ? "Front" : "Warped", true);
  if (r._back) addWarped(r._back._warped_jpeg_b64, "Back", false);
  $("btn-adjust-borders").classList.toggle("hidden", !r._warped_jpeg_b64);

  // Grade reveal — "PSA 9 likely · high confidence", consistent with the web. The legacy
  // grade-band row stays for the non-PSA path and is hidden here.
  const psaShort = psaEquiv ? psaEquiv.replace(/^PSA\s*/i, "PSA ").split(" ").slice(0, 2).join(" ") : `Grade ${gradeNum}`;
  const confP = confidencePhrase(cen0Conf(r), r.centering?.reliable);
  $("grade-reveal").classList.remove("hidden");
  $("grade-headline").textContent = `${psaShort} likely`;
  $("grade-headline").className = `grade-headline ${psaScoreClass(overall)}`;
  const subBits = [confP, `overall ${overall ? overall.toFixed(1) : "—"}/10`];
  if (r._back) subBits.push("front + back");
  else if (r._back_error) subBits.push("front only");
  if (r._adjusted) subBits.unshift("✎ adjusted");
  $("grade-sub").textContent = subBits.join(" · ");
  document.querySelector(".grade-row").classList.add("hidden");
  $("grade-dist").innerHTML   = "";
  $("grade-limiting").classList.add("hidden");

  // Verdict — should you grade it? Qualitative (dollar figures arrive with the comps source).
  const vb = $("verdict-banner");
  vb.classList.remove("hidden");
  if (gradeNum >= 9) { vb.className = "verdict-banner good"; vb.textContent = "✓ Strong grading candidate — high grade, cards like this usually clear the fee."; }
  else if (gradeNum >= 7) { vb.className = "verdict-banner mid"; vb.textContent = "≈ Borderline — at this grade the fee may outweigh the value bump."; }
  else { vb.className = "verdict-banner bad"; vb.textContent = "✕ Skip grading — condition caps the grade; fees likely exceed the bump."; }

  // Pillar summary cards — score badge (combined/worst-side when both sides
  // graded) + descriptor from the front reading.
  const cen  = r.centering ?? {};
  const cor  = r.corners   ?? {};
  const edg  = r.edges     ?? {};
  const surf = r.surface   ?? {};
  const C = combined;

  renderPsaPillar("centering", C ? C.centering_score : cen.score,
    centeringPhrase(cen.left_right, cen.top_bottom));
  renderPsaPillar("corners", C ? C.corners_score : cor.score,
    plainPillarNote("corners", r, C ? C.corners_score : cor.score,
      worstSeverityLabel([cor.top_left, cor.top_right, cor.bottom_right, cor.bottom_left])));
  renderPsaPillar("edges", C ? C.edges_score : edg.score,
    plainPillarNote("edges", r, C ? C.edges_score : edg.score,
      worstSeverityLabel([edg.top, edg.right, edg.bottom, edg.left])));
  renderPsaPillar("surface", C ? C.surface_score : surf.score,
    plainPillarNote("surface", r, C ? C.surface_score : surf.score,
      worstSeverityLabel([surf.scratches, surf.print_lines, surf.stains, surf.creases])));

  // RF-DETR defect boxes (surface / edges & corners) over the warped card — mirrors the web DefectsPanel.
  renderDefects(r);

  // Economics — shown when the server attached eBay comps + ROI.
  if (r.economics) {
    $("economics-block").style.display = "";
    renderEconomics(r.economics, currentListing);
  } else {
    $("economics-block").style.display = "none";
  }

  // PSA summary text in the collapsible "AI Reasoning" panel (the decision
  // banner already carries the ROI reason, so surface the grade summary here).
  const summaryText = (r.decision?.label && r.summary) ? r.summary : "";
  $("reasoning-front").textContent = summaryText;
  $("reasoning-back").textContent  = "";
  const reasoningEl = document.querySelector(".reasoning-details");
  if (reasoningEl) reasoningEl.style.display = summaryText ? "" : "none";

  // Caveat when economics are based on active asking prices (sold-comp fallback).
  const caveatEl = $("caveats-list");
  if (r._comps_basis === "active") {
    caveatEl.innerHTML =
      `<div class="caveat">Estimates use active <em>asking</em> prices (sold-comp quota exhausted) — actual sold prices are typically lower.</div>`;
    caveatEl.classList.remove("hidden");
  } else {
    caveatEl.classList.add("hidden");
  }
}

function psaScoreClass(score) {
  return score >= 9 ? "high" : score >= 7 ? "medium" : "low";
}

// Render one PSA pillar summary card: a big score + a one-line descriptor.
function renderPsaPillar(name, score, descriptor) {
  const cls = score >= 9 ? "issue-clean" : score >= 7 ? "issue-warn" : "issue-bad";
  const scoreText = (typeof score === "number") ? score.toFixed(1) : "—";
  $(`issues-${name}`).innerHTML =
    `<span class="${cls}" style="font-weight:700">${scoreText}</span>` +
    `<span class="pillar-count">${descriptor}</span>`;
}

// ── Defects panel — RF-DETR defect boxes over the warped card + a Surface / Edges&Corners toggle + a table
//    (hover/click a row to highlight its box). Vanilla-JS port of the web DefectsPanel; colors + inflateBox match. ──
const DEFECT_COLORS = { edge: "#06b6d4", corner: "#f97316", surface: "#ef4444" };
const DEFECT_LABEL  = { edge: "Edge",    corner: "Corner",  surface: "Surface" };

// Grow a box [x,y,w,h] (0..1) outward + floor tiny ones, clamped inside the card — mirrors lib/grading/defects.ts.
function defectInflate(box, min = 0.045, pad = 0.01) {
  let [x, y, w, h] = box;
  x -= pad; y -= pad; w += 2 * pad; h += 2 * pad;
  if (w < min) { x -= (min - w) / 2; w = min; }
  if (h < min) { y -= (min - h) / 2; h = min; }
  w = Math.min(w, 1); h = Math.min(h, 1);
  x = Math.max(0, Math.min(x, 1 - w));
  y = Math.max(0, Math.min(y, 1 - h));
  return [x, y, w, h];
}

function renderDefects(r) {
  const block = $("defects-block");
  if (!block) return;
  block.innerHTML = "";
  const db = r.defect_boxes || {};
  const valid = (d) => Array.isArray(d.box) && d.box.length === 4;
  const mk = (arr, pillar) => (arr || []).filter(valid).map((d) => ({ d, pillar }));
  const groups = {
    surface: mk(db.surface, "surface"),
    ec: [...mk(db.edges, "edge"), ...mk(db.corners, "corner")],
  };
  const warp = r._warped_jpeg_b64;
  if (!warp) { block.style.display = "none"; return; }
  block.style.display = "";   // ALWAYS show after a grade (web parity): tabs with counts + empty message when clean

  let tab = (groups.surface.length === 0 && groups.ec.length > 0) ? "ec" : "surface";

  const head = document.createElement("div"); head.className = "defects-head";
  head.innerHTML = `<span class="defects-title">Defects</span>`;
  const toggle = document.createElement("div"); toggle.className = "defects-toggle";
  const tabBtns = {};
  [["surface", "Surface"], ["ec", "Edges & Corners"]].forEach(([key, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "defects-tab";
    b.innerHTML = `${label} <span class="defects-count">${groups[key].length}</span>`;
    b.onclick = () => { tab = key; draw(); };
    tabBtns[key] = b; toggle.appendChild(b);
  });
  head.appendChild(toggle); block.appendChild(head);
  const body = document.createElement("div"); body.className = "defects-body"; block.appendChild(body);

  function draw() {
    Object.entries(tabBtns).forEach(([k, b]) => b.classList.toggle("active", k === tab));
    body.innerHTML = "";
    const items = groups[tab].slice().sort((a, b) => (b.d.conf ?? 0) - (a.d.conf ?? 0));

    const wrap = document.createElement("div"); wrap.className = "image-overlay-wrap defects-card";
    const img = document.createElement("img"); img.className = "overlay-img"; img.src = `data:image/jpeg;base64,${warp}`;
    wrap.appendChild(img);
    const svg = document.createElementNS(NS_SVG, "svg");
    svg.setAttribute("class", "overlay-svg"); svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
    const rects = items.map((it) => {
      const [x, y, w, h] = defectInflate(it.d.box);
      const rect = document.createElementNS(NS_SVG, "rect");
      rect.setAttribute("x", x * 100); rect.setAttribute("y", y * 100);
      rect.setAttribute("width", w * 100); rect.setAttribute("height", h * 100);
      rect.setAttribute("fill", "none"); rect.setAttribute("stroke", DEFECT_COLORS[it.pillar]);
      rect.setAttribute("stroke-width", "0.4"); rect.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(rect); return rect;
    });
    wrap.appendChild(svg);
    const confLbl = document.createElement("div");           // conf label above the active box (web parity)
    confLbl.className = "defects-conf-label"; confLbl.style.display = "none";
    wrap.appendChild(confLbl);
    body.appendChild(wrap);
    attachZoomPan(wrap);                                     // scroll-zoom / drag-pan / dbl-click reset

    const legend = document.createElement("div"); legend.className = "defects-legend";
    (tab === "surface" ? ["surface"] : ["edge", "corner"]).forEach((p) => {
      const s = document.createElement("span"); s.className = "defects-legend-item";
      s.innerHTML = `<span class="defects-swatch" style="background:${DEFECT_COLORS[p]}"></span>${DEFECT_LABEL[p].toLowerCase()}`;
      legend.appendChild(s);
    });
    body.appendChild(legend);

    if (items.length === 0) {
      const p = document.createElement("p"); p.className = "defects-empty";
      p.textContent = `No ${tab === "surface" ? "surface" : "edge or corner"} defects detected.`;
      body.appendChild(p); return;
    }
    const table = document.createElement("table"); table.className = "defects-table";
    table.innerHTML = `<thead><tr><th>Defect</th><th>Type</th><th class="r">Conf</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    const setActive = (idx) => {
      rects.forEach((rc, j) => {
        const on = idx === j, dim = idx !== null && !on;
        rc.setAttribute("stroke-width", on ? "1" : "0.4");
        rc.setAttribute("stroke-opacity", dim ? "0.25" : "1");
        rc.setAttribute("fill", on ? DEFECT_COLORS[items[j].pillar] + "22" : "none");
      });
      Array.from(tbody.children).forEach((row, j) => row.classList.toggle("active", idx === j));
      if (idx !== null && items[idx] && items[idx].d.conf != null) {   // conf label above the active box
        const [bx, by] = defectInflate(items[idx].d.box);
        confLbl.textContent = items[idx].d.conf.toFixed(2);
        confLbl.style.color = DEFECT_COLORS[items[idx].pillar];
        confLbl.style.left = `${bx * 100}%`;
        confLbl.style.top = `${by * 100}%`;
        confLbl.style.display = "";
      } else {
        confLbl.style.display = "none";
      }
    };
    let pinned = null;
    items.forEach((it, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><span class="defects-swatch" style="background:${DEFECT_COLORS[it.pillar]}"></span>${DEFECT_LABEL[it.pillar]}</td>` +
        `<td class="muted">${it.d.type ?? "—"}</td>` +
        `<td class="r">${it.d.conf != null ? Math.round(it.d.conf * 100) + "%" : "—"}</td>`;
      tr.onmouseenter = () => setActive(i);
      tr.onmouseleave = () => setActive(pinned);
      tr.onclick = () => {
        pinned = (pinned === i ? null : i);
        setActive(pinned);
        if (pinned !== null) {                               // zoom the card to the pinned defect
          const [bx, by, bw, bh] = defectInflate(items[i].d.box);
          wrap._zoomTo(bx + bw / 2, by + bh / 2, 3);
        } else {
          wrap._zoomReset();
        }
      };
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); body.appendChild(table);
    const hint = document.createElement("p"); hint.className = "defects-hint"; hint.textContent = "tap a row to zoom to it · tap again to reset";
    body.appendChild(hint);
  }
  draw();
}

// ── Plain-language helpers (mirror apps/web lib/grading/plain.ts so both surfaces speak the same) ──

// "45/55" + "48/52" → a human read of how centered the card is.
function centeringPhrase(leftRight, topBottom) {
  const dev = (s) => {
    const p = (s ?? "").split("/").map((n) => parseInt(n, 10));
    return p.length === 2 && !p.some(Number.isNaN) ? Math.abs(p[0] - 50) : 0;
  };
  const d = Math.max(dev(leftRight), dev(topBottom));
  if (d <= 3)  return "dead centered";
  if (d <= 7)  return "near perfect";
  if (d <= 12) return "slightly off-center";
  if (d <= 20) return "noticeably off-center";
  return "heavily off-center";
}

// Selector confidence float → the label the reveal shows.
function confidencePhrase(conf, reliable) {
  if (reliable === false || (conf != null && conf < 0.6)) return "low confidence — try a brighter photo";
  if (conf != null && conf < 0.85) return "medium confidence";
  return "high confidence";
}
function cen0Conf(r) { return r?.centering?.confidence ?? null; }

// One short note per pillar from what the detectors actually found (defect_boxes), else the
// legacy severity words, else a score-based read.
function plainPillarNote(pillar, r, score, fallback) {
  const boxes = (r.defect_boxes ?? {})[pillar === "surface" ? "surface" : pillar] ?? [];
  const n = boxes.length;
  if (pillar === "corners") {
    if (n > 0) return n === 1 ? "wear on one corner" : `wear on ${n} corners`;
    if (score >= 9) return "sharp, all four";
  }
  if (pillar === "edges") {
    if (n > 0) return n === 1 ? "light wear, one spot" : `light wear, ${n} spots`;
    if (score >= 9) return "clean all around";
  }
  if (pillar === "surface") {
    if (n > 0) return n === 1 ? "one faint mark" : `${n} faint marks`;
    if (score >= 9) return "clean";
  }
  return fallback || (score >= 8 ? "minor wear" : "wear visible");
}

// PSA-style word under the big badge number.
function badgeWord(grade) {
  if (grade >= 10) return "GEM MINT";
  if (grade >= 9)  return "MINT";
  if (grade >= 8)  return "NM-MT";
  if (grade >= 7)  return "NEAR MINT";
  if (grade >= 6)  return "EX-MT";
  if (grade >= 5)  return "EXCELLENT";
  return "PLAYED";
}

// Reduce a list of severity words to the single worst-case descriptor.
function worstSeverityLabel(words) {
  const order = ["bent","worn","heavy","heavy_wear","rough","creases",
                 "moderate","moderate_wear","chip","stains","print_lines",
                 "minor","minor_nick","slight_wear","scratches",
                 "clean","sharp","none"];
  const present = words.filter(Boolean).map((w) => String(w).toLowerCase());
  if (present.length === 0) return "—";
  let worst = null, worstRank = Infinity;
  for (const w of present) {
    const rank = order.indexOf(w);
    const r = rank === -1 ? 50 : rank;
    if (r < worstRank) { worstRank = r; worst = w; }
  }
  return prettySeverity(worst);
}

function prettySeverity(w) {
  const map = {
    sharp: "✓ Sharp", clean: "✓ Clean", none: "✓ Clean",
    slight_wear: "Slight wear", minor: "Minor", minor_nick: "Minor nick",
    moderate: "Moderate", moderate_wear: "Moderate wear", chip: "Chip",
    rough: "Rough", worn: "Worn", heavy: "Heavy", heavy_wear: "Heavy wear",
    bent: "⚠ Bent", scratches: "Scratches", print_lines: "Print lines",
    stains: "Stains", creases: "⚠ Creases",
  };
  return map[w] ?? w;
}

// ── Feedback ──────────────────────────────────────────────────────────────
async function sendFeedback(accurate) {
  const { lastResult } = await chrome.storage.local.get("lastResult");
  if (!lastResult) return;
  // TODO: wire to /api/grade/feedback when endpoint exists
  console.log("Feedback:", { accurate, listing: lastResult.listing?.url });
  const btn = accurate ? $("btn-feedback-good") : $("btn-feedback-bad");
  btn.textContent = accurate ? "✅" : "❌";
  btn.disabled = true;
}

// ── Utilities ─────────────────────────────────────────────────────────────
function show(viewName) {
  VIEWS.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== viewName);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PILLAR DETAIL VIEWS
// ══════════════════════════════════════════════════════════════════════════

const PILLAR_TITLES = {
  centering: "Centering",
  corners:   "Corners",
  edges:     "Edges",
  surface:   "Surface",
};

// Distinguishes the Python grading_server PSA result (centering.content_region,
// per-side severity words, psa_equivalent) from the older Next.js _cv result.
function isPsaShape(r) {
  return !!(r && (r.psa_equivalent || r.centering?.content_region));
}

function openPillarDetail(pillar) {
  if (!currentResult) return;
  if (isPsaShape(currentResult)) return openPillarDetailPsa(pillar);
  $("detail-title").textContent = PILLAR_TITLES[pillar] ?? pillar;

  // Compute and display overall severity for this pillar
  const sev = computePillarSeverity(pillar, currentResult);
  const sevEl = $("detail-severity");
  sevEl.className = `detail-severity sev-${sev.level}`;
  sevEl.textContent = sev.label;

  // Build the two image cards (front + back if assessable)
  renderDetailImages(pillar, currentResult, currentListing);

  // Findings list (from Claude's per-side analysis + top-level issues)
  renderDetailFindings(pillar, currentResult);

  // Numerical measurements (CV-derived)
  renderDetailMeasurements(pillar, currentResult);

  show("detail");
}

// ══════════════════════════════════════════════════════════════════════════
// PSA-shape pillar detail (Python grading_server result)
// ══════════════════════════════════════════════════════════════════════════

const NS_SVG = "http://www.w3.org/2000/svg";

function openPillarDetailPsa(pillar) {
  const r = currentResult;
  const back = r._back || null;
  $("detail-title").textContent = PILLAR_TITLES[pillar] ?? pillar;

  // Combined (worst-side) score drives the severity header when both sides graded.
  const score = r._combined ? r._combined[`${pillar}_score`] : r[pillar]?.score;
  const sev   = psaSeverityFromScore(score);
  const sevEl = $("detail-severity");
  sevEl.className = `detail-severity sev-${sev.level}`;
  sevEl.textContent = `${sev.label}${typeof score === "number" ? ` — score ${score.toFixed(1)}` : ""}`
    + (back ? " · front + back" : "");

  const imgContainer = $("detail-images");
  imgContainer.innerHTML = "";

  if (pillar === "centering") {
    imgContainer.appendChild(buildCenteringAuditCard(r, back ? "Front" : null));  // interactive
    if (back) imgContainer.appendChild(buildCenteringAuditCard(back, "Back"));    // interactive
  } else if (pillar === "corners") {
    buildCornerCropCards(r, imgContainer, back ? "Front" : "");
    if (back) buildCornerCropCards(back, imgContainer, "Back");
  } else {
    imgContainer.appendChild(buildWarpedCard(r, pillar, back ? "Front" : null));
    if (back) imgContainer.appendChild(buildWarpedCard(back, pillar, "Back"));
  }

  renderPsaFindings(pillar, r);
  renderPsaMeasurements(pillar, r);
  show("detail");
}

// Re-derive the headline grade from the current per-side pillar scores. With both
// sides graded, headline = combined worst-side per pillar (run through the Stage-B
// aggregator); otherwise front-only. Called after a boundary adjustment.
function recomputeGrade() {
  const r = currentResult;
  const minS = (a, b) => {
    const v = [a, b].filter((x) => typeof x === "number");
    return v.length ? Math.min(...v) : null;
  };
  if (r._back) {
    const b = r._back;
    const cp = {
      centering: minS(r.centering?.score, b.centering?.score),
      corners:   minS(r.corners?.score,   b.corners?.score),
      edges:     minS(r.edges?.score,     b.edges?.score),
      surface:   minS(r.surface?.score,   b.surface?.score),
    };
    const co = aggregateGrade(cp);
    r._combined = {
      centering_score: cp.centering, corners_score: cp.corners,
      edges_score: cp.edges, surface_score: cp.surface,
      overall_score: Math.round(co * 10) / 10,
      psa_equivalent: psaLabelFromScore(co),
    };
  } else {
    const o = aggregateGrade({
      centering: r.centering?.score, corners: r.corners?.score,
      edges: r.edges?.score, surface: r.surface?.score,
    });
    r.overall_score  = Math.round(o * 10) / 10;
    r.psa_equivalent = psaLabelFromScore(o);
  }
}

function psaSeverityFromScore(score) {
  if (typeof score !== "number") return { level: "minor", label: "Assessed" };
  if (score >= 9) return { level: "clean",    label: "✓ Excellent" };
  if (score >= 7) return { level: "minor",    label: "Minor wear" };
  if (score >= 5) return { level: "moderate", label: "⚠ Moderate wear" };
  return { level: "heavy", label: "⚠ Heavy wear" };
}

// Centering audit — the notebook's exact visualization: green = physical card
// boundary, gold = content_region (printed border inner edge), with L/R/T/B
// border-width labels. card_boundary and content_region are both normalised
// (0–1) in the WARPED card's coordinate space, so they map directly onto the
// warped image we render here.
// Interactive centering audit: the green box = physical card edge (outer), the
// gold box = printed-border inner edge (content_region). Both are editable —
// drag the edge handles to refine, and L/R · T/B · score recompute live. The
// image supports scroll-zoom / drag-pan via attachZoomPan().
function buildCenteringAuditCard(src, label = null) {
  const card = document.createElement("div");
  card.className = "detail-img-card";
  card.style.maxWidth = "100%";

  const lbl = document.createElement("div");
  lbl.className = "detail-img-label";
  const detName = src._detector === "seg" ? "seg ✓"
                : src._detector === "yolo" ? "yolo"
                : src._detector || null;
  const detTag = detName
    ? ` <span style="color:var(--sub);font-weight:600;text-transform:none;letter-spacing:0">· ${detName}</span>`
    : "";
  const prefix = label ? `${label} centering` : "Centering audit";
  lbl.innerHTML = `${prefix}${detTag}`;
  card.appendChild(lbl);

  const wrap = document.createElement("div");
  wrap.className = "image-overlay-wrap";

  if (src._warped_jpeg_b64) {
    const img = document.createElement("img");
    img.className = "overlay-img";
    img.src = `data:image/jpeg;base64,${src._warped_jpeg_b64}`;
    wrap.appendChild(img);
  }

  const svg = document.createElementNS(NS_SVG, "svg");
  svg.setAttribute("class", "overlay-svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  wrap.appendChild(svg);
  card.appendChild(wrap);

  // Live readout + reset
  const readout = document.createElement("div");
  readout.className = "centering-readout";
  card.appendChild(readout);

  const actions = document.createElement("div");
  actions.className = "cen-actions";
  // Manual adjustment is opt-in. Two scopes:
  //  • "Adjust border"    → edit BLUE content_region (Claude's interpretation) — common
  //  • "Adjust card edge" → edit the CYAN boundary (trusted seg detection) — rare override
  const adjustInnerBtn = document.createElement("button");
  adjustInnerBtn.className = "cen-reset-btn";
  adjustInnerBtn.textContent = "✎ Adjust border";
  const adjustOuterBtn = document.createElement("button");
  adjustOuterBtn.className = "cen-reset-btn";
  adjustOuterBtn.textContent = "✎ Adjust card edge";
  const applyBtn = document.createElement("button");
  applyBtn.className = "cen-apply-btn";
  applyBtn.textContent = "✓ Apply adjustment";
  const resetBtn = document.createElement("button");
  resetBtn.className = "cen-reset-btn";
  resetBtn.textContent = "↺ Reset";
  applyBtn.style.display = "none";   // hidden until a scope is active
  resetBtn.style.display = "none";
  actions.appendChild(adjustInnerBtn);
  actions.appendChild(adjustOuterBtn);
  actions.appendChild(applyBtn);
  actions.appendChild(resetBtn);
  card.appendChild(actions);

  let editMode = null;   // null = view-only | "inner" = blue | "outer" = cyan/edge

  // ── Seed boundaries (viewBox units 0..100) ──
  const cb = src._card_boundary;            // [x1,y1,x2,y2] (0..1)
  const cr = src.centering?.content_region; // {x1,y1,x2,y2} (0..1)
  // True card outline from the segmentation detector (rounded corners), in the
  // same warped-normalised space as cb/cr. Drawn as a non-interactive reference
  // overlay; the editable green rectangle below still drives centering/feedback.
  let contourPts = Array.isArray(src._card_contour_warped) ? src._card_contour_warped : null;
  let seedOuter = (cb && cb.length === 4)
    ? { x1: cb[0]*100, y1: cb[1]*100, x2: cb[2]*100, y2: cb[3]*100 }
    : { x1: 4, y1: 4, x2: 96, y2: 96 };
  let seedInner = (cr && ["x1","y1","x2","y2"].every((k) => k in cr))
    ? { x1: cr.x1*100, y1: cr.y1*100, x2: cr.x2*100, y2: cr.y2*100 }
    : { x1: seedOuter.x1 + (seedOuter.x2-seedOuter.x1)*0.10,
        y1: seedOuter.y1 + (seedOuter.y2-seedOuter.y1)*0.10,
        x2: seedOuter.x2 - (seedOuter.x2-seedOuter.x1)*0.10,
        y2: seedOuter.y2 - (seedOuter.y2-seedOuter.y1)*0.10 };

  // seedOuter stays = _card_boundary (a straight rectangle), matching the web /grade centering view. We do NOT
  // seed from the raw contour bbox — the outer boundary is drawn as a clean rectangle, not the wiggly contour.
  void contourPts;

  let outer = { ...seedOuter };
  let inner = { ...seedInner };
  let active = null;

  function redraw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Border geometry (drives the readout in every mode)
    const L = inner.x1 - outer.x1, R = outer.x2 - inner.x2;
    const T = inner.y1 - outer.y1, B = outer.y2 - inner.y2;
    const midX = (inner.x1+inner.x2)/2, midY = (inner.y1+inner.y2)/2;

    // Cyan = the card boundary, drawn as a STRAIGHT rectangle (consistent with the web /grade view — the card
    // IS a rectangle; we don't render the raw wiggly contour). Shown except while overriding the edge, where the
    // editable green rectangle stands in for it.
    if (editMode !== "outer") {
      addRect(svg, outer.x1, outer.y1, outer.x2 - outer.x1, outer.y2 - outer.y1,
              "sv-contour", { fill: "none", "stroke-width": "0.7", stroke: "#22d3ee" });   // fill:none — a bare
      // SVG <rect> defaults to fill:black and would cover the card image (.sv-contour has no CSS fill rule).
    }

    // Outer card edge — editable green rectangle ONLY while adjusting the edge.
    if (editMode === "outer") {
      addRect(svg, outer.x1, outer.y1, outer.x2-outer.x1, outer.y2-outer.y1,
              "sv-bounds", { "stroke-width": "0.5", stroke: "var(--green)" });
      const oMidX=(outer.x1+outer.x2)/2, oMidY=(outer.y1+outer.y2)/2;
      [
        [outer.x1,oMidY,"outer","left"],[outer.x2,oMidY,"outer","right"],
        [oMidX,outer.y1,"outer","top"], [oMidX,outer.y2,"outer","bottom"],
      ].forEach(([hx,hy,rect,side]) => addHandle(hx,hy,rect,side));
    }

    // Inner printed border (blue, content_region = Claude's read):
    //  • editable + handles while adjusting the border
    //  • shown as static context while adjusting the edge
    if (editMode === "inner") {
      addRect(svg, inner.x1, inner.y1, inner.x2-inner.x1, inner.y2-inner.y1,
              "sv-content", { "stroke-width": "0.6" });
      [
        [inner.x1,midY,"inner","left"], [inner.x2,midY,"inner","right"],
        [midX,inner.y1,"inner","top"],  [midX,inner.y2,"inner","bottom"],
      ].forEach(([hx,hy,rect,side]) => addHandle(hx,hy,rect,side));
    } else {   // "outer" edit OR view mode → static inner content rect so the margins are visible (like the web)
      addRect(svg, inner.x1, inner.y1, inner.x2-inner.x1, inner.y2-inner.y1,
              "sv-content", { "stroke-width": "0.5" });
    }

    // Border-width labels while editing either box
    if (editMode) {
      addLabel(svg, NS_SVG, (outer.x1+inner.x1)/2, midY, `L ${(L*6.3)|0}`);
      addLabel(svg, NS_SVG, (inner.x2+outer.x2)/2, midY, `R ${(R*6.3)|0}`);
      addLabel(svg, NS_SVG, midX, (outer.y1+inner.y1)/2, `T ${(T*8.8)|0}`);
      addLabel(svg, NS_SVG, midX, (inner.y2+outer.y2)/2, `B ${(B*8.8)|0}`);
    }

    // Live readout (always shown)
    const lr = (L+R)>1e-6 ? Math.round(L/(L+R)*100) : 50;
    const tb = (T+B)>1e-6 ? Math.round(T/(T+B)*100) : 50;
    const score = centeringScore(lr, tb);
    const sc = score>=9 ? "issue-clean" : score>=7 ? "issue-warn" : "issue-bad";
    readout.innerHTML =
      `<span>L/R <b>${lr}/${100-lr}</b></span>` +
      `<span>T/B <b>${tb}/${100-tb}</b></span>` +
      `<span>score <b class="${sc}">${score}</b></span>`;
  }

  function addHandle(cx, cy, rect, side) {
    const c = document.createElementNS(NS_SVG, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 1.8);
    c.setAttribute("class", `bound-handle bh-${rect}`);
    c.dataset.rect = rect; c.dataset.side = side;
    c.addEventListener("pointerdown", onHandleDown);
    svg.appendChild(c);
  }

  function svgPoint(e) {
    const m = svg.getScreenCTM(); if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.max(0, Math.min(100, p.x)), y: Math.max(0, Math.min(100, p.y)) };
  }
  function onHandleDown(e) {
    e.stopPropagation(); e.preventDefault();   // don't start a pan
    active = { rect: e.currentTarget.dataset.rect, side: e.currentTarget.dataset.side };
    window.addEventListener("pointermove", onHandleMove);
    window.addEventListener("pointerup", onHandleUp, { once: true });
  }
  function onHandleMove(e) {
    if (!active) return;
    const p = svgPoint(e); if (!p) return;
    const GAP = 2; // keep inner from collapsing
    if (active.rect === "outer") {
      if (active.side==="left")   outer.x1 = Math.min(p.x, inner.x1);
      if (active.side==="right")  outer.x2 = Math.max(p.x, inner.x2);
      if (active.side==="top")    outer.y1 = Math.min(p.y, inner.y1);
      if (active.side==="bottom") outer.y2 = Math.max(p.y, inner.y2);
    } else {
      if (active.side==="left")   inner.x1 = Math.max(outer.x1, Math.min(p.x, inner.x2-GAP));
      if (active.side==="right")  inner.x2 = Math.min(outer.x2, Math.max(p.x, inner.x1+GAP));
      if (active.side==="top")    inner.y1 = Math.max(outer.y1, Math.min(p.y, inner.y2-GAP));
      if (active.side==="bottom") inner.y2 = Math.min(outer.y2, Math.max(p.y, inner.y1+GAP));
    }
    redraw();
  }
  function onHandleUp() {
    active = null;
    window.removeEventListener("pointermove", onHandleMove);
  }

  function setMode(mode) {
    editMode = (editMode === mode) ? null : mode;   // clicking the active one exits
    const on = editMode !== null;
    applyBtn.style.display = on ? "" : "none";
    resetBtn.style.display = on ? "" : "none";
    adjustInnerBtn.textContent = editMode === "inner" ? "✓ Done" : "✎ Adjust border";
    adjustOuterBtn.textContent = editMode === "outer" ? "✓ Done" : "✎ Adjust card edge";
    redraw();
  }
  adjustInnerBtn.addEventListener("click", () => setMode("inner"));
  adjustOuterBtn.addEventListener("click", () => setMode("outer"));

  resetBtn.addEventListener("click", () => {
    outer = { ...seedOuter }; inner = { ...seedInner }; redraw();
  });

  // Commit: recompute centering (geometry) + re-aggregate overall (Stage B, no
  // Claude), reflect across all pillars, persist into currentResult, save the
  // correction for YOLO retraining, then return to the summary.
  applyBtn.addEventListener("click", () => {
    const L = inner.x1 - outer.x1, R = outer.x2 - inner.x2;
    const T = inner.y1 - outer.y1, B = outer.y2 - inner.y2;
    const lr = (L+R) > 1e-6 ? Math.round(L/(L+R)*100) : 50;
    const tb = (T+B) > 1e-6 ? Math.round(T/(T+B)*100) : 50;
    const cenScore = centeringScore(lr, tb);

    const isBack = (src === currentResult._back);
    const before = {
      side:            isBack ? "back" : "front",
      card_boundary:   Array.isArray(src._card_boundary) ? [...src._card_boundary] : null,
      content_region:  src.centering?.content_region ? { ...src.centering.content_region } : null,
      centering_score: src.centering?.score ?? null,
    };

    // Write the adjusted boundaries back onto the edited side (front or back).
    const newOuter = { x1: outer.x1/100, y1: outer.y1/100, x2: outer.x2/100, y2: outer.y2/100 };
    const newInner = { x1: inner.x1/100, y1: inner.y1/100, x2: inner.x2/100, y2: inner.y2/100 };
    src._card_boundary = [newOuter.x1, newOuter.y1, newOuter.x2, newOuter.y2];
    // If the user overrode the card edge, their rectangle replaces the seg contour.
    if (editMode === "outer") { src._card_contour_warped = null; contourPts = null; }
    src.centering = {
      ...(src.centering ?? {}),
      score: cenScore,
      left_right: `${lr}/${100-lr}`,
      top_bottom: `${tb}/${100-tb}`,
      content_region: newInner,
      _source: "user_adjusted",
    };

    // Re-derive the headline grade (combined worst-side if both sides graded).
    recomputeGrade();
    currentResult._adjusted = true;

    chrome.storage.local.set({ lastResult: { listing: currentListing, result: currentResult, timestamp: Date.now() } });
    saveAdjustmentFeedback(src, isBack ? "back" : "front", before);

    // Refresh the summary DOM in the background, but STAY in the detail view so
    // the other side can still be adjusted. This commit becomes the new baseline
    // (Reset returns here, not to the original detection).
    renderPSAResult(currentResult, currentListing);
    show("detail");
    seedOuter = { ...outer };
    seedInner = { ...inner };
    applyBtn.textContent = "✓ Applied";
    applyBtn.disabled = true;
    setTimeout(() => {
      applyBtn.textContent = "✓ Apply adjustment";
      applyBtn.disabled = false;
    }, 1400);
  });

  redraw();
  attachZoomPan(wrap);

  const cap = document.createElement("div");
  cap.className = "detail-image-caption";
  const cen = src.centering ?? {};
  cap.textContent = cen.notes
    ? cen.notes
    : "Cyan = card edge (detected). “Adjust border” edits the printed-border box Claude reads (blue); “Adjust card edge” overrides the detected boundary (rare).";
  card.appendChild(cap);
  return card;
}

// Corner crops — the high-res zooms Claude actually inspected, each labelled
// with the severity it returned for that corner.
function buildCornerCropCards(r, container, prefix = "") {
  const crops = r._corner_crops_b64 ?? {};
  const cor   = r.corners ?? {};
  const cfg = [
    ["TL", "top_left",     "Top-left"],
    ["TR", "top_right",    "Top-right"],
    ["BR", "bottom_right", "Bottom-right"],
    ["BL", "bottom_left",  "Bottom-left"],
  ];
  for (const [key, field, label] of cfg) {
    const card = document.createElement("div");
    card.className = "detail-img-card";
    const lbl = document.createElement("div");
    lbl.className = "detail-img-label";
    lbl.textContent = prefix ? `${prefix} ${label}` : label;
    card.appendChild(lbl);

    const wrap = document.createElement("div");
    wrap.className = "image-overlay-wrap";
    wrap.style.aspectRatio = "1 / 1";
    if (crops[key]) {
      const img = document.createElement("img");
      img.className = "overlay-img";
      img.src = `data:image/jpeg;base64,${crops[key]}`;
      wrap.appendChild(img);
      attachZoomPan(wrap);
    } else {
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.justifyContent = "center";
      wrap.style.color = "var(--sub)";
      wrap.style.fontSize = "11px";
      wrap.textContent = "No crop";
    }
    card.appendChild(wrap);

    const sevWord = cor[field];
    const cap = document.createElement("div");
    cap.className = "detail-image-caption";
    const cls = /bent|heavy/.test(String(sevWord)) ? "issue-bad"
      : /moderate|rough/.test(String(sevWord)) ? "issue-warn"
      : "issue-clean";
    cap.innerHTML = `<span class="${cls}">${prettySeverity(String(sevWord ?? "—").toLowerCase())}</span>`;
    card.appendChild(cap);
    container.appendChild(card);
  }
}

// Plain warped card; for edges, tint the four sides by their severity.
function buildWarpedCard(r, pillar, label = null) {
  const card = document.createElement("div");
  card.className = "detail-img-card";
  card.style.maxWidth = "100%";
  const lbl = document.createElement("div");
  lbl.className = "detail-img-label";
  lbl.textContent = label ? `${label} — perspective-corrected` : "Perspective-corrected card";
  card.appendChild(lbl);

  const wrap = document.createElement("div");
  wrap.className = "image-overlay-wrap";
  if (r._warped_jpeg_b64) {
    const img = document.createElement("img");
    img.className = "overlay-img";
    img.src = `data:image/jpeg;base64,${r._warped_jpeg_b64}`;
    wrap.appendChild(img);
  }

  if (pillar === "edges") {
    const svg = document.createElementNS(NS_SVG, "svg");
    svg.setAttribute("class", "overlay-svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const edg = r.edges ?? {};
    const sevClass = (w) => /worn|rough/.test(String(w)) ? "sv-heavy"
      : /chip/.test(String(w)) ? "sv-moderate"
      : /minor_nick/.test(String(w)) ? "sv-minor" : null;
    const bands = {
      top:    [4, 0, 92, 4], bottom: [4, 96, 92, 4],
      left:   [0, 4, 4, 92], right:  [96, 4, 4, 92],
    };
    for (const side of ["top", "bottom", "left", "right"]) {
      const c = sevClass(edg[side]);
      if (!c) continue;
      const [x, y, w, h] = bands[side];
      addRect(svg, x, y, w, h, c, { "stroke-width": "0.4" });
    }
    wrap.appendChild(svg);
  }

  card.appendChild(wrap);
  if (r._warped_jpeg_b64) attachZoomPan(wrap);
  return card;
}

function renderPsaFindings(pillar, r) {
  const findings = $("detail-findings");
  findings.innerHTML = "";

  const sideRows = (p) => {
    if (pillar === "centering") return [["Left / Right", p.left_right], ["Top / Bottom", p.top_bottom]];
    if (pillar === "corners")   return [["Top-left", p.top_left], ["Top-right", p.top_right],
                                        ["Bottom-right", p.bottom_right], ["Bottom-left", p.bottom_left]];
    if (pillar === "edges")     return [["Top", p.top], ["Right", p.right], ["Bottom", p.bottom], ["Left", p.left]];
    if (pillar === "surface")   return [["Scratches", p.scratches], ["Print lines", p.print_lines],
                                        ["Stains", p.stains], ["Creases", p.creases]];
    return [];
  };

  const renderSide = (src, sideLabel) => {
    const p = src[pillar] ?? {};
    if (sideLabel) {
      const hdr = document.createElement("div");
      hdr.className = "finding-side-hdr";
      hdr.textContent = sideLabel;
      findings.appendChild(hdr);
    }
    for (const [label, val] of sideRows(p)) {
      if (val == null) continue;
      const w = String(val).toLowerCase();
      const sev = /bent|heavy|worn|severe/.test(w) ? "heavy"
        : /moderate|chip|rough/.test(w) ? "moderate"
        : /minor|slight|nick/.test(w) ? "minor" : "clean";
      const row = document.createElement("div");
      row.className = `finding-row f-${sev}`;
      row.innerHTML = `<strong style="color:var(--sub);font-weight:600">${label}:</strong> ${prettySeverity(w)}`;
      findings.appendChild(row);
    }
    if (p.notes) {
      const note = document.createElement("div");
      note.className = "finding-row f-clean";
      note.style.borderLeftColor = "var(--accent)";
      note.textContent = p.notes;
      findings.appendChild(note);
    }
  };

  const back = r._back || null;
  renderSide(r, back ? "Front" : null);
  if (back) renderSide(back, "Back");

  if (!findings.children.length) {
    findings.innerHTML = `<div class="finding-empty">No detail returned for ${(PILLAR_TITLES[pillar]||pillar).toLowerCase()}.</div>`;
  }
}

function renderPsaMeasurements(pillar, r) {
  const block  = $("detail-measurements-block");
  const target = $("detail-measurements");
  target.innerHTML = "";
  const rows = [];

  if (pillar === "centering") {
    const cen = r.centering ?? {};
    const cb  = r._card_boundary;
    const cr  = cen.content_region;
    rows.push(["L/R ratio", cen.left_right ?? "—"]);
    rows.push(["T/B ratio", cen.top_bottom ?? "—"]);
    if (cb && cr && ["x1","y1","x2","y2"].every((k) => k in cr)) {
      rows.push(["Left border",   `${((cr.x1 - cb[0]) * 630) | 0}px`]);
      rows.push(["Right border",  `${((cb[2] - cr.x2) * 630) | 0}px`]);
      rows.push(["Top border",    `${((cr.y1 - cb[1]) * 880) | 0}px`]);
      rows.push(["Bottom border", `${((cb[3] - cr.y2) * 880) | 0}px`]);
    }
    const claude = cen._claude_reported;
    if (claude) rows.push(["Claude (pre-geom)", `${claude.left_right ?? "?"} · ${claude.top_bottom ?? "?"}`]);
    else if (cen._source) rows.push(["Detector", cen.reliable === false ? `${cen._source} (low-confidence)` : cen._source]);
    if (r._centering_self_consistent != null)
      rows.push(["Self-consistent", r._centering_self_consistent ? "yes" : "no (±>5pp)"]);
  } else {
    const score = r[pillar]?.score;
    rows.push(["Pillar score", typeof score === "number" ? `${score.toFixed(1)} / 10` : "—"]);
    rows.push(["Overall", typeof r.overall_score === "number" ? `${r.overall_score.toFixed(1)} (${r.psa_equivalent ?? "—"})` : "—"]);
  }

  if (!rows.length) { block.style.display = "none"; return; }
  block.style.display = "";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "measurement-row";
    row.innerHTML = `<span class="measurement-label">${label}</span><span class="measurement-value">${value}</span>`;
    target.appendChild(row);
  }
}

// Small SVG rect helper (class + attribute overrides).
function addRect(svg, x, y, w, h, cls, attrs = {}) {
  const rect = document.createElementNS(NS_SVG, "rect");
  rect.setAttribute("x", x); rect.setAttribute("y", y);
  rect.setAttribute("width", w); rect.setAttribute("height", h);
  rect.setAttribute("class", cls);
  for (const [k, v] of Object.entries(attrs)) rect.setAttribute(k, v);
  svg.appendChild(rect);
}

// ── Stage-B aggregator (client-side, no Claude) ────────────────────────────
// Combines the 4 pillar scores into an overall PSA grade using the linear model
// in grade_model.js (generated by grading_server/train_aggregator.py). Falls back
// to a plain mean if the model file is missing. Stage A (pillar scores) is
// unchanged — this only re-blends pillars into the overall grade.
function aggregateGrade(p) {
  const m = window.GRADE_MODEL;
  let g;
  if (m && m.weights) {
    g = m.intercept
      + m.weights.centering * (p.centering ?? 0)
      + m.weights.corners   * (p.corners   ?? 0)
      + m.weights.edges     * (p.edges     ?? 0)
      + m.weights.surface   * (p.surface   ?? 0);
  } else {
    const vals = [p.centering, p.corners, p.edges, p.surface].filter((v) => typeof v === "number");
    g = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return Math.max(1, Math.min(10, g));
}

const PSA_NAMES = {
  10: "Gem Mint", 9: "Mint", 8: "NM-MT", 7: "NM", 6: "EX-MT",
  5: "EX", 4: "VG-EX", 3: "VG", 2: "Good", 1: "Poor",
};
function psaLabelFromScore(score) {
  const g = Math.max(1, Math.min(10, Math.round(score)));
  return `PSA ${g} ${PSA_NAMES[g] ?? ""}`.trim();
}

// Persist a boundary correction so it can be turned into YOLO OBB training labels
// (the corrected green/outer box is YOLO's target; warp context lets the offline
// converter map it back to original-image coordinates). Best-effort, non-blocking.
async function saveAdjustmentFeedback(src, side, before) {
  try {
    // The graded image for THIS side is what YOLO ran on; the converter downloads it.
    const imageUrl = side === "back"
      ? (currentListing?.back_url  ?? currentListing?.image_urls?.[1] ?? "")
      : (currentListing?.front_url ?? currentListing?.image_urls?.[0] ?? "");

    const record = {
      title:       currentListing?.title ?? "",
      listing_url: currentListing?.url ?? "",
      image_url:   imageUrl,
      side,
      original:    before,
      corrected: {
        card_boundary:   src._card_boundary ?? null,
        content_region:  src.centering?.content_region ?? null,
        centering_score: src.centering?.score ?? null,
        left_right:      src.centering?.left_right ?? null,
        top_bottom:      src.centering?.top_bottom ?? null,
      },
      grade: {
        overall_score: currentResult.overall_score ?? null,
        combined:      currentResult._combined ?? null,
      },
      // Warp context needed to map the warped-space box back to the original image
      warp: {
        quad_raw:    src._quad_raw ?? null,
        quad_padded: src._quad_padded ?? null,
        orig_dims:   src._orig_dims ?? null,
      },
      warped_jpeg_b64: src._warped_jpeg_b64 ?? null,
      model:           src._model ?? null,
      client_ts:       Date.now(),
    };
    await sendBg({ type: "SAVE_ADJUSTMENT", record }, 15_000);
  } catch { /* best-effort — never block the UI */ }
}

// PSA centering score from L/R + T/B percentages (mirrors the server thresholds).
function centeringScore(lr, tb) {
  const worst = Math.max(Math.abs(50 - lr), Math.abs(50 - tb));
  return worst <= 5 ? 10 : worst <= 10 ? 9 : worst <= 15 ? 8 : worst <= 20 ? 7
       : worst <= 25 ? 6 : worst <= 30 ? 5 : worst <= 35 ? 4 : worst <= 40 ? 3
       : worst <= 45 ? 2 : 1;
}

// Zoom + pan for a `.image-overlay-wrap`: scroll to zoom (toward cursor), drag to
// pan, double-click to reset. Moves the wrap's children (img + svg overlay) into a
// single transform layer so the image and its overlay stay perfectly aligned at
// any zoom. SVG handles re-enable pointer-events, so dragging a handle edits
// rather than pans (getScreenCTM accounts for this transform).
function attachZoomPan(wrap) {
  if (wrap.dataset.zoomable) return;       // idempotent
  wrap.dataset.zoomable = "1";

  const layer = document.createElement("div");
  layer.className = "zoom-layer";
  while (wrap.firstChild) layer.appendChild(wrap.firstChild);
  wrap.appendChild(layer);

  const MIN = 1, MAX = 6;
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { layer.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  const clampPan = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    tx = Math.min(0, Math.max(-(scale - 1) * w, tx));
    ty = Math.min(0, Math.max(-(scale - 1) * h, ty));
  };

  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const prev = scale;
    scale = Math.min(MAX, Math.max(MIN, scale * (e.deltaY < 0 ? 1.15 : 1/1.15)));
    // keep the point under the cursor fixed
    const px = (cx - tx) / prev, py = (cy - ty) / prev;
    tx = cx - px * scale; ty = cy - py * scale;
    if (scale === MIN) { tx = 0; ty = 0; }
    clampPan(); apply();
  }, { passive: false });

  let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".bound-handle")) return; // handle drag, not pan
    if (scale <= MIN) return;
    panning = true; sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
    wrap.style.cursor = "grabbing";
    try { wrap.setPointerCapture(e.pointerId); } catch {}
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!panning) return;
    tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy);
    clampPan(); apply();
  });
  const endPan = (e) => {
    if (!panning) return;
    panning = false; wrap.style.cursor = "";
    try { wrap.releasePointerCapture(e.pointerId); } catch {}
  };
  wrap.addEventListener("pointerup", endPan);
  wrap.addEventListener("pointercancel", endPan);
  wrap.addEventListener("dblclick", () => { scale = 1; tx = 0; ty = 0; apply(); });

  // Programmatic zoom (smooth) — e.g. "tap a defect row → zoom to its box".
  // (fx, fy) = fractional point on the image to center; s = target scale.
  const animate = (fn) => {
    layer.style.transition = "transform 0.28s ease";
    fn();
    setTimeout(() => { layer.style.transition = ""; }, 300);
  };
  wrap._zoomTo = (fx, fy, s) => animate(() => {
    scale = Math.min(MAX, Math.max(MIN, s));
    const w = wrap.clientWidth, h = wrap.clientHeight;
    tx = w / 2 - fx * w * scale;
    ty = h / 2 - fy * h * scale;
    if (scale === MIN) { tx = 0; ty = 0; }
    clampPan(); apply();
  });
  wrap._zoomReset = () => animate(() => { scale = 1; tx = 0; ty = 0; apply(); });

  const hint = document.createElement("div");
  hint.className = "zoom-hint";
  hint.textContent = "scroll: zoom · drag: pan · dbl-click: reset";
  wrap.appendChild(hint);
}

// ── Severity summary ──────────────────────────────────────────────────────
function computePillarSeverity(pillar, r) {
  const issues = r.issues?.[pillar] ?? [];
  if (issues.length === 0) {
    return { level: "clean", label: "✓ Clean — no notable defects detected" };
  }
  const txt = issues.join(" ").toLowerCase();
  if (txt.includes("heavy") || txt.includes("bent") || txt.includes("severe")) {
    return { level: "heavy", label: `⚠ Heavy — ${issues.length} issue${issues.length>1?"s":""} flagged` };
  }
  if (txt.includes("moderate") || txt.includes("chip")) {
    return { level: "moderate", label: `⚠ Moderate — ${issues.length} issue${issues.length>1?"s":""}` };
  }
  return { level: "minor", label: `Minor — ${issues.length} issue${issues.length>1?"s":""}` };
}

// ── Per-image overlay rendering ───────────────────────────────────────────
function renderDetailImages(pillar, r, listing) {
  const container = $("detail-images");
  container.innerHTML = "";

  const urls = listing?.image_urls ?? [];

  // Front
  if (urls[0]) {
    container.appendChild(buildImageCard({
      label: "Front",
      url:   urls[0],
      pillar,
      result: r,
      sideIndex: 0,
      analysis:  r.front_analysis,
      caption:   r.front_analysis?.assessable === false ? "Not assessable" : null,
    }));
  }

  // Back (only if user provided one — many listings are front-only)
  if (urls[1]) {
    container.appendChild(buildImageCard({
      label: "Back",
      url:   urls[1],
      pillar,
      result: r,
      sideIndex: 1,
      analysis:  r.back_analysis,
      caption:   r.back_analysis?.assessable === false ? "Not assessable" : null,
    }));
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "detail-img-card";
    placeholder.innerHTML = `
      <div class="detail-img-label">Back</div>
      <div class="image-overlay-wrap" style="display:flex;align-items:center;justify-content:center;color:var(--sub);font-size:11px;">
        Not provided
      </div>
      <div class="detail-image-caption">Back image not in listing</div>
    `;
    container.appendChild(placeholder);
  }
}

function buildImageCard({ label, url, pillar, result, sideIndex, analysis, caption }) {
  const card = document.createElement("div");
  card.className = "detail-img-card";

  // Detail image label
  const lbl = document.createElement("div");
  lbl.className = "detail-img-label";
  lbl.textContent = label;
  card.appendChild(lbl);

  // Image + SVG overlay container
  const wrap = document.createElement("div");
  wrap.className = "image-overlay-wrap";

  const img = document.createElement("img");
  img.className = "overlay-img";
  img.src = url;
  img.onerror = () => { img.style.display = "none"; };
  wrap.appendChild(img);

  // SVG overlay — viewBox 0..100 so we use percentages directly
  const NS  = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class",   "overlay-svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");

  // Card boundary outline (always shown — anchors the overlay)
  const cardBounds = result.card_bounds_pct?.[sideIndex];
  if (cardBounds) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", cardBounds.x * 100);
    rect.setAttribute("y", cardBounds.y * 100);
    rect.setAttribute("width",  cardBounds.w * 100);
    rect.setAttribute("height", cardBounds.h * 100);
    rect.setAttribute("class", "sv-bounds");
    rect.setAttribute("stroke-width", "0.4");
    rect.setAttribute("stroke", "rgba(139,148,158,0.7)");
    svg.appendChild(rect);
  }

  // Pillar-specific shapes — only on the side that has CV data (usually front)
  const isFront = sideIndex === 0;
  if (isFront) {
    if (pillar === "centering") drawCenteringOverlay(svg, NS, result, cardBounds);
    if (pillar === "corners")   drawCornersOverlay(svg, NS, result, cardBounds);
    if (pillar === "edges")     drawEdgesOverlay(svg, NS, result, cardBounds);
    if (pillar === "surface")   drawSurfaceOverlay(svg, NS, result, cardBounds);
  }

  // Per-side zones from Claude (works for back too)
  if (analysis?.zones?.length) {
    drawZoneOverlays(svg, NS, analysis.zones, pillar, cardBounds);
  }

  wrap.appendChild(svg);
  card.appendChild(wrap);

  // Caption
  const cap = document.createElement("div");
  cap.className = "detail-image-caption";
  cap.textContent = caption ?? overlayCaption(pillar, result, sideIndex);
  card.appendChild(cap);

  return card;
}

function overlayCaption(pillar, r, sideIndex) {
  if (pillar === "centering") {
    const c = r.centering?.[sideIndex];
    if (!c) return "";
    if (c.ratios?.left_right && c.ratios?.top_bottom) return `L/R ${c.ratios.left_right} · T/B ${c.ratios.top_bottom}`;
    return c.interpretation ?? "";
  }
  if (pillar === "surface" && sideIndex === 0) {
    const sl = r.surface_lines;
    return sl ? `Glare ${(sl.glare_fraction*100|0)}% · scratch score ${sl.score?.toFixed?.(2)}` : "";
  }
  return "";
}

// ── CENTERING overlay ─────────────────────────────────────────────────────
function drawCenteringOverlay(svg, NS, r, cardBounds) {
  const c = r.centering?.[0];
  if (!c || !c.inner_frame_bbox_pct) return;

  const inner = c.inner_frame_bbox_pct;
  // inner_frame_bbox_pct is in card-fraction space (0–1 relative to the cropped card).
  // The SVG viewBox is 0..100 over the full photo, so we must offset by cardBounds.
  const cb = cardBounds ?? { x: 0, y: 0, w: 1, h: 1 };
  const fx = (cb.x + inner.x * cb.w) * 100;
  const fy = (cb.y + inner.y * cb.h) * 100;
  const fw = inner.w * cb.w * 100;
  const fh = inner.h * cb.h * 100;

  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("x", fx);
  rect.setAttribute("y", fy);
  rect.setAttribute("width",  fw);
  rect.setAttribute("height", fh);
  rect.setAttribute("class", "sv-content");
  rect.setAttribute("stroke-width", "0.6");
  svg.appendChild(rect);

  // Margin labels — placed at the midpoint of each margin band
  if (c.margins_pct) {
    const { left, right, top, bottom } = c.margins_pct;
    const cLeft   = cb.x * 100;
    const cRight  = (cb.x + cb.w) * 100;
    const cTop    = cb.y * 100;
    const cBottom = (cb.y + cb.h) * 100;
    addLabel(svg, NS, (cLeft + fx) / 2,         fy + fh / 2, `${left}%`);
    addLabel(svg, NS, (fx + fw + cRight) / 2,   fy + fh / 2, `${right}%`);
    addLabel(svg, NS, fx + fw / 2, (cTop + fy) / 2,          `${top}%`);
    addLabel(svg, NS, fx + fw / 2, (fy + fh + cBottom) / 2,  `${bottom}%`);
  }
}

// ── Coordinate helper ─────────────────────────────────────────────────────
// CV measurements (corner_boxes, edge_bands, surface_grid, zone boxes) are in
// card-percentage space (0–100 of the cropped card). The SVG viewBox covers the
// full eBay photo (0–100). cardBounds {x,y,w,h} in 0–1 photo fractions maps
// the card region inside the photo — apply it to all card-space coordinates.
function cardPctToSvg(x, y, w, h, cb) {
  const c = cb ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: (c.x + (x / 100) * c.w) * 100,
    y: (c.y + (y / 100) * c.h) * 100,
    w: (w / 100) * c.w * 100,
    h: (h / 100) * c.h * 100,
  };
}

// ── CORNERS overlay ───────────────────────────────────────────────────────
function drawCornersOverlay(svg, NS, r, cardBounds) {
  for (const c of (r.corner_boxes ?? [])) {
    const s = cardPctToSvg(c.x_pct, c.y_pct, c.w_pct, c.h_pct, cardBounds);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", s.x);
    rect.setAttribute("y", s.y);
    rect.setAttribute("width",  s.w);
    rect.setAttribute("height", s.h);
    rect.setAttribute("class", `sv-${c.severity}`);
    rect.setAttribute("stroke-width", "0.8");
    svg.appendChild(rect);
    addLabel(svg, NS, s.x + s.w / 2, s.y + s.h / 2, c.corner);
  }
}

// ── EDGES overlay ─────────────────────────────────────────────────────────
function drawEdgesOverlay(svg, NS, r, cardBounds) {
  for (const e of (r.edge_bands ?? [])) {
    const s = cardPctToSvg(e.x_pct, e.y_pct, e.w_pct, e.h_pct, cardBounds);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", s.x);
    rect.setAttribute("y", s.y);
    rect.setAttribute("width",  s.w);
    rect.setAttribute("height", s.h);
    rect.setAttribute("class", `sv-${e.severity}`);
    rect.setAttribute("stroke-width", "0.6");
    svg.appendChild(rect);
  }
}

// ── SURFACE heatmap overlay ───────────────────────────────────────────────
function drawSurfaceOverlay(svg, NS, r, cardBounds) {
  for (const cell of (r.surface_grid ?? [])) {
    const s = cardPctToSvg(cell.x_pct, cell.y_pct, cell.w_pct, cell.h_pct, cardBounds);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", s.x);
    rect.setAttribute("y", s.y);
    rect.setAttribute("width",  s.w);
    rect.setAttribute("height", s.h);
    rect.setAttribute("class", `sv-${cell.severity}`);
    rect.setAttribute("stroke-width", "0.15");
    // Glare-masked cells are shown dim — Claude couldn't see them
    if (cell.glare_masked) {
      rect.setAttribute("fill", "rgba(120,120,120,0.35)");
      rect.setAttribute("stroke", "rgba(180,180,180,0.5)");
    } else {
      const opacity = Math.min(0.55, 0.15 + (cell.score ?? 0) * 0.5);
      rect.setAttribute("fill-opacity", opacity);
    }
    svg.appendChild(rect);
  }
}

// ── Per-side Claude zones (works on back too) ─────────────────────────────
function drawZoneOverlays(svg, NS, zones, pillar, cardBounds) {
  const PILLAR_MATCH = {
    centering: (z) => false, // covered by drawCenteringOverlay
    corners:   (z) => /-corner$/.test(z.zone),
    edges:     (z) => /-edge$/.test(z.zone),
    surface:   (z) => z.zone === "surface" || /^surface/.test(z.zone),
  };
  const isMatch = PILLAR_MATCH[pillar] ?? (() => false);

  // Zone positions as percentages of the card (0–100)
  const ZONE_BOXES = {
    "tl-corner": { x: 0,  y: 0,  w: 18, h: 18 },
    "tr-corner": { x: 82, y: 0,  w: 18, h: 18 },
    "bl-corner": { x: 0,  y: 82, w: 18, h: 18 },
    "br-corner": { x: 82, y: 82, w: 18, h: 18 },
    "top-edge":     { x: 18, y: 0,  w: 64, h: 8  },
    "bottom-edge":  { x: 18, y: 92, w: 64, h: 8  },
    "left-edge":    { x: 0,  y: 18, w: 8,  h: 64 },
    "right-edge":   { x: 92, y: 18, w: 8,  h: 64 },
    "surface":      { x: 18, y: 18, w: 64, h: 64 },
  };

  for (const z of zones) {
    if (!isMatch(z)) continue;
    const box = ZONE_BOXES[z.zone];
    if (!box) continue;
    const s = cardPctToSvg(box.x, box.y, box.w, box.h, cardBounds);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", s.x);
    rect.setAttribute("y", s.y);
    rect.setAttribute("width",  s.w);
    rect.setAttribute("height", s.h);
    rect.setAttribute("class", `sv-${z.severity ?? "minor"}`);
    rect.setAttribute("stroke-width", "0.5");
    rect.setAttribute("fill-opacity", "0.18");
    svg.appendChild(rect);
  }
}

function addLabel(svg, NS, x, y, text) {
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.setAttribute("class", "sv-label");
  t.textContent = text;
  svg.appendChild(t);
}

// ── Findings list ─────────────────────────────────────────────────────────
function renderDetailFindings(pillar, r) {
  const findings = $("detail-findings");
  findings.innerHTML = "";

  // Combine top-level issues + per-side issues (deduped, side-tagged)
  const combined = [];
  const top      = r.issues?.[pillar] ?? [];
  for (const i of top) combined.push({ text: i, side: null });

  const fIssues = r.front_analysis?.issues?.[pillar] ?? [];
  for (const i of fIssues) {
    if (!top.some(t => t.includes(i))) combined.push({ text: i, side: "front" });
  }
  const bIssues = r.back_analysis?.issues?.[pillar] ?? [];
  for (const i of bIssues) combined.push({ text: i, side: "back" });

  if (combined.length === 0) {
    findings.innerHTML = `<div class="finding-empty">No issues detected for ${PILLAR_TITLES[pillar].toLowerCase()}.</div>`;
    return;
  }

  for (const f of combined) {
    const row = document.createElement("div");
    const sev = severityFromText(f.text);
    row.className = `finding-row f-${sev}`;
    const sideTag = f.side ? `<strong style="color:var(--sub);font-weight:600">[${f.side}]</strong> ` : "";
    row.innerHTML = `${sideTag}${f.text}`;
    findings.appendChild(row);
  }
}

function severityFromText(text) {
  const t = String(text).toLowerCase();
  if (t.includes("heavy") || t.includes("severe") || t.includes("bent")) return "heavy";
  if (t.includes("moderate") || t.includes("chip")) return "moderate";
  if (t.includes("minor") || t.includes("slight") || t.includes("light")) return "minor";
  return "minor";
}

// ── Measurements ──────────────────────────────────────────────────────────
function renderDetailMeasurements(pillar, r) {
  const block  = $("detail-measurements-block");
  const target = $("detail-measurements");
  target.innerHTML = "";

  const rows = [];

  if (pillar === "centering") {
    const c = r.centering?.[0];
    if (c?.ratios) {
      rows.push(["L/R ratio", c.ratios.left_right ?? "—"]);
      rows.push(["T/B ratio", c.ratios.top_bottom ?? "—"]);
    }
    if (c?.margins_pct) {
      rows.push(["Left margin",   pct(c.margins_pct.left)]);
      rows.push(["Right margin",  pct(c.margins_pct.right)]);
      rows.push(["Top margin",    pct(c.margins_pct.top)]);
      rows.push(["Bottom margin", pct(c.margins_pct.bottom)]);
    }
    if (c?.interpretation) rows.push(["Interpretation", c.interpretation]);
    if (c?.confidence)     rows.push(["Confidence",    c.confidence]);
  }

  if (pillar === "corners") {
    const sevs = (r.corner_boxes ?? []).reduce((acc, c) => ((acc[c.corner] = c.severity), acc), {});
    rows.push(["Top-left",     sevs.TL ?? "—"]);
    rows.push(["Top-right",    sevs.TR ?? "—"]);
    rows.push(["Bottom-left",  sevs.BL ?? "—"]);
    rows.push(["Bottom-right", sevs.BR ?? "—"]);
  }

  if (pillar === "edges") {
    const bi = r.border_irregularity ?? {};
    rows.push(["Severity",            bi.severity ?? "—"]);
    rows.push(["Irregularity score",  bi.score?.toFixed?.(3) ?? "—"]);
    if (bi.per_side) {
      const ps = bi.per_side;
      rows.push(["Top edge grad",    pct(ps.top?.grad_fraction)]);
      rows.push(["Right edge grad",  pct(ps.right?.grad_fraction)]);
      rows.push(["Bottom edge grad", pct(ps.bottom?.grad_fraction)]);
      rows.push(["Left edge grad",   pct(ps.left?.grad_fraction)]);
    }
  }

  if (pillar === "surface") {
    const sl = r.surface_lines ?? {};
    rows.push(["Severity",           sl.severity ?? "—"]);
    rows.push(["Scratch score",      sl.score?.toFixed?.(3) ?? "—"]);
    rows.push(["Glare coverage",     pct(sl.glare_fraction)]);
    rows.push(["Diagonal energy",    pct(sl.diagonal_energy_fraction)]);
    rows.push(["Horizontal energy",  pct(sl.h_energy_fraction)]);
    rows.push(["Vertical energy",    pct(sl.v_energy_fraction)]);
    const gridCells = r.surface_grid ?? [];
    const heavy = gridCells.filter(c => c.severity === "heavy").length;
    const total = gridCells.length;
    if (total) rows.push(["Heavy grid cells", `${heavy} / ${total}`]);
  }

  if (rows.length === 0) {
    block.style.display = "none";
    return;
  }
  block.style.display = "";

  for (const [label, value] of rows) {
    const row  = document.createElement("div");
    row.className = "measurement-row";
    row.innerHTML = `<span class="measurement-label">${label}</span><span class="measurement-value">${value}</span>`;
    target.appendChild(row);
  }
}

function pct(v) {
  if (v == null || isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

// ══════════════════════════════════════════════════════════════════════════

// Ask the active tab's content script for its listing. If the content script
// isn't present (the tab was already open when the extension last reloaded —
// content scripts only inject on page load), inject it on the fly and retry,
// so the user never has to manually refresh the eBay tab.
async function requestListingFromTab(tabId) {
  let resp = await chrome.tabs.sendMessage(tabId, { type: "REQUEST_LISTING" }).catch(() => null);
  if (resp?.listing) return resp.listing;
  await sendBg({ type: "INJECT_CONTENT", tabId });   // best-effort programmatic inject
  await new Promise((r) => setTimeout(r, 500));        // let document_idle extraction settle
  resp = await chrome.tabs.sendMessage(tabId, { type: "REQUEST_LISTING" }).catch(() => null);
  return resp?.listing ?? null;
}

// sendBg — always resolves (never hangs). 8 s timeout as safety net.
function sendBg(msg, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({});
        else resolve(resp ?? {});
      });
    } catch {
      clearTimeout(timer);
      resolve({});
    }
  });
}
