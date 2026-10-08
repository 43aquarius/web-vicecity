/**
 * reVCDOS archive Service Worker — browser-direct asset serving.
 *
 * Intercepts /vcsky/* and /vcbr/* requests and serves them WITHOUT the
 * main server: the flat index (public/game/revcdos-index.json) maps every
 * path to its byte range inside the 1.08 GB packed archive; the matching
 * bytes are fetched with HTTP Range requests DIRECTLY from the user's
 * partitioned relay servers (see the repo's relay-a/relay-b branches —
 * CORS-open range servers), or from the static GitHub mirror
 * (raw.githubusercontent.com serves cross-origin ranges), then decompressed
 * with the vendored WASM brotli decoder and cached in the browser.
 *
 * Source chain (never breaks the game):
 *   1. browser caches (this SW's asset cache + the launcher's own cache)
 *   2. partitioned relays (/api/archive/sources routing map) — user's aux
 *      servers, disk-cached partitions, CORS open
 *   3. GitHub raw mirror ranged reads + WASM brotli decompress
 *   4. same-origin server proxy (fetch(request) passthrough — the server has
 *      its own relay-routing / remote / local archive modes)
 * Relays and the mirror each have their own circuit breaker (3 consecutive
 * failures → 2 min cool-down) so a dead source never stalls requests.
 */

importScripts('/game/brotli-dec.js')

const INDEX_URL = '/game/revcdos-index.json'
const ASSET_CACHE = 'revcdos-assets-v1'
// Mirror URL forms, tried in order (see fetchMirrorRange):
//   1. refs/heads/<branch>/... - stable; distinct CDN cache key from the short
//      branch form (which can get stuck in per-URL 404 negative caches right
//      after parts are (re)pushed).
//   2. <commit-sha>/... - immutable path, immune to branch propagation.
// Parts are plain byte slices of revcdos.bin (see scripts/push-archive-parts.sh).
const MIRROR_REPO = '43aquarius/web-vicecity'
const MIRROR_BRANCH = 'archive-data'
const MIRROR_SHA = '6e81c6b1ef5d553aa4da54c43ac6970f75697d79'
const MIRROR_BASES = [
  `https://raw.githubusercontent.com/${MIRROR_REPO}/refs/heads/${MIRROR_BRANCH}/`,
  `https://raw.githubusercontent.com/${MIRROR_REPO}/${MIRROR_SHA}/`,
]
const MIRROR_PART_FILE = 'revcdos.bin.part'
const PART_SIZE = 96_000_000 // bytes — MUST match scripts/split-and-push-archive.sh (split -b 96MB, SI units)
const MIRROR_TIMEOUT_MS = 15_000
const MIRROR_FAILURE_LIMIT = 3
const MIRROR_BUST_RETRIES = 3
// After this many consecutive failures the mirror is bypassed for a cool-down
// window (CDN negative-cache propagation, transient 404/5xx), then retried.
const MIRROR_COOLDOWN_MS = 120_000
// A mirror reachability probe gate: the raw.githubusercontent.com host is
// unreachable from some networks (e.g. mainland China). Probing it ONCE per
// worker lifetime (a 16-byte ranged read, 8 s timeout) avoids stalling every
// archive request behind per-part mirror timeouts on such networks.
const MIRROR_PROBE_TIMEOUT_MS = 8_000
// Network-level probe failure (timeout / DNS / refused): mirror is presumed
// blocked and is skipped for a long cool-down (persisted via the Cache API so
// later SW lifetimes remember). A plain 404/5xx answer means "reachable but
// wrong" and only gets the short cool-down.
const MIRROR_BLOCKED_MS = 2 * 60 * 60 * 1000
const SW_STATE_CACHE = 'revcdos-sw-state'
const SW_STATE_KEY = 'mirror-blocked-until'

