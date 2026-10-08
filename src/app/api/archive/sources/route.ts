import { NextResponse } from 'next/server'
import { ARCHIVE_URL, getArchiveStatus, getRelaySources } from '@/lib/archive-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The byte-range routing map for archive reads, consumed by the Service
 * Worker (public/sw.js) so the PLAYER'S BROWSER can fetch asset ranges
 * straight from the partitioned relay servers (CORS is open on the relays),
 * falling back to the GitHub raw mirror and finally this server's proxy.
 *
 * Response shape:
 * {
 *   total: 1084364719,
 *   relays: [ { id, url, start, end } ],          // aux servers, end exclusive
 *   upstream: { url, start, end, servedBy },       // this server (tail bytes + gaps)
 *   mirror: { repo, branch, parts, partSize }      // GitHub raw mirror fallback
 * }
 *
 * NOTE: relay URLs are passed through verbatim (they may carry ?token=…).
 * This endpoint is same-origin and only reachable from the game page itself.
 */
export async function GET(): Promise<NextResponse> {
  const relays = getRelaySources()
  const status = getArchiveStatus()
  const total = status.total > 0 ? status.total : 1084364719

  // This server owns everything the relays do not: the tail after the last
  // relay plus any gap between/around partitions (parseRelaySources keeps
  // partitions sorted and non-overlapping).
  let lastEnd = 0
  for (const r of relays) lastEnd = Math.max(lastEnd, r.end)

  return NextResponse.json(
    {
      total,
      relays,
      upstream: {
        url: ARCHIVE_URL,
        start: lastEnd,
        end: total,
        servedBy: 'main-server',
      },
      mirror: {
        repo: '43aquarius/web-vicecity',
        branch: 'archive-data',
        parts: 12,
        partSize: 96_000_000,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
