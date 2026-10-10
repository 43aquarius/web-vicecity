#!/usr/bin/env node
/**
 * web-vicecity archive relay — partitioned range server for revcdos.bin
 * =====================================================================
 *
 * Serves ONE byte partition of the 1.08 GB packed GTA: Vice City archive
 * (https://folder.morgen.qzz.io/revcdos.bin) with:
 *
 *   - Zero dependencies (plain Node.js 18+, uses global fetch + streams)
 *   - First-boot auto-seeding: downloads its partition to data/part.bin
 *     (~361 MB, resumable, 8 MB chunks) — fits a ~400 MB disk quota
 *   - Standard HTTP Range semantics with GLOBAL archive coordinates
 *     (clients split requests per partition; this relay translates
 *     global → local slice offsets and streams from disk)
 *   - CORS open (Access-Control-Allow-Origin: *) so browsers can fetch
 *     directly from the Service Worker
 *   - Optional out-of-partition LIVE proxy fallback to upstream
 *   - /healthz JSON status + a human status page at /
 *
 * Configuration: config.json in this directory (branch-specific defaults,
 * e.g. {"id":"relay-a","partStart":0,"partEnd":361454906}) — every value
 * can be overridden via environment variables:
 *
 *   RELAY_ID        relay identifier (default from config.json)
 *   PART_START      partition start byte, inclusive   (default config.json)
 *   PART_END        partition end byte, EXCLUSIVE     (default config.json)
 *   ARCHIVE_URL     upstream archive (default https://folder.morgen.qzz.io/revcdos.bin)
 *   DATA_DIR        where part.bin lives (default ./data)
 *   PORT            listen port (default 8787)
 *   HOST            bind host (default 0.0.0.0)
 *   LIVE_FALLBACK   1 = serve out-of-partition ranges from upstream (default 1)
 *   RELAY_TOKEN     optional shared secret; if set, /revcdos.bin requires
 *                   ?token=... or X-Relay-Token header
 *   MAX_LIVE_CONC   max concurrent live-proxy requests (default 8)
 *   SEED_CHUNK      seed chunk size in bytes (default 8 MiB)
 *
 * CLI:
 *   node server.js            start serving (auto-seeds in background)
 *   node server.js --seed     only seed the partition, then exit
 *   node server.js --status   print health JSON, exit
 */

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { timingSafeEqual } = require('node:crypto')
const { Readable } = require('node:stream')

// ---------------------------------------------------------------- config ----

function loadConfig() {
  let file = {}
  const cfgPath = path.join(__dirname, 'config.json')
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  } catch {
    /* no config.json — env only */
  }
  const env = process.env
  const cfg = {
    id: env.RELAY_ID || file.id || 'relay',
    partStart: num(env.PART_START ?? file.partStart),
    partEnd: num(env.PART_END ?? file.partEnd),
    archiveUrl: env.ARCHIVE_URL || file.archiveUrl || 'https://folder.morgen.qzz.io/revcdos.bin',
    archiveTotal: num(env.ARCHIVE_TOTAL ?? file.archiveTotal ?? 1084364719),
    dataDir: env.DATA_DIR || file.dataDir || path.join(__dirname, 'data'),
    port: num(env.PORT ?? file.port ?? 8787),
    host: env.HOST || file.host || '0.0.0.0',
    liveFallback: (env.LIVE_FALLBACK ?? file.liveFallback ?? '1') !== '0',
    relayToken: env.RELAY_TOKEN || file.relayToken || '',
    maxLiveConc: num(env.MAX_LIVE_CONC ?? file.maxLiveConc ?? 8),
    seedChunk: num(env.SEED_CHUNK ?? file.seedChunk ?? 8 * 1024 * 1024),
  }
  if (!Number.isFinite(cfg.partStart) || !Number.isFinite(cfg.partEnd) || cfg.partEnd <= cfg.partStart) {
    console.error(
      '[relay] FATAL: invalid partition — set config.json or PART_START/PART_END ' +
        `(got [${cfg.partStart}, ${cfg.partEnd}))`,
    )
    process.exit(1)
  }
  if (cfg.archiveTotal <= 0) cfg.archiveTotal = 1084364719
  return cfg
}

