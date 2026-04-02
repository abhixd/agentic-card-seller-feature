'use client'

import { useEffect, useRef, useState } from 'react'

interface AnimatedNumberProps {
  value:      number
  duration?:  number                // ms, default 900
  formatter?: (n: number) => string
  className?: string
}

/**
 * Counts from 0 (or its previous value) to `value` using easeOutExpo.
 * Safe to use in server-component pages — just wrap in a client component.
 */
export function AnimatedNumber({
  value,
  duration = 900,
  formatter,
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

  return (
    <span className={className}>
      {formatter ? formatter(display) : display.toFixed(0)}
    </span>
  )
}
