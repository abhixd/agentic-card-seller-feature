'use client'

import { useCallback, useRef, useState } from 'react'
import { Target, Upload, Loader2, X } from 'lucide-react'

type Identity = {
  name?: string; set?: string; number?: string; year?: number
  variant?: string; language?: string; title?: string; confidence?: number
}
type Grade = { overall_score: number; psa_equivalent?: string; confidence?: string }
type Economics = {
  expected_value?: number | null
  max_buy_price_for_psa9_target?: number | null
  max_buy_price_for_psa8_target?: number | null
  psa9_estimate?: number | null
} | null
type Decision = { label: string; reason: string } | null
type ScoutResult = {
  identity: Identity
  identify_error?: string | null
  grade: Grade
  economics: Economics
  decision: Decision
  comps_source?: string | null
  thumb_b64?: string | null
}
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
  const anyEconomics = rows.some(
    (r) => r.result?.economics && Object.values(r.result.economics).some((v) => v != null),
  )

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

      {/* Upload + actions */}
      <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
          >
            <Upload className="h-4 w-4" /> Add photos
          </button>
          <input
            ref={inputRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => addFiles(e.target.files)}
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
        {total === 0 && (
          <p className="mt-3 text-xs text-white/40">
            Select multiple card photos (front-facing). Each is scanned independently, so results stream in.
          </p>
        )}
      </div>

      {/* comps caveat */}
      {done > 0 && !anyEconomics && (
        <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/90">
          <b>Comps unavailable</b> — identity + predicted grade are live, but max-bid / EV / buy-pass stay blank
          until a graded-price feed is connected. Ranked by predicted grade for now.
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
                return (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
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
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(econ?.max_buy_price_for_psa9_target) ?? <span className="text-white/25">NO DATA</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(econ?.expected_value) ?? <span className="text-white/25">—</span>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {dec ? (
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] capitalize ${DECISION_STYLE[dec] || DECISION_STYLE.unknown}`}>
                          {dec}
                        </span>
                      ) : <span className="text-white/25 text-[11px]">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button onClick={() => removeRow(r.id)} className="text-white/25 hover:text-white/60">
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
    </div>
  )
}
