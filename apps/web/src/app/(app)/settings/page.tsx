import { Suspense } from 'react'
import { Settings } from 'lucide-react'
import { EbayConnectCard } from '@/components/ebay/EbayConnectCard'

export default function SettingsPage() {
  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 space-y-6 max-w-xl text-white">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)', boxShadow: '0 2px 10px rgba(99,102,241,0.4)' }}
        >
          <Settings className="h-4 w-4 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Settings</h1>
          <p className="text-xs text-white/30">Manage integrations and account preferences</p>
        </div>
      </div>

      {/* Integrations section */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-white/30 uppercase tracking-widest px-1">
          Integrations
        </p>
        <Suspense fallback={null}>
          <EbayConnectCard />
        </Suspense>
      </div>
    </div>
  )
}
