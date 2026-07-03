'use client'

// Root error boundary — catches crashes outside the (app) segment (e.g. login).

import { useEffect } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[root error boundary]', error)
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="glass-panel w-full max-w-md p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/25">
          <AlertTriangle className="h-6 w-6 text-red-300" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight">Something went wrong</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            An unexpected error occurred. Try again — if it keeps happening, refresh the page.
          </p>
          {error.digest && (
            <p className="mt-2 text-[10px] text-muted-foreground/50 font-mono">ref: {error.digest}</p>
          )}
        </div>
        <button
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:brightness-110"
          style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Try again
        </button>
      </div>
    </div>
  )
}
