import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardSearchResult } from '@/types/catalog'

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/analyze',
}))

// Mock next/link to render a plain <a> so hrefs are testable
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEARCH_RESULTS: CardSearchResult[] = [
  {
    catalog_id: 'uuid-charizard',
    category: 'tcg',
    franchise_or_brand: 'Pokemon',
    set_name: 'Base Set',
    year: 1999,
    card_name: 'Charizard',
    card_number: '4/102',
    variant: null,
    canonical_image_url: null,
  },
  {
    catalog_id: 'uuid-blastoise',
    category: 'tcg',
    franchise_or_brand: 'Pokemon',
    set_name: 'Base Set',
    year: 1999,
    card_name: 'Blastoise',
    card_number: '2/102',
    variant: null,
    canonical_image_url: null,
  },
]

function mockSearchResponse(results: CardSearchResult[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ results, query: 'charizard', count: results.length }),
  })
}

beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------
// SearchForm
// ---------------------------------------------------------------------------

import { SearchForm } from '@/components/catalog/SearchForm'

describe('SearchForm', () => {
  it('renders a search input and submit button', () => {
    render(<SearchForm onSearch={vi.fn()} />)
    expect(screen.getByTestId('search-input')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
  })

  it('disables submit when query is shorter than 2 characters', () => {
    render(<SearchForm onSearch={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
  })

  it('calls onSearch with the trimmed query on submit', async () => {
    const onSearch = vi.fn()
    const user = userEvent.setup()
    render(<SearchForm onSearch={onSearch} />)

    await user.type(screen.getByTestId('search-input'), 'charizard')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(onSearch).toHaveBeenCalledWith('charizard')
  })
})

// ---------------------------------------------------------------------------
// SearchResults
// ---------------------------------------------------------------------------

import { SearchResults } from '@/components/catalog/SearchResults'

describe('SearchResults', () => {
  it('renders nothing before a search is performed', () => {
    const { container } = render(
      <SearchResults results={[]} query="" isLoading={false} hasSearched={false} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders skeleton rows while loading', () => {
    render(
      <SearchResults results={[]} query="charizard" isLoading={true} hasSearched={true} />
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders a no-results message when search returns empty', () => {
    render(
      <SearchResults results={[]} query="xyz999" isLoading={false} hasSearched={true} />
    )
    expect(screen.getByTestId('no-results')).toBeInTheDocument()
    expect(screen.getByText(/xyz999/i)).toBeInTheDocument()
  })

  it('renders result items and links to the correct card detail URL', () => {
    render(
      <SearchResults
        results={SEARCH_RESULTS}
        query="pokemon"
        isLoading={false}
        hasSearched={true}
      />
    )

    const items = screen.getAllByTestId('search-result-item')
    expect(items).toHaveLength(2)
    expect(screen.getByText('Charizard')).toBeInTheDocument()
    expect(screen.getByText('Blastoise')).toBeInTheDocument()

    // Each result should link to /analyze/[catalogId]
    expect(items[0]).toHaveAttribute('href', '/analyze/uuid-charizard')
    expect(items[1]).toHaveAttribute('href', '/analyze/uuid-blastoise')
  })
})

// ---------------------------------------------------------------------------
// AnalyzePage — full search flow
// ---------------------------------------------------------------------------

import AnalyzePage from '@/app/(app)/analyze/page'

describe('AnalyzePage search flow', () => {
  it('renders the search form on load', () => {
    render(<AnalyzePage />)
    expect(screen.getByTestId('search-input')).toBeInTheDocument()
  })

  it('shows results after a successful search', async () => {
    mockSearchResponse(SEARCH_RESULTS)
    const user = userEvent.setup()
    render(<AnalyzePage />)

    await user.type(screen.getByTestId('search-input'), 'charizard')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(screen.getByTestId('search-results')).toBeInTheDocument()
    })
    expect(screen.getByText('Charizard')).toBeInTheDocument()
    expect(screen.getByText('Blastoise')).toBeInTheDocument()
  })

  it('shows the no-results message when search returns empty', async () => {
    mockSearchResponse([])
    const user = userEvent.setup()
    render(<AnalyzePage />)

    await user.type(screen.getByTestId('search-input'), 'xyzabc')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(screen.getByTestId('no-results')).toBeInTheDocument()
    })
  })

  it('navigates to card detail on result click', async () => {
    mockSearchResponse(SEARCH_RESULTS)
    const user = userEvent.setup()
    render(<AnalyzePage />)

    await user.type(screen.getByTestId('search-input'), 'charizard')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => screen.getByTestId('search-results'))

    const firstResult = screen.getAllByTestId('search-result-item')[0]
    expect(firstResult).toHaveAttribute('href', '/analyze/uuid-charizard')
  })
})
