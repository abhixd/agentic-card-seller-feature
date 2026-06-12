'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, UserCheck, UserPlus, Clock, Lock, Users } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

type Visibility = 'public' | 'friends' | 'private'

interface UserProfile {
  user_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  collection_visibility: Visibility
}

interface CardCatalog {
  card_name: string
  set_name: string
  year: number | null
  card_number: string | null
  canonical_image_url: string | null
  metadata_json: Record<string, unknown> | null
}

interface CollectionItem {
  item_id: string
  catalog_id: string
  status: string
  acquisition_cost?: number
  card: CardCatalog | null
}

type FollowStatus = 'none' | 'pending' | 'accepted'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    <span className={cn('text-[11px] font-semibold px-2 py-1 rounded-full border', cls)}>
      {emoji} {label}
    </span>
  )
}

function getMarketPrice(item: CollectionItem): number | null {
  const meta = item.card?.metadata_json
  if (!meta) return null
  const price =
    (meta.market_price as number | undefined) ??
    (meta.price as number | undefined) ??
    ((meta.prices as Record<string, number> | undefined)?.holofoil) ??
    ((meta.prices as Record<string, number> | undefined)?.normal) ??
    null
  return typeof price === 'number' ? price : null
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UserCollectionPage() {
  const params = useParams()
  const username = params.username as string

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [items, setItems] = useState<CollectionItem[]>([])
  const [followStatus, setFollowStatus] = useState<FollowStatus>('none')
  const [profileLoading, setProfileLoading] = useState(true)
  const [collectionLoading, setCollectionLoading] = useState(false)
  const [collectionError, setCollectionError] = useState<string | null>(null)
  const [followLoading, setFollowLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)

  // ── Fetch profile ────────────────────────────────────────────────────────────

  const fetchProfile = useCallback(async () => {
    setProfileLoading(true)
    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(username)}`)
      if (res.status === 404) { setNotFound(true); return }
      if (!res.ok) return
      const json = await res.json() as { profile: UserProfile }
      setProfile(json.profile)
    } finally {
      setProfileLoading(false)
    }
  }, [username])

  // ── Fetch follow status ───────────────────────────────────────────────────────

  const fetchFollowStatus = useCallback(async () => {
    const res = await fetch('/api/social/follow')
    if (!res.ok) return
    const json = await res.json() as { following: Array<{ status: string; following: { username: string } }> }
    const match = json.following.find((f) => f.following.username === username)
    if (!match) setFollowStatus('none')
    else setFollowStatus(match.status as FollowStatus)
  }, [username])

  // ── Fetch collection ──────────────────────────────────────────────────────────

  const fetchCollection = useCallback(async () => {
    setCollectionLoading(true)
    setCollectionError(null)
    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(username)}/collection`)
      if (res.status === 403) {
        const json = await res.json() as { error: string }
        setCollectionError(json.error)
        return
      }
      if (!res.ok) { setCollectionError('Failed to load collection.'); return }
      const json = await res.json() as { items: CollectionItem[] }
      setItems(json.items)
    } finally {
      setCollectionLoading(false)
    }
  }, [username])

  useEffect(() => {
    fetchProfile()
    fetchFollowStatus()
  }, [fetchProfile, fetchFollowStatus])

  useEffect(() => {
    if (profile) fetchCollection()
  }, [profile, fetchCollection])

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleFollow() {
    if (!profile) return
    setFollowLoading(true)
    try {
      if (followStatus === 'accepted' || followStatus === 'pending') {
        await fetch('/api/social/follow', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ followingId: profile.user_id }),
        })
        setFollowStatus('none')
      } else {
        await fetch('/api/social/follow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ followingId: profile.user_id }),
        })
        const newStatus = profile.collection_visibility === 'friends' ? 'pending' : 'accepted'
        setFollowStatus(newStatus)
      }
      await fetchCollection()
    } finally {
      setFollowLoading(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (profileLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-white/30 text-sm">Loading profile…</p>
      </div>
    )
  }

  if (notFound || !profile) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-white/40 text-sm">User not found.</p>
        <Link href="/community" className="text-violet-400 text-sm hover:underline">
          Back to Community
        </Link>
      </div>
    )
  }

  const letter = (profile.display_name ?? profile.username).charAt(0).toUpperCase()

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">
      {/* Back link */}
      <Link
        href="/community"
        className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors w-fit"
      >
        <ArrowLeft className="h-4 w-4" />
        Community
      </Link>

      {/* Profile header */}
      <div className="flex items-start gap-4 p-5 rounded-2xl bg-white/[0.03] border border-white/8">
        {/* Avatar */}
        <div
          className={cn(
            'w-16 h-16 rounded-2xl flex items-center justify-center text-white font-bold text-2xl flex-shrink-0',
            avatarColor(profile.username)
          )}
        >
          {letter}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-white">@{profile.username}</h1>
            <VisibilityBadge v={profile.collection_visibility} />
          </div>
          {profile.display_name && (
            <p className="text-sm text-white/60 mt-0.5">{profile.display_name}</p>
          )}
          {profile.bio && (
            <p className="text-sm text-white/40 mt-2 leading-relaxed">{profile.bio}</p>
          )}
        </div>

        {/* Follow button */}
        <button
          disabled={followLoading}
          onClick={handleFollow}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 flex-shrink-0',
            followStatus === 'accepted'
              ? 'bg-white/[0.06] text-white/60 hover:bg-red-500/20 hover:text-red-400'
              : followStatus === 'pending'
              ? 'bg-white/[0.06] text-white/40 cursor-default'
              : 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30'
          )}
        >
          {followStatus === 'accepted' ? (
            <><UserCheck className="h-4 w-4" />Following</>
          ) : followStatus === 'pending' ? (
            <><Clock className="h-4 w-4" />Pending</>
          ) : (
            <><UserPlus className="h-4 w-4" />Follow</>
          )}
        </button>
      </div>

      {/* Collection section */}
      <div>
        <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">
          Collection
        </h2>

        {collectionLoading && (
          <p className="text-sm text-white/30 text-center py-12">Loading collection…</p>
        )}

        {!collectionLoading && collectionError && (
          <div className="flex flex-col items-center gap-3 py-16 rounded-2xl bg-white/[0.02] border border-white/8">
            {collectionError.includes('private') ? (
              <Lock className="h-8 w-8 text-white/20" />
            ) : (
              <Users className="h-8 w-8 text-white/20" />
            )}
            <p className="text-sm text-white/40">{collectionError}</p>
            {collectionError.toLowerCase().includes('follow') && followStatus === 'none' && (
              <button
                onClick={handleFollow}
                disabled={followLoading}
                className="mt-2 px-4 py-2 rounded-xl text-sm font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4 inline mr-1.5" />
                Request to Follow
              </button>
            )}
          </div>
        )}

        {!collectionLoading && !collectionError && items.length === 0 && (
          <p className="text-sm text-white/25 text-center py-12">No cards in collection yet.</p>
        )}

        {!collectionLoading && !collectionError && items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((item) => {
              const card = item.card
              const price = getMarketPrice(item)
              return (
                <div
                  key={item.item_id}
                  className="flex flex-col rounded-xl bg-white/[0.03] border border-white/8 overflow-hidden hover:bg-white/[0.05] hover:border-white/12 transition-all"
                >
                  {/* Card image */}
                  <div className="aspect-[3/4] bg-white/[0.03] relative">
                    {card?.canonical_image_url ? (
                      <Image
                        src={card.canonical_image_url}
                        alt={card.card_name}
                        fill
                        className="object-contain p-1"
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 25vw"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-white/10 text-3xl">🃏</span>
                      </div>
                    )}
                  </div>

                  {/* Card info */}
                  <div className="p-2.5 flex flex-col gap-1">
                    <p className="text-xs font-semibold text-white truncate leading-tight">
                      {card?.card_name ?? 'Unknown Card'}
                    </p>
                    <p className="text-[11px] text-white/40 truncate">
                      {card?.set_name ?? '—'}
                      {card?.year ? ` · ${card.year}` : ''}
                    </p>
                    {card?.card_number && (
                      <p className="text-[10px] text-white/25">#{card.card_number}</p>
                    )}
                    {price !== null && (
                      <p className="text-[11px] text-emerald-400 font-semibold mt-0.5">
                        ${price.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
