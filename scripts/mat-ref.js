#!/usr/bin/env node
/**
 * Disk-materialisation verification reference:
 * decompress vcbr/vc-sky-en-v6.data.br straight from the upstream archive and
 * print sha256 of a byte window, to compare against the 206 slice served by
 * the standalone server under test.
 *
 * Usage: node mat-ref.js <start> <end>   (inclusive byte range)
 */
const { createBrotliDecompress } = require('node:zlib')
const crypto = require('node:crypto')

const ARCHIVE_URL = 'https://folder.morgen.qzz.io/revcdos.bin'

// Read the exact offset/compressedSize from the bundled flat index.
const idx = JSON.parse(require('node:fs').readFileSync(
  '/home/z/my-project/public/game/revcdos-index.json',
  'utf-8',
))
const entry = idx.entries.find((e) => e[0] === 'vcbr/vc-sky-en-v6.data.br')
if (!entry) throw new Error('index entry not found')
const DATA_BR_OFFSET = entry[1]
const DATA_BR_SIZE = entry[2]

async function main() {
  const start = Number(process.argv[2])
  const end = Number(process.argv[3])

  // Fetch the engine package's compressed bytes.
  const res = await fetch(ARCHIVE_URL, {
    headers: { Range: `bytes=${DATA_BR_OFFSET}-${DATA_BR_OFFSET + DATA_BR_SIZE - 1}` },
  })
  if (res.status !== 206) throw new Error(`fetch HTTP ${res.status}`)
  const raw = Buffer.from(await res.arrayBuffer())
  console.error(`[ref] raw ${raw.length} bytes (expect ${DATA_BR_SIZE})`)

  // Streaming brotli decompress.
  const chunks = []
  await new Promise((resolve, reject) => {
    const dec = createBrotliDecompress()
    dec.on('data', (c) => chunks.push(c))
    dec.on('end', resolve)
    dec.on('error', reject)
    dec.end(raw)
  })
  const full = Buffer.concat(chunks)
  console.error(`[ref] decompressed ${full.length} bytes`)
  const slice = full.subarray(start, end + 1)
  const sha = crypto.createHash('sha256').update(slice).digest('hex')
  console.log(sha)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
