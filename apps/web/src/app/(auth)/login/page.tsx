'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { signIn } from '@/lib/auth/authService'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ScanLine } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const redirectTo = `${window.location.origin}/callback`
    const result = await signIn(supabase, email, redirectTo)

    if (result.error) {
      setError(result.error)
    } else {
      setSent(true)
    }
    setLoading(false)
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background p-4 overflow-hidden">
      {/* Ambient brand glow */}
      <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 h-[28rem] w-[42rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(closest-side, oklch(0.62 0.2 250 / 0.14), transparent)' }} />
      <div aria-hidden className="pointer-events-none absolute bottom-[-20%] right-[-10%] h-80 w-80 rounded-full blur-3xl"
        style={{ background: 'radial-gradient(closest-side, oklch(0.65 0.18 280 / 0.10), transparent)' }} />
      <div aria-hidden className="ambient-dot-grid absolute inset-0 opacity-60" />

      <div className="relative w-full max-w-md space-y-7 page-enter">
        <div className="flex flex-col items-center gap-3">
          <div className="logo-glow flex h-12 w-12 items-center justify-center rounded-2xl"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
            <ScanLine className="h-6 w-6 text-white" />
          </div>
          <div className="text-center">
            <span className="text-3xl font-extrabold tracking-tight">
              <span className="text-white">Scan</span>
              <span className="text-gradient">Dex</span>
            </span>
            <p className="mt-1 text-xs text-muted-foreground">The decision engine for card investors</p>
          </div>
        </div>

        <Card className="glass-panel border-white/10">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Enter your email to receive a magic link
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <Alert>
                <AlertDescription>
                  Check your email — we sent a sign-in link to{' '}
                  <strong>{email}</strong>.
                </AlertDescription>
              </Alert>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? 'Sending...' : 'Send magic link'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          The operating system for collectible card sellers
        </p>
      </div>
    </div>
  )
}