let indexPromise = null
let brotliReady = null
let mirrorFailures = 0
let mirrorCooldownUntil = 0
// 'pending' → probe in flight (requests bypass the mirror meanwhile);
// 'ok' → mirror usable; 'blocked' → probe failed on the network level.
let mirrorProbeState = 'pending'
// Cache-bust token for mirror URLs. Assigned randomly on first use and
// remembered once it works — the CDN caches per exact URL, so a stable
// working token hits a warm positive cache while a fresh random one escapes
// stale per-URL negative caches (right after parts are (re)pushed).
let mirrorBust = ''

// ---------- partitioned relays (user's aux servers) ----------
// The relay routing map comes from /api/archive/sources (same-origin) —
// [{id, url, start, end}] with GLOBAL archive byte partitions. Relay URLs
// are FULL archive URLs (may carry ?token=…) and serve standard 206 ranges
// with CORS open, so the browser fetches the player's own servers directly.
const RELAY_SOURCES_URL = '/api/archive/sources'
const RELAY_TIMEOUT_MS = 15_000
const RELAY_RETRIES = 2
const RELAY_FAILURE_LIMIT = 3
const RELAY_COOLDOWN_MS = 120_000

let relayList = [] // [{id, url, start, end}]
let relaySourcesPromise = null
let relayFailures = 0
let relayCooldownUntil = 0
// Set by the range fetchers ('relay' | 'mirror') for observability headers.
let lastRangeSource = 'mirror'

function ensureRelaySources() {
  if (!relaySourcesPromise) {
    relaySourcesPromise = fetch(RELAY_SOURCES_URL, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`sources HTTP ${r.status}`)
        return r.json()
      })
      .then((cfg) => {
        const list = Array.isArray(cfg && cfg.relays) ? cfg.relays : []
        const clean = list.filter(
          (r) => r && typeof r.url === 'string' && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start,
        )
        relayList = clean
        if (clean.length > 0) {
          console.warn('[sw] relay routing map loaded:', clean.map((r) => `${r.id}=[${r.start}, ${r.end})`).join(' '))
        }
      })
      .catch((e) => {
        // Sources endpoint unreachable — no relays; mirror + server remain.
        console.warn('[sw] relay sources unavailable:', e && e.message)
        relayList = []
      })
  }
  return relaySourcesPromise
}

function relayCircuitOk() {
  return relayList.length > 0 && relayCooldownUntil < Date.now()
}

function noteRelayFailure() {
  relayFailures++
  if (relayFailures >= RELAY_FAILURE_LIMIT) {
    relayCooldownUntil = Date.now() + RELAY_COOLDOWN_MS
    relayFailures = 0
    console.warn('[sw] relays failing — bypassing for ' + RELAY_COOLDOWN_MS / 1000 + 's (mirror/server take over)')
  }
}

/**
 * Whether the relays FULLY cover [offset, offset+length). Partial coverage
 * falls through to the mirror (config gaps are a setup mistake, the mirror
 * or server still serve everything).
 */
function relaysCover(offset, length) {
  if (!relayCircuitOk()) return false
  let pos = offset
  const end = offset + length
  for (const r of [...relayList].sort((a, b) => a.start - b.start)) {
    if (r.end <= pos) continue
    if (r.start > pos) return false // gap
    pos = Math.min(end, r.end)
    if (pos >= end) return true
  }
  return pos >= end
}

/**
 * Fetch [offset, offset+length) from the partitioned relays: split per owner,
 * fetch segments in parallel, verify each 206 + length, concatenate.
 * Throws on any failure (caller falls back to the mirror).
 */