function num(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const CFG = loadConfig()
const PART_SIZE = CFG.partEnd - CFG.partStart
const PART_FILE = path.join(CFG.dataDir, 'part.bin')
const TMP_FILE = PART_FILE + '.tmp'

// ------------------------------------------------------------- runtime ----

const startedAt = Date.now()
/** Bytes of the partition already on disk (part.bin or seeded prefix of .tmp). */
let seededBytes = 0
/** 'seeding' | 'ready' | 'error' ('error' + liveFallback still SERVES via live proxy) */
let seedState = 'seeding'
let seedError = ''
/** Archive total size: config default (known), refined by the upstream probe. */
let archiveTotal = CFG.archiveTotal
let stats = { requests: 0, bytesServed: 0, liveServed: 0, rangeServed: 0, rejected: 0 }

function health() {
  return {
    // ok = the relay can serve archive requests right now: either the local
    // disk cache is complete, or seeding aborted but live fallback is on.
    ok: seedState === 'ready' || (CFG.liveFallback && seedState === 'error'),
    id: CFG.id,
    relay: 'web-vicecity',
    part: { start: CFG.partStart, end: CFG.partEnd, size: PART_SIZE },
    ready: seedState === 'ready',
    state: seedState,
    seeded: seededBytes,
    progress: PART_SIZE > 0 ? Math.round((seededBytes / PART_SIZE) * 1000) / 10 : 0,
    seedError: seedError || undefined,
    liveFallback: CFG.liveFallback,
    archiveUrl: CFG.archiveUrl,
    archiveTotal: archiveTotal > 0 ? archiveTotal : undefined,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    tokenRequired: Boolean(CFG.relayToken),
    served: stats,
  }
}

// ------------------------------------------------------------ CORS/util ----

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, X-Relay-Token')
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, Content-Length, Accept-Ranges, X-Relay-Id, X-Relay-Partition, X-Relay-Source',
  )
}

function relayHeaders(res, source) {
  res.setHeader('X-Relay-Id', CFG.id)
  res.setHeader('X-Relay-Partition', `${CFG.partStart}-${CFG.partEnd}`)
  if (source) res.setHeader('X-Relay-Source', source)
}

/**
 * Parse a single-range Range header. Returns {start, end} (inclusive,
 * GLOBAL archive coordinates), {invalid:true}, or null when absent.
 */
function parseRange(header) {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d+)-(\d*)\s*$/.exec(header)
  if (!m) return { invalid: true }
  const start = Number(m[1])
  const end = m[2] === '' ? NaN : Number(m[2])
  return { start, end }
}

function authorized(url, req) {
  if (!CFG.relayToken) return true
  const q = url.searchParams.get('token') || ''
  const h = req.headers['x-relay-token'] || ''
  const a = Buffer.from(String(q))
  const b = Buffer.from(String(h))
  const tok = Buffer.from(CFG.relayToken)
  return (
    (a.length === tok.length && timingSafeEqual(a, tok)) ||
    (b.length === tok.length && timingSafeEqual(b, tok))
  )
}

// ----------------------------------------------------------- live proxy ----

let liveActive = 0
const liveQueue = []
async function withLiveSlot(fn) {
  if (liveActive >= CFG.maxLiveConc) {
    await new Promise((resolve) => liveQueue.push(resolve))
  }
  liveActive++
  try {
    return await fn()
  } finally {
    liveActive--
    const next = liveQueue.shift()
    if (next) next()
  }
}

/**
 * Proxy an arbitrary GLOBAL range straight from upstream (streamed, no
 * buffering). Used for out-of-partition requests when LIVE_FALLBACK=1 and
 * for ranges not yet seeded during the initial download.
 */
