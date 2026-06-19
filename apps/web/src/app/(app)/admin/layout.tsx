import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/admin'

/** Server-side gate: only allow-listed admins (ADMIN_EMAILS) may render anything under /admin. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireAdmin()
  if (!user) redirect('/grade')
  return <>{children}</>
}
