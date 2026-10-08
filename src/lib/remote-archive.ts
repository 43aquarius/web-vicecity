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

const MAX_RAW_CACHE_BYTES = 128 * 1024 * 1024
const MAX_CONCURRENT_FETCHES = 16
// Timeout scales with the range size: small assets get ~30 s, the ~61 MB
// engine data package gets up to 10 minutes (slow upstream links must not
// abort a legitimately slow transfer halfway through materialisation).
const MAX_FETCH_TIMEOUT_MS = 600_000
const FETCH_RETRIES = 3

interface FlatIndex {
  v: number
  size: number
  files: number
  folders: number
  totalCompressed: number
  entries: Array<[string, number, number]>
}

/**
 * Drain a 206 response body as a Buffer, reporting received bytes along the
 * way so multi-MB engine-file fetches surface real progress (arrayBuffer()
 * gives no intermediate signal).
 */
async function readBodyWithProgress(
  res: Response,
  expectedLength: number,
  onProgress?: (received: number) => void,
): Promise<Buffer> {
  if (!res.body || !onProgress) {
    return Buffer.from(await res.arrayBuffer())
  }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const b = Buffer.from(value)
    chunks.push(b)
    received += b.length
    onProgress(received)
  }
  if (chunks.length === 1 && received === expectedLength) return chunks[0]
  const out = Buffer.allocUnsafe(Math.max(received, 0))
  let pos = 0
  for (const c of chunks) {
    c.copy(out, pos)
    pos += c.length
  }
  return out
}

export interface RelaySourceConfig {
  /** Short identifier used in logs / the sources API. */
  id: string
  /** FULL archive URL on the relay, e.g. https://relay-a.example.com/revcdos.bin (may carry ?token=). */
  url: string
  /** Partition start byte, inclusive. */
  start: number
  /** Partition end byte, EXCLUSIVE. */
  end: number
}

/**
 * Parse REVCDOS_RELAYS="a=https://host/revcdos.bin:0-361454906,b=...:361454906-722909812".
 * Invalid entries are skipped with a warning; overlapping partitions keep the
 * first owner (later relays get the overlap trimmed); gaps simply stay with
 * the upstream (the main server itself).
 */
export function parseRelaySources(raw: string | undefined): RelaySourceConfig[] {
  if (!raw || !raw.trim()) return []
  const out: RelaySourceConfig[] = []
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (!entry) continue
    // id=url:start-end  (the URL itself may contain ':' and '?', so parse
    // from the RIGHT: the LAST ':' separates the range from the URL).
    const m = /^(.*)=(https?:\/\/[^\s]+):(\d+)-(\d+)$/.exec(entry)
    if (!m) {
      console.warn(`[archive] invalid REVCDOS_RELAYS entry skipped: "${entry}"`)
      continue
    }
    const [, id, url, start, end] = m
    const s = Number(start)
    const e = Number(end)
    if (!(s >= 0) || !(e > s)) {
      console.warn(`[archive] relay "${id}" has an empty/negative partition [${s}, ${e}) — skipped`)
      continue
    }
    out.push({ id, url, start: s, end: e })
  }
  // Sort by start; trim overlaps (first owner wins) and log them.
  out.sort((a, b) => a.start - b.start)
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) {
      console.warn(
        `[archive] relay partitions overlap: "${out[i - 1].id}" [${out[i - 1].start}, ${out[i - 1].end}) ∩ "${out[i].id}" [${out[i].start}, ${out[i].end}) — trimming "${out[i].id}"`,
      )
      out[i] = { ...out[i], start: out[i - 1].end }
      if (out[i].end <= out[i].start) {
        console.warn(`[archive] relay "${out[i].id}" fully overlapped — dropped`)
        out.splice(i, 1)
        i--
      }
    }
  }
  return out
}

const RELAY_RETRIES = 2
const RELAY_TIMEOUT_MS = 20_000
/** Consecutive failures before a relay is bypassed for the cooldown window. */
const RELAY_CIRCUIT_FAILURES = 3
const RELAY_CIRCUIT_COOLDOWN_MS = 120_000

export class RemoteArchive {
  stats: ArchiveStats = { folders: 0, files: 0, totalCompressed: 0, archiveSize: 0 }
  private entries = new Map<string, [number, number]>()
  private rawCache = new Map<string, Buffer>()
  private inflight = new Map<string, Promise<Buffer>>()
  private activeFetches = 0
  private fetchQueue: Array<() => void> = []
  private expectedSize = 0
  private closed = false
  /** Partitioned relays (aux servers); empty = single-upstream behaviour. */
  private relays: RelaySourceConfig[]
  /** Circuit-breaker state per relay id. */
  private relayCircuit = new Map<string, { failures: number; downUntil: number }>()

  constructor(
    private readonly indexPath: string,
    private readonly archiveUrl: string,
    /** Granular progress for the raw (still-compressed) upstream fetch. */
    private readonly onRawProgress?: (path: string, received: number, total: number) => void,
    relays: RelaySourceConfig[] = [],
  ) {
    this.relays = relays
    if (relays.length > 0) {
      const covered = relays.reduce((acc, r) => acc + (r.end - r.start), 0)
      console.log(
        `[archive] relay routing enabled: ${relays.length} relay(s), ${(covered / 1048576).toFixed(1)} MiB delegated, ` +
          relays.map((r) => `${r.id}=[${r.start}, ${r.end})`).join(' '),
      )
    }
  }

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

  /** Relay partitions exposed to clients (the /api/archive/sources route). */
  getRelaySources(): RelaySourceConfig[] {
    return this.relays.map((r) => ({ ...r }))
  }

