'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, X, AlertTriangle } from 'lucide-react'

export function CardScanner() {
  const [scanning, setScanning]   = useState(false)
  const [error,    setError]      = useState<string | null>(null)
  const [result,   setResult]     = useState<{ cardName: string | null; confidence: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const router  = useRouter()

  const handleFile = async (file: File) => {
    setScanning(true)
    setError(null)
    setResult(null)

    const form = new FormData()
    form.append('image', file)

    try {
      const res  = await fetch('/api/scan', { method: 'POST', body: form })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error ?? 'Scan failed')
      if (!data.card_name) throw new Error('Could not identify card — try a clearer photo')

      setResult({ cardName: data.card_name, confidence: data.confidence })

      // Navigate to analyze search with identified card name
      router.push(`/analyze?q=${encodeURIComponent(data.card_name)}`)
    } catch (e: any) {
      setError(e.message ?? 'Scan failed')
      setScanning(false)
    }
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

      <button
        onClick={() => { setError(null); fileRef.current?.click() }}
        disabled={scanning}
        title="Scan card photo"
        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 hover:border-white/20 hover:bg-white/[0.07] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
      >
        {scanning
          ? <><Loader2 className="h-4 w-4 animate-spin shrink-0" /> Scanning…</>
          : <><Camera className="h-4 w-4 shrink-0" /> Scan Card</>
        }
      </button>

      {error && (
        <div className="absolute top-full mt-2 left-0 right-0 flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2 z-10">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-400 flex-1">{error}</p>
          <button onClick={() => setError(null)}>
            <X className="h-3 w-3 text-red-400/50" />
          </button>
        </div>
      )}
    </div>
  )
}