async function liveProxyRange(req, res, start, end) {
  await withLiveSlot(async () => {
    const rangeHdr = end >= 0 ? `bytes=${start}-${end}` : `bytes=${start}-`
    let upstream
    try {
      upstream = await fetch(CFG.archiveUrl, {
        headers: { Range: rangeHdr },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(600_000, 60_000 + (end - start + 1) * 5)),
      })
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`relay live fetch failed: ${err.message}`)
      return
    }
    if (upstream.status !== 206) {
      // Upstream ignored the Range header (some CDNs/edges do). NEVER pipe a
      // 200 full stream back to a ranged request — that would answer a
      // 100-byte ask with the whole 1.08 GB archive. Fail loudly instead so
      // callers fall back to another source.
      await upstream.body?.cancel().catch(() => {})
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        `relay live fetch failed: upstream returned HTTP ${upstream.status} ` +
          'for a Range request (Range header ignored upstream)',
      )
      return
    }
    const headers = {}
    for (const h of ['content-range', 'content-type', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h)
      if (v) headers[h] = v
    }
    if (!headers['content-type']) headers['content-type'] = 'application/octet-stream'
    headers['accept-ranges'] = 'bytes'
    res.writeHead(upstream.status, headers)
    stats.liveServed++
    if (req.method === 'HEAD') {
      await upstream.body?.cancel().catch(() => {})
      res.end()
      return
    }
    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body)
      nodeStream.on('error', () => res.destroy())
      nodeStream.pipe(res)
    } else {
      res.end()
    }
  })
}

// ------------------------------------------------------------- seeding ----

async function probeArchiveTotal() {
  try {
    const res = await fetch(CFG.archiveUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(30_000),
    })
    const cr = res.headers.get('content-range') || ''
    await res.arrayBuffer().catch(() => {})
    const total = Number(cr.split('/')[1] || 0)
    if (total > 0) {
      archiveTotal = total
      console.log(`[relay] upstream archive total: ${total} bytes`)
      if (CFG.partEnd > total) {
        console.error(`[relay] WARNING: partition end ${CFG.partEnd} exceeds archive total ${total}!`)
      }
    }
  } catch (err) {
    console.warn('[relay] total probe failed (will retry on first live use):', err.message)
  }
}

/** The file currently holding the seeded bytes: part.bin once complete,
 *  part.bin.tmp while seeding (or after an aborted seed — its prefix is
 *  still a valid local slice source). */
function seededFile() {
  return seedState === 'ready' ? PART_FILE : TMP_FILE
}

async function ensureDir() {
  await fsp.mkdir(CFG.dataDir, { recursive: true })
}

async function fileSafeSize(p) {
  try {
    return (await fsp.stat(p)).size
  } catch {
    return 0
  }
}

/**
 * Download the partition to part.bin with resume. Serving continues while
 * seeding (unseeded ranges fall back to live proxy).
 */
