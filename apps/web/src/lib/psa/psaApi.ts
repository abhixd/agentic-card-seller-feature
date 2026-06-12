// PSA Public API — https://www.psacard.com/publicapi
// Cert lookup and population report for graded cards.
// Requires PSA_BEARER_TOKEN env var (get from psacard.com/publicapi).

const PSA_API_BASE = 'https://api.psacard.com/publicapi'

function headers() {
  return {
    Authorization: `bearer ${process.env.PSA_BEARER_TOKEN ?? ''}`,
    Accept: 'application/json',
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PsaCert {
  CertNumber:                  string
  SpecNumber:                  string
  SpecID:                      number
  LabelType:                   string
  Year:                        string
  Brand:                       string
  Category:                    string
  CardNumber:                  string
  Subject:                     string
  Variety:                     string | null
  GradeDescription:            string
  CardGrade:                   string
  ItemStatus:                  string
  TotalPopulation:             number
  TotalPopulationWithQualifier: number
  PopulationHigher:            number
  IsPSADNA:                    boolean
  IsDualCert:                  boolean
}

export interface PsaCertResponse {
  PSACert: PsaCert | null
  IsValidRequest: boolean
  ServerMessage: string | null
}

export interface PsaPop {
  Total:    number
  Auth:     number
  Grade1:   number; Grade1_5: number; Grade1Q: number
  Grade2:   number; Grade2_5: number; Grade2Q: number
  Grade3:   number; Grade3_5: number; Grade3Q: number
  Grade4:   number; Grade4_5: number; Grade4Q: number
  Grade5:   number; Grade5_5: number; Grade5Q: number
  Grade6:   number; Grade6_5: number; Grade6Q: number
  Grade7:   number; Grade7_5: number; Grade7Q: number
  Grade8:   number; Grade8_5: number; Grade8Q: number
  Grade9:   number; Grade9_5: number; Grade9Q: number
  Grade10:  number; Grade10Q: number
}

export interface PsaPopResponse {
  SpecID:      number
  Description: string
  PSAPop:      PsaPop | null
  IsValidRequest: boolean
  ServerMessage:  string | null
}

export interface PsaCertImage {
  ImageURL:    string
  IsFrontImage: boolean
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function getPsaCert(certNumber: string): Promise<PsaCertResponse> {
  const clean = certNumber.replace(/\D/g, '')
  const res = await fetch(
    `${PSA_API_BASE}/cert/GetByCertNumber/${clean}`,
    { headers: headers(), next: { revalidate: 3600 } }
  )
  if (!res.ok) throw new Error(`PSA API error: ${res.status}`)
  return res.json()
}

export async function getPsaCertImages(certNumber: string): Promise<PsaCertImage[]> {
  const clean = certNumber.replace(/\D/g, '')
  const res = await fetch(
    `${PSA_API_BASE}/cert/GetImagesByCertNumber/${clean}`,
    { headers: headers(), next: { revalidate: 3600 } }
  )
  if (!res.ok) return []
  return res.json()
}

export async function getPsaPop(specId: number): Promise<PsaPopResponse> {
  const res = await fetch(
    `${PSA_API_BASE}/pop/GetPSASpecPopulation/${specId}`,
    { headers: headers(), next: { revalidate: 3600 } }
  )
  if (!res.ok) throw new Error(`PSA API error: ${res.status}`)
  return res.json()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert PsaPop to a sorted array of { grade, count } for display. */
export function popToGrades(pop: PsaPop): { grade: string; count: number }[] {
  return [
    { grade: '10',  count: pop.Grade10  },
    { grade: '9',   count: pop.Grade9   },
    { grade: '8.5', count: pop.Grade8_5 },
    { grade: '8',   count: pop.Grade8   },
    { grade: '7.5', count: pop.Grade7_5 },
    { grade: '7',   count: pop.Grade7   },
    { grade: '6.5', count: pop.Grade6_5 },
    { grade: '6',   count: pop.Grade6   },
    { grade: '5',   count: pop.Grade5   },
    { grade: '4',   count: pop.Grade4   },
    { grade: '3',   count: pop.Grade3   },
    { grade: '2',   count: pop.Grade2   },
    { grade: '1',   count: pop.Grade1   },
    { grade: 'Auth', count: pop.Auth    },
  ].filter(g => g.count > 0)
}
