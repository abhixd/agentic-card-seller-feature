'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, ScanLine, Archive, MessageSquare, LogOut, Layers, BookOpen, Newspaper } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/auth/authService'
import { Button } from '@/components/ui/button'

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/analyze', label: 'Analyze Card', icon: ScanLine },
  { href: '/inventory', label: 'Inventory', icon: Archive },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/sets', label: 'Browse Sets', icon: BookOpen },
  { href: '/news', label: 'News', icon: Newspaper },
]

export function NavBar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await signOut(supabase)
    router.push('/login')
  }

  return (
    <aside className="hidden md:flex flex-col w-56 border-r bg-background h-screen sticky top-0 p-4 gap-1">
      <div className="flex items-center gap-2 mb-6 px-2">
        <Layers className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">Card Seller OS</span>
      </div>

      {navItems.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors',
            pathname.startsWith(href)
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          )}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}

      <div className="mt-auto">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground"
          onClick={handleSignOut}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  )
}
