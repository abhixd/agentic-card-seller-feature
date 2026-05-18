'use client'

import Link from 'next/link'
import {
  Calculator, Star, Layers2, PackagePlus, PieChart, Tag, Handshake,
  ArrowRight,
} from 'lucide-react'

const tools = [
  {
    href:        '/tools/buy-price',
    label:       'Buy Calculator',
    description: 'Compute the max price to pay at a card show based on recent comps and target ROI.',
    icon:        Calculator,
    grad:        ['#06b6d4', '#0e7490'],
    glow:        'rgba(6,182,212,0.6)',
    text:        'text-cyan-300',
    tag:         'Shows',
  },
  {
    href:        '/tools/grading-optimizer',
    label:       'Grade Optimizer',
    description: 'MIP solver that picks the optimal grading submission plan given your budget and deadlines.',
    icon:        Star,
    grad:        ['#a855f7', '#7e22ce'],
    glow:        'rgba(168,85,247,0.6)',
    text:        'text-purple-300',
    tag:         'Grading',
  },
  {
    href:        '/tools/triage',
    label:       'Bulk Triage',
    description: 'Rapidly classify a pile of raw cards — grade, sell raw, or hold — using expected value.',
    icon:        Layers2,
    grad:        ['#f59e0b', '#b45309'],
    glow:        'rgba(245,158,11,0.6)',
    text:        'text-amber-300',
    tag:         'Inventory',
  },
  {
    href:        '/tools/buy-basket',
    label:       'Buy Basket',
    description: 'Build an optimal buy basket for a card show by maximising expected profit under a budget.',
    icon:        PackagePlus,
    grad:        ['#10b981', '#047857'],
    glow:        'rgba(16,185,129,0.6)',
    text:        'text-emerald-300',
    tag:         'Shows',
  },
  {
    href:        '/tools/rebalance',
    label:       'Rebalance',
    description: 'Analyse your portfolio concentration and get sell/hold recommendations to rebalance risk.',
    icon:        PieChart,
    grad:        ['#6366f1', '#4338ca'],
    glow:        'rgba(99,102,241,0.6)',
    text:        'text-indigo-300',
    tag:         'Portfolio',
  },
  {
    href:        '/tools/listing-price',
    label:       'Listing Price',
    description: 'Set the right eBay ask price using recency-weighted median comps and sell-through rate.',
    icon:        Tag,
    grad:        ['#f97316', '#c2410c'],
    glow:        'rgba(249,115,22,0.6)',
    text:        'text-orange-300',
    tag:         'Selling',
  },
  {
    href:        '/tools/offer',
    label:       'Offer Advisor',
    description: 'EV-based negotiation advisor — know exactly when to accept, counter, or walk away.',
    icon:        Handshake,
    grad:        ['#8b5cf6', '#6d28d9'],
    glow:        'rgba(139,92,246,0.6)',
    text:        'text-violet-300',
    tag:         'Selling',
  },
]

export default function ToolsHubPage() {
  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: 'linear-gradient(180deg, #0d1117 0%, #0f1623 60%, #0d1117 100%)' }}>

      {/* Header */}
      <div className="mb-8">
        <h1
          className="text-2xl font-bold tracking-tight mb-1"
          style={{
            background: 'linear-gradient(90deg, #818cf8, #a78bfa)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          Optimization Tools
        </h1>
        <p className="text-sm text-white/40">
          Data-driven tools for buying, selling, grading, and portfolio management.
        </p>
      </div>

      {/* Tool cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {tools.map(({ href, label, description, icon: Icon, grad, glow, text, tag }) => (
          <Link
            key={href}
            href={href}
            className="group relative flex flex-col gap-4 rounded-2xl border border-white/[0.06] p-5 transition-all duration-200 hover:border-white/10 hover:-translate-y-0.5"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
            }}
          >
            {/* Hover glow */}
            <div
              className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
              style={{ background: `radial-gradient(ellipse at 20% 20%, ${glow.replace('0.6', '0.06')} 0%, transparent 70%)` }}
            />

            {/* Top row: icon + tag */}
            <div className="relative flex items-start justify-between">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-xl flex-shrink-0 transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-3"
                style={{
                  background: `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`,
                  boxShadow:  `0 4px 14px 0 ${glow}, 0 0 0 1px ${grad[0]}40`,
                }}
              >
                <Icon className="h-5 w-5 text-white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }} />
              </div>

              <span
                className="text-[10px] font-semibold tracking-widest uppercase px-2 py-0.5 rounded-full border"
                style={{
                  color:            grad[0],
                  borderColor:      `${grad[0]}40`,
                  backgroundColor:  `${grad[0]}12`,
                }}
              >
                {tag}
              </span>
            </div>

            {/* Text */}
            <div className="relative flex flex-col gap-1.5 flex-1">
              <p className="text-sm font-semibold text-white/90 group-hover:text-white transition-colors duration-150">
                {label}
              </p>
              <p className="text-xs text-white/40 leading-relaxed">
                {description}
              </p>
            </div>

            {/* CTA */}
            <div className={`relative flex items-center gap-1 text-xs font-medium ${text} transition-all duration-150 group-hover:gap-2`}>
              Open tool
              <ArrowRight className="h-3 w-3 transition-transform duration-150 group-hover:translate-x-0.5" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
