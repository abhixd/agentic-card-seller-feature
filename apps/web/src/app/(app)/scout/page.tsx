'use client'

import { useCallback, useRef, useState } from 'react'
import { Target, Upload, Loader2, X } from 'lucide-react'
import { PillarVisualDialog } from '@/components/grading/PillarVisualDialog'
import type { PillarVisuals } from '@/lib/grading/types'

type Identity = {
  name?: string; set?: string; number?: string; year?: number
  variant?: string; language?: string; title?: string; confidence?: number
}
type Grade = {
  overall_score: number; psa_equivalent?: string; confidence?: string
  tier_distribution?: Record<string, number>; summary?: string; border_type?: string
}
type Pillar = {
  score?: number; left_right?: string; top_bottom?: string; notes?: string; worst_severity?: string
  content_region?: { x1: number; y1: number; x2: number; y2: number }
  /** centering only: 0..1 numeric read confidence from the grader (faint-edge / sleeve aware) */
  confidence?: number | null
}

/** Same thresholds as the grade page's CenteringPanel so the two surfaces can't disagree. */
function ConfidenceBadge({ conf }: { conf?: number | null }) {
  if (conf == null) return <span className="text-white/25">—</span>
  const cls =
    conf >= 0.85 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
    : conf >= 0.6 ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
    : 'border-red-500/40 bg-red-500/10 text-red-400'
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums ${cls}`}
          title="centering read confidence — low means verify the borders before trusting the centering">
      {Math.round(conf * 100)}%
    </span>
  )
}
type Pillars = { centering?: Pillar; corners?: Pillar; edges?: Pillar; surface?: Pillar }
type Economics = {
  expected_value?: number | null
  max_buy_price_for_psa9_target?: number | null
  max_buy_price_for_psa8_target?: number | null
  raw_estimate?: number | null
  psa8_estimate?: number | null
  psa9_estimate?: number | null
  psa10_estimate?: number | null
  listing_price?: number | null
} | null
type Decision = { label: string; reason: string } | null
type GradeStat = {
  count?: number; medianPrice?: number; averagePrice?: number; minPrice?: number; maxPrice?: number
  marketPrice7Day?: number; marketPriceMedian7Day?: number; dailyVolume7Day?: number
  marketTrend?: string; smartPrice?: number; smartConfidence?: string; smartMethod?: string
}
type CompsDetail = {
  card?: { name?: string; setName?: string; cardNumber?: string; rarity?: string; tcgPlayerUrl?: string; imageCdnUrl?: string }
  raw?: { market?: number; low?: number; sellers?: number; lastUpdated?: string }
  ebay_updated?: string
  grades?: Record<string, GradeStat>
}
type ScoutResult = {
  identity: Identity
  identify_error?: string | null
  grade: Grade
  pillars?: Pillars
  card_boundary?: number[] | null
  pillar_visuals?: PillarVisuals
  issues?: Record<string, string[]>
  economics: Economics
  decision: Decision
  comps_source?: string | null
  comps_basis?: string | null
  estimated?: boolean
  price_matched?: string | null
  price_confidence?: string | null
  comps_detail?: CompsDetail | null
  thumb_b64?: string | null
}

/** comps present only when the service reports a real pricing basis (not "none"). */
const hasComps = (r?: ScoutResult | null) => !!r?.comps_basis && r.comps_basis !== 'none'
type Row = {
  id: string; file: File; name: string; previewUrl: string
  status: 'pending' | 'scanning' | 'done' | 'error'
  result?: ScoutResult; error?: string
}

const CONCURRENCY = 3
const money = (n?: number | null) => (n == null ? null : `$${Math.round(n)}`)
const DECISION_STYLE: Record<string, string> = {
  buy:     'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  maybe:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
  skip:    'bg-white/5 text-white/40 border-white/10',
  unknown: 'bg-white/5 text-white/40 border-white/10',
}

export default function ScoutPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<Row | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (files: FileList | null) => {
    if (!files) return
    const next: Row[] = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`, file: f, name: f.name,
        previewUrl: URL.createObjectURL(f), status: 'pending' as const,
      }))
    setRows((prev) => [...prev, ...next])
  }

  const scanOne = async (row: Row): Promise<ScoutResult | { error: string }> => {
    const fd = new FormData()
    fd.append('image', row.file, row.name)
    try {
      const res = await fetch('/api/scout', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) return { error: data?.error || 'Scan failed' }
      return data as ScoutResult
    } catch {
      return { error: 'Network error' }
    }
  }

  const scan = useCallback(async () => {
    const queue = rows.filter((r) => r.status === 'pending' || r.status === 'error')
    if (!queue.length) return
    setScanning(true)
    const ids = new Set(queue.map((q) => q.id))
    setRows((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, status: 'scanning', error: undefined } : r)))
    const work = [...queue]
    const worker = async () => {
      while (work.length) {
        const row = work.shift()!
        const out = await scanOne(row)
        setRows((prev) => prev.map((r) => (r.id === row.id
          ? ('error' in out ? { ...r, status: 'error', error: out.error } : { ...r, status: 'done', result: out })
          : r)))
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker))
    setScanning(false)
  }, [rows])

  const removeRow = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id))
  const clearAll = () => { setRows([]); if (inputRef.current) inputRef.current.value = '' }

  // rank: buy > maybe > skip/unknown, then by predicted grade desc
  const ordered = [...rows].sort((a, b) => {
    const rank = (r: Row) => {
      if (r.status !== 'done' || !r.result) return -1
      const d = r.result.decision?.label
      const base = d === 'buy' ? 3 : d === 'maybe' ? 2 : d === 'skip' ? 1 : 0
      return base * 100 + (r.result.grade?.overall_score || 0)
    }
    return rank(b) - rank(a)
  })

  const total = rows.length
  const done = rows.filter((r) => r.status === 'done').length
  const pendingCount = rows.filter((r) => r.status === 'pending' || r.status === 'error').length
  const anyComps = rows.some((r) => hasComps(r.result))
  const anyEstimated = rows.some((r) => r.result?.estimated)

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-cyan-700">
          <Target className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Sourcing Scout</h1>
          <p className="text-sm text-white/50">
            Drop a dealer&apos;s photo dump — it identifies each card, predicts its grade, and tells you what to pay.
          </p>
        </div>
      </div>

      {/* Upload (drag-and-drop, multi-select) + actions */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
        className={`mt-5 rounded-xl border border-dashed bg-white/[0.02] p-4 transition-colors ${
          dragOver ? 'border-cyan-500/60 bg-cyan-500/[0.06]' : 'border-white/15'
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
          >
            <Upload className="h-4 w-4" /> Add photos
          </button>
          <input
            ref={inputRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { addFiles(e.target.files); if (inputRef.current) inputRef.current.value = '' }}
          />
          <button
            onClick={scan}
            disabled={scanning || pendingCount === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 hover:bg-cyan-500"
          >
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            {scanning ? 'Scanning…' : `Scan ${pendingCount || ''} card${pendingCount === 1 ? '' : 's'}`}
          </button>
          {total > 0 && (
            <button onClick={clearAll} className="text-xs text-white/40 hover:text-white/70">Clear all</button>
          )}
          {total > 0 && (
            <span className="ml-auto text-xs text-white/40 tabular-nums">{done}/{total} scanned</span>
          )}
        </div>
        <p className="mt-3 text-xs text-white/40">
          {dragOver
            ? 'Drop to add these photos…'
            : 'Drag a whole batch of card photos here, or click “Add photos” and select several at once (Cmd/Ctrl- or Shift-click). Each scans independently and streams in.'}
        </p>
      </div>

      {/* comps caveat */}
      {done > 0 && anyEstimated && (
        <div className="mt-4 rounded-lg border border-cyan-500/25 bg-cyan-500/[0.06] px-3 py-2 text-xs text-cyan-100/90">
          <b>Prices via pokemontcg.io (free).</b> Raw is real market price; PSA 8/9/10, EV and max-bid are
          <b> estimated</b> from raw × grade multipliers (shown with a ~). Connect a paid graded feed for true
          PSA sold comps — the estimate is replaced automatically.
        </div>
      )}
      {done > 0 && !anyComps && (
        <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/90">
          <b>No price match</b> — identity + predicted grade are live (click any card for the full grading
          breakdown), but max-bid / EV / verdict stay <b>NO DATA</b> when no card matched in pokemontcg.io.
          Ranked by predicted grade for now.
        </div>
      )}

      {/* worklist */}
      {total > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-white/40">
              <tr>
                <th className="px-3 py-2 text-left font-normal">Card</th>
                <th className="px-3 py-2 text-left font-normal">Identity</th>
                <th className="px-3 py-2 text-center font-normal">Grade</th>
                <th className="px-3 py-2 text-center font-normal">Confidence</th>
                <th className="px-3 py-2 text-right font-normal">Max bid</th>
                <th className="px-3 py-2 text-right font-normal">EV</th>
                <th className="px-3 py-2 text-center font-normal">Verdict</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {ordered.map((r) => {
                const res = r.result
                const id = res?.identity
                const econ = res?.economics
                const dec = res?.decision?.label
                const comps = hasComps(res)
                const est = res?.estimated
                const tilde = est ? '~' : ''
                const clickable = r.status === 'done'
                return (
                  <tr
                    key={r.id}
                    onClick={() => clickable && setSelected(r)}
                    className={`hover:bg-white/[0.02] ${clickable ? 'cursor-pointer' : ''}`}
                    title={clickable ? 'Click for grading details' : undefined}
                  >
                    <td className="px-3 py-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={res?.thumb_b64 ? `data:image/jpeg;base64,${res.thumb_b64}` : r.previewUrl}
                        alt={id?.title || r.name}
                        className="h-16 w-12 rounded object-cover bg-white/5"
                      />
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {r.status === 'scanning' && <span className="text-white/40">identifying…</span>}
                      {r.status === 'error' && <span className="text-red-400">{r.error}</span>}
                      {r.status === 'pending' && <span className="text-white/30">queued</span>}
                      {r.status === 'done' && (
                        <div>
                          <div className="font-medium">{id?.title || id?.name || 'Unknown card'}</div>
                          <div className="text-[11px] text-white/40">
                            {[id?.set, id?.number, id?.variant].filter(Boolean).join(' · ')}
                            {id?.confidence != null && <> · id {Math.round(id.confidence * 100)}%</>}
                            <span className="ml-1.5 text-cyan-400/70">· details</span>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums">
                      {res ? (
                        <div>
                          <div className="font-semibold">{res.grade.psa_equivalent || res.grade.overall_score}</div>
                          <div className="text-[11px] text-white/40">
                            {res.grade.overall_score?.toFixed(1)} · {res.grade.confidence}
                          </div>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {res ? <ConfidenceBadge conf={res.pillars?.centering?.confidence} /> : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" title={est ? 'estimated from raw price' : undefined}>
                      {comps ? `${tilde}${money(econ?.max_buy_price_for_psa9_target) ?? '—'}`
                        : <span className="text-white/25">NO DATA</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" title={est ? 'estimated from raw price' : undefined}>
                      {comps ? `${tilde}${money(econ?.expected_value) ?? '—'}`
                        : <span className="text-white/25">NO DATA</span>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {!res ? <span className="text-white/25 text-[11px]">—</span>
                        : comps && dec ? (
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] capitalize ${DECISION_STYLE[dec] || DECISION_STYLE.unknown}`}>
                            {dec}
                          </span>
                        ) : <span className="text-white/25 text-[11px]">NO DATA</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); removeRow(r.id) }}
                        className="text-white/25 hover:text-white/60"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected?.result && <ScoutDetail row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function Stat({ label, v }: { label: string; v: string | null }) {
  return (
    <div className="rounded bg-white/[0.03] p-2">
      <div className="text-[10px] text-white/40">{label}</div>
      <div className="font-semibold tabular-nums">{v ?? '—'}</div>
    </div>
  )
}

