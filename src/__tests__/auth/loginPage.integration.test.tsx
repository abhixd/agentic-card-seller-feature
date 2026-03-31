import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// Mock @/lib/supabase/client so the component never hits real Supabase
// ---------------------------------------------------------------------------
const mockSignInWithOtp = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
    },
  }),
}))

// Mock next/navigation (used by Button internally via Link — not needed here
// but avoids "invariant" errors if the component ever imports router hooks)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}))

import LoginPage from '@/app/(auth)/login/page'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LoginPage integration', () => {
  it('renders the email form', () => {
    render(<LoginPage />)
    // CardTitle from @base-ui renders as a <div>, not a heading element
    expect(screen.getByText(/sign in/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send magic link/i })).toBeInTheDocument()
  })

  it('shows success state after a valid email is submitted (happy path)', async () => {
    mockSignInWithOtp.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()

    render(<LoginPage />)
    await user.type(screen.getByLabelText(/email/i), 'seller@example.com')
    await user.click(screen.getByRole('button', { name: /send magic link/i }))

    await waitFor(() => {
      expect(screen.getByText(/check your email/i)).toBeInTheDocument()
      expect(screen.getByText(/seller@example\.com/i)).toBeInTheDocument()
    })
  })

  it('shows an error when Supabase returns an error (invalid credential path)', async () => {
    mockSignInWithOtp.mockResolvedValueOnce({
      error: { message: 'Email rate limit exceeded' },
    })
    const user = userEvent.setup()

    render(<LoginPage />)
    await user.type(screen.getByLabelText(/email/i), 'bad@example.com')
    await user.click(screen.getByRole('button', { name: /send magic link/i }))

    await waitFor(() => {
      expect(screen.getByText(/email rate limit exceeded/i)).toBeInTheDocument()
    })
    // Form should still be visible (not replaced by success message)
    expect(screen.getByRole('button', { name: /send magic link/i })).toBeInTheDocument()
  })

  it('disables the submit button while loading', async () => {
    // Never resolve so we can inspect the loading state
    mockSignInWithOtp.mockReturnValueOnce(new Promise(() => {}))
    const user = userEvent.setup()

    render(<LoginPage />)
    await user.type(screen.getByLabelText(/email/i), 'test@example.com')
    await user.click(screen.getByRole('button', { name: /send magic link/i }))

    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled()
  })

  it('shows inline validation error for an email without @', async () => {
    // Client-side guard in authService fires before Supabase is called
    const user = userEvent.setup()
    render(<LoginPage />)

    // Bypass HTML5 validation by firing directly
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'notanemail' },
    })
    // Submit via form to trigger our guard (HTML5 type=email would block it,
    // so we call submit programmatically)
    fireEvent.submit(screen.getByTestId('login-form'))

    await waitFor(() => {
      expect(screen.getByText(/invalid email address/i)).toBeInTheDocument()
    })
    expect(mockSignInWithOtp).not.toHaveBeenCalled()
  })
})
