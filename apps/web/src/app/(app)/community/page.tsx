'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Search, Users, UserCheck, UserPlus, Clock, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

type Visibility = 'public' | 'friends' | 'private'

interface UserResult {
  user_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  collection_visibility: Visibility
}

interface FollowEntry {
  id: string
  status: 'pending' | 'accepted'
  following: UserResult
}

interface RequestEntry {
  id: string
  follower: {
    user_id: string
    username: string
    display_name: string | null
    avatar_url: string | null
  }
}

type Tab = 'discover' | 'friends' | 'requests'

// ── Helpers ───────────────────────────────────────────────────────────────────

function avatarLetter(u: { username: string; display_name?: string | null }) {
  return (u.display_name ?? u.username).charAt(0).toUpperCase()
}

const AVATAR_COLORS = [
  'bg-indigo-500',
  'bg-violet-500',
  'bg-sky-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-amber-500',
]

function avatarColor(username: string) {
  let hash = 0
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function VisibilityBadge({ v }: { v: Visibility }) {
  const map: Record<Visibility, { label: string; emoji: string; cls: string }> = {
    public:  { label: 'Public',  emoji: '🌐', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
    friends: { label: 'Friends', emoji: '👥', cls: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
    private: { label: 'Private', emoji: '🔒', cls: 'text-white/40 bg-white/5 border-white/10' },
  }
  const { label, emoji, cls } = map[v]
  return (
    <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full border', cls)}>
      {emoji} {label}
    </span>
  )
}

function AvatarCircle({ user }: { user: { username: string; display_name?: string | null } }) {
  return (
    <div
      className={cn(
        'w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0',
        avatarColor(user.username)
      )}
    >
      {avatarLetter(user)}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CommunityPage() {
  const [tab, setTab] = useState<Tab>('discover')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserResult[]>([])
  const [following, setFollowing] = useState<FollowEntry[]>([])
  const [requests, setRequests] = useState<RequestEntry[]>([])
  const [loadingFollowing, setLoadingFollowing] = useState(false)
  const [loadingRequests, setLoadingRequests] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  // Build a map of userId -> follow status from the following list
  const followMap = new Map<string, 'pending' | 'accepted'>(
    following.map((f) => [f.following.user_id, f.status])
  )

  // ── Data fetching ────────────────────────────────────────────────────────────

  const fetchFollowing = useCallback(async () => {
    setLoadingFollowing(true)
    try {
      const res = await fetch('/api/social/follow')
      if (res.ok) {
        const json = await res.json() as { following: FollowEntry[] }
        setFollowing(json.following)
      }
    } finally {
      setLoadingFollowing(false)
    }
  }, [])

  const fetchRequests = useCallback(async () => {
    setLoadingRequests(true)
    try {
      const res = await fetch('/api/social/requests')
      if (res.ok) {
        const json = await res.json() as { requests: RequestEntry[] }
        setRequests(json.requests)
      }
    } finally {
      setLoadingRequests(false)
    }
  }, [])

  const searchUsers = useCallback(async (q: string) => {
    setSearchLoading(true)
    try {
      const res = await fetch(`/api/social/users?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const json = await res.json() as { users: UserResult[] }
        setSearchResults(json.users)
      }
    } finally {
      setSearchLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFollowing()
    fetchRequests()
  }, [fetchFollowing, fetchRequests])

  useEffect(() => {
    const timer = setTimeout(() => {
      searchUsers(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, searchUsers])

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleFollow(userId: string) {
    setActionLoading((p) => ({ ...p, [userId]: true }))
    try {
      await fetch('/api/social/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: userId }),
      })
      await fetchFollowing()
    } finally {
      setActionLoading((p) => ({ ...p, [userId]: false }))
    }
  }

  async function handleUnfollow(userId: string) {
    setActionLoading((p) => ({ ...p, [userId]: true }))
    try {
      await fetch('/api/social/follow', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: userId }),
      })
      await fetchFollowing()
    } finally {
      setActionLoading((p) => ({ ...p, [userId]: false }))
    }
  }

  async function handleRequest(followerId: string, action: 'accept' | 'reject') {
    setActionLoading((p) => ({ ...p, [followerId]: true }))
    try {
      await fetch('/api/social/requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followerId, action }),
      })
      await fetchRequests()
      if (action === 'accept') await fetchFollowing()
    } finally {
      setActionLoading((p) => ({ ...p, [followerId]: false }))
    }
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'discover', label: 'Discover', icon: <Search className="h-4 w-4" /> },
    {
      id: 'friends',
      label: 'Friends',
      icon: <UserCheck className="h-4 w-4" />,
      badge: following.filter((f) => f.status === 'accepted').length || undefined,
    },
    {
      id: 'requests',
      label: 'Requests',
      icon: <Users className="h-4 w-4" />,
      badge: requests.length || undefined,
    },
  ]

  const friends = following.filter((f) => f.status === 'accepted')

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Community</h1>
        <p className="text-sm text-white/40 mt-1">Discover collectors, follow friends, browse collections</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/8">
        {tabs.map(({ id, label, icon, badge }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'relative flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200',
              tab === id
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
            )}
          >
            {icon}
            <span>{label}</span>
            {badge !== undefined && badge > 0 && (
              <span className="absolute top-1 right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-violet-500 text-[10px] font-bold text-white px-1">
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Discover Tab ── */}
      {tab === 'discover' && (
        <div className="flex flex-col gap-4">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by username or display name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/8 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-all"
            />
          </div>

          {searchLoading && (
            <p className="text-sm text-white/30 text-center py-4">Searching…</p>
          )}

          {!searchLoading && searchResults.length === 0 && (
            <p className="text-sm text-white/25 text-center py-8">
              {searchQuery.trim() ? 'No users found.' : 'Start typing to find collectors.'}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {searchResults.map((u) => {
              const status = followMap.get(u.user_id)
              const busy = actionLoading[u.user_id]
              return (
                <div
                  key={u.user_id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/8 hover:bg-white/[0.05] transition-all"
                >
                  <AvatarCircle user={u} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">@{u.username}</p>
                    {u.display_name && (
                      <p className="text-xs text-white/40 truncate">{u.display_name}</p>
                    )}
                  </div>
                  <VisibilityBadge v={u.collection_visibility} />
                  {status === 'accepted' ? (
                    <button
                      disabled={busy}
                      onClick={() => handleUnfollow(u.user_id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] text-white/60 hover:bg-red-500/20 hover:text-red-400 transition-all disabled:opacity-50"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      Following
                    </button>
                  ) : status === 'pending' ? (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] text-white/40 cursor-default"
                    >
                      <Clock className="h-3.5 w-3.5" />
                      Pending
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => handleFollow(u.user_id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all disabled:opacity-50"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      + Follow
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Friends Tab ── */}
      {tab === 'friends' && (
        <div className="flex flex-col gap-2">
          {loadingFollowing && (
            <p className="text-sm text-white/30 text-center py-8">Loading…</p>
          )}
          {!loadingFollowing && friends.length === 0 && (
            <p className="text-sm text-white/25 text-center py-8">
              You are not following anyone yet. Head to Discover to find collectors.
            </p>
          )}
          {friends.map(({ following: u, id }) => (
            <div
              key={id}
              className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/8 hover:bg-white/[0.05] transition-all"
            >
              <AvatarCircle user={u} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">@{u.username}</p>
                {u.display_name && (
                  <p className="text-xs text-white/40 truncate">{u.display_name}</p>
                )}
              </div>
              <Link
                href={`/community/${u.username}`}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all"
              >
                View Collection
              </Link>
              <button
                disabled={actionLoading[u.user_id]}
                onClick={() => handleUnfollow(u.user_id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] text-white/40 hover:bg-red-500/20 hover:text-red-400 transition-all disabled:opacity-50"
              >
                Unfollow
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Requests Tab ── */}
      {tab === 'requests' && (
        <div className="flex flex-col gap-2">
          {loadingRequests && (
            <p className="text-sm text-white/30 text-center py-8">Loading…</p>
          )}
          {!loadingRequests && requests.length === 0 && (
            <p className="text-sm text-white/25 text-center py-8">No pending follow requests.</p>
          )}
          {requests.map(({ follower, id }) => (
            <div
              key={id}
              className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/8 hover:bg-white/[0.05] transition-all"
            >
              <AvatarCircle user={follower} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">@{follower.username}</p>
                {follower.display_name && (
                  <p className="text-xs text-white/40 truncate">{follower.display_name}</p>
                )}
                <p className="text-xs text-white/30 mt-0.5">wants to follow your collection</p>
              </div>
              <button
                disabled={actionLoading[follower.user_id]}
                onClick={() => handleRequest(follower.user_id, 'accept')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-all disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Accept
              </button>
              <button
                disabled={actionLoading[follower.user_id]}
                onClick={() => handleRequest(follower.user_id, 'reject')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] text-white/40 hover:bg-red-500/20 hover:text-red-400 transition-all disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                Decline
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
