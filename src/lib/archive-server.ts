/**
 * Archive server singleton.
 *
 * Mirrors reVCDOS `server.py --packed` mode: ensures the packed game archive
 * (revcdos.bin) is available locally (downloading it with resume support when
 * missing), builds the file index, and exposes helpers used by the
 * /vcsky and /vcbr route handlers.
 */

import { createWriteStream, statSync, mkdirSync, readFileSync, createReadStream, renameSync, rmSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { PackedArchive, type ArchiveStats } from './packed-archive'
import {
  RemoteArchive,
  parseRelaySources,
  discardBody,
  type RelaySourceConfig,
  isLowMemoryEnvironment,
  detectContainerMemoryLimit,
} from './remote-archive'

/**
 * Common serving surface for local (PackedArchive) and remote (RemoteArchive)
 * backends — serveFromArchive and the materialisation cache are agnostic.
 */
export interface ArchiveSource {
  readonly stats: ArchiveStats
  resolve(path: string): { dataOffset: number; compressedSize: number } | null
  streamRaw(path: string): ReadableStream<Uint8Array> | null
  streamDecompressed(path: string): ReadableStream<Uint8Array> | null
  /** Remote backends request disk materialisation for large files (OOM guard). */
  wantsDiskMaterialization?(path: string): boolean
  close(): Promise<void>
}

export const ARCHIVE_URL =
  process.env.REVCDOS_ARCHIVE_URL ?? 'https://folder.morgen.qzz.io/revcdos.bin'

/**
 * Relay config resolution: env var first, then a deployable JSON file.
 *
 * The JSON fallback exists for published containers where custom env vars
 * cannot be set: edit public/relay.config.json (it ships with the standalone
 * build) and redeploy. The file uses the exact same string format as the
 * REVCDOS_RELAYS environment variable, so instructions stay consistent:
 *
 *   { "REVCDOS_RELAYS": "a=https://relay-a.example.com/revcdos.bin:0-361454906,b=…" }
 */
function resolveRelayConfig(): string | undefined {
  if (process.env.REVCDOS_RELAYS !== undefined) return process.env.REVCDOS_RELAYS
  const candidates = [
    '/home/z/my-project/public/relay.config.json',
    `${process.cwd()}/public/relay.config.json`,
    `${process.cwd()}/relay.config.json`,
  ]
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf-8')) as Record<string, unknown>
      const val = raw['REVCDOS_RELAYS']
      if (typeof val === 'string' && val.trim()) {
        console.log(`[archive] relay config loaded from ${candidate}`)
        return val
      }
    } catch {
      /* not present / not JSON — try the next candidate */
    }
  }
  return undefined
}

/**
 * Partitioned archive relays (aux servers) configured via REVCDOS_RELAYS —
 * see parseRelaySources() for the format. Parsed once at module level so the
 * /api/archive/sources route can expose the routing map to the Service
 * Worker no matter which serving mode the archive itself runs in.
 */
const RELAY_SOURCES = parseRelaySources(resolveRelayConfig())

/** Relay partition map for clients (copy of the parsed env config). */
export function getRelaySources(): RelaySourceConfig[] {
  return RELAY_SOURCES.map((r) => ({ ...r }))
}

/**
 * Resolve the local archive path with fallbacks so the server also boots in
 * environments where the project directory is absent or read-only (e.g. a
 * published container with a different filesystem layout).
 */
