// Instant skeleton while the market index scans the catalog server-side.
export default function MarketLoading() {
  return (
    <div className="space-y-5 pb-12 max-w-[1400px] animate-pulse">
      <div className="h-36 rounded-2xl bg-white/[0.04]" />
      <div className="h-14 rounded-xl bg-white/[0.04]" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="h-64 rounded-xl bg-white/[0.04]" />
        <div className="h-64 rounded-xl bg-white/[0.04]" />
      </div>
      <div className="h-96 rounded-2xl bg-white/[0.04]" />
    </div>
  )
}