async function fetchRelayRange(offset, length) {
  const segments = []
  let pos = offset
  const end = offset + length
  for (const r of [...relayList].sort((a, b) => a.start - b.start)) {
    if (r.end <= pos || r.start >= end) continue
    const segStart = Math.max(pos, r.start)
    const segEnd = Math.min(r.end, end)
    if (segStart > pos) throw new Error('relay gap at ' + pos)
    segments.push({ relay: r, start: segStart, length: segEnd - segStart })
    pos = segEnd
  }
  if (pos < end) throw new Error('relays do not cover tail at ' + pos)

  const fetched = await Promise.all(
    segments.map(async (seg) => {
      let lastErr = null
      for (let attempt = 1; attempt <= RELAY_RETRIES; attempt++) {
        try {
          const res = await fetch(seg.relay.url, {
            headers: { Range: `bytes=${seg.start}-${seg.start + seg.length - 1}` },
            cache: 'no-store',
            signal: AbortSignal.timeout(
              Math.max(RELAY_TIMEOUT_MS, Math.min(600_000, 10_000 + seg.length * 20)),
            ),
          })
          if (res.status !== 206) {
            await res.arrayBuffer().catch(() => {})
            throw new Error(`relay ${seg.relay.id} HTTP ${res.status}`)
          }
          const b = new Uint8Array(await res.arrayBuffer())
          if (b.length !== seg.length) {
            throw new Error(`relay ${seg.relay.id} short read ${b.length}/${seg.length}`)
          }
          return b
        } catch (err) {
          lastErr = err
          console.warn('[sw] relay ' + seg.relay.id + ' attempt ' + attempt + '/' + RELAY_RETRIES + ' failed:', err && err.message)
        }
      }
      throw lastErr || new Error('relay segment failed')
    }),
  )

  relayFailures = 0 // success resets the circuit
  lastRangeSource = 'relay'
  if (fetched.length === 1) return fetched[0]
  const out = new Uint8Array(length)
  let o = 0
  for (const p of fetched) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---------- lazily loaded helpers ----------

function getIndex() {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL, { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`index HTTP ${r.status}`)
        return r.json()
      })
      .then((idx) => {
        const map = new Map()
        for (const [path, offset, csize] of idx.entries) map.set(path, [offset, csize])
        return { size: idx.size, map }
      })
  }
  return indexPromise
}

