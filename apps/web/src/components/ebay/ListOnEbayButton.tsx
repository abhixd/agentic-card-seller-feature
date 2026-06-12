'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { ExternalLink, Loader2, ShoppingCart, AlertCircle } from 'lucide-react'
import { CONDITION_LABELS } from '@/lib/ebay/sellApi'
import type { EbayCondition, SellerPolicies } from '@/lib/ebay/sellApi'

interface Props {
  inventoryItemId: string
  suggestedPrice:  number | null
  isConnected:     boolean
  currentStatus:   string
}

const CONDITIONS: EbayCondition[] = [
  'VERY_GOOD', 'GOOD', 'EXCELLENT', 'ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING',
]

export function ListOnEbayButton({
  inventoryItemId,
  suggestedPrice,
  isConnected,
  currentStatus,
}: Props) {
  const [open,          setOpen]          = useState(false)
  const [price,         setPrice]         = useState(suggestedPrice?.toFixed(2) ?? '')
  const [condition,     setCondition]     = useState<EbayCondition>('VERY_GOOD')
  const [conditionDesc, setConditionDesc] = useState('')
  const [policies,      setPolicies]      = useState<SellerPolicies | null>(null)
  const [fulfillId,     setFulfillId]     = useState('')
  const [paymentId,     setPaymentId]     = useState('')
  const [returnId,      setReturnId]      = useState('')
  const [loadingPolicies, setLoadingPolicies] = useState(false)
  const [policyError,   setPolicyError]   = useState<string | null>(null)
  const [submitting,    setSubmitting]    = useState(false)
  const [listedUrl,     setListedUrl]     = useState<string | null>(null)

  useEffect(() => {
    if (!open || policies || !isConnected) return
    setLoadingPolicies(true)
    setPolicyError(null)

    fetch('/api/ebay/policies')
      .then(r => r.json())
      .then((data: SellerPolicies & { error?: string }) => {
        if (data.error) { setPolicyError(data.error); return }
        setPolicies(data)
        if (data.fulfillment[0]) setFulfillId(data.fulfillment[0].id)
        if (data.payment[0])     setPaymentId(data.payment[0].id)
        if (data.return[0])      setReturnId(data.return[0].id)
      })
      .catch(() => setPolicyError('Failed to load eBay seller policies.'))
      .finally(() => setLoadingPolicies(false))
  }, [open, policies, isConnected])

  async function handleList() {
    const numPrice = parseFloat(price)
    if (isNaN(numPrice) || numPrice <= 0) { toast.error('Enter a valid price.'); return }
    if (!fulfillId || !paymentId || !returnId) { toast.error('Select all three seller policies.'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/ebay/list', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          inventoryItemId,
          price:          numPrice,
          condition,
          conditionDesc,
          fulfillmentPolicyId: fulfillId,
          paymentPolicyId:     paymentId,
          returnPolicyId:      returnId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Listing failed')
      setListedUrl(data.ebayUrl)
      toast.success('Listed on eBay!', {
        action: { label: 'View listing', onClick: () => window.open(data.ebayUrl, '_blank') },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create listing')
    } finally {
      setSubmitting(false)
    }
  }

  if (currentStatus === 'listed' || currentStatus === 'sold') {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 px-3 py-1.5 text-sm border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
      >
        <ShoppingCart className="h-3.5 w-3.5" />
        {currentStatus === 'sold' ? 'Sold' : 'Listed on eBay'}
      </Badge>
    )
  }

  if (!isConnected) {
    return (
      <a href="/settings">
        <Button variant="outline" size="sm" className="gap-2 text-white/40 border-white/10 hover:border-white/20">
          <ShoppingCart className="h-4 w-4" />
          Connect eBay to List
        </Button>
      </a>
    )
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="gap-2 text-sm font-medium"
        style={{ background: 'linear-gradient(135deg, #10b981, #047857)', boxShadow: '0 2px 12px rgba(16,185,129,0.3)' }}
      >
        <ShoppingCart className="h-4 w-4" />
        List on eBay
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md bg-[#0d1117] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">List on eBay</DialogTitle>
            <DialogDescription className="text-white/40">
              Set your price and condition. The listing goes live immediately.
            </DialogDescription>
          </DialogHeader>

          {listedUrl ? (
            <div className="py-4 space-y-3 text-center">
              <p className="text-sm font-medium text-emerald-400">Listed successfully!</p>
              <a
                href={listedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:underline"
              >
                <ExternalLink className="h-4 w-4" />
                View on eBay
              </a>
              <div className="pt-2">
                <Button
                  variant="outline"
                  className="w-full border-white/10 text-white/60 hover:bg-white/5"
                  onClick={() => setOpen(false)}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {/* Price */}
              <div className="space-y-1.5">
                <Label className="text-white/60 text-xs">Listing Price (USD)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={price}
                    onChange={e => setPrice(e.target.value)}
                    placeholder="0.00"
                    className="pl-7 bg-white/5 border-white/10 text-white placeholder:text-white/20"
                  />
                </div>
                {suggestedPrice && (
                  <p className="text-xs text-white/30">Market estimate: ${suggestedPrice.toFixed(2)}</p>
                )}
              </div>

              {/* Condition */}
              <div className="space-y-1.5">
                <Label className="text-white/60 text-xs">Condition</Label>
                <Select value={condition} onValueChange={v => v && setCondition(v as EbayCondition)}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#0d1117] border-white/10 text-white">
                    {CONDITIONS.map(c => (
                      <SelectItem key={c} value={c} className="focus:bg-white/10 focus:text-white">
                        {CONDITION_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Condition notes */}
              <div className="space-y-1.5">
                <Label className="text-white/60 text-xs">
                  Condition Notes <span className="text-white/25">(optional)</span>
                </Label>
                <Input
                  value={conditionDesc}
                  onChange={e => setConditionDesc(e.target.value)}
                  placeholder="e.g. Light scratching on back, front near perfect"
                  maxLength={500}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/20"
                />
              </div>

              {/* Seller policies */}
              {loadingPolicies ? (
                <div className="flex items-center gap-2 text-sm text-white/40">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading your eBay seller policies…
                </div>
              ) : policyError ? (
                <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3 border border-red-500/20">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Could not load policies</p>
                    <p className="text-xs mt-0.5 text-white/40">{policyError}</p>
                  </div>
                </div>
              ) : policies ? (
                <div className="space-y-3">
                  {policies.fulfillment.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-white/60 text-xs">Shipping Policy</Label>
                      <Select value={fulfillId} onValueChange={v => v && setFulfillId(v)}>
                        <SelectTrigger className="bg-white/5 border-white/10 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#0d1117] border-white/10 text-white">
                          {policies.fulfillment.map(p => (
                            <SelectItem key={p.id} value={p.id} className="focus:bg-white/10 focus:text-white">{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {policies.payment.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-white/60 text-xs">Payment Policy</Label>
                      <Select value={paymentId} onValueChange={v => v && setPaymentId(v)}>
                        <SelectTrigger className="bg-white/5 border-white/10 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#0d1117] border-white/10 text-white">
                          {policies.payment.map(p => (
                            <SelectItem key={p.id} value={p.id} className="focus:bg-white/10 focus:text-white">{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {policies.return.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-white/60 text-xs">Return Policy</Label>
                      <Select value={returnId} onValueChange={v => v && setReturnId(v)}>
                        <SelectTrigger className="bg-white/5 border-white/10 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#0d1117] border-white/10 text-white">
                          {policies.return.map(p => (
                            <SelectItem key={p.id} value={p.id} className="focus:bg-white/10 focus:text-white">{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {!listedUrl && (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="border-white/10 text-white/60 hover:bg-white/5"
              >
                Cancel
              </Button>
              <Button
                onClick={handleList}
                disabled={submitting || loadingPolicies || !!policyError}
                className="gap-2"
                style={{ background: 'linear-gradient(135deg, #10b981, #047857)' }}
              >
                {submitting
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Listing…</>
                  : <><ShoppingCart className="h-4 w-4" /> List Now</>
                }
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
