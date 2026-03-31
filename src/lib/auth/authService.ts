import type { SupabaseClient } from '@supabase/supabase-js'

export interface SignInResult {
  error: string | null
}

export interface SignOutResult {
  error: string | null
}

export interface GetUserResult {
  user: { id: string; email?: string } | null
  error: string | null
}

/**
 * Send a magic-link OTP to the provided email.
 * The redirectTo URL must be the /callback route of the app.
 */
export async function signIn(
  supabase: SupabaseClient,
  email: string,
  redirectTo: string
): Promise<SignInResult> {
  if (!email || !email.includes('@')) {
    return { error: 'Invalid email address.' }
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  })

  return { error: error?.message ?? null }
}

/**
 * Sign the current user out and clear the session.
 */
export async function signOut(supabase: SupabaseClient): Promise<SignOutResult> {
  const { error } = await supabase.auth.signOut()
  return { error: error?.message ?? null }
}

/**
 * Retrieve the currently authenticated user from the server-side session.
 */
export async function getUser(supabase: SupabaseClient): Promise<GetUserResult> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  return {
    user: user ? { id: user.id, email: user.email } : null,
    error: error?.message ?? null,
  }
}
