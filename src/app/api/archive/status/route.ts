import { NextResponse } from 'next/server'
import { getArchiveStatus } from '@/lib/archive-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<NextResponse> {
  const status = getArchiveStatus()
  return NextResponse.json(status, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
