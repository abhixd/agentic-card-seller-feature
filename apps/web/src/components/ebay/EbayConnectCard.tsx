'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { ExternalLink, Link2, Link2Off, Loader2, ShoppingCart } from 'lucide-react'
import { useSearchParams } from 'next/navigation'

interface EbayStatus {
  connected:    boolean
  expired:      boolean
  connectedAt:  string | null
  ebayUsername: string | null
}

export function EbayConnectCard() {
  const [status,        setStatus]        = useState<EbayStatus | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const searchParams = useSearchParams()

  useEffect(() => {
    const ebayParam = searchParams.get('ebay')
    if (ebayParam === 'connected') toast.success('eBay account connected!')
    if (ebayParam === 'denied')    toast.error('eBay connection cancelled.')
    if (ebayParam === 'error')     toast.error(`eBay connection failed: ${searchParams.get('reason') ?? 'unknown error'}`)
  }, [searchParams])

  useEffect(() => {
    fetch('/api/ebay/auth/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))
  }, [])

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await fetch('/api/ebay/auth/status', { method: 'DELETE' })
      setStatus({ connected: false, expired: false, connectedAt: null, ebayUsername: null })
      toast.success('eBay account disconnected.')
    } catch {
      toast.error('Failed to disconnect eBay account.')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div
      className="rounded-xl p-5 space-y-4 border border-white/[0.08]"
      style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(5,150,105,0.04) 100%)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #10b981, #047857)', boxShadow: '0 2px 10px rgba(16,185,129,0.4)' }}
        >
          <ShoppingCart className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">eBay Account</p>
          <p className="text-xs text-white/40">Connect to list cards directly from inventory</p>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-white/40">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking connection…
        </div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/40">Status</span>
            <Badge className="gap-1 bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20">
              <Link2 className="h-3 w-3" />
              Connected
            </Badge>
          </div>
          {status.ebayUsername && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/40">Username</span>
              <span className="font-medium text-white/80">{status.ebayUsername}</span>
            </div>
          )}
          {status.connectedAt && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/40">Connected</span>
              <span className="text-white/30 text-xs">
                {new Date(status.connectedAt).toLocaleDateString()}
              </span>
            </div>
          )}
          <div className="pt-1 flex items-center gap-3 border-t border-white/[0.06]">
            <Button
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/30"
            >
              {disconnecting
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Link2Off className="h-3.5 w-3.5" />
              }
              Disconnect
            </Button>
            <a
              href="/listings"
              className="text-xs text-white/30 hover:text-emerald-400 transition-colors"
            >
              View listings →
            </a>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/40">Status</span>
            <Badge variant="outline" className="gap-1 border-white/10 text-white/40">
              <Link2Off className="h-3 w-3" />
              {status?.expired ? 'Session expired' : 'Not connected'}
            </Badge>
          </div>
          <a href="/api/ebay/auth/connect">
            <Button
              className="gap-2 w-full text-sm font-medium"
              style={{ background: 'linear-gradient(135deg, #10b981, #047857)', boxShadow: '0 2px 12px rgba(16,185,129,0.3)' }}
            >
              <ExternalLink className="h-4 w-4" />
              {status?.expired ? 'Reconnect eBay Account' : 'Connect eBay Account'}
            </Button>
          </a>
          <p className="text-xs text-white/25">
            You will be redirected to eBay to authorize this app. Credentials are stored
            securely and only used to create listings on your behalf.
          </p>
        </div>
      )}
    </div>
  )
}
