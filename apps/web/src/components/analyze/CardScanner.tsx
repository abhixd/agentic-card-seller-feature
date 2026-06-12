'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, X, AlertTriangle, CheckCircle, Search, RotateCcw } from 'lucide-react'

interface ScanResult {
  card_name:  string | null
  set_name:   string | null
  card_number: string | null
  confidence: 'high' | 'medium' | 'low'
}

const CONFIDENCE_STYLE: Record<string, string> = {
  high:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/25',
  low:    'text-red-400 bg-red-500/10 border-red-500/25',
}

export function CardScanner() {
  const [scanning, setScanning] = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [result,   setResult]   = useState<ScanResult | null>(null)
  const [preview,  setPreview]  = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const router  = useRouter()

  const reset = () => {
    setResult(null)
    setPreview(null)
    setError(null)
    setScanning(false)
  }

  const handleFile = async (file: File) => {
    setScanning(true)
    setError(null)
    setResult(null)

    // Show image preview
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target?.result as string)
    reader.readAsDataURL(file)

    const form = new FormData()
    form.append('image', file)

    try {
      const res  = await fetch('/api/scan', { method: 'POST', body: form })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error ?? 'Scan failed')
      if (!data.card_name) throw new Error('Could not identify card — try a clearer photo')

      setResult(data)
    } catch (e: any) {
      setError(e.message ?? 'Scan failed')
      setPreview(null)
    } finally {
      setScanning(false)
    }
  }

  const handleSearch = () => {
    if (!result?.card_name) return
    const parts = [result.card_name, result.set_name, result.card_number].filter(Boolean)
    const q = parts.join(' ')
    router.push(`/analyze?q=${encodeURIComponent(q)}`)
  }

  return (
    <div className="relative">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
      />

      {/* Scan button — hidden once we have a result */}
      {!result && !scanning && (
        <button
          onClick={() => { setError(null); fileRef.current?.click() }}
          title="Scan card photo"
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 hover:border-white/20 hover:bg-white/[0.07] transition-all"
        >
          <Camera className="h-4 w-4 shrink-0" />
          Scan Card
        </button>
      )}

      {/* Scanning spinner */}
      {scanning && (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm font-medium text-white/30">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          Identifying…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-400 flex-1">{error}</p>
          <button onClick={reset}>
            <X className="h-3 w-3 text-red-400/50 hover:text-red-400 transition-colors" />
          </button>
        </div>
      )}

      {/* Confirmation card */}
      {result && !scanning && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden w-72">
          {/* Image preview + header */}
          <div className="flex items-center gap-3 px-3 pt-3 pb-2">
            {preview && (
              <img
                src={preview}
                alt="Scanned card"
                className="h-14 w-10 rounded-md object-cover shrink-0 border border-white/10"
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <CheckCircle className="h-3 w-3 text-emerald-400 shrink-0" />
                <span className="text-[10px] uppercase tracking-widest text-white/40 font-medium">Card identified</span>
              </div>
              <p className="text-sm font-semibold text-white leading-tight truncate">
                {result.card_name}
              </p>
              {(result.set_name || result.card_number) && (
                <p className="text-[11px] text-white/40 mt-0.5 truncate">
                  {[result.set_name, result.card_number].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
            <span className={[
              'text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0 capitalize',
              CONFIDENCE_STYLE[result.confidence] ?? CONFIDENCE_STYLE.low,
            ].join(' ')}>
              {result.confidence}
            </span>
          </div>

          {/* Actions */}
          <div className="flex border-t border-white/8">
            <button
              onClick={reset}
              className="flex items-center justify-center gap-1.5 flex-1 py-2 text-xs text-white/30 hover:text-white/60 hover:bg-white/[0.03] transition-all border-r border-white/8"
            >
              <RotateCcw className="h-3 w-3" />
              Rescan
            </button>
            <button
              onClick={handleSearch}
              className="flex items-center justify-center gap-1.5 flex-1 py-2 text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:bg-indigo-500/10 transition-all"
            >
              <Search className="h-3 w-3" />
              Search this card
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