function getBrotli() {
  if (!brotliReady) {
    brotliReady = fetch('/game/brotli_dec_wasm_bg.wasm', { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`brotli wasm HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then((buf) => {
        if (typeof __BrotliDec === 'undefined') throw new Error('brotli glue missing')
        __BrotliDec.initSync(buf)
        return __BrotliDec
      })
  }
  return brotliReady
}

// ---------- mirror reachability ----------

/** Remember "mirror blocked until T" across SW restarts (Cache API). */
async function persistBlockedUntil(ts) {
  try {
    const cache = await caches.open(SW_STATE_CACHE)
    await cache.put(SW_STATE_KEY, new Response(String(ts)))
  } catch (e) { /* best effort */ }
}

async function readPersistedBlockedUntil() {
  try {
    const cache = await caches.open(SW_STATE_CACHE)
    const res = await cache.match(SW_STATE_KEY)
    if (!res) return 0
    return Number(await res.text()) || 0
  } catch (e) {
    return 0
  }
}

async function clearPersistedBlocked() {
  try {
    const cache = await caches.open(SW_STATE_CACHE)
    await cache.delete(SW_STATE_KEY)
  } catch (e) { /* best effort */ }
}

/**
 * One-shot 16-byte ranged read against the mirror. Sets mirrorProbeState:
 *   'ok'      — reachable, ranged reads work → mirror may serve requests
 *   'blocked' — network-level failure (timeout / DNS / refused) → long skip
 * A 404/5xx response means the host IS reachable (only the path is wrong) →
 * short cool-down, ordinary fallback continues.
 */
function probeMirror() {
  const url =
    MIRROR_BASES[0] + MIRROR_PART_FILE + '00' + '?rb=' + Date.now().toString(36)
  return fetch(url, {
    headers: { Range: 'bytes=0-15' },
    cache: 'no-store',
    signal: AbortSignal.timeout(MIRROR_PROBE_TIMEOUT_MS),
  })
    .then(async (res) => {
      await res.arrayBuffer().catch(() => {})
      if (res.status === 206 || res.status === 200) {
        mirrorProbeState = 'ok'
        return
      }
      // Reachable but wrong content — short cool-down only.
      mirrorProbeState = 'ok'
      mirrorCooldownUntil = Math.max(mirrorCooldownUntil, Date.now() + 10 * 60_000)
      console.warn('[sw] mirror probe returned HTTP', res.status, '— 10 min cool-down')
    })
    .catch(() => {
      mirrorProbeState = 'blocked'
      mirrorCooldownUntil = Date.now() + MIRROR_BLOCKED_MS
      persistBlockedUntil(mirrorCooldownUntil)
      console.warn('[sw] mirror unreachable — serving via server proxy for 2 h')
    })
}

/**
 * Whether a request may try the mirror at all: probe must have settled 'ok',
 * persisted/soft cool-downs must have expired.
 */
function mirrorAllowed() {
  if (mirrorCooldownUntil > Date.now()) return false
  if (mirrorProbeState === 'pending') return false // never stall on the probe
  return mirrorProbeState === 'ok'
}

async function mirrorSucceeded() {
  // A successful mirror read clears any blocked state (e.g. the user's
  // network changed) so subsequent sessions use it again.
  if (mirrorCooldownUntil > 0) {
    mirrorCooldownUntil = 0
    await clearPersistedBlocked()
  }
}

// ---------- mirror ranged reads ----------

async function fetchMirrorRange(offset, length) {
  if (offset < 0 || length <= 0) throw new Error('bad range')
  const end = offset + length
  const parts = []
  let pos = offset
  while (pos < end) {
    const partIdx = Math.floor(pos / PART_SIZE)
    const inPart = pos - partIdx * PART_SIZE
    const take = Math.min(PART_SIZE - inPart, end - pos)
    const suffix = String(partIdx).padStart(2, '0')

    // The mirror CDN serves per-URL negative 404 caches right after the
    // parts are (re)pushed, and edge nodes disagree until propagation
    // settles. Each retry uses a fresh random query (new cache key → likely
    // a different edge); the first token that works is remembered for the
    // rest of the session.
    let buf = null
    let lastErr = null
    outer: for (let attempt = 0; attempt < MIRROR_BUST_RETRIES; attempt++) {
      const base = MIRROR_BASES[Math.min(attempt, MIRROR_BASES.length - 1)]
      const bust =
        attempt === 0 && mirrorBust
          ? mirrorBust
          : Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
      const url = base + MIRROR_PART_FILE + suffix + `?rb=${bust}`
      try {
        const res = await fetch(url, {
          headers: { Range: `bytes=${inPart}-${inPart + take - 1}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
        })
        if (res.status !== 206) {
          await res.arrayBuffer().catch(() => {})
          lastErr = new Error(`mirror part ${partIdx} HTTP ${res.status} (bust=${bust})`)
          continue
        }
        const b = new Uint8Array(await res.arrayBuffer())
        if (b.length !== take) {
          lastErr = new Error(`mirror short read ${b.length}/${take}`)
          continue
        }
        buf = b
        mirrorBust = bust
        mirrorSucceeded()
        break outer
      } catch (err) {
        lastErr = err
      }
    }
    if (!buf) throw lastErr || new Error(`mirror part ${partIdx} failed`)
    parts.push(buf)
    pos += take
  }
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(length)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function entryFor(path) {
  const idx = await getIndex()
  return idx.map.get(path) || null
}

