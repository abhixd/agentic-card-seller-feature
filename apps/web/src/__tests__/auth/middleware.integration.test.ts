import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mock @supabase/ssr — we control what getUser() returns per test
// ---------------------------------------------------------------------------
const mockGetUser = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: mockGetUser,
    },
  }),
}))

// Provide env vars so the middleware's createServerClient call doesn't throw
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')

import { middleware } from '@/middleware'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://localhost:3000'))
}

function isRedirectTo(response: Response, pathname: string): boolean {
  const location = response.headers.get('location') ?? ''
  return location.includes(pathname)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Protected route behaviour
// ---------------------------------------------------------------------------

describe('middleware — protected routes', () => {
  const protectedPaths = ['/dashboard', '/analyze', '/inventory', '/chat']

  it.each(protectedPaths)(
    'redirects unauthenticated user from %s to /login',
    async (path) => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const res = await middleware(makeRequest(path))
      expect(res.status).toBe(307)
      expect(isRedirectTo(res, '/login')).toBe(true)
    }
  )

  it.each(protectedPaths)(
    'allows authenticated user through to %s',
    async (path) => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'user-1', email: 'test@example.com' } },
      })
      const res = await middleware(makeRequest(path))
      // NextResponse.next() has no redirect (status 200 or no location header)
      expect(isRedirectTo(res, '/login')).toBe(false)
    }
  )
})

// ---------------------------------------------------------------------------
// Auth-only pages (login) — authenticated users should be pushed to dashboard
// ---------------------------------------------------------------------------

describe('middleware — auth-only pages', () => {
  it('redirects authenticated user from /login to /dashboard', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
    })
    const res = await middleware(makeRequest('/login'))
    expect(res.status).toBe(307)
    expect(isRedirectTo(res, '/dashboard')).toBe(true)
  })

  it('allows unauthenticated user to reach /login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await middleware(makeRequest('/login'))
    expect(isRedirectTo(res, '/dashboard')).toBe(false)
    expect(isRedirectTo(res, '/login')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Public paths pass through without redirect
// ---------------------------------------------------------------------------

describe('middleware — public paths', () => {
  it('allows /callback without authentication', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await middleware(makeRequest('/callback'))
    expect(isRedirectTo(res, '/login')).toBe(false)
  })
})
