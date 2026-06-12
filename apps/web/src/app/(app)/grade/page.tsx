'use client'

import { useState } from 'react'
import type { GradeResult } from '@/lib/grading/types'

const SCORE_COLOR = (s: number) =>
  s >= 9 ? 'text-emerald-600' : s >= 7.5 ? 'text-lime-600' : s >= 6 ? 'text-amber-600' : 'text-red-600'

function Pillar({ label, score }: { label: string; score: number }) {
  const pct = Math.max(0, Math.min(100, score * 10))
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-sm capitalize text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 rounded-full bg-muted">
        <div className="h-2 rounded-full bg-foreground/70" style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-10 text-right text-sm font-semibold ${SCORE_COLOR(score)}`}>
        {score.toFixed(1)}
      </span>
    </div>
  )
}

export default function GradePage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setResult(null)
    setError(null)
    setPreview(f ? URL.createObjectURL(f) : null)
  }

  async function grade() {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('image', file)
      const res = await fetch('/api/grade', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Grading failed')
      setResult(data as GradeResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Grading failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Grade a card</h1>
        <p className="text-sm text-muted-foreground">
          Upload a card front — the same computer-vision grader the browser extension uses.
        </p>
      </div>

      <div className="rounded-lg border p-4">
        <input type="file" accept="image/*" onChange={onPick} className="block w-full text-sm" />
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="card preview" className="mt-4 max-h-72 rounded-md object-contain" />
        )}
        <button
          onClick={grade}
          disabled={!file || loading}
          className="mt-4 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {loading ? 'Grading…' : 'Grade card'}
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      {result && (
        <div className="space-y-5 rounded-lg border p-5">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-sm text-muted-foreground">Estimated grade</div>
              <div className={`text-4xl font-bold ${SCORE_COLOR(result.overall_score)}`}>
                {result.psa_equivalent}
              </div>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <div>overall {result.overall_score.toFixed(1)}/10</div>
              {result._confidence && <div>confidence: {result._confidence}</div>}
            </div>
          </div>

          <div className="space-y-2">
            <Pillar label="centering" score={result.centering.score} />
            <Pillar label="corners" score={result.corners.score} />
            <Pillar label="edges" score={result.edges.score} />
            <Pillar label="surface" score={result.surface.score} />
            <p className="pt-1 text-xs text-muted-foreground">
              centering {result.centering.left_right} L/R · {result.centering.top_bottom} T/B
              {result.centering.reliable === false && ' (low-confidence)'}
            </p>
          </div>

          {result.summary && <p className="text-sm">{result.summary}</p>}

          {result.issues && result.issues.length > 0 && (
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {result.issues.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          )}

          {result._warped_jpeg_b64 && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/jpeg;base64,${result._warped_jpeg_b64}`}
              alt="detected card"
              className="max-h-72 rounded-md object-contain"
            />
          )}
        </div>
      )}
    </div>
  )
}
