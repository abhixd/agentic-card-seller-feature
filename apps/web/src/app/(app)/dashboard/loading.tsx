// Instant skeleton while the dashboard server render fetches.
export default function DashboardLoading() {
  return (
    <div className="space-y-4 pb-12 max-w-[1400px] animate-pulse">
      <div className="h-40 rounded-2xl bg-white/[0.04]" />
      <div className="h-24 rounded-2xl bg-white/[0.04]" />
      <div className="h-12 rounded-xl bg-white/[0.04]" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="h-56 rounded-xl bg-white/[0.04]" />
        <div className="h-56 rounded-xl bg-white/[0.04]" />
      </div>
      <div className="h-72 rounded-2xl bg-white/[0.04]" />
    </div>
  )
}
