import { NextRequest } from 'next/server'
import { serveFromArchive } from '@/lib/archive-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function handler(request: NextRequest, pathSegments: string[]): Promise<Response> {
  const path = pathSegments
    .map((segment) => decodeURIComponent(segment))
    .join('/')
    .replace(/\.\./g, '')
    .replace(/^\/+/, '')

  // The packed archive stores assets under vcsky/…
  return serveFromArchive(`vcsky/${path}`, request as unknown as Request)
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params
  return handler(request, path ?? [])
}

export async function HEAD(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params
  return handler(request, path ?? [])
}
