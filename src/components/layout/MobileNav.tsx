'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, ScanLine, Archive, MessageSquare, BookOpen, Newspaper } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/analyze', label: 'Analyze', icon: ScanLine },
  { href: '/inventory', label: 'Inventory', icon: Archive },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/sets', label: 'Sets', icon: BookOpen },
  { href: '/news', label: 'News', icon: Newspaper },
]

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t bg-background z-50">
      <div className="flex">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex-1 flex flex-col items-center gap-1 py-3 text-xs font-medium transition-colors',
              pathname.startsWith(href) ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <Icon className="h-5 w-5" />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
