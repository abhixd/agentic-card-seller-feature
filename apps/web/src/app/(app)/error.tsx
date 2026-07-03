'use client'

// Segment error boundary for the authed app: a crash in any page renders this
// styled recovery screen instead of taking down the whole shell.

import { useEffect } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app error boundary]', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="glass-panel w-full max-w-md p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/25">
          <AlertTriangle className="h-6 w-6 text-red-300" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight">Something went wrong</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This section hit an unexpected error. Your data is safe — try again, or head back to the dashboard.
          </p>
          {error.digest && (
            <p className="mt-2 text-[10px] text-muted-foreground/50 font-mono">ref: {error.digest}</p>
          )}
        </div>
        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:brightness-110"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Try again
          </button>
          <a
            href="/dashboard"
            className="inline-flex items-center rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-foreground/80 hover:bg-white/[0.08] transition-colors"
          >
            Dashboard
          </a>
        </div>
      </div>
    </div>
  )
}
