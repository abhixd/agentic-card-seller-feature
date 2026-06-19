'use client'

import { useCallback, useEffect, useState } from 'react'

type Probe = { key: string; name: string; host: string | null; ok: boolean; status: string; ms: number | null }
type SideMap = Record<string, number | null>
type TrainResult = {
  n_corrections: number
  loo_before: number | null
  loo_after: number | null
  delta: number | null
  per_side?: SideMap
  per_class?: SideMap
  deployed?: boolean
  persisted?: boolean
}
type Correction = {
  correction_id: string
  left_right: string | null
  top_bottom: string | null
  original_left_right: string | null
  original_top_bottom: string | null
  created_at: string
}
type Deploy = { loo: number | null; n_corrections: number | null; created_at: string }
type Overview = { corrections: { total: number; recent: Correction[] }; history: Deploy[] }

function badge(ok: boolean, status: string): string {
  if (ok) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
  if (status === 'timeout') return 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
  if (status === 'not configured') return 'bg-muted text-muted-foreground'
  return 'bg-red-500/15 text-red-700 dark:text-red-400'
}
const pct = (v?: number | null) => (v == null ? '—' : `${v}%`)
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function AdminPage() {
  const [services, setServices] = useState<Probe[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [training, setTraining] = useState(false)
  const [trainResult, setTrainResult] = useState<TrainResult | null>(null)
  const [trainErr, setTrainErr] = useState<string | null>(null)
  const [deployLive, setDeployLive] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)

  const loadServices = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/services', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Failed to load')
      setServices(data.services)
      setCheckedAt(data.checkedAt)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/overview', { cache: 'no-store' })
      if (res.ok) setOverview(await res.json())
    } catch { /* non-fatal */ }
  }, [])

  async function runTraining() {
    setTraining(true)
    setTrainErr(null)
    setTrainResult(null)
    try {
      const res = await fetch('/api/admin/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploy: deployLive }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Training failed')
      setTrainResult(data)
      loadOverview() // a deploy may have just landed in the history
    } catch (e) {
      setTrainErr(e instanceof Error ? e.message : 'Training failed')
    } finally {
      setTraining(false)
    }
  }

  useEffect(() => {
    loadServices()
    loadOverview()
    const t = setInterval(loadServices, 30000)
    return () => clearInterval(t)
  }, [loadServices, loadOverview])

  const up = services?.filter((s) => s.ok).length ?? 0
  const totalSvc = services?.length ?? 0

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      {/* ── services ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Services</h1>
          <p className="text-sm text-muted-foreground">
            {services ? `${up} / ${totalSvc} up` : 'checking…'}
            {checkedAt && ` · checked ${new Date(checkedAt).toLocaleTimeString()}`}
          </p>
        </div>
        <button onClick={loadServices} disabled={loading} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="space-y-2">
        {(services ?? []).map((s) => (
          <div key={s.key} className="flex items-center justify-between rounded-lg border p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{s.name}</div>
              <div className="truncate text-xs text-muted-foreground">{s.host ?? '—'}</div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {s.ms != null && s.ms > 0 && <span className="text-xs tabular-nums text-muted-foreground">{s.ms} ms</span>}
              <span className={`rounded-md px-2 py-1 text-xs font-medium ${badge(s.ok, s.status)}`}>{s.status}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── self-improving grader ── */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Self-improving grader</div>
            <p className="text-xs text-muted-foreground">Retrain the per-side centering selector from your corrections (~30s).</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={deployLive} onChange={(e) => setDeployLive(e.target.checked)} />
              deploy live
            </label>
            <button onClick={runTraining} disabled={training} className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50">
              {training ? 'Training…' : 'Run training'}
            </button>
          </div>
        </div>

        {trainErr && <p className="mt-2 text-sm text-red-600">{trainErr}</p>}

        {trainResult && (
          <>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">corrections</div>
                <div className="text-sm font-medium tabular-nums">{trainResult.n_corrections}</div>
              </div>
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">accuracy (LOO)</div>
                <div className="text-sm font-medium tabular-nums">{trainResult.loo_before}% → {trainResult.loo_after}%</div>
              </div>
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">delta</div>
                <div className={`text-sm font-medium tabular-nums ${(trainResult.delta ?? 0) > 0 ? 'text-emerald-600' : (trainResult.delta ?? 0) < 0 ? 'text-red-600' : ''}`}>
                  {(trainResult.delta ?? 0) > 0 ? '+' : ''}{trainResult.delta}
                </div>
              </div>
            </div>
            {trainResult.per_side && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-muted-foreground">per side</span>
                {['L', 'R', 'T', 'B'].map((s) => (
                  <span key={s} className="rounded bg-muted/50 px-1.5 py-0.5 tabular-nums">{s} {pct(trainResult.per_side![s])}</span>
                ))}
                {trainResult.per_class && (
                  <>
                    <span className="ml-2 text-muted-foreground">by type</span>
                    {Object.entries(trainResult.per_class).map(([c, v]) => (
                      <span key={c} className="rounded bg-muted/50 px-1.5 py-0.5 tabular-nums">{c} {pct(v)}</span>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}

        <p className={`mt-2 text-[11px] ${trainResult?.deployed ? 'text-emerald-600' : 'text-muted-foreground'}`}>
          {trainResult?.deployed
            ? (trainResult.persisted
                ? '✓ Deployed live + saved — serving grades now and will survive restarts.'
                : '✓ Deployed live — serving grades now (not persisted; reverts on restart).')
            : 'Check “deploy live” to hot-swap the retrained model into the live grader; leave it off to just preview the delta.'}
        </p>
      </div>

      {/* ── collected data ── */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Data collected</div>
          <span className="text-xs text-muted-foreground">{overview ? `${overview.corrections.total} corrections (yours)` : '…'}</span>
        </div>
        {overview && overview.corrections.recent.length > 0 ? (
          <div className="mt-2 space-y-1">
            {overview.corrections.recent.map((c) => (
              <div key={c.correction_id} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{when(c.created_at)}</span>
                <span className="tabular-nums">
                  {c.original_left_right ?? '?'}→{c.left_right ?? '?'} · {c.original_top_bottom ?? '?'}→{c.top_bottom ?? '?'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No corrections yet — fix a centering read on /grade to collect one.</p>
        )}
      </div>

      {/* ── training history ── */}
      <div className="rounded-lg border p-4">
        <div className="text-sm font-medium">Training history</div>
        {overview && overview.history.length > 0 ? (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal">deployed</th>
                <th className="text-right font-normal">accuracy</th>
                <th className="text-right font-normal">corrections</th>
              </tr>
            </thead>
            <tbody>
              {overview.history.map((h, i) => (
                <tr key={i}>
                  <td className="py-0.5">{when(h.created_at)}</td>
                  <td className="py-0.5 text-right tabular-nums">{pct(h.loo)}</td>
                  <td className="py-0.5 text-right tabular-nums">{h.n_corrections ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No deploys yet — tick “deploy live” + Run training to record one.</p>
        )}
      </div>
    </div>
  )
}
