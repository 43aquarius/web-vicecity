/**
 * RemoteArchive: serves packed-archive files straight from the upstream
 * archive via HTTP Range requests — zero local disk usage.
 *
 * Used when the container cannot hold the 1.08 GB archive (published
 * environments with small storage quotas). The flat index
 * (public/game/revcdos-index.json, ~1.8 MB, bundled with the app) gives
 * every path's byte range inside the archive; reads fetch just that range
 * from upstream and stream-decompress it on the fly.
 *
 * Memory is bounded: raw (still-compressed) bytes go through an inflight
 * dedup + LRU cache (MAX_RAW_CACHE_BYTES) so the ~61 MB data package is
 * fetched from upstream once and then shared across players; decompressed
 * content is handled by the caller's bounded materialisation cache.
 */

import { createBrotliDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import type { ArchiveStats } from './packed-archive'

const MAX_RAW_CACHE_BYTES = 160 * 1024 * 1024
const MAX_CONCURRENT_FETCHES = 16
const FETCH_TIMEOUT_MS = 300_000
const FETCH_RETRIES = 3

interface FlatIndex {
  v: number
  size: number
  files: number
  folders: number
  totalCompressed: number
  entries: Array<[string, number, number]>
}

export class RemoteArchive {
  stats: ArchiveStats = { folders: 0, files: 0, totalCompressed: 0, archiveSize: 0 }
  private entries = new Map<string, [number, number]>()
  private rawCache = new Map<string, Buffer>()
  private inflight = new Map<string, Promise<Buffer>>()
  private activeFetches = 0
  private fetchQueue: Array<() => void> = []
  private expectedSize = 0
  private closed = false

  constructor(
    private readonly indexPath: string,
    private readonly archiveUrl: string,
  ) {}

  async init(): Promise<void> {
    const raw = await readFile(this.indexPath, 'utf-8')
    const idx = JSON.parse(raw) as FlatIndex
    if (idx.v !== 1) throw new Error(`Unsupported index version ${idx.v}`)
    if (!Array.isArray(idx.entries) || idx.entries.length === 0) {
      throw new Error('Empty archive index')
    }
    for (const [path, offset, csize] of idx.entries) {
      this.entries.set(path, [offset, csize])
    }
    this.expectedSize = idx.size
    this.stats = {
      folders: idx.folders,
      files: idx.files,
      totalCompressed: idx.totalCompressed,
      archiveSize: idx.size,
    }
    console.log(
      `[archive] remote index loaded: ${this.entries.size} paths, ${(idx.size / 1048576).toFixed(1)} MB upstream @ ${this.archiveUrl}`,
    )
  }

  resolve(path: string): { dataOffset: number; compressedSize: number } | null {
    const normalized = path.replace(/^\/+/, '').replace(/\/+/g, '/')
    const e = this.entries.get(normalized)
    return e ? { dataOffset: e[0], compressedSize: e[1] } : null
  }

  private async fetchRange(offset: number, length: number): Promise<Buffer> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.activeFetches >= MAX_CONCURRENT_FETCHES) {
          await new Promise<void>((resolve) => this.fetchQueue.push(resolve))
        }
        this.activeFetches++
        try {
          const res = await fetch(this.archiveUrl, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` },
            // Do NOT set Accept-Encoding — the CDN ignores Range for identity.
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
          if (res.status !== 206) {
            await res.arrayBuffer().catch(() => {})
            throw new Error(`upstream returned HTTP ${res.status} for range ${offset}+${length}`)
          }
          // Guard against a silently replaced upstream archive: a total-size
          // mismatch means the bundled index no longer matches the bytes.
          const total = Number((res.headers.get('content-range') ?? '').split('/')[1] ?? 0)
          if (this.expectedSize > 0 && total > 0 && total !== this.expectedSize) {
            throw new Error(
              `upstream archive size mismatch: index expects ${this.expectedSize}, upstream has ${total} (stale index)`,
            )
          }
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length !== length) {
            throw new Error(`upstream short read: ${buf.length}/${length} bytes at ${offset}`)
          }
          return buf
        } finally {
          this.activeFetches--
          const next = this.fetchQueue.shift()
          if (next) next()
        }
      } catch (err) {
        if (attempt >= FETCH_RETRIES || this.closed) throw err
        console.warn(
          `[archive] remote fetch attempt ${attempt}/${FETCH_RETRIES} failed:`,
          err instanceof Error ? err.message : err,
        )
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }

  /** Fetch the stored (brotli) bytes with inflight dedup + LRU caching. */
  private readRawCached(
    path: string,
    entry: { dataOffset: number; compressedSize: number },
  ): Promise<Buffer> {
    const cached = this.rawCache.get(path)
    if (cached) {
      // Refresh LRU recency.
      this.rawCache.delete(path)
      this.rawCache.set(path, cached)
      return Promise.resolve(cached)
    }
    let p = this.inflight.get(path)
    if (!p) {
      p = this.fetchRange(entry.dataOffset, entry.compressedSize).then((buf) => {
        this.rawCache.set(path, buf)
        let used = 0
        for (const b of this.rawCache.values()) used += b.length
        while (used > MAX_RAW_CACHE_BYTES && this.rawCache.size > 1) {
          const oldest = this.rawCache.keys().next().value
          if (oldest === undefined) break
          const b = this.rawCache.get(oldest)
          this.rawCache.delete(oldest)
          used -= b ? b.length : 0
        }
        return buf
      })
      this.inflight.set(path, p)
      p.catch(() => {})
        .finally(() => {
          this.inflight.delete(path)
        })
        .catch(() => {})
    }
    return p
  }

  /** Stream the raw stored bytes (for brotli passthrough serving). */
  streamRaw(path: string): ReadableStream<Uint8Array> | null {
    const entry = this.resolve(path)
    if (!entry) return null
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const buf = await this.readRawCached(path, entry)
          controller.enqueue(new Uint8Array(buf))
          controller.close()
        } catch (err) {
          try {
            controller.error(err)
          } catch {
            /* already closed */
          }
        }
      },
    })
  }

  /**
   * Stream the DECOMPRESSED content: raw bytes → zlib streaming brotli
   * decoder. Bounded memory (a few pipe buffers + the cached raw bytes).
   */
  streamDecompressed(path: string): ReadableStream<Uint8Array> | null {
    const entry = this.resolve(path)
    if (!entry) return null
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const raw = await this.readRawCached(path, entry)
          const nodeStream = Readable.from(raw)
          const decoder = createBrotliDecompress()
          const piped = nodeStream.pipe(decoder)
          piped.on('error', (err: unknown) => {
            try {
              controller.error(err)
            } catch {
              /* already closed */
            }
          })
          for await (const chunk of piped) {
            controller.enqueue(chunk as Uint8Array)
          }
          controller.close()
        } catch (err) {
          try {
            controller.error(err)
          } catch {
            /* already closed */
          }
        }
      },
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.rawCache.clear()
  }
}
