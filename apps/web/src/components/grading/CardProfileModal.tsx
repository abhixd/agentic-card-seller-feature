'use client'

/**
 * CardProfileModal — click-to-open card profile for a graded card.
 * Shows the vision-identified identity (set + number + rarity + variant + language + year + ID confidence),
 * a card image, the raw market price + TCGplayer link, and a compact graded-comps table — everything the
 * buyer needs to confirm "what is this card" before purchase. Data comes from the /scout response
 * (identity + comps_detail + thumb_b64), hydrated alongside the grade. Self-contained, no UI-lib dep.
 */
import { useEffect } from 'react'
import type { CardProfile } from '@/lib/grading/types'

const money = (n?: number | null) =>
  n == null ? null : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const gradeOrder = (g: string) => {
  const m = g.match(/^psa(\d+)(?:_(\d))?$/i)
  if (m) return 100 - (parseInt(m[1]) + (m[2] ? 0.5 : 0))   // PSA 10 first … PSA 1
  if (g === 'ungraded') return 200
  return 300
}

export function CardProfileModal({ profile, confirmed = true, analyzeHref = null, onClose }: { profile: CardProfile | null; confirmed?: boolean; analyzeHref?: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!profile) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [profile, onClose])
  if (!profile) return null

  const id = profile.identity
  const c = profile.comps
  const img = c?.card?.imageCdnUrl || (profile.thumb_b64 ? `data:image/jpeg;base64,${profile.thumb_b64}` : null)
  const meta = [id.set || c?.card?.setName, id.number && `#${id.number}`, id.variant, id.language, id.year]
    .filter(Boolean).join(' · ')
  const grades = Object.entries(c?.grades || {})
    .filter(([, v]) => v && (v.medianPrice != null || v.count))
    .sort((a, b) => gradeOrder(a[0]) - gradeOrder(b[0]))

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose() }} className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div onClick={(e) => e.stopPropagation()} className="my-[4vh] w-full max-w-lg rounded-xl border bg-background p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{id.title || id.name || 'Card profile'}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{meta || 'identity details'}</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">✕</button>
        </div>

        {!confirmed && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            ⚠️ We couldn’t confirm this exact card from your photo (glare, sleeve, or an unclear image). These
            details — and the reference image — are a best guess and may not match the card you uploaded.
          </div>
        )}

        <div className="mt-4 flex gap-4">
          {img && (
            <div className="shrink-0 self-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt={id.name || 'card'} className={`w-28 rounded-md border object-contain ${confirmed ? '' : 'opacity-60'}`} />
              {!confirmed && <p className="mt-1 w-28 text-center text-[10px] text-amber-600 dark:text-amber-400">reference — may not match</p>}
            </div>
          )}
          <dl className="min-w-0 flex-1 space-y-1 text-sm">
            <Row k="Set" v={id.set || c?.card?.setName} />
            <Row k="Number" v={id.number} />
            <Row k="Rarity" v={id.rarity || c?.card?.rarity} />
            <Row k="Variant" v={id.variant} />
            <Row k="Language" v={id.language} />
            <Row k="Year" v={id.year != null ? String(id.year) : null} />
            {id.confidence != null && <Row k="ID confidence" v={`${Math.round(id.confidence * 100)}%`} />}
          </dl>
        </div>

        {(c?.raw?.market != null || c?.card?.tcgPlayerUrl) && (
          <div className="mt-4 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Raw market{c?.raw?.sellers != null ? ` · ${c.raw.sellers} sellers` : ''}</span>
            <span className="flex items-center gap-3">
              {c?.raw?.market != null && <span className="font-medium tabular-nums">{money(c.raw.market)}</span>}
              {c?.card?.tcgPlayerUrl && (
                <a href={c.card.tcgPlayerUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">TCGplayer ↗</a>
              )}
            </span>
          </div>
        )}

        {grades.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Graded comps · eBay sold</div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-[12px] tabular-nums">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-normal">Grade</th>
                    <th className="px-2 py-1 text-right font-normal">Median</th>
                    <th className="px-2 py-1 text-right font-normal">7-day</th>
                    <th className="px-2 py-1 text-right font-normal">n</th>
                    <th className="px-2 py-1 text-center font-normal">Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {grades.map(([g, v]) => (
                    <tr key={g}>
                      <td className="px-2 py-1 uppercase">{g.replace('_', '.')}</td>
                      <td className="px-2 py-1 text-right">{money(v.medianPrice) ?? '—'}</td>
                      <td className="px-2 py-1 text-right">{money(v.marketPrice7Day) ?? '—'}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{v.count ?? '—'}</td>
                      <td className="px-2 py-1 text-center">{v.marketTrend === 'up' ? '↑' : v.marketTrend === 'down' ? '↓' : '·'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!c && <p className="mt-4 text-xs text-muted-foreground">No market match found yet — set &amp; identity shown from the photo read.</p>}

        {analyzeHref && (
          // Same-tab: the grade page persists its result to sessionStorage, so the browser Back button
          // returns here with the graded card restored (no re-grade). Works on mobile too.
          <a href={analyzeHref}
             className="mt-4 flex items-center justify-between rounded-lg border border-blue-500/40 bg-blue-500/5 px-3 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-500/10 dark:text-blue-400">
            <span>View full price history &amp; grading analysis</span>
            <span aria-hidden>→</span>
          </a>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground/70">Identified from your photo. Confirm set &amp; number before listing.</p>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v?: string | number | null }) {
  if (v == null || v === '') return null
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{k}</dt>
      <dd className="min-w-0 flex-1 truncate">{v}</dd>
    </div>
  )
}
