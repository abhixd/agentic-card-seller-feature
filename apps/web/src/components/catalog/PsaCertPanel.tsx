'use client'

/**
 * PsaCertPanel — PSA Cert Lookup + Population Report
 *
 * Usage:
 *   <PsaCertPanel />
 *
 * The user types a PSA cert number. We fetch:
 *   1. Cert details  (grade, subject, year, brand, etc.)
 *   2. Population report  (how many exist per grade)
 */

import { useState } from 'react'
import { Search, Loader2, Shield, BarChart2, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import type { PsaCert, PsaPopResponse } from '@/lib/psa/psaApi'
import { popToGrades } from '@/lib/psa/psaApi'

// ── Helpers ───────────────────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  if (grade === '10')   return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
  if (grade === '9')    return 'bg-green-500/20 text-green-300 border-green-500/30'
  if (grade === '8.5' || grade === '8') return 'bg-lime-500/20 text-lime-300 border-lime-500/30'
  if (grade === '7.5' || grade === '7') return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
  if (grade === '6.5' || grade === '6') return 'bg-orange-500/20 text-orange-300 border-orange-500/30'
  if (grade === 'Auth') return 'bg-sky-500/20 text-sky-300 border-sky-500/30'
  return 'bg-red-500/20 text-red-300 border-red-500/30'
}

