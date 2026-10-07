/** Reference bytes for verifying remote-mode serving (from the local archive). */
import { PackedArchive } from '../src/lib/packed-archive'

const arc = new PackedArchive('.revcdos-cache/revcdos.bin')
await arc.init()

const targets = [
  'vcbr/vc-sky-en-v6.data.br', // big data package (brotli, 60.9MB)
  'vcbr/vc-sky-en-v6.wasm.br', // wasm package
]

for (const t of targets) {
  const dec = await arc.open(t, false)
  if (!dec) throw new Error(`missing ${t}`)
  // write first 64KB + a middle slice + sha256 of full content for manual checks
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update(dec).digest('hex')
  const sliceMid = dec.subarray(100_000_000, 100_000_000 + 4096)
  const slice0 = dec.subarray(0, 65536)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`/tmp/ref-${t.replace(/\//g, '_')}.head`, slice0)
  writeFileSync(`/tmp/ref-${t.replace(/\//g, '_')}.mid`, sliceMid)
  console.log(`${t}: decompressed=${dec.length} sha256=${sha}`)
}

// one small vcsky asset, fully
const small = 'vcsky/fetched/anim/cuts.img/ass_1.ifp'
const dec = await arc.open(small, false)
if (!dec) throw new Error(`missing ${small}`)
const { createHash } = await import('node:crypto')
const { writeFileSync } = await import('node:fs')
writeFileSync('/tmp/ref-small.bin', dec)
console.log(`${small}: decompressed=${dec.length} sha256=${createHash('sha256').update(dec).digest('hex')}`)