async function seedPartition() {
  seedState = 'seeding'
  await ensureDir()
  const finalSize = await fileSafeSize(PART_FILE)
  if (finalSize === PART_SIZE) {
    seededBytes = finalSize
    seedState = 'ready'
    console.log(`[relay] partition already complete: ${PART_SIZE} bytes`)
    return
  }

  // Disk pre-check: the full partition plus a write margin must be free,
  // otherwise seeding would fill the disk mid-download. When it fails we
  // stay in 'error' state and keep SERVING via the live proxy (still fully
  // functional, just uncached) instead of wrecking the host filesystem.
  try {
    const fsStats = await fsp.statfs(CFG.dataDir)
    const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize)
    const needBytes = PART_SIZE + 64 * 1024 * 1024
    if (freeBytes < needBytes) {
      seedState = 'error'
      seedError =
        `insufficient disk (${(freeBytes / 1048576).toFixed(0)} MiB free, ` +
        `need ~${(needBytes / 1048576).toFixed(0)} MiB) — serving via live proxy`
      console.error(`[relay] ${seedError}`)
      return
    }
  } catch {
    /* statfs unavailable on this platform — proceed optimistically */
  }

  if (finalSize > 0 && finalSize !== PART_SIZE) {
    console.warn('[relay] part.bin size mismatch — reseeding from scratch')
    await fsp.rm(PART_FILE, { force: true })
  }

  let done = await fileSafeSize(TMP_FILE)
  if (done > PART_SIZE) {
    await fsp.rm(TMP_FILE, { force: true })
    done = 0
  }
  seededBytes = done
  console.log(
    `[relay] seeding partition [${CFG.partStart}, ${CFG.partEnd}) (${PART_SIZE} bytes) — resume @ ${done}`,
  )

  const out = fs.createWriteStream(TMP_FILE, { flags: 'a' })
  let failures = 0
  while (done < PART_SIZE) {
    const want = Math.min(CFG.seedChunk, PART_SIZE - done)
    const absStart = CFG.partStart + done
    try {
      const res = await fetch(CFG.archiveUrl, {
        headers: { Range: `bytes=${absStart}-${absStart + want - 1}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(600_000, 120_000 + want * 5)),
      })
      if (res.status !== 206) {
        await res.arrayBuffer().catch(() => {})
        throw new Error(`upstream HTTP ${res.status} for seed range`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length !== want) throw new Error(`seed short read ${buf.length}/${want}`)
      await new Promise((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()))
      })
      done += want
      seededBytes = done
      failures = 0
      if (PART_SIZE - done < 64 * 1024 * 1024 || done % (64 * 1024 * 1024) < want) {
        console.log(`[relay] seed progress: ${(done / 1048576).toFixed(1)} / ${(PART_SIZE / 1048576).toFixed(1)} MiB`)
      }
    } catch (err) {
      failures++
      console.warn(`[relay] seed chunk failed (${failures}):`, err.message)
      if (failures >= 8) {
        seedState = 'error'
        seedError = err.message
        out.end()
        console.error('[relay] seed aborted — serving live; will NOT retry until restart')
        return
      }
      await new Promise((r) => setTimeout(r, 1000 * failures))
    }
  }
  out.end()
  await new Promise((resolve) => out.on('close', resolve))
  await fsp.rename(TMP_FILE, PART_FILE)
  seededBytes = PART_SIZE
  seedState = 'ready'
  console.log('[relay] seed complete — partition ready on disk')
}

// ------------------------------------------------------------ requests ----

function humanStatusPage() {
  const h = health()
  const pct = h.progress
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>web-vicecity relay · ${h.id}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#12071f;color:#eee;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:560px;padding:32px 36px;border:1px solid #ff419366;border-radius:16px;
background:#1b0d33;box-shadow:0 0 40px #ff419322}
h1{margin:0 0 4px;font-size:18px;color:#ff4193;letter-spacing:.2em;text-transform:uppercase}
table{margin-top:14px;border-collapse:collapse;width:100%}
td{padding:3px 8px;border-bottom:1px solid #ffffff14;font-size:13px}
td:first-child{color:#ff9ac0;white-space:nowrap}
code{color:#ffe08a}
.bar{margin-top:14px;height:12px;border:1px solid #ffffff55;border-radius:7px;overflow:hidden}
.bar>div{height:100%;background:linear-gradient(90deg,#ffe08a,#ff4193);width:${pct}%}
</style></head><body><div class="card">
<h1>Vice City Archive Relay</h1>
<div>${h.id} · 分区 [${h.part.start}, ${h.part.end}) · ${(h.part.size / 1048576).toFixed(1)} MiB</div>
<div class="bar"><div></div></div>
<table>
<tr><td>状态</td><td>${h.state === 'ready' ? '✅ 就绪' : h.state === 'seeding' ? '⏳ 预下载中 ' + pct + '%' : h.liveFallback ? '⚡ 实时代理模式（缓存不可用：' + (h.seedError || h.state) + '）' : '❌ ' + h.state + ' ' + (h.seedError || '')}</td></tr>
<tr><td>已缓存</td><td>${(h.seeded / 1048576).toFixed(1)} / ${(h.part.size / 1048576).toFixed(1)} MiB</td></tr>
<tr><td>回源兜底</td><td>${h.liveFallback ? '开启（分区外/未就绪请求实时代理上游）' : '关闭'}</td></tr>
<tr><td>鉴权</td><td>${h.tokenRequired ? '需要 token' : '开放（CORS *）'}</td></tr>
<tr><td>已服务</td><td>${h.served.requests} 请求 / ${(h.served.bytesServed / 1048576).toFixed(1)} MiB（实时回源 ${h.served.liveServed} 次）</td></tr>
<tr><td>运行时长</td><td>${h.uptimeSec} 秒</td></tr>
<tr><td>健康检查</td><td><code>GET /healthz</code></td></tr>
<tr><td>归档地址</td><td><code>GET /revcdos.bin</code>（支持 Range，全局坐标）</td></tr>
</table></div></body></html>`
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Serve the request's GLOBAL range from the local partition slice.
 * The caller has already verified [start, end] ⊆ [partStart, partEnd-1].
 */
function serveLocalSlice(req, res, start, end) {
  const len = end - start + 1
  const total = archiveTotal || CFG.partEnd
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(len),
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Cache-Control': 'public, max-age=86400',
  }
  res.writeHead(206, headers)
  stats.rangeServed++
  stats.bytesServed += len
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(seededFile(), { start: start - CFG.partStart, end: end - CFG.partStart })
  stream.on('error', (err) => {
    console.error('[relay] local read failed:', err.message)
    res.destroy()
  })
  stream.pipe(res)
}

const server = http.createServer(async (req, res) => {
  corsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' })
    res.end()
    return
  }

  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/healthz') {
    sendJson(res, 200, health())
    return
  }
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(humanStatusPage())
    return
  }

  const isArchivePath = p === '/revcdos.bin' || p === '/archive.bin' || p === '/bin'
  if (!isArchivePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found — try /revcdos.bin, /healthz')
    return
  }

  stats.requests++
  relayHeaders(res)

  if (!authorized(url, req)) {
    stats.rejected++
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('unauthorized: missing or wrong token')
    return
  }

  const range = parseRange(req.headers.range)
  if (range && range.invalid) {
    // Multi-range or malformed — refuse rather than dumping 361 MB.
    stats.rejected++
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('bad Range header (single range only: bytes=start-end)')
    return
  }

  // No Range: serve the whole partition slice (bounded by partition size).
  if (!range) {
    const localReady = seededBytes >= PART_SIZE
    if (localReady) {
      const total = archiveTotal || CFG.partEnd
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(PART_SIZE),
        'Accept-Ranges': 'bytes',
        'X-Relay-Source': 'local',
        'Cache-Control': 'public, max-age=86400',
      })
      stats.bytesServed += PART_SIZE
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      fs.createReadStream(PART_FILE).pipe(res)
      return
    }
    if (CFG.liveFallback) {
      relayHeaders(res, 'live')
      await liveProxyRange(req, res, CFG.partStart, CFG.partEnd - 1)
      return
    }
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`relay not seeded yet (${seededBytes}/${PART_SIZE}) and live fallback off`)
    return
  }

  let { start, end } = range
  if (!Number.isFinite(start) || start < 0) {
    stats.rejected++
    res.writeHead(400)
    res.end('invalid range start')
    return
  }
  if (!Number.isFinite(end)) {
    // "bytes=a-" → clamp to end of the partition (clients use explicit ends;
    // a true to-EOF read is out of this relay's scope by definition).
    end = CFG.partEnd - 1
  }

  const inPartition = start >= CFG.partStart && start < CFG.partEnd
  const endsWithin = end >= CFG.partStart && end < CFG.partEnd
  const crosses = inPartition && end >= CFG.partEnd
  const localReady = seededBytes >= PART_SIZE

  // Fully out of partition → live proxy (or 416).
  if (!inPartition) {
    if (CFG.liveFallback) {
      relayHeaders(res, 'live')
      await liveProxyRange(req, res, start, Number.isFinite(end) ? end : -1)
      return
    }
    res.writeHead(416, { 'Content-Range': `bytes */${archiveTotal || 'unknown'}` })
    res.end('range outside this relay partition and live fallback off')
    return
  }

  // Inside the partition and fully seeded → local slice (clamp if crossing).
  if (localReady) {
    const clampedEnd = Math.min(end, CFG.partEnd - 1)
    if (crosses) {
      // Range crosses into the next partition: serve our part with an exact
      // Content-Range so well-behaved clients can detect the short read and
      // fetch the tail elsewhere. (Our own integrators always pre-split.)
      relayHeaders(res, 'local-partial')
      serveLocalSlice(req, res, start, clampedEnd)
      return
    }
    if (endsWithin) {
      relayHeaders(res, 'local')
      serveLocalSlice(req, res, start, end)
      return
    }
  }

  // Seeded prefix fully covers the range → local slice (from part.bin once
  // complete, or the growing part.bin.tmp while seeding).
  if (end < CFG.partStart + seededBytes) {
    relayHeaders(res, 'local')
    serveLocalSlice(req, res, start, Math.min(end, CFG.partStart + seededBytes - 1))
    return
  }

  // Not locally available (seeding in progress, or seeding impossible —
  // e.g. insufficient disk) → live proxy this range from upstream, so the
  // relay keeps serving correct 206s in EVERY state, not just while a
  // first seed download runs.
  if (CFG.liveFallback) {
    relayHeaders(res, seedState === 'seeding' ? 'live-while-seeding' : 'live-unseeded')
    await liveProxyRange(req, res, start, end)
    return
  }

  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(
    `not seeded to this offset yet (${seededBytes}/${PART_SIZE}) and live fallback off; retry later`,
  )
})

