import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signIn, signOut, getUser } from '@/lib/auth/authService'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Helpers — build minimal Supabase client mocks
// ---------------------------------------------------------------------------

function makeSupabase(overrides: Partial<{
  signInWithOtp: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
  getUser: ReturnType<typeof vi.fn>
}> = {}): SupabaseClient {
  return {
    auth: {
      signInWithOtp: overrides.signInWithOtp ?? vi.fn().mockResolvedValue({ error: null }),
      signOut: overrides.signOut ?? vi.fn().mockResolvedValue({ error: null }),
      getUser: overrides.getUser ?? vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'test@example.com' } },
        error: null,
      }),
    },
  } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------

describe('signIn', () => {
  it('returns no error on a valid email (happy path)', async () => {
    const supabase = makeSupabase()
    const result = await signIn(supabase, 'test@example.com', 'http://localhost/callback')
    expect(result.error).toBeNull()
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'test@example.com',
      options: { emailRedirectTo: 'http://localhost/callback' },
    })
  })

  it('returns validation error for an email without @', async () => {
    const supabase = makeSupabase()
    const result = await signIn(supabase, 'notanemail', 'http://localhost/callback')
    expect(result.error).toBe('Invalid email address.')
    // Should not call Supabase at all for invalid input
    expect(supabase.auth.signInWithOtp).not.toHaveBeenCalled()
  })

  it('returns validation error for an empty email', async () => {
    const supabase = makeSupabase()
    const result = await signIn(supabase, '', 'http://localhost/callback')
    expect(result.error).toBe('Invalid email address.')
    expect(supabase.auth.signInWithOtp).not.toHaveBeenCalled()
  })

  it('surfaces Supabase error message when OTP call fails', async () => {
    const supabase = makeSupabase({
      signInWithOtp: vi.fn().mockResolvedValue({
        error: { message: 'Email rate limit exceeded' },
      }),
    })
    const result = await signIn(supabase, 'test@example.com', 'http://localhost/callback')
    expect(result.error).toBe('Email rate limit exceeded')
  })
})

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe('signOut', () => {
  it('returns no error on success (happy path)', async () => {
    const supabase = makeSupabase()
    const result = await signOut(supabase)
    expect(result.error).toBeNull()
    expect(supabase.auth.signOut).toHaveBeenCalled()
  })

  it('surfaces Supabase error when sign-out fails', async () => {
    const supabase = makeSupabase({
      signOut: vi.fn().mockResolvedValue({
        error: { message: 'Network error' },
      }),
    })
    const result = await signOut(supabase)
    expect(result.error).toBe('Network error')
  })
})

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

describe('getUser', () => {
  it('returns the user when a valid session exists (happy path)', async () => {
    const supabase = makeSupabase()
    const result = await getUser(supabase)
    expect(result.error).toBeNull()
    expect(result.user).toEqual({ id: 'user-1', email: 'test@example.com' })
  })

  it('returns null user when no session exists', async () => {
    const supabase = makeSupabase({
      getUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: null,
      }),
    })
    const result = await getUser(supabase)
    expect(result.user).toBeNull()
    expect(result.error).toBeNull()
  })

  it('surfaces Supabase error when session retrieval fails', async () => {
    const supabase = makeSupabase({
      getUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'JWT expired' },
      }),
    })
    const result = await getUser(supabase)
    expect(result.user).toBeNull()
    expect(result.error).toBe('JWT expired')
  })
})