function gradeBg(grade: string): string {
  if (grade === '10')   return 'bg-emerald-500'
  if (grade === '9')    return 'bg-green-500'
  if (grade === '8.5' || grade === '8') return 'bg-lime-500'
  if (grade === '7.5' || grade === '7') return 'bg-yellow-500'
  if (grade === '6.5' || grade === '6') return 'bg-orange-500'
  if (grade === 'Auth') return 'bg-sky-500'
  return 'bg-red-500'
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CertCard({ cert }: { cert: PsaCert }) {
  const psaUrl = `https://www.psacard.com/cert/${cert.CertNumber}`
  return (
    <div className="rounded-xl border border-border/25 bg-card overflow-hidden">
      {/* Grade hero */}
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(5,150,105,0.06) 100%)' }}
      >
        <div>
          <p className="text-[10px] uppercase tracking-widest text-emerald-400/70 font-semibold mb-0.5">PSA Grade</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-black text-emerald-300 tabular-nums leading-none">
              {cert.CardGrade}
            </span>
            <span className="text-xs text-emerald-400/60">{cert.GradeDescription}</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-medium mb-0.5">Cert #</p>
          <p className="text-sm font-mono font-semibold text-muted-foreground">{cert.CertNumber}</p>
          <span
            className={[
              'text-[10px] px-1.5 py-0.5 rounded-full border font-semibold mt-1 inline-block',
              cert.ItemStatus === 'Y' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30',
            ].join(' ')}
          >
            {cert.ItemStatus === 'Y' ? 'Valid' : cert.ItemStatus}
          </span>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 divide-x divide-border/20">
        {[
          { label: 'Subject',    value: cert.Subject },
          { label: 'Year',       value: cert.Year },
          { label: 'Brand',      value: cert.Brand },
          { label: 'Category',   value: cert.Category },
          { label: 'Card #',     value: cert.CardNumber || '—' },
          { label: 'Label',      value: cert.LabelType },
          { label: 'Variety',    value: cert.Variety || '—' },
          { label: 'Spec #',     value: cert.SpecNumber },
        ].map(({ label, value }, i) => (
          <div
            key={label}
            className={[
              'px-3 py-2 text-xs border-b border-border/15',
              i >= 6 ? 'border-b-0' : '',
            ].join(' ')}
          >
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-0.5">{label}</p>
            <p className="text-foreground font-medium truncate">{value}</p>
          </div>
        ))}
      </div>

      {/* Population summary */}
      <div className="px-3 py-2.5 border-t border-border/20 flex items-center justify-between gap-4 bg-muted/5">
        <div className="flex gap-4 text-xs">
          <div>
            <span className="text-muted-foreground/50 text-[10px] uppercase tracking-wider block">Total Pop</span>
            <span className="font-semibold tabular-nums text-foreground">{cert.TotalPopulation.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-muted-foreground/50 text-[10px] uppercase tracking-wider block">Pop Higher</span>
            <span className="font-semibold tabular-nums text-foreground">{cert.PopulationHigher.toLocaleString()}</span>
          </div>
          {cert.TotalPopulationWithQualifier > 0 && (
            <div>
              <span className="text-muted-foreground/50 text-[10px] uppercase tracking-wider block">w/ Qualifier</span>
              <span className="font-semibold tabular-nums text-foreground">{cert.TotalPopulationWithQualifier.toLocaleString()}</span>
            </div>
          )}
        </div>
        <a
          href={psaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors shrink-0"
        >
          PSA <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </div>
    </div>
  )
}

function PopChart({ pop }: { pop: PsaPopResponse }) {
  if (!pop.PSAPop) return null
  const grades = popToGrades(pop.PSAPop)
  if (grades.length === 0) return null
  const max = Math.max(...grades.map(g => g.count))

  return (
    <div className="rounded-xl border border-border/25 bg-card overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border/15 flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            Population Report
          </p>
          {pop.Description && (
            <p className="text-[10px] text-muted-foreground/50 mt-0.5 leading-snug">{pop.Description}</p>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground/40 tabular-nums">
          Total: {pop.PSAPop.Total.toLocaleString()}
        </span>
      </div>

      <div className="px-3 py-3 space-y-1.5">
        {grades.map(({ grade, count }) => {
          const pct = max > 0 ? (count / max) * 100 : 0
          return (
            <div key={grade} className="flex items-center gap-2">
              <span className={['text-[10px] font-bold px-1.5 py-0.5 rounded border w-12 text-center shrink-0', gradeColor(grade)].join(' ')}>
                {grade}
              </span>
              <div className="flex-1 h-4 bg-muted/30 rounded-full overflow-hidden">
                <div
                  className={['h-full rounded-full transition-all', gradeBg(grade)].join(' ')}
                  style={{ width: `${pct}%`, opacity: 0.75 }}
                />
              </div>
              <span className="text-xs font-semibold tabular-nums text-foreground/80 w-10 text-right shrink-0">
                {count.toLocaleString()}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function PsaCertPanel() {
  const [certInput, setCertInput]   = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [cert, setCert]             = useState<PsaCert | null>(null)
  const [pop, setPop]               = useState<PsaPopResponse | null>(null)
  const [showPop, setShowPop]       = useState(true)

  async function lookup() {
    const clean = certInput.replace(/\D/g, '')
    if (!clean) return
    setLoading(true); setError(null); setCert(null); setPop(null)

    try {
      const res = await fetch(`/api/psa/cert/${clean}`)
      if (res.status === 503) {
        setError('PSA API not configured yet — add your PSA_BEARER_TOKEN to get started.')
        return
      }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error ?? `PSA lookup failed (${res.status})`)
        return
      }
      const data = await res.json()
      if (!data.IsValidRequest || !data.PSACert) {
        setError(data.ServerMessage ?? 'Cert not found. Double-check the number.')
        return
      }
      setCert(data.PSACert)

      // Fetch population report using SpecID from the cert
      const specId = data.PSACert.SpecID
      if (specId) {
        const popRes = await fetch(`/api/psa/pop/${specId}`)
        if (popRes.ok) {
          const popData = await popRes.json()
          if (popData.IsValidRequest) setPop(popData)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-emerald-400/70" />
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
          PSA Cert Lookup
        </p>
      </div>

      {/* Search input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
          <input
            type="text"
            inputMode="numeric"
            value={certInput}
            onChange={e => setCertInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && lookup()}
            placeholder="Enter PSA cert number…"
            className="w-full rounded-lg border border-border/30 bg-card pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-emerald-500/40 transition-colors"
          />
        </div>
        <button
          onClick={lookup}
          disabled={loading || !certInput.trim()}
          className="px-4 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 shrink-0"
          style={{
            background: 'linear-gradient(135deg, #059669, #047857)',
            boxShadow: '0 2px 8px rgba(5,150,105,0.3)',
            color: '#fff',
          }}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Look up'}
        </button>
      </div>

      <p className="text-[10px] text-muted-foreground/35 -mt-1">
        PSA cert number is printed on the slab label (e.g. 12345678)
      </p>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-xs text-red-300 leading-relaxed">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          <div className="h-24 bg-muted/20 animate-pulse rounded-xl" />
          <div className="h-40 bg-muted/20 animate-pulse rounded-xl" />
        </div>
      )}

      {/* Cert result */}
      {cert && !loading && (
        <div className="space-y-3">
          <CertCard cert={cert} />

          {/* Population toggle */}
          {pop?.PSAPop && (
            <div>
              <button
                onClick={() => setShowPop(v => !v)}
                className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground transition-colors font-medium mb-2"
              >
                <BarChart2 className="h-3 w-3" />
                Population Report
                {showPop ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showPop && <PopChart pop={pop} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
