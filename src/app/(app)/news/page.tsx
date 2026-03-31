import { createClient } from '@/lib/supabase/server'

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    year:  'numeric',
  })
}

export default async function NewsPage() {
  const articles = await fetchNews()

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Pokemon TCG News</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Market insights for card sellers and collectors
        </p>
      </div>

      {/* No articles state */}
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
