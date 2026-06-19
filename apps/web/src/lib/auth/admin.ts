import { createClient } from '@/lib/supabase/server'

/** Allow-listed admin emails from ADMIN_EMAILS (comma-separated, server-only env). */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Resolve the current request's admin context. Returns the supabase client plus the user — but
 * `user` is non-null ONLY if the signed-in account's email is on the ADMIN_EMAILS allowlist.
 * Fail-closed: if ADMIN_EMAILS is unset/empty, nobody is an admin.
 */
export async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const allow = adminEmails()
  const ok = !!user && allow.length > 0 && !!user.email && allow.includes(user.email.toLowerCase())
  return { supabase, user: ok ? user : null }
}
