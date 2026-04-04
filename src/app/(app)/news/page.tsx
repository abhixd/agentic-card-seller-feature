import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'

interface NewsArticle {
  id:           number
  slug:         string
  title:        string
  summary:      string
  body:         string
  source_url:   string | null
  source_name:  string | null
  image_url:    string | null
  tags:         string[]
  published_at: string
  created_at:   string
}

interface IntelPost {
  id:               number
  headline:         string
  body:             string
  signal_types:     string[]
  cards_referenced: { name: string; set: string; price: number; change_pct: number | null }[]
  confidence:       number
  generated_at:     string
}

async function fetchNews(): Promise<NewsArticle[]> {
  try {
    const supabase = await createClient()
    const { data } = await supabase
      .from('pokemon_news')
      .select('*')
      .order('published_at', { ascending: false })
      .limit(20)
    return (data ?? []) as NewsArticle[]
  } catch {
    return []
  }
}

async function fetchIntelPosts(): Promise<IntelPost[]> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('market_intelligence_posts')
      .select('id, headline, body, signal_types, cards_referenced, confidence, generated_at')
      .order('generated_at', { ascending: false })
      .limit(5)
    return (data ?? []) as IntelPost[]
  } catch {
    return []
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    year:  'numeric',
  })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

// Signal type color mapping
const SIGNAL_COLORS: Record<string, string> = {
  'momentum':        'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  'arbitrage':       'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30',
  'anomaly':         'bg-red-500/15 text-red-400 border border-red-500/30',
  'mean-reversion':  'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  'supply':          'bg-orange-500/15 text-orange-400 border border-orange-500/30',
  'set-correlation': 'bg-purple-500/15 text-purple-400 border border-purple-500/30',
  'edition-premium': 'bg-pink-500/15 text-pink-400 border border-pink-500/30',
  'volatility':      'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30',
}

function signalClass(signal: string): string {
  return SIGNAL_COLORS[signal] ?? 'bg-muted text-muted-foreground border border-border'
}

export default async function NewsPage() {
  const [articles, intelPosts] = await Promise.all([fetchNews(), fetchIntelPosts()])

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Pokemon TCG News</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Market insights for card sellers and collectors
        </p>
      </div>

      {/* ── NEXUS Market Intelligence Section ────────────────────────────── */}
      <div className="mb-10">
        {/* Section header */}
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-bold tracking-tight">NEXUS · Market Intelligence Bot</h2>
          {/* Pulsing live dot */}
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
          </span>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-widest">
            Bot
          </span>
        </div>

        {intelPosts.length === 0 ? (
          /* Warming-up placeholder */
          <div
            className="rounded-xl border border-purple-500/20 p-6 text-center"
            style={{
              background: 'linear-gradient(135deg, hsl(var(--card)) 0%, rgba(139,92,246,0.04) 100%)',
              boxShadow:  '0 0 0 1px rgba(139,92,246,0.15), 0 0 24px rgba(139,92,246,0.05)',
            }}
          >
            <p className="text-muted-foreground font-medium text-sm">
              Bot is warming up — needs 7+ days of price history to generate observations
            </p>
            <p className="text-xs text-muted-foreground mt-2 opacity-70">
              Once enough price data is collected, NEXUS will run daily at 6 AM UTC
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {intelPosts.map((post) => (
              <div
                key={post.id}
                className="rounded-xl border border-purple-500/20 p-5"
                style={{
                  background: 'linear-gradient(135deg, hsl(var(--card)) 0%, rgba(139,92,246,0.05) 100%)',
                  boxShadow:  '0 0 0 1px rgba(139,92,246,0.12), 0 0 20px rgba(139,92,246,0.06)',
                }}
              >
                {/* Headline */}
                <p className="font-bold text-sm leading-snug text-foreground">
                  {post.headline}
                </p>

                {/* Body */}
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                  {post.body}
                </p>

                {/* Signal type badges */}
                {post.signal_types.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {post.signal_types.map((signal) => (
                      <span
                        key={signal}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${signalClass(signal)}`}
                      >
                        {signal}
                      </span>
                    ))}
                  </div>
                )}

                {/* Referenced card chips */}
                {Array.isArray(post.cards_referenced) && post.cards_referenced.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {post.cards_referenced.map((card, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 text-xs bg-background/60 border border-border rounded-md px-2 py-0.5 font-mono"
                      >
                        <span className="text-foreground/80">{card.name}</span>
                        {card.price > 0 && (
                          <span className="text-muted-foreground">${card.price.toFixed(2)}</span>
                        )}
                        {card.change_pct !== null && card.change_pct !== undefined && (
                          <span className={card.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {card.change_pct >= 0 ? '+' : ''}{card.change_pct.toFixed(1)}%
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {/* Confidence bar + timestamp */}
                <div className="flex items-center justify-between mt-3 gap-3">
                  {/* Confidence */}
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      Confidence {post.confidence}%
                    </span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[80px]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${post.confidence}%`,
                          background: post.confidence >= 80
                            ? 'linear-gradient(90deg, #a855f7, #22d3ee)'
                            : post.confidence >= 60
                            ? 'linear-gradient(90deg, #f59e0b, #a855f7)'
                            : 'linear-gradient(90deg, #ef4444, #f59e0b)',
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDateTime(post.generated_at)}
                  </span>
                </div>
              </div>
            ))}

            {/* Disclaimer */}
            <p className="text-xs text-muted-foreground text-center mt-1 opacity-60">
              AI-generated analysis · Not financial advice
            </p>
          </div>
        )}
      </div>

      {/* ── Regular News ──────────────────────────────────────────────────── */}
      <div className="mb-4">
        <h2 className="text-lg font-bold">Latest News</h2>
      </div>

      {articles.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-muted-foreground font-medium">
            No news yet — check back tomorrow
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            We track news from PokeBeach, PokéJungle, and Pokémon official sources.
            Articles are generated daily at 7 AM UTC.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {articles.map((article) => (
            <article
              key={article.id}
              className="rounded-lg border bg-card p-5 hover:border-primary/30 transition-colors"
            >
              {/* Title */}
              <h2 className="font-semibold text-base leading-snug">
                {article.source_url ? (
                  <a
                    href={article.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary transition-colors"
                  >
                    {article.title}
                  </a>
                ) : (
                  article.title
                )}
              </h2>

              {/* Meta row */}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {article.source_name && (
                  <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                    {article.source_name}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatDate(article.published_at)}
                </span>
                {article.tags?.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              {/* Summary / body */}
              <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
                {article.summary?.slice(0, 120) || article.body?.slice(0, 120)}
                {(article.summary?.length > 120 || article.body?.length > 120) ? '…' : ''}
              </p>
            </article>
          ))}
        </div>
      )}

      {/* Source attribution */}
      <p className="text-xs text-muted-foreground text-center mt-8">
        Powered by{' '}
        <a href="https://www.pokebeach.com" target="_blank" rel="noopener noreferrer" className="hover:underline">PokeBeach</a>
        {', '}
        <a href="https://pokejungle.net" target="_blank" rel="noopener noreferrer" className="hover:underline">PokéJungle</a>
        {', and '}
        <a href="https://www.pokemon.com/en/pokemon-news" target="_blank" rel="noopener noreferrer" className="hover:underline">Pokémon official news</a>
      </p>
    </div>
  )
}
