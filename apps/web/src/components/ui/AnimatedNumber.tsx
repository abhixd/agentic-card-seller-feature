'use client'

import { useEffect, useRef, useState } from 'react'

// Serializable formatting presets — use `format` (a string) from SERVER
// components, since functions cannot be passed across the server→client boundary.
const FORMATTERS: Record<string, (n: number) => string> = {
  usdCompact: (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`),
  usd:        (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  int:        (n) => Math.round(n).toLocaleString('en-US'),
  compact:    (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))),
}

interface AnimatedNumberProps {
  value:      number
  duration?:  number                // ms, default 900
  /** client-only: a custom formatter function (can't be passed from a server component) */
  formatter?: (n: number) => string
  /** server-safe: a named formatting preset (string) */
  format?:    keyof typeof FORMATTERS
  className?: string
}

/**
 * Counts from 0 (or its previous value) to `value` using easeOutExpo.
 * From a SERVER component, pass `format="usdCompact"` (string) — NOT `formatter`.
 */
export function AnimatedNumber({
  value,
  duration = 900,
  formatter,
  format,
  className,
}: AnimatedNumberProps) {
  const [display, setDisplay] = useState(0)
  const rafRef  = useRef<number>(0)
  const prevRef = useRef<number>(0)

  useEffect(() => {
    const from  = prevRef.current
    const to    = value
    const start = performance.now()
    prevRef.current = value

    const tick = (now: number) => {
      const t  = Math.min((now - start) / duration, 1)
      const e  = t === 1 ? 1 : 1 - Math.pow(2, -10 * t)   // easeOutExpo
      setDisplay(from + (to - from) * e)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }

    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value, duration])

  const text = formatter
    ? formatter(display)
    : format
      ? FORMATTERS[format](display)
      : display.toFixed(0)

  return <span className={className}>{text}</span>
}
