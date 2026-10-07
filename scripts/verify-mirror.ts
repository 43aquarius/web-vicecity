/**
 * End-to-end simulation of the Service Worker data path:
 *   index lookup → raw.githubusercontent.com ranged reads → vendored WASM
 *   brotli decompress → compare against the local archive reference.
 *
 * This proves the exact code public/sw.js will run in the browser.
 */
import { readFileSync } from 'node:fs'

const MIRROR = 'https://raw.githubusercontent.com/43aquarius/web-vicecity/archive-data/revcdos.bin.part'
const PART_SIZE = 96_000_000

// --- SW's fetchMirrorRange (verbatim logic) ---
async function fetchMirrorRange(offset: number, length: number): Promise<Uint8Array> {
  const end = offset + length
  const parts: Uint8Array[] = []
  let pos = offset
  while (pos < end) {
    const partIdx = Math.floor(pos / PART_SIZE)
    const inPart = pos - partIdx * PART_SIZE
    const take = Math.min(PART_SIZE - inPart, end - pos)
    const url = MIRROR + String(partIdx).padStart(2, '0')
    const res = await fetch(url, {
      headers: { Range: `bytes=${inPart}-${inPart + take - 1}` },
      cache: 'no-store',
    })
    if (res.status !== 206) throw new Error(`mirror part ${partIdx} HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length !== take) throw new Error(`short read ${buf.length}/${take}`)
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

// --- SW's brotli setup ---
const glueSrc = readFileSync('public/game/brotli-dec.js', 'utf-8')
const wasm = readFileSync('public/game/brotli_dec_wasm_bg.wasm')
const BrotliDec = new Function('importScripts', glueSrc + '\nreturn __BrotliDec;')(() => {})
BrotliDec.initSync(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))

// --- index ---
const idx = JSON.parse(readFileSync('public/game/revcdos-index.json', 'utf-8'))
const map = new Map<string, [number, number]>()
for (const [p, off, csz] of idx.entries) map.set(p, [off, csz])

// --- reference ---
const { PackedArchive } = await import('../src/lib/packed-archive')
const arc = new PackedArchive('.revcdos-cache/revcdos.bin')
await arc.init()

const cases = [
  'vcsky/fetched/anim/cuts.img/ass_1.ifp', // small asset (single part read)
  'vcbr/vc-sky-en-v6.wasm.br', // 1.8MB
]

// Find an asset that straddles a part boundary (exercises multi-part reads)
const BOUNDARY = PART_SIZE
let straddler: string | null = null
for (const [p, [off, csz]] of map) {
  if (off < BOUNDARY && off + csz > BOUNDARY && csz > 1000 && csz < 500_000) {
    straddler = p
    break
  }
}
if (straddler) cases.push(straddler)

for (const path of cases) {
  const entry = map.get(path)
  if (!entry) throw new Error(`not in index: ${path}`)
  const t0 = Date.now()
  const br = await fetchMirrorRange(entry[0], entry[1])
  const dec = BrotliDec.decompress(br)
  const ref = await arc.open(path, false)
  const equal = Buffer.compare(Buffer.from(dec), ref) === 0
  console.log(
    `${path}: br=${entry[1]}B → dec=${dec.length}B ref=${ref.length}B equal=${equal} (${Date.now() - t0}ms)`,
  )
  if (!equal) throw new Error(`MISMATCH for ${path}`)
}
console.log('MIRROR E2E: ALL OK')
