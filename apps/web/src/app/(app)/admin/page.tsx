'use client'

import { useCallback, useEffect, useState } from 'react'

type Probe = { key: string; name: string; host: string | null; ok: boolean; status: string; ms: number | null }

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

      <div className="rounded-lg border border-dashed p-4">
        <div className="text-sm font-medium">Training as a service</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Self-improving grader — bias report, retrain-readiness, and a launch button. Coming next (phase 2).
        </p>
      </div>
    </div>
  )
}
