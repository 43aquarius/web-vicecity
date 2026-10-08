import { NextResponse } from 'next/server'
import { getArchiveStatus, warmArchive } from '@/lib/archive-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Kick off (idempotent) background warm-up of the two engine files
 * (vc-sky-en-v6.data.br / .wasm.br). Called by the entry page as soon as it
 * loads, so by the time the player clicks "play" the remote-mode server has
 * already materialised the ~61 MB data package and the chunked download runs
 * at full speed. Progress is visible via /api/archive/status (`warm` field).
 */
export async function POST(): Promise<NextResponse> {
  warmArchive()
  return NextResponse.json(getArchiveStatus(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET(): Promise<NextResponse> {
  warmArchive()
  return NextResponse.json(getArchiveStatus(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}