function resolveArchivePath(): string {
  if (process.env.REVCDOS_ARCHIVE_PATH) return process.env.REVCDOS_ARCHIVE_PATH
  const candidates = [
    '/home/z/my-project/.revcdos-cache/revcdos.bin',
    `${process.cwd()}/.revcdos-cache/revcdos.bin`,
    '/tmp/revcdos-cache/revcdos.bin',
  ]
  for (const candidate of candidates) {
    try {
      mkdirSync(dirname(candidate), { recursive: true })
      return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return candidates[candidates.length - 1]
}

export const ARCHIVE_PATH = resolveArchivePath()

/**
 * Locate the bundled flat index (dumped by scripts/dump-archive-index.ts,
 * ~1.8 MB). It ships with the app under public/game/, so published
 * containers can serve archive files without holding the 1.08 GB archive.
 */
function resolveIndexPath(): string | null {
  if (process.env.REVCDOS_INDEX_PATH) return process.env.REVCDOS_INDEX_PATH
  const candidates = [
    `${process.cwd()}/public/game/revcdos-index.json`,
    '/home/z/my-project/public/game/revcdos-index.json',
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).size > 0) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Read just the `size` field of a flat index file (integrity checks). */
async function indexSize(indexPath: string): Promise<number> {
  try {
    const idx = JSON.parse(await readFile(indexPath, 'utf-8')) as { size?: number }
    return idx.size ?? 0
  } catch {
    return 0
  }
}

export type ArchiveState = 'idle' | 'downloading' | 'indexing' | 'ready' | 'error'

export type WarmPhase = 'idle' | 'pending' | 'downloading' | 'decompressing' | 'done' | 'error'

export interface WarmEntry {
  phase: WarmPhase
  /** Received raw (compressed) bytes — meaningful while phase='downloading'. */
  received: number
  total: number
  error?: string
}

export interface ArchiveStatus {
  state: ArchiveState
  /** 'local' = read off the local archive file; 'remote' = ranged reads from upstream. */
  mode?: 'local' | 'remote'
  downloaded: number
  total: number
  progress: number // 0..100
  files: number
  folders: number
  error?: string
  /** Server-side warm-up of the two engine files (remote mode). */
  warm?: { data: WarmEntry; wasm: WarmEntry }
  /** Partitioned relays configured via REVCDOS_RELAYS (aux servers). */
  relays?: Array<{ id: string; url: string; start: number; end: number }>
}

const status: ArchiveStatus = {
  state: 'idle',
  downloaded: 0,
  total: 0,
  progress: 0,
  files: 0,
  folders: 0,
}

/**
 * Singleton storage on globalThis — Turbopack dev re-instantiates modules per
 * route graph, so plain module state is NOT shared between route handlers.
 *
 * ARCHIVE_INSTANCE_VERSION guards against a subtler dev-mode trap: after a
 * hot reload the NEW module code must not keep using a PackedArchive instance
 * created by the OLD module (whose class shape may lack new methods). Bump
 * this constant whenever PackedArchive's public API changes.
 */
const ARCHIVE_INSTANCE_VERSION = 4

interface ArchiveGlobal {
  archive?: ArchiveSource | null
  initPromise?: Promise<ArchiveSource> | null
  status?: ArchiveStatus
  version?: number
  warm?: Map<string, WarmEntry>
  warmStarted?: boolean
}
const g = globalThis as typeof globalThis & { __revcdosArchive?: ArchiveGlobal }
if (!g.__revcdosArchive) {
  g.__revcdosArchive = {
    archive: null,
    initPromise: null,
    status,
    version: ARCHIVE_INSTANCE_VERSION,
    warm: new Map(),
    warmStarted: false,
  }
}

/** The two engine files the launcher downloads in ranged chunks. */
const WARM_DATA_PATH = 'vcbr/vc-sky-en-v6.data.br'
const WARM_WASM_PATH = 'vcbr/vc-sky-en-v6.wasm.br'

function warmEntry(path: string): WarmEntry {
  const store = g.__revcdosArchive!
  if (!store.warm) store.warm = new Map()
  let e = store.warm.get(path)
  if (!e) {
    e = { phase: 'idle', received: 0, total: 0 }
    store.warm.set(path, e)
  }
  return e
}

function touchWarmPhase(path: string, phase: WarmPhase): void {
  const e = g.__revcdosArchive?.warm?.get(path)
  if (e && e.phase !== 'done' && e.phase !== 'error') e.phase = phase
}

function snapshotWarm(): { data: WarmEntry; wasm: WarmEntry } | undefined {
  const store = g.__revcdosArchive
  if (!store?.warm) return undefined
  return {
    data: { ...store.warm.get(WARM_DATA_PATH) ?? { phase: 'idle', received: 0, total: 0 } },
    wasm: { ...store.warm.get(WARM_WASM_PATH) ?? { phase: 'idle', received: 0, total: 0 } },
  }
}

export function getArchiveStatus(): ArchiveStatus {
  const s = g.__revcdosArchive?.status
  if (s) {
    const out: ArchiveStatus = { ...s, warm: snapshotWarm() }
    if (RELAY_SOURCES.length > 0) {
      out.relays = RELAY_SOURCES.map((r) => ({ id: r.id, url: r.url, start: r.start, end: r.end }))
    }
    return out
  }
  return status
}

function setStatus(patch: Partial<ArchiveStatus>): void {
  const s = g.__revcdosArchive?.status ?? status
  Object.assign(s, patch)
}

/** Get (and lazily initialize) the archive. Concurrent callers share one promise. */
export function getArchive(): Promise<ArchiveSource> {
  const store = g.__revcdosArchive!
  // Hot-reload guard: drop instances created by an older module shape.
  if (store.archive && store.version !== ARCHIVE_INSTANCE_VERSION) {
    const stale = store.archive
    store.archive = null
    store.initPromise = null
    store.version = ARCHIVE_INSTANCE_VERSION
    // Plain Uint8Array cache entries stay valid across reloads, but drop any
    // in-flight materialisations started against the stale instance.
    const mstore = mg.__revcdosMaterialized
    if (mstore) mstore.inflight.clear()
    stale.close().catch(() => {})
    console.log('[archive] module reloaded — rebuilding archive instance')
  }
  if (!store.version) store.version = ARCHIVE_INSTANCE_VERSION
  if (!store.initPromise) {
    store.initPromise = init().catch((err) => {
      // Allow a later retry after a failed initialization.
      store.initPromise = null
      const s = store.status!
      s.state = 'error'
      s.error = err instanceof Error ? err.message : String(err)
      throw err
    })
  }
  return store.initPromise
}

/** Fire-and-forget preparation (used by instrumentation + landing page). */
export function prepareArchive(): void {
  getArchive()
    .then(() => warmArchive())
    .catch((err) => {
      console.error('[archive] preparation failed:', err)
    })
}

/**
 * Warm up the two engine files (data + wasm) in the background so the first
 * player click does not pay the upstream fetch latency. Idempotent: the
 * materialisation cache + inflight dedup make repeated calls free. Safe in
 * both local (disk read, fast) and remote (upstream ranged read) modes.
 */
export function warmArchive(): void {
  const store = g.__revcdosArchive!
  getArchive()
    .then((arc) => {
      for (const path of [WARM_DATA_PATH, WARM_WASM_PATH]) {
        const w = warmEntry(path)
        if (
          w.phase === 'done' ||
          w.phase === 'error' ||
          w.phase === 'downloading' ||
          w.phase === 'decompressing' ||
          w.phase === 'pending'
        ) {
          continue
        }
        w.phase = 'pending'
        w.received = 0
        w.total = 0
        w.error = undefined
        getMaterialized(arc, path)
          .then(() => {
            w.phase = 'done'
          })
          .catch((err: unknown) => {
            w.phase = 'error'
            w.error = err instanceof Error ? err.message : String(err)
            console.error(`[archive] warm-up failed for ${path}:`, w.error)
          })
      }
    })
    .catch((err) => {
      console.error('[archive] warm-up could not start:', err)
    })
}

async function fileSize(path: string): Promise<number> {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function finishReady(arc: ArchiveSource, mode: 'local' | 'remote', s: ArchiveStatus): ArchiveSource {
  s.state = 'ready'
  s.mode = mode
  s.files = arc.stats.files
  s.folders = arc.stats.folders
  s.total = arc.stats.archiveSize
  s.progress = 100
  s.downloaded = mode === 'local' ? arc.stats.archiveSize : 0
  s.error = undefined
  g.__revcdosArchive!.archive = arc
  console.log(
    `[archive] ready (${mode}): ${s.files} files, ${s.folders} folders, ${(arc.stats.archiveSize / 1024 / 1024).toFixed(1)} MB`,
  )
  return arc
}

async function init(): Promise<ArchiveSource> {
  console.log('[archive] init: starting')
  const s = g.__revcdosArchive!.status!
  const indexPath = resolveIndexPath()

  // ---- Mode A: complete local archive (dev sandbox / persistent volume) ----
  // A partial leftover (e.g. a download truncated by a storage quota) must
  // never be treated as complete, so verify against the bundled index size.
  const localSize = await fileSize(ARCHIVE_PATH)
  if (localSize > 0) {
    const expected = indexPath ? await indexSize(indexPath) : 0
    if (expected === 0 || localSize === expected) {
      s.state = 'indexing'
      s.total = localSize
      s.downloaded = localSize
      s.progress = 100
      const arc = new PackedArchive(ARCHIVE_PATH)
      await arc.init()
      return finishReady(arc, 'local', s)
    }
    console.warn(
      `[archive] init: local file is partial (${localSize}/${expected}) — not usable in local mode`,
    )
  }

  // ---- Mode B: explicit download request (REVCDOS_DOWNLOAD=1) ----
  // Legacy behaviour for hosts with ample disk that want zero upstream
  // latency: fetch the full archive with resume support, then go local.
  if (process.env.REVCDOS_DOWNLOAD === '1') {
    await mkdir(dirname(ARCHIVE_PATH), { recursive: true })
    const idxSz = indexPath ? await indexSize(indexPath) : 0
    s.total = idxSz > 0 ? idxSz : await probeRemoteSize()
    console.log(`[archive] init: expected total ${s.total}`)

    for (let attempt = 1; ; attempt++) {
      const local = await fileSize(ARCHIVE_PATH)
      const total = s.total

      if (local >= total && total > 0) break
      if (local > 0 && local < total) {
        if (!(await remoteSupportsRange())) {
          await import('node:fs/promises').then((fsp) => fsp.rm(ARCHIVE_PATH, { force: true }))
        }
      }

      s.state = 'downloading'
      s.mode = undefined
      s.downloaded = local
      s.progress = total > 0 ? Math.floor((local / total) * 100) : 0

      try {
        await downloadWithResume(local, total)
      } catch (err) {
        if (attempt >= 10) throw err
        console.error(`[archive] download attempt ${attempt} failed, retrying:`, err)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    s.state = 'indexing'
    s.downloaded = await fileSize(ARCHIVE_PATH)
    s.progress = 100
    const arc = new PackedArchive(ARCHIVE_PATH)
    await arc.init()
    return finishReady(arc, 'local', s)
  }

  // ---- Mode C (default): remote ranged reads — zero disk, zero boot traffic ----
  // Small published containers cannot hold the 1.08 GB archive; instead every
  // asset request fetches just its byte range from upstream (with a raw-bytes
  // LRU so hot files are shared across players).
  if (!indexPath) {
    throw new Error(
      'No local archive and no bundled index (public/game/revcdos-index.json); set REVCDOS_DOWNLOAD=1 to download the archive at boot',
    )
  }
  s.state = 'indexing'
  const arc = new RemoteArchive(
    indexPath,
    ARCHIVE_URL,
    (path, received, total) => {
      const w = g.__revcdosArchive?.warm?.get(path)
      if (w && w.phase !== 'done' && w.phase !== 'error') {
        w.phase = 'downloading'
        w.received = received
        w.total = total
      }
    },
    RELAY_SOURCES,
  )
  await arc.init()
  return finishReady(arc, 'remote', s)
}

async function probeRemoteSize(): Promise<number> {
  // A Range GET (rather than HEAD) survives CDN header normalization and
  // reports the total size via Content-Range. The 206 body is a single byte
  // (safe tiny drain); a 200 answer means the upstream is ignoring Range —
  // discard BOUNDED via discardBody (an arrayBuffer() drain would buffer
  // the full 1.08 GB archive and OOM small containers).
  const res = await fetch(ARCHIVE_URL, {
    headers: { Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok && res.status !== 206) {
    throw new Error(`Probe ${ARCHIVE_URL} -> ${res.status}`)
  }
  if (res.status === 206) {
    const contentRange = res.headers.get('content-range') ?? ''
    const total = Number(contentRange.split('/')[1] ?? 0)
    await res.arrayBuffer().catch(() => {})
    if (total > 0) return total
  } else {
    // 200 full-body on a ranged probe — Range is (currently) ignored.
    await discardBody(res)
  }
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > 1) return len
  throw new Error('Remote archive size unknown')
}

async function remoteSupportsRange(): Promise<boolean> {
  try {
    const res = await fetch(ARCHIVE_URL, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(30_000),
    })
    const ok = res.status === 206
    if (ok) {
      // 1-byte body — tiny drain is safe.
      await res.arrayBuffer().catch(() => {})
    } else {
      // 200 full-body — discard BOUNDED (never arrayBuffer: OOM).
      await discardBody(res)
    }
    return ok
  } catch {
    return false
  }
}

async function downloadWithResume(from: number, _total: number): Promise<void> {
  // NOTE: do NOT set Accept-Encoding: identity — the CDN ignores Range
  // headers for identity requests. undici's default works (206 responses).
  const headers: Record<string, string> = {}
  if (from > 0) headers.Range = `bytes=${from}-`

  const res = await fetch(ARCHIVE_URL, {
    headers,
    signal: AbortSignal.timeout(3_600_000),
  })
  if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed: HTTP ${res.status}`)
  }
  let startOffset = from
  if (from > 0 && res.status !== 206) {
    // Server ignored the Range header; restart from zero.
    startOffset = 0
  }

  if (!res.body) throw new Error('Empty download body')

  const ws = createWriteStream(ARCHIVE_PATH, { flags: startOffset > 0 ? 'a' : 'w' })
  await pipeTo(res.body as unknown as ReadableStream<Uint8Array>, ws, startOffset)
}

async function pipeTo(
  body: ReadableStream<Uint8Array>,
  ws: import('node:fs').WriteStream,
  startOffset: number,
): Promise<void> {
  const reader = body.getReader()
  let received = startOffset
  const s = g.__revcdosArchive!.status!
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      ws.write(chunk, (err) => (err ? reject(err) : resolve()))
    })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await write(Buffer.from(value))
      received += value.length
      s.downloaded = received
      if (s.total > 0) {
        s.progress = Math.min(100, Math.floor((received / s.total) * 100))
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.end(() => resolve())
    })
  } finally {
    reader.releaseLock()
  }
}

/**
 * Materialised (decompressed) view of archive files for ranged serving.
 *
 * Two backing stores, chosen per file:
 *  - MEMORY LRU (small files): stream-decompressed once on first request,
 *    kept capped at MAX_MATERIALIZED_BYTES.
 *  - DISK materialisation (large engine files, remote backend): the ~135 MB
 *    decompressed package is streamed to <dir>/<escaped>.tmp and renamed into
 *    place; ranged requests then slice it with createReadStream — bounded RAM
 *    in ANY container. Guards against the OOM that killed small published
 *    containers (gateway 502 → unresponsive site) when the whole package,
 *    its compressed raw form and the assembly copy were all held in memory.
 */
const LOW_MEMORY = isLowMemoryEnvironment()
const MAX_MATERIALIZED_BYTES = LOW_MEMORY ? 24 * 1024 * 1024 : 192 * 1024 * 1024
/** Free disk bytes required before enabling disk materialisation. */
const DISK_MAT_MIN_FREE = 160 * 1024 * 1024

type MaterializedRef =
  | { kind: 'mem'; buf: Uint8Array }
  | { kind: 'disk'; filePath: string; size: number }

interface MaterializedGlobal {
  lru: Map<string, Uint8Array>
  disk: Map<string, { filePath: string; size: number }>
  inflight: Map<string, Promise<MaterializedRef>>
}

const mg = globalThis as typeof globalThis & { __revcdosMaterialized?: MaterializedGlobal }
if (!mg.__revcdosMaterialized) {
  mg.__revcdosMaterialized = { lru: new Map(), disk: new Map(), inflight: new Map() }
}

function matFileName(entryPath: string): string {
  return entryPath.replace(/[^a-zA-Z0-9._-]+/g, '__')
}

interface DiskMatDirGlobal {
  resolved?: string | null
}
const dg = globalThis as typeof globalThis & { __revcdosMatDir?: DiskMatDirGlobal }

function diskFreeBytes(dir: string): number {
  try {
    const fs = require('node:fs') as typeof import('node:fs') & {
      statfsSync?: (p: string) => { bavail: number; bsize: number }
    }
    if (typeof fs.statfsSync !== 'function') return Infinity
    const st = fs.statfsSync(dir)
    const free = Number(st.bavail) * Number(st.bsize)
    return Number.isFinite(free) && free > 0 ? free : Infinity
  } catch {
    return Infinity
  }
}

/**
 * Resolve the disk-materialisation directory (once per process): prefer
 * <cwd>/.revcdos-mat, fall back to /tmp/revcdos-mat. Returns null when no
 * candidate can guarantee the min free budget — LOW_MEMORY environments then
 * refuse large-file requests instead of OOM-ing (see materialize).
 */
function resolveMatDir(): string | null {
  const store = dg.__revcdosMatDir ?? (dg.__revcdosMatDir = {})
  if (store.resolved !== undefined) return store.resolved
  const candidates = [`${process.cwd()}/.revcdos-mat`, '/tmp/revcdos-mat']
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const free = diskFreeBytes(dir)
      if (free !== Infinity && free < DISK_MAT_MIN_FREE) continue
      store.resolved = dir
      const memLimit = detectContainerMemoryLimit()
      console.log(
        `[archive] disk materialisation dir: ${dir} (free ${(free / 1048576).toFixed(0)} MiB, ` +
          `memory limit ${memLimit > 0 ? `${(memLimit / 1048576).toFixed(0)} MiB` : 'unknown'})`,
      )
      return dir
    } catch {
      /* try next candidate */
    }
  }
  store.resolved = null
  console.warn(
    '[archive] disk materialisation unavailable — large files will be refused in low-memory mode',
  )
  return null
}

function getMaterialized(arc: ArchiveSource, entryPath: string): Promise<MaterializedRef> {
  const store = mg.__revcdosMaterialized!
  const cached = store.lru.get(entryPath)
  if (cached) {
    // Refresh LRU recency.
    store.lru.delete(entryPath)
    store.lru.set(entryPath, cached)
    return Promise.resolve({ kind: 'mem', buf: cached })
  }
  const diskEntry = store.disk.get(entryPath)
  if (diskEntry) {
    try {
      if (statSync(diskEntry.filePath).size === diskEntry.size) {
        return Promise.resolve({ kind: 'disk', ...diskEntry })
      }
      console.warn(
        `[archive] disk materialised file size mismatch for ${entryPath} — rematerialising`,
      )
    } catch {
      /* file vanished — rematerialise */
    }
    store.disk.delete(entryPath)
  }
  let inflight = store.inflight.get(entryPath)
  if (!inflight) {
    inflight = materialize(arc, entryPath, store)
    store.inflight.set(entryPath, inflight)
    inflight
      .catch(() => {})
      .finally(() => {
        store.inflight.delete(entryPath)
      })
      .catch(() => {})
  }
  return inflight
}

async function materialize(
  arc: ArchiveSource,
  entryPath: string,
  store: MaterializedGlobal,
): Promise<MaterializedRef> {
  const stream = arc.streamDecompressed(entryPath)
  if (!stream) throw new Error(`File not found: ${entryPath}`)

  // ---- Disk path: large engine files (OOM guard for published containers) ----
  if (arc.wantsDiskMaterialization?.(entryPath) === true) {
    const dir = resolveMatDir()
    if (dir) {
      const ref = await materializeToDisk(stream, entryPath, dir)
      store.disk.set(entryPath, { filePath: ref.filePath, size: ref.size })
      return { kind: 'disk', ...ref }
    }
    if (LOW_MEMORY) {
      // Refusing beats OOM-killing the whole container (observed as gateway
      // 502s followed by an unresponsive site on small published containers).
      throw new Error(
        `file ${entryPath} requires disk materialisation but no usable cache dir exists (low-memory mode)`,
      )
    }
    // Ample-RAM environment without a disk dir: fall through to memory.
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let warmTouched = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (!warmTouched) {
      warmTouched = true
      // Raw bytes are in (raw fetch resolves before decompression starts for
      // the remote backend) — the decompression pass is running now.
      touchWarmPhase(entryPath, 'decompressing')
    }
  }
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  store.lru.set(entryPath, out)
  // Evict least-recently-used entries while over the budget (never the file
  // that was just materialised — it is the most recent one).
  let used = 0
  for (const buf of store.lru.values()) used += buf.length
  while (used > MAX_MATERIALIZED_BYTES && store.lru.size > 1) {
    const oldest = store.lru.keys().next().value
    if (oldest === undefined) break
    const buf = store.lru.get(oldest)
    store.lru.delete(oldest)
    used -= buf ? buf.length : 0
  }
  return { kind: 'mem', buf: out }
}

/**
 * Stream-decompress a large archive entry straight to a cache file
 * (tmp + atomic rename), never holding more than a few pipe buffers of RAM.
 */
async function materializeToDisk(
  stream: ReadableStream<Uint8Array>,
  entryPath: string,
  dir: string,
): Promise<{ filePath: string; size: number }> {
  const reader = stream.getReader()
  const target = join(dir, matFileName(entryPath))
  const tmp = `${target}.tmp`
  const ws = createWriteStream(tmp, { flags: 'w' })
  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      ws.write(chunk as unknown as Buffer, (err) => (err ? reject(err) : resolve()))
    })
  let total = 0
  let warmTouched = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        await write(value)
        total += value.length
      }
      if (!warmTouched) {
        warmTouched = true
        touchWarmPhase(entryPath, 'decompressing')
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.end(() => resolve())
    })
  } catch (err) {
    reader.cancel().catch(() => {})
    try {
      ws.destroy()
    } catch {
      /* already closed */
    }
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best effort */
    }
    throw err
  }
  renameSync(tmp, target)
  console.log(
    `[archive] materialised to disk: ${entryPath} → ${target} (${(total / 1048576).toFixed(1)} MiB)`,
  )
  return { filePath: target, size: total }
}

/**
 * Serve helper shared by /vcsky and /vcbr route handlers.
 *
 * Response modes:
 *   1. `Range: bytes=…` → 206 slices of the DECOMPRESSED content, served from
 *      a bounded LRU materialisation cache (decompressed once per file).
 *      Clients assemble chunks of the final content — every response is
 *      small enough for any intermediary (CDN / function-compute edge) to
 *      carry, and each chunk is independently retryable.
 *   2. `Accept-Encoding: br` → 200 passthrough of the stored brotli bytes
 *      (streamed straight off disk, near-zero memory).
 *   3. otherwise → 200 STREAMING server-side decompression (bounded memory,
 *      a few pipe buffers) instead of the previous whole-file sync
 *      `brotliDecompressSync` which spiked ~600 MB RSS for the 60 MB data
 *      package and could OOM the container.
 */
export async function serveFromArchive(
  entryPath: string,
  request: Request,
): Promise<Response> {
  let arc: ArchiveSource
  try {
    arc = await getArchive()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(`Archive unavailable: ${message}`, { status: 503 })
  }

  const entry = arc.resolve(entryPath)
  if (!entry) {
    return new Response(`File not found in archive: ${entryPath}`, { status: 404 })
  }

  const mediaType = getMediaType(entryPath)
  const isHead = request.method === 'HEAD'

  const baseHeaders: Record<string, string> = {
    'Content-Type': mediaType,
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
    'X-ReVCDOS-Source': 'packed-archive',
    // Match the upstream reVCDOS response headers.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  }

  // ---- Mode 1: HTTP Range → slices of the DECOMPRESSED content, 206 ----
  // The first ranged request materialises (stream-decompresses) the file once
  // into a bounded LRU cache; subsequent chunks are served as instant slices
  // of the final content, so every response is small enough for any proxy to
  // carry, works in every browser (no client-side decompression needed) and
  // is individually retryable — the properties that make the chunked game
  // download resilient against edges that truncate long streams.
  const rangeHeader = request.headers.get('range')
  if (rangeHeader) {
    let ref: MaterializedRef
    try {
      ref = await getMaterialized(arc, entryPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`Failed to prepare file: ${message}`, { status: 500 })
    }
    const totalLen = ref.kind === 'mem' ? ref.buf.length : ref.size
    const range = parseRange(rangeHeader, totalLen)
    if (!range) {
      const headers = new Headers({
        ...baseHeaders,
        'Cache-Control': 'no-store',
        'Content-Range': `bytes */${totalLen}`,
      })
      return new Response(null, { status: 416, headers })
    }
    const [start, end] = range
    const length = end - start + 1
    const headers = new Headers({
      ...baseHeaders,
      // Partial responses must not be cached by shared intermediaries —
      // they are reassembled by the client and cached via the Cache API.
      'Cache-Control': 'no-store',
      'Content-Range': `bytes ${start}-${end}/${totalLen}`,
      'Content-Length': String(length),
    })
    if (isHead) return new Response(null, { status: 206, headers })
    if (ref.kind === 'mem') {
      return new Response(ref.buf.subarray(start, end + 1) as unknown as BodyInit, {
        status: 206,
        headers,
      })
    }
    // Disk-backed slice: stream straight off the materialised cache file —
    // memory usage is a couple of pipe buffers regardless of file size.
    try {
      const nodeStream = createReadStream(ref.filePath, { start, end })
      const body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
      return new Response(body as unknown as BodyInit, { status: 206, headers })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`Failed to read materialised file: ${message}`, { status: 500 })
    }
  }

  // ---- Mode 2: brotli passthrough ----
  const acceptEncoding = (request.headers.get('accept-encoding') ?? '').toLowerCase()
  const acceptsBr = acceptEncoding.includes('br')
  if (acceptsBr) {
    const headers = new Headers({
      ...baseHeaders,
      'Content-Encoding': 'br',
      'Content-Length': String(entry.compressedSize),
    })
    if (isHead) return new Response(null, { status: 200, headers })
    const stream = arc.streamRaw(entryPath)
    if (!stream) return new Response('File not found', { status: 404 })
    return new Response(stream, { status: 200, headers })
  }

  // ---- Mode 3: streaming decompression (bounded memory) ----
  if (isHead) {
    const headers = new Headers({ ...baseHeaders })
    return new Response(null, { status: 200, headers })
  }
  const decompressed = await acquireDecompressSlot(arc, entryPath)
  if (decompressed === null) return new Response('File not found', { status: 404 })
  // No Content-Length (chunked transfer) — the decompressed size is unknown
  // upfront and materialising it would defeat the bounded-memory goal.
  const headers = new Headers({ ...baseHeaders })
  return new Response(decompressed, { status: 200, headers })
}

/**
 * Cap concurrent streaming decompressions so a burst of requests from a
 * proxy that strips Accept-Encoding cannot fan out into unbounded memory.
 */
const MAX_CONCURRENT_DECOMPRESS = 12
let activeDecompress = 0
const decompressQueue: (() => void)[] = []

async function acquireDecompressSlot(
  arc: ArchiveSource,
  entryPath: string,
): Promise<ReadableStream<Uint8Array> | null> {
  if (activeDecompress >= MAX_CONCURRENT_DECOMPRESS) {
    await new Promise<void>((resolve) => decompressQueue.push(resolve))
  }
  activeDecompress++
  const stream = arc.streamDecompressed(entryPath)
  if (!stream) {
    activeDecompress--
    const next = decompressQueue.shift()
    if (next) next()
    return null
  }
  const reader = stream.getReader()
  const release = () => {
    activeDecompress--
    const next = decompressQueue.shift()
    if (next) next()
  }
  // Release the slot when the stream finishes OR errors OR is cancelled.
  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = (): Promise<void> =>
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              release()
              controller.close()
              return
            }
            controller.enqueue(value)
            return pump()
          })
          .catch((err: unknown) => {
            release()
            try {
              controller.error(err)
            } catch {
              /* already closed */
            }
          })
      pump()
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return wrapped
}

/** Parse a single-range `bytes=` header against a resource of `size` bytes. */
function parseRange(
  header: string,
  size: number,
): [start: number, end: number] | null {
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header)
  if (!match) return null
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return null
  let start: number
  let end: number
  if (startStr === '') {
    // suffix-length form: bytes=-N → last N bytes
    const suffix = Number(endStr)
    if (suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startStr)
    end = endStr === '' ? size - 1 : Number(endStr)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null
  }
  if (start >= size) return null // unsatisfiable
  end = Math.min(end, size - 1)
  return [start, end]
}

function getMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.wasm.br')) return 'application/wasm'
  if (lower.endsWith('.js.br')) return 'application/javascript'
  if (lower.endsWith('.json.br')) return 'application/json'
  if (lower.endsWith('.html.br')) return 'text/html'
  if (lower.endsWith('.css.br')) return 'text/css'
  if (lower.endsWith('.br')) return 'application/octet-stream'
  if (lower.endsWith('.wasm')) return 'application/wasm'
  if (lower.endsWith('.js')) return 'application/javascript'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.html')) return 'text/html'
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.ini')) return 'text/plain'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}
