'use client'

import { useCallback, useEffect, useState } from 'react'

type Probe = { key: string; name: string; host: string | null; ok: boolean; status: string; ms: number | null }
type TrainResult = { n_corrections: number; loo_before: number | null; loo_after: number | null; delta: number | null; deployed?: boolean }

function badge(ok: boolean, status: string): string {
  if (ok) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
  if (status === 'timeout') return 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
  if (status === 'not configured') return 'bg-muted text-muted-foreground'
  return 'bg-red-500/15 text-red-700 dark:text-red-400'
}

export default function AdminPage() {
  const [services, setServices] = useState<Probe[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [training, setTraining] = useState(false)
  const [trainResult, setTrainResult] = useState<TrainResult | null>(null)
  const [trainErr, setTrainErr] = useState<string | null>(null)
  const [deployLive, setDeployLive] = useState(false)

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
    } catch (e) {
      setTrainErr(e instanceof Error ? e.message : 'Training failed')
    } finally {
      setTraining(false)
    }
  }

  const load = useCallback(async () => {
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

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load])

  const up = services?.filter((s) => s.ok).length ?? 0
  const total = services?.length ?? 0

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Services</h1>
          <p className="text-sm text-muted-foreground">
            {services ? `${up} / ${total} up` : 'checking…'}
            {checkedAt && ` · checked ${new Date(checkedAt).toLocaleTimeString()}`}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">
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

      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Self-improving grader</div>
            <p className="text-xs text-muted-foreground">Retrain the per-side centering selector from your corrections.</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={deployLive} onChange={(e) => setDeployLive(e.target.checked)} />
              deploy live
            </label>
            <button
              onClick={runTraining}
              disabled={training}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
            >
              {training ? 'Training…' : 'Run training'}
            </button>
          </div>
        </div>

        {trainErr && <p className="mt-2 text-sm text-red-600">{trainErr}</p>}

        {trainResult && (
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
        )}

        <p className={`mt-2 text-[11px] ${trainResult?.deployed ? 'text-emerald-600' : 'text-muted-foreground'}`}>
          {trainResult?.deployed
            ? '✓ Deployed live — the retrained model is serving grades now (reverts to baseline on restart; durable persistence is next).'
            : 'Check “deploy live” to hot-swap the retrained model into the live grader; leave it off to just preview the delta.'}
        </p>
      </div>
    </div>
  )
}
