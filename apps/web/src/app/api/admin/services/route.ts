import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Probe = { key: string; name: string; host: string | null; ok: boolean; status: string; ms: number | null }

function host(u?: string) {
  try { return u ? new URL(u).host : null } catch { return null }
}

async function ping(url: string, path: string, headers?: Record<string, string>): Promise<{ ok: boolean; status: string; ms: number }> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, { signal: ctrl.signal, cache: 'no-store', headers })
    return { ok: res.ok, status: res.ok ? 'up' : `http ${res.status}`, ms: Date.now() - t0 }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return { ok: false, status: aborted ? 'timeout' : 'unreachable', ms: Date.now() - t0 }
  } finally {
    clearTimeout(id)
  }
}

/** GET /api/admin/services — health-probe every deployed backend (server-side: no CORS, URLs stay secret). */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const http = [
    { key: 'grading', name: 'Card grader API', url: process.env.GRADING_SERVICE_URL, path: '/health' },
    { key: 'forecast', name: 'Forecast service', url: process.env.FORECAST_SERVICE_URL, path: '/health' },
    { key: 'optimize', name: 'Optimize service', url: process.env.OPTIMIZE_SERVICE_URL, path: '/health' },
  ]
  const probes: Probe[] = await Promise.all(
    http.map(async (s): Promise<Probe> => {
      if (!s.url) return { key: s.key, name: s.name, host: null, ok: false, status: 'not configured', ms: null }
      return { key: s.key, name: s.name, host: host(s.url), ...(await ping(s.url, s.path)) }
    })
  )

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supa: Probe = sbUrl
    ? { key: 'supabase', name: 'Supabase (database)', host: host(sbUrl), ...(await ping(sbUrl, '/auth/v1/health')) }
    : { key: 'supabase', name: 'Supabase (database)', host: null, ok: false, status: 'not configured', ms: null }

  const web: Probe = {
    key: 'web', name: 'Web app (this deployment)',
    host: host(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
    ok: true, status: 'up', ms: 0,
  }

  return NextResponse.json({ services: [web, ...probes, supa], checkedAt: new Date().toISOString() })
}
