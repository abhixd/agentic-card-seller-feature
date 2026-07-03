// Instant skeleton while the sets catalog loads server-side.
export default function SetsLoading() {
  return (
    <div className="space-y-4 pb-12 animate-pulse">
      <div className="h-16 w-72 rounded-xl bg-white/[0.04]" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-40 rounded-xl bg-white/[0.04]" />
        ))}
      </div>
    </div>
  )
}
