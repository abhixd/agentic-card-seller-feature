import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScanLine, Archive, MessageSquare, TrendingUp } from 'lucide-react'
import Link from 'next/link'

const quickLinks = [
  {
    href: '/analyze',
    icon: ScanLine,
    title: 'Analyze a Card',
    description: 'Look up a card, pull comps, and get a sell/grade/hold recommendation.',
  },
  {
    href: '/inventory',
    icon: Archive,
    title: 'View Inventory',
    description: 'Browse your saved cards and manage their status.',
  },
  {
    href: '/chat',
    icon: MessageSquare,
    title: 'Chat Copilot',
    description: 'Ask the AI to explain recommendations or rank your best opportunities.',
  },
]

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Welcome back{user?.email ? `, ${user.email}` : ''}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {quickLinks.map(({ href, icon: Icon, title, description }) => (
          <Link key={href} href={href}>
            <Card className="h-full hover:bg-muted/50 transition-colors cursor-pointer">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 text-primary" />
                  <CardTitle className="text-base">{title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>{description}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base text-muted-foreground">Portfolio Summary</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <CardDescription>
            Portfolio analytics will appear here once you add cards to your inventory.
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  )
}