  private circuitOk(relay: RelaySourceConfig): boolean {
    const c = this.relayCircuit.get(relay.id)
    return !c || c.downUntil < Date.now()
  }

  private noteRelayFailure(relay: RelaySourceConfig) {
    const c = this.relayCircuit.get(relay.id) ?? { failures: 0, downUntil: 0 }
    c.failures++
    if (c.failures >= RELAY_CIRCUIT_FAILURES) {
      c.downUntil = Date.now() + RELAY_CIRCUIT_COOLDOWN_MS
      c.failures = 0
      console.warn(
        `[archive] relay "${relay.id}" failed ${RELAY_CIRCUIT_FAILURES}× — bypassing for ${RELAY_CIRCUIT_COOLDOWN_MS / 1000}s (upstream takes over)`,
      )
    }
    this.relayCircuit.set(relay.id, c)
  }

  private noteRelaySuccess(relay: RelaySourceConfig) {
    this.relayCircuit.delete(relay.id)
  }

  /** Fetch a byte segment from one relay; throws on any mismatch. */
  private async fetchRelaySegment(
    path: string,
    relay: RelaySourceConfig,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= RELAY_RETRIES; attempt++) {
      try {
        const res = await fetch(relay.url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          // No Accept-Encoding — range semantics break under content encoding.
          signal: AbortSignal.timeout(Math.max(RELAY_TIMEOUT_MS, Math.min(600_000, 10_000 + length * 20))),
        })
        if (res.status !== 206) {
          await res.arrayBuffer().catch(() => {})
          throw new Error(`relay ${relay.id} returned HTTP ${res.status}`)
        }
        const buf = await readBodyWithProgress(res, length, (received) => {
          if (this.onRawProgress) this.onRawProgress(path, received, length)
        })
        if (buf.length !== length) {
          throw new Error(`relay ${relay.id} short read: ${buf.length}/${length} bytes at ${offset}`)
        }
        this.noteRelaySuccess(relay)
        return buf
      } catch (err) {
        lastErr = err
        console.warn(
          `[archive] relay ${relay.id} attempt ${attempt}/${RELAY_RETRIES} failed for ${path}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    this.noteRelayFailure(relay)
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async fetchRange(path: string, offset: number, length: number): Promise<Buffer> {
    // ---- Partition routing: split [offset, offset+length) per relay owner.
    // Each segment goes to its relay (concurrently, when there are two);
    // uncovered bytes and any FAILED relay segment fall back to upstream so
    // a dead aux server never breaks the game.
    const usable = this.relays.filter(
      (r) => this.circuitOk(r) && r.start < offset + length && r.end > offset,
    )
    if (usable.length > 0) {
      const segments: Array<{
        relay?: RelaySourceConfig
        start: number
        len: number
      }> = []
      let pos = offset
      const sorted = [...usable].sort((a, b) => a.start - b.start)
      for (const r of sorted) {
        if (r.end <= pos) continue
        const segStart = Math.max(pos, r.start)
        if (segStart >= offset + length) break
        if (segStart > pos) {
          // Gap before this relay's partition — upstream owns it.
          segments.push({ start: pos, len: segStart - pos })
          pos = segStart
        }
        const segLen = Math.min(r.end, offset + length) - pos
        if (segLen <= 0) continue
        segments.push({ relay: r, start: pos, len: segLen })
        pos += segLen
      }
      if (pos < offset + length) segments.push({ start: pos, len: offset + length - pos })

      if (segments.some((s) => s.relay)) {
        const parts: Array<Buffer | null> = await Promise.all(
          segments.map(async (s) => {
            if (s.relay) {
              try {
                return await this.fetchRelaySegment(path, s.relay, s.start, s.len)
              } catch (err) {
                console.warn(
                  `[archive] relay segment failed, falling back to upstream [${s.start}, ${s.start + s.len}):`,
                  err instanceof Error ? err.message : err,
                )
                return null
              }
            }
            return null
          }),
        )
        const missing = segments.filter((_, i) => parts[i] === null)
        if (missing.length > 0) {
          // Fetch the failed/uncovered segments from upstream.
          const ups = await Promise.all(
            missing.map((s) => this.fetchUpstreamRange(s.start, s.len)),
          )
          for (let i = 0, j = 0; i < segments.length; i++) {
            if (parts[i] === null) parts[i] = ups[j++] ?? Buffer.alloc(0)
          }
        }
        const bufs = parts.filter((b): b is Buffer => b !== null)
        if (bufs.length === 1) return bufs[0]
        const totalLen = bufs.reduce((a, b) => a + b.length, 0)
        const out = Buffer.allocUnsafe(totalLen)
        let o = 0
        for (const p of bufs) {
          p.copy(out, o)
          o += p.length
        }
        return out
      }
    }

    // ---- Single upstream fetch (no relay covers this range).
    return this.fetchUpstreamRange(offset, length)
  }

  /** The original direct-upstream ranged fetch with retries. */
  private async fetchUpstreamRange(offset: number, length: number): Promise<Buffer> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.activeFetches >= MAX_CONCURRENT_FETCHES) {
          await new Promise<void>((resolve) => this.fetchQueue.push(resolve))
        }
        this.activeFetches++
        try {
          const timeoutMs = Math.min(MAX_FETCH_TIMEOUT_MS, 30_000 + length * 20)
          const res = await fetch(this.archiveUrl, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` },
            // Do NOT set Accept-Encoding — the CDN ignores Range for identity.
            signal: AbortSignal.timeout(timeoutMs),
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
          const buf = await readBodyWithProgress(res, length)
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
          `[archive] upstream fetch attempt ${attempt}/${FETCH_RETRIES} failed:`,
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
      p = this.fetchRange(path, entry.dataOffset, entry.compressedSize).then((buf) => {
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
