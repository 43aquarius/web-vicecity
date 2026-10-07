// Standalone test of the archive download + parse pipeline (outside Next.js)
const { createWriteStream } = require('node:fs')
const { statSync } = require('node:fs')

const ARCHIVE_URL = 'https://folder.morgen.qzz.io/revcdos.bin'
const ARCHIVE_PATH = '/home/z/my-project/.revcdos-cache/revcdos.bin'

async function fileSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

async function probe() {
  const res = await fetch(ARCHIVE_URL, { headers: { Range: 'bytes=0-0' } })
  await res.body?.cancel().catch(() => {})
  const cr = res.headers.get('content-range') ?? ''
  console.log('probe status:', res.status, 'content-range:', cr)
  return Number(cr.split('/')[1] ?? 0)
}

async function main() {
  const total = await probe()
  let from = await fileSize(ARCHIVE_PATH)
  console.log('total:', total, 'local:', from)
  if (from >= total) {
    console.log('already complete')
    return
  }
  const headers = {}
  if (from > 0) headers.Range = `bytes=${from}-`
  const res = await fetch(ARCHIVE_URL, { headers })
  console.log('download status:', res.status, 'expected 206')
  if (from > 0 && res.status !== 206) {
    console.log('server ignored range, restarting from 0')
    from = 0
  }
  const ws = createWriteStream(ARCHIVE_PATH, { flags: from > 0 ? 'a' : 'w' })
  const reader = res.body.getReader()
  let received = from
  const t0 = Date.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    await new Promise((resolve, reject) => {
      ws.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
    })
    received += value.length
    if (received % (50 * 1024 * 1024) < value.length) {
      const secs = (Date.now() - t0) / 1000
      console.log(`  ${received} bytes (${((received - from) / 1024 / 1024 / secs).toFixed(1)} MB/s)`)
    }
  }
  await new Promise((resolve) => ws.end(() => resolve()))
  console.log('final size:', await fileSize(ARCHIVE_PATH), 'expected:', total)
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