/** Fetch the stored brotli bytes — relays first, then the mirror. */
async function loadDecompressed(path) {
  const entry = await entryFor(path)
  if (!entry) return null
  let br = null
  await ensureRelaySources()
  if (relaysCover(entry[0], entry[1])) {
    try {
      br = await fetchRelayRange(entry[0], entry[1])
    } catch (err) {
      noteRelayFailure()
      console.warn('[sw] relay fetch failed, falling back to mirror:', err && err.message)
    }
  }
  if (!br) {
    br = await fetchMirrorRange(entry[0], entry[1])
    lastRangeSource = 'mirror'
  }
  const brotli = await getBrotli()
  return brotli.decompress(br)
}

// ---------- decompressed-materialisation cache for ranged requests ----------
// Large engine files (.data.br / .wasm.br) are downloaded by the launcher in
// 4 MB ranged chunks. The SW materialises the whole decompressed file once,
// keeps it in worker memory for zero-copy slicing, and consults the
// launcher's own browser cache (populated on a previous session) first.

const materialized = new Map() // entryPath -> Promise<Uint8Array>

function materialize(cacheKey, entryPath) {
  let p = materialized.get(entryPath)
  if (p) return p
  p = (async () => {
    // The launcher caches the fully assembled file under the same URL in a
    // cache named after the hostname (see game.js loadData).
    try {
      const launcherCache = await caches.open(location.hostname)
      const cached = await launcherCache.match(cacheKey)
      if (cached) {
        const buf = new Uint8Array(await cached.arrayBuffer())
        if (buf.length > 0) return buf
      }
    } catch (e) {
      /* Cache API unavailable — continue to the mirror */
    }
    const data = await loadDecompressed(entryPath)
    if (!data || data.length === 0) throw new Error(`not in archive index: ${entryPath}`)
    return data
  })()
  materialized.set(entryPath, p)
  p.catch(() => materialized.delete(entryPath))
  return p
}

// ---------- responses ----------

function mediaType(path) {
  const p = path.toLowerCase()
  if (p.endsWith('.wasm.br') || p.endsWith('.wasm')) return 'application/wasm'
  if (p.endsWith('.js.br') || p.endsWith('.js')) return 'application/javascript'
  if (p.endsWith('.json')) return 'application/json'
  if (p.endsWith('.mp3')) return 'audio/mpeg'
  if (p.endsWith('.raw')) return 'application/octet-stream'
  if (p.endsWith('.ifp') || p.endsWith('.dff') || p.endsWith('.img') || p.endsWith('.col') || p.endsWith('.txd')) {
    return 'application/octet-stream'
  }
  return 'application/octet-stream'
}

const COMMON_HEADERS = {
  'Accept-Ranges': 'bytes',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/** Whole-file (non-ranged) asset request: cache-first, then mirror. */
async function serveWhole(cacheKey, entryPath) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(cacheKey)
  if (cached) return cached

  const data = await loadDecompressed(entryPath)
  if (!data) throw new Error(`not in archive index: ${entryPath}`)

  const headers = new Headers({
    ...COMMON_HEADERS,
    'Content-Type': mediaType(entryPath),
    'Content-Length': String(data.length),
    'Cache-Control': 'public, max-age=86400',
    'X-ReVCDOS-Source': 'sw-' + lastRangeSource,
  })
  const res = new Response(data, { status: 200, headers })
  cache.put(cacheKey, res.clone()).catch(() => {})
  return res
}

function parseRangeHeader(header) {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d+)\s*-\s*(\d*)\s*$/.exec(header)
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? Number.POSITIVE_INFINITY : Number(m[2])
  return [start, end]
}

/** Ranged request (.data.br / .wasm.br chunked download): 206 slices. */
async function serveRanged(request, cacheKey, entryPath) {
  const range = parseRangeHeader(request.headers.get('range'))
  if (!range) return serveWhole(cacheKey, entryPath)

  const data = await materialize(cacheKey, entryPath)
  const total = data.length
  let start = range[0]
  let end = Math.min(range[1], total - 1)
  if (start >= total) {
    return new Response(null, {
      status: 416,
      headers: { ...COMMON_HEADERS, 'Content-Range': `bytes */${total}` },
    })
  }
  if (end < start) end = start

  const headers = new Headers({
    ...COMMON_HEADERS,
    'Content-Type': mediaType(entryPath),
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'no-store',
    'X-ReVCDOS-Source': 'sw-' + lastRangeSource,
  })
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
  return new Response(data.subarray(start, end + 1), { status: 206, headers })
}