// Visual "value by grade" ladder — raw → PSA 8/9/10 bars, predicted grade highlighted, source labelled.
function PriceLadder({ res }: { res: ScoutResult }) {
  const e = res.economics
  if (!e) return null
  const rows = ([
    { key: 'raw', label: 'Raw', v: e.raw_estimate },
    { key: 'psa8', label: 'PSA 8', v: e.psa8_estimate },
    { key: 'psa9', label: 'PSA 9', v: e.psa9_estimate },
    { key: 'psa10', label: 'PSA 10', v: e.psa10_estimate },
  ].filter((r) => r.v != null) as { key: string; label: string; v: number }[])
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.v))
  const pm = (res.grade.psa_equivalent || '').match(/PSA\s*(\d+)/i)
  const predicted = pm ? `psa${pm[1]}` : null
  const src = res.comps_basis === 'sold' ? 'real PSA sold · PPT'
    : res.comps_basis === 'active' ? 'eBay asking (skews high)'
    : res.estimated ? 'modeled from raw' : ''
  return (
    <div className="mt-4 rounded-lg border border-white/10 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-white/40">Value by grade</span>
        {src && <span className="text-[10px] text-white/40">{src}</span>}
      </div>
      <div className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const hot = r.key === predicted
          return (
            <div key={r.key} className="flex items-center gap-2">
              <span className={`w-12 text-[11px] ${hot ? 'font-semibold text-emerald-300' : 'text-white/50'}`}>{r.label}</span>
              <div className="h-5 flex-1 rounded bg-white/5">
                <div
                  className={`flex h-full min-w-[2.75rem] items-center justify-end rounded px-1.5 ${hot ? 'bg-emerald-500/80' : 'bg-cyan-600/70'}`}
                  style={{ width: `${Math.max(10, Math.round((r.v / max) * 100))}%` }}
                >
                  <span className="text-[10px] font-medium tabular-nums text-white">{money(r.v)}</span>
                </div>
              </div>
              {hot && <span className="w-16 text-[9px] uppercase tracking-wide text-emerald-300/70">your grade</span>}
              {!hot && <span className="w-16" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PillarBar({ label, p, onClick }: { label: string; p?: Pillar; onClick?: () => void }) {
  const s = p?.score
  const color = s == null ? 'bg-white/10' : s >= 9 ? 'bg-emerald-500' : s >= 7 ? 'bg-amber-500' : 'bg-rose-500'
  const body = (
    <>
      <span className="w-20 capitalize text-white/50">{label}</span>
      <div className="h-1.5 flex-1 rounded bg-white/5">
        <div className={`h-full rounded ${color}`} style={{ width: `${Math.max(0, Math.min(10, s ?? 0)) * 10}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums">{s != null ? s.toFixed(1) : '—'}</span>
      {onClick && <span className="text-white/30" aria-hidden>⤢</span>}
    </>
  )
  return onClick
    ? <button type="button" onClick={onClick} title="See what we measured" className="flex w-full items-center gap-2 text-left text-xs hover:opacity-80">{body}</button>
    : <div className="flex items-center gap-2 text-xs">{body}</div>
}

function ScoutDetail({ row, onClose }: { row: Row; onClose: () => void }) {
  const res = row.result!
  const [openPillar, setOpenPillar] = useState<string | null>(null)
  const id = res.identity
  const g = res.grade
  const p = res.pillars
  const comps = hasComps(res)
  const dist = g.tier_distribution || {}
  const cr = p?.centering?.content_region
  const cb = res.card_boundary && res.card_boundary.length === 4 ? res.card_boundary : null
  const pv = res.pillar_visuals
  const hasVisual = (k: string) => !!pv && !!pv[k as keyof PillarVisuals]
  return (
    // scrollable overlay so a tall modal never clips at the top
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div
        className="mx-auto my-[2vh] w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0e0e12] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{id.title || id.name || 'Unknown card'}</h2>
            <p className="text-[11px] text-white/40">
              {[id.set, id.number, id.variant, id.language, id.year].filter(Boolean).join(' · ')}
              {id.confidence != null && <> · identified {Math.round(id.confidence * 100)}%</>}
            </p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-4 flex gap-4">
          {/* warped card + centering overlay (outer edge blue, inner print border emerald) — matches Grade Card */}
          <div className="relative w-32 shrink-0 self-start overflow-hidden rounded-lg bg-white/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={res.thumb_b64 ? `data:image/jpeg;base64,${res.thumb_b64}` : row.previewUrl}
              alt={id.title || row.name}
              className="block w-full"
            />
            {cr && res.thumb_b64 && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
                {cb && (
                  <rect x={cb[0] * 100} y={cb[1] * 100} width={(cb[2] - cb[0]) * 100} height={(cb[3] - cb[1]) * 100}
                    fill="none" stroke="#3b82f6" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                )}
                <rect x={cr.x1 * 100} y={cr.y1 * 100} width={(cr.x2 - cr.x1) * 100} height={(cr.y2 - cr.y1) * 100}
                  fill="none" stroke="#10b981" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{g.psa_equivalent || g.overall_score}</span>
              <span className="text-sm text-white/50">
                overall {g.overall_score?.toFixed(1)}/10 · {g.confidence} confidence
              </span>
            </div>
            {Object.keys(dist).length > 0 && (
              <div className="mt-2 space-y-1">
                {Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    <span className="w-14 text-white/50">{k}</span>
                    <div className="h-1.5 flex-1 rounded bg-white/5">
                      <div className="h-full rounded bg-cyan-500" style={{ width: `${Math.round(v * 100)}%` }} />
                    </div>
                    <span className="w-8 text-right tabular-nums text-white/60">{Math.round(v * 100)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-white/40">Pillar scores</div>
          <PillarBar label="centering" p={p?.centering} onClick={hasVisual('centering') ? () => setOpenPillar('centering') : undefined} />
          <PillarBar label="corners" p={p?.corners} onClick={hasVisual('corners') ? () => setOpenPillar('corners') : undefined} />
          <PillarBar label="edges" p={p?.edges} onClick={hasVisual('edges') ? () => setOpenPillar('edges') : undefined} />
          <PillarBar label="surface" p={p?.surface} onClick={hasVisual('surface') ? () => setOpenPillar('surface') : undefined} />
          <PillarVisualDialog pillar={openPillar} visuals={pv} centering={p?.centering} onClose={() => setOpenPillar(null)} />
          {pv && <p className="pt-0.5 text-[11px] text-white/30">tap a pillar to see what we measured</p>}
          {p?.centering && (p.centering.left_right || p.centering.top_bottom) && (
            <p className="pt-1 text-[11px] text-white/40">
              centering: {p.centering.left_right} L/R · {p.centering.top_bottom} T/B
              {p.centering.notes ? ` — ${p.centering.notes}` : ''}
            </p>
          )}
        </div>

        {res.issues && Object.values(res.issues).some((v) => v && v.length) && (
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wide text-white/40">Detected issues</div>
            <ul className="mt-1 space-y-0.5 text-xs text-white/60">
              {Object.entries(res.issues).flatMap(([pillar, list]) =>
                (list || []).map((it, i) => (
                  <li key={`${pillar}-${i}`}>· <span className="capitalize text-white/40">{pillar}:</span> {it}</li>
                )),
              )}
            </ul>
          </div>
        )}

        {g.summary && <p className="mt-3 rounded-lg bg-white/[0.03] p-2 text-xs text-white/60">{g.summary}</p>}

        {comps && <PriceLadder res={res} />}

        <div className="mt-4 rounded-lg border border-white/10 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-white/40">Decision math</span>
            <span className="text-[11px] text-white/40">comps: {res.comps_source || 'none'}</span>
          </div>
          {comps ? (
            <>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <Stat label="Raw (market)" v={money(res.economics?.raw_estimate)} />
                <Stat label={`PSA 9${res.estimated ? ' (est)' : ''}`} v={money(res.economics?.psa9_estimate)} />
                <Stat label={`PSA 10${res.estimated ? ' (est)' : ''}`} v={money(res.economics?.psa10_estimate)} />
                <Stat label={`Max bid PSA 9${res.estimated ? ' (est)' : ''}`} v={money(res.economics?.max_buy_price_for_psa9_target)} />
                <Stat label={`Expected value${res.estimated ? ' (est)' : ''}`} v={money(res.economics?.expected_value)} />
                <Stat label="Your ask" v={money(res.economics?.listing_price ?? null)} />
              </div>
              {res.price_matched && (
                <p className="mt-2 text-[11px] text-white/40">matched: {res.price_matched}</p>
              )}
              {res.estimated && (
                <p className="mt-1 text-[11px] text-cyan-200/70">
                  Raw is real market price (pokemontcg.io). PSA 8/9/10, EV and max-bid are <b>modeled</b> from
                  raw × grade multipliers — not real sold comps. A paid graded feed replaces these with
                  observed PSA prices.
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 text-xs text-amber-200/80">
              No price match in pokemontcg.io for this card, so max-bid / EV / verdict can&apos;t be computed.
              They populate when the card matches or a graded-price feed is connected.
            </p>
          )}
        </div>

        {res.comps_detail && <CompsTable d={res.comps_detail} />}
      </div>
    </div>
  )
}

const gradeOrder = (g: string) => {
  const m = g.match(/^psa(\d+)(?:_(\d))?$/i)
  if (m) return 100 - (parseInt(m[1]) + (m[2] ? 0.5 : 0)) // PSA 10 first … PSA 1
  if (g === 'ungraded') return 200
  return 300 // bgs/cgc/sgc/ace/etc. last
}

function CompsTable({ d }: { d: CompsDetail }) {
  const grades = Object.entries(d.grades || {})
    .filter(([, v]) => v && (v.medianPrice != null || v.count))
    .sort((a, b) => gradeOrder(a[0]) - gradeOrder(b[0]))
  const meta = [
    d.card?.rarity,
    d.raw?.market != null ? `raw $${d.raw.market}` : null,
    d.raw?.sellers != null ? `${d.raw.sellers} sellers` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="mt-3 rounded-lg border border-white/10 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-white/40">All comps · eBay sold (PPT)</span>
        {d.card?.tcgPlayerUrl && (
          <a href={d.card.tcgPlayerUrl} target="_blank" rel="noreferrer" className="text-[11px] text-cyan-400/80 hover:underline">
            TCGplayer ↗
          </a>
        )}
      </div>
      {meta && <div className="mt-1 text-[11px] text-white/40">{meta}</div>}
      {grades.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-white/35">
              <tr>
                <th className="px-1 py-1 text-left font-normal">Grade</th>
                <th className="px-1 py-1 text-right font-normal">Median</th>
                <th className="px-1 py-1 text-right font-normal">7-day</th>
                <th className="px-1 py-1 text-right font-normal">n</th>
                <th className="px-1 py-1 text-right font-normal">Range</th>
                <th className="px-1 py-1 text-center font-normal">Trend</th>
                <th className="px-1 py-1 text-right font-normal">Smart</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {grades.map(([g, v]) => (
                <tr key={g} className="text-white/70">
                  <td className="px-1 py-1 uppercase">{g.replace('_', '.')}</td>
                  <td className="px-1 py-1 text-right">{money(v.medianPrice) ?? '—'}</td>
                  <td className="px-1 py-1 text-right">{money(v.marketPrice7Day) ?? '—'}</td>
                  <td className="px-1 py-1 text-right text-white/40">{v.count ?? '—'}</td>
                  <td className="px-1 py-1 text-right text-white/40">
                    {v.minPrice != null && v.maxPrice != null ? `${money(v.minPrice)}–${money(v.maxPrice)}` : '—'}
                  </td>
                  <td className="px-1 py-1 text-center">
                    {v.marketTrend === 'up' ? '↑' : v.marketTrend === 'down' ? '↓' : '·'}
                  </td>
                  <td className="px-1 py-1 text-right">
                    {money(v.smartPrice) ?? '—'}
                    {v.smartConfidence ? <span className="text-white/30"> {v.smartConfidence[0]}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
