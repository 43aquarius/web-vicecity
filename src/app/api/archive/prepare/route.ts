import { NextResponse } from 'next/server'
import { getArchiveStatus, prepareArchive } from '@/lib/archive-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Kick off archive preparation (download + index) without blocking. */
export async function POST(): Promise<NextResponse> {
  prepareArchive()
  return NextResponse.json(getArchiveStatus(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET(): Promise<NextResponse> {
  prepareArchive()
  return NextResponse.json(getArchiveStatus(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}
