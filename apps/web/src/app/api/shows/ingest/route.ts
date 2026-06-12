import { NextRequest, NextResponse } from 'next/server'
import { runIngestion } from '@/lib/events/ingest'

export const runtime     = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  // Light auth — require the CRON_SECRET or ADMIN_SECRET
  const authHeader  = req.headers.get('authorization') ?? ''
  const token       = authHeader.replace('Bearer ', '')
  const cronSecret  = process.env.CRON_SECRET
  const adminSecret = process.env.ADMIN_SECRET
  if (token !== cronSecret && token !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await runIngestion()
  return NextResponse.json(result)
}

// Also allow GET for cron jobs
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (req.headers.get('x-cron-secret') !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await runIngestion()
  return NextResponse.json(result)
}
