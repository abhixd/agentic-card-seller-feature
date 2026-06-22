import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock variables before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

import { POST } from '@/app/api/grade/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function imageFile(bytes = 100, name = 'card.jpg', type = 'image/jpeg'): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

// Hand the route the FormData directly. Building a real multipart Request and
// re-parsing it yields an undici File that fails the route's `instanceof File`
// guard under jsdom (the Next.js runtime returns a proper global File); this
// mirrors what the runtime hands the handler without the multipart round-trip.
function makeRequest(form: FormData): Request {
  return { formData: async () => form } as unknown as Request
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  // Default: authenticated user, mock grading backend
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } })
  vi.stubEnv('GRADING_API_URL', 'mock')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/grade', () => {
  describe('authentication', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const fd = new FormData()
      fd.append('image', imageFile())
      const res = await POST(makeRequest(fd))
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('Unauthorized')
    })
  })

  describe('request validation', () => {
    it('returns 400 when no image is provided', async () => {
      const res = await POST(makeRequest(new FormData()))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('No image provided.')
    })

    it('returns 400 when the image exceeds 10MB', async () => {
      const fd = new FormData()
      fd.append('image', imageFile(10 * 1024 * 1024 + 1))
      const res = await POST(makeRequest(fd))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Image must be under 10MB.')
    })
  })

  describe('happy path (mock backend)', () => {
    it('returns a contract-shaped GradeResponse from the mock', async () => {
      const fd = new FormData()
      fd.append('image', imageFile())
      fd.append('title', 'Charizard Base Set 4/102')

      const res = await POST(makeRequest(fd))
      expect(res.status).toBe(200)

      const grade = await res.json()
      // shape from @acs/grading-contract via mockGrade()
      expect(grade.overall_score).toBe(9)
      expect(grade.psa_equivalent).toBe('PSA 9 MINT')
      expect(grade.confidence).toBe('high')
      expect(grade.centering).toMatchObject({ score: 7, left_right: '52/48', reliable: true })
      expect(grade.corners.score).toBe(9)
      expect(grade.edges.score).toBe(9)
      expect(grade.surface.score).toBe(10)
      expect(grade.issues).toEqual({ corners: [], edges: [], surface: [], centering: [] })
    })

    it('defaults to the mock backend when GRADING_API_URL is unset', async () => {
      vi.unstubAllEnvs()
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } })
      const fd = new FormData()
      fd.append('image', imageFile())
      const res = await POST(makeRequest(fd))
      expect(res.status).toBe(200)
      expect((await res.json()).psa_equivalent).toBe('PSA 9 MINT')
    })
  })
})
