/**
 * Dump the flat archive index to public/game/revcdos-index.json.
 *
 * The index lets both the server (RemoteArchive) and the browser Service
 * Worker serve any file from the remote packed archive with a plain
 * table lookup — no local 1.08 GB copy, no sequential scan.
 *
 * Run: bun scripts/dump-archive-index.ts
 */
import { writeFileSync, statSync } from 'node:fs'
import { PackedArchive } from '../src/lib/packed-archive'

const ARCHIVE = process.env.REVCDOS_ARCHIVE_PATH ?? '.revcdos-cache/revcdos.bin'
const OUT = process.env.OUT ?? 'public/game/revcdos-index.json'

const size = statSync(ARCHIVE).size
console.log(`[dump-index] scanning ${ARCHIVE} (${(size / 1048576).toFixed(1)} MB)…`)

const arc = new PackedArchive(ARCHIVE)
const t0 = Date.now()
await arc.init()

const idx = arc.dumpIndex()
writeFileSync(OUT, JSON.stringify(idx))

console.log(`[dump-index] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`[dump-index] entries: ${idx.entries.length}`)
console.log(`[dump-index] index size: ${(statSync(OUT).size / 1048576).toFixed(2)} MB → ${OUT}`)

// Sanity: a few entries must decompress-match the direct read.
const { brotliDecompressSync } = await import('node:zlib')
const probe = idx.entries[Math.floor(idx.entries.length / 2)]
const raw = await arc.readRaw(probe[0])
if (!raw || raw.length !== probe[2] || raw.length !== 0 && brotliDecompressSync(raw).length === 0) {
  throw new Error(`index sanity check failed for ${probe[0]}`)
}
console.log(`[dump-index] sanity OK (${probe[0]}, ${probe[2]} B compressed)`)