// ----------------------------------------------------------------- main ----

async function main() {
  const mode = process.argv[2] || ''
  console.log(
    `[relay] ${CFG.id}: partition [${CFG.partStart}, ${CFG.partEnd}) = ${(PART_SIZE / 1048576).toFixed(1)} MiB, live=${CFG.liveFallback}, token=${CFG.relayToken ? 'on' : 'off'}`,
  )
  await ensureDir()

  if (mode === '--status') {
    await probeArchiveTotal()
    console.log(JSON.stringify(health(), null, 2))
    return
  }

  if (mode === '--seed') {
    await seedPartition()
    console.log(JSON.stringify(health(), null, 2))
    return
  }

  // Listen FIRST (clients can connect immediately); learn the authoritative
  // upstream total in the background — the config default already keeps
  // Content-Range totals correct.
  server.listen(CFG.port, CFG.host, () => {
    console.log(`[relay] listening on http://${CFG.host}:${CFG.port}`)
    console.log(`[relay] status page:  http://<host>:${CFG.port}/`)
    console.log(`[relay] health JSON:  http://<host>:${CFG.port}/healthz`)
    console.log(`[relay] archive:      http://<host>:${CFG.port}/revcdos.bin (Range, global coords)`)
  })

  // Auto-(re)seed in the background; serve immediately (live fallback covers
  // unseeded ranges while the download runs).
  const finalSize = await fileSafeSize(PART_FILE)
  if (finalSize === PART_SIZE) {
    seededBytes = PART_SIZE
    seedState = 'ready'
  } else {
    seedPartition().catch((err) => {
      seedState = 'error'
      seedError = err.message
      console.error('[relay] seed crashed:', err)
    })
  }

  probeArchiveTotal().catch(() => {})
}

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

main().catch((err) => {
  console.error('[relay] fatal:', err)
  process.exit(1)
})