// ---------- fetch handler ----------

async function handleArchive(request) {
  const url = new URL(request.url)
  // cacheKey: absolute pathname — matches the launcher's own cache keys.
  // entryPath: leading slash stripped — matches the archive index keys
  // ('vcbr/…' and 'vcsky/…' prefixes are part of the key!).
  const cacheKey = url.pathname
  const entryPath = url.pathname.slice(1)

  // Whole-file requests served from cache never touch the mirror.
  if (!request.headers.get('range')) {
    try {
      const cache = await caches.open(ASSET_CACHE)
      const cached = await cache.match(cacheKey)
      if (cached) return cached
    } catch (e) {
      /* cache unavailable — fall through */
    }
  }

  try {
    // Relays (if configured) are tried inside serveRanged/serveWhole via
    // loadDecompressed; the mirror path needs its probe gate. When neither
    // direct source is currently usable, throw to hit the server fallback.
    await ensureRelaySources()
    const relayPossible = relayCircuitOk()
    const mirrorPossible = mirrorAllowed()
    if (!relayPossible && !mirrorPossible) {
      throw new Error(mirrorProbeState === 'blocked' ? 'mirror blocked, no relays' : 'no direct source available')
    }
    const res = request.headers.get('range')
      ? await serveRanged(request, cacheKey, entryPath)
      : await serveWhole(cacheKey, entryPath)
    mirrorFailures = 0
    return res
  } catch (err) {
    mirrorFailures++
    if (mirrorProbeState === 'ok' && mirrorFailures >= MIRROR_FAILURE_LIMIT) {
      mirrorCooldownUntil = Date.now() + MIRROR_COOLDOWN_MS
      mirrorFailures = 0
    }
    const reason = err && err.message ? err.message : String(err)
    console.warn('[sw] mirror path failed, falling back to server proxy:', reason)
    // Same-origin passthrough: the server serves /vcsky /vcbr itself
    // (remote ranged reads or local archive). The fallback reason is surfaced
    // as a response header for observability.
    try {
      const upstream = await fetch(request)
      const headers = new Headers(upstream.headers)
      headers.set('x-sw-fallback', reason.slice(0, 180))
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
    } catch (e) {
      return new Response(`sw+server failed: ${reason}; server: ${e && e.message ? e.message : e}`, {
        status: 502,
      })
    }
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  let url
  try {
    url = new URL(request.url)
  } catch (e) {
    return
  }
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/vcsky/') && !url.pathname.startsWith('/vcbr/')) return
  event.respondWith(handleArchive(request))
})

// New versions take over immediately (deployments rely on the updated
// mirror URLs living in this file).
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Take control of existing clients immediately so the current page
      // benefits from direct mirror reads in this very session.
      await self.clients.claim()
      // Drop caches from older SW generations if the version constant changed.
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== ASSET_CACHE && k !== location.hostname && k !== SW_STATE_CACHE).map((k) => caches.delete(k)))
      // Load the relay routing map (non-blocking failures → no relays).
      ensureRelaySources().catch(() => {})
      // Restore any persisted "mirror blocked" verdict, then (re)probe the
      // mirror reachability in the background — requests never wait on it.
      const blockedUntil = await readPersistedBlockedUntil()
      if (blockedUntil > Date.now()) {
        mirrorCooldownUntil = blockedUntil
        mirrorProbeState = 'blocked'
        console.warn('[sw] mirror still in persisted cool-down until', new Date(blockedUntil).toISOString())
      } else {
        probeMirror()
      }
    })(),
  )
})
