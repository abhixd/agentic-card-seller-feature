'use client'

/**
 * DefectZoomGallery — high-resolution close-ups of a graded card's potential problem areas, so a buyer
 * can verify whitening / edge wear / corner damage / surface scratches before purchase. Crops come from
 * GradeResult.pillar_zooms (present only when /grade was called with ?zoom=1). Crops are clean (no
 * overlay) — the buyer judges the actual pixels; `flagged` is an advisory hint from our scan.
 * Tap any crop to open it full-screen. Self-contained, no UI-lib dep.
 */
import { useEffect, useState } from 'react'
import type { PillarZooms } from '@/lib/grading/types'

const src = (b64: string) => `data:image/jpeg;base64,${b64}`
const SIDES = ['top', 'right', 'bottom', 'left'] as const
const CORNERS = ['TL', 'TR', 'BR', 'BL'] as const

export function DefectZoomGallery({ zooms, onClose }: { zooms: PillarZooms | null; onClose: () => void }) {
  const [full, setFull] = useState<string | null>(null)
  useEffect(() => {
    if (!zooms) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') (full ? setFull(null) : onClose()) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zooms, full, onClose])
  if (!zooms) return null

  const edges = zooms.edges ?? {}
  const corners = zooms.corners ?? {}
  const surface = zooms.surface?.scratches
  const empty = !Object.keys(edges).length && !Object.keys(corners).length && !surface

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose() }} className="fixed inset-0 z-[60] overflow-y-auto bg-black/70 p-4">
      <div onClick={(e) => e.stopPropagation()} className="mx-auto my-[3vh] w-full max-w-3xl rounded-xl border bg-background p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Defect close-ups</h2>
            <p className="text-xs text-muted-foreground">High-res crops of every edge, corner &amp; flagged surface area — tap any to enlarge.</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">✕</button>
        </div>

        {Object.keys(edges).length > 0 && (
          <Section title="Edges">
            <div className="space-y-2">
              {SIDES.map((side) => {
                const e = edges[side]
                if (!e) return null
                return (
                  <figure key={side} className="overflow-hidden rounded-md border">
                    <button onClick={() => setFull(e.crop_b64)} className="block w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src(e.crop_b64)} alt={`${side} edge`} className="block w-full" />
                    </button>
                    <figcaption className="flex items-center justify-between gap-2 bg-muted/40 px-2 py-1 text-[11px]">
                      <span className="capitalize text-muted-foreground">{side} edge</span>
                      <span className={e.flagged && e.flagged.length ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'}>
                        {e.flagged && e.flagged.length ? `flagged: ${e.flagged.join(', ')}` : 'no significant wear flagged'}
                      </span>
                    </figcaption>
                  </figure>
                )
              })}
            </div>
          </Section>
        )}

        {Object.keys(corners).length > 0 && (
          <Section title="Corners">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CORNERS.map((c) => {
                const b = corners[c]
                if (!b) return null
                return (
                  <figure key={c} className="overflow-hidden rounded-md border">
                    <button onClick={() => setFull(b)} className="block w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src(b)} alt={`${c} corner`} className="block aspect-square w-full object-cover" />
                    </button>
                    <figcaption className="bg-muted/40 px-2 py-0.5 text-center text-[11px] text-muted-foreground">{c}</figcaption>
                  </figure>
                )
              })}
            </div>
          </Section>
        )}

        {surface && (
          <Section title="Surface">
            <figure className="overflow-hidden rounded-md border">
              <button onClick={() => setFull(surface.crop_b64)} className="block w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src(surface.crop_b64)} alt="surface scratch area" className="block w-full" />
              </button>
              <figcaption className="bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                {surface.count ? `${surface.count} scratch area${surface.count > 1 ? 's' : ''} flagged — inspect for scratches` : 'flagged surface area'}
              </figcaption>
            </figure>
          </Section>
        )}

        {empty && <p className="text-sm text-muted-foreground">No close-ups available for this card.</p>}
        <p className="mt-3 text-[11px] text-muted-foreground/70">Clean high-res crops for buyer verification. &ldquo;flagged&rdquo; is our scan&rsquo;s hint — judge from the photo.</p>
      </div>

      {full && (
        <div onClick={(e) => { e.stopPropagation(); setFull(null) }} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src(full)} alt="defect close-up" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}
