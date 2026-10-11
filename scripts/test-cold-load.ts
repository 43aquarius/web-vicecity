/**
 * test-cold-load.ts — cold first-visit REAL progress verification.
 * Fresh browser + cold server (mat cache wiped, warm idle):
 *   warm downloading  → real compressed bytes / total on the bar
 *   warm decompressing→ real decompressed bytes / known total
 *   SW materialisation→ real raw bytes via postMessage (server stream)
 *   chunk assembly    → decompressed scale
 * Ends at "click to continue" (no engine boot needed).
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'

const URL = 'http://127.0.0.1:3100/?lang=zh'
const OUT = '/home/z/my-project/tool-results'
const LOG: string[] = []
const log = (s: string) => { LOG.push(s); console.log(s) }
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const iphone = devices['iPhone 14'] as any
  const ctx = await browser.newContext({ ...iphone, viewport: { width: 568, height: 320 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('pageerror', (e: any) => log(`[pageerror] ${String(e).slice(0, 200)}`))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.evaluate(() => { (document.getElementById('click-to-play-button') as HTMLButtonElement)?.click() })
  log('clicked play (cold server — warm starts now)')

  const series: any[] = []
  const t0 = Date.now()
  let done = false
  let sawWarmDown = false, sawWarmDec = false, sawMatProgress = false
  for (let i = 0; i < 240 && !done; i++) {
    await page.waitForTimeout(1000)
    const st = await page.evaluate(() => {
      const g = (id: string) => ((document.getElementById(id) || {}) as any).textContent || ''
      const fill = (document.getElementById('vc-loading-fill') || {}) as any
      const intro = document.querySelector('.intro-container') as HTMLElement | null
      return {
        phase: g('vc-loading-phase'),
        stats: g('vc-loading-stats'),
        fill: fill.style ? fill.style.width : '',
        cursor: intro ? intro.style.cursor : '',
        err: !!(document.getElementById('vc-loading') as any)?.className?.includes?.('vc-err'),
      }
    })
    series.push({ t: Math.round((Date.now() - t0) / 1000), ...st })
    if (i % 3 === 0 || st.cursor === 'pointer' || st.err) log(`t=${series[series.length - 1].t}s ${JSON.stringify(st).slice(0, 200)}`)
    if (/拉取|从源站|准备/.test(st.phase) || /MB/.test(st.stats)) { /* warm visible */ }
    if (st.phase.includes('2/5') && /\d+/.test(st.stats)) sawWarmDown = sawWarmDown || /\/\s*\d/.test(st.stats) || /MB/.test(st.stats)
    if (st.phase.includes('解压') || st.stats.includes('解压')) sawWarmDec = true
    if (st.phase.includes('3/5') && st.stats.includes('MB /')) sawMatProgress = true
    if (st.err) { log('LOAD ERROR'); break }
    if (st.cursor === 'pointer') { done = true; log('REACHED click-to-continue') }
  }
  const tEnd = Math.round((Date.now() - t0) / 1000)
  const mbRows = series.filter((s) => s.stats.includes('MB'))
  const pctRows = series.filter((s) => s.stats.match(/^\d+%/))
  const phases = [...new Set(series.map((s) => s.phase))]
  log(`COLD-LOAD report: total=${tEnd}s phases=${JSON.stringify(phases)}`)
  log(`  rows with MB stats: ${mbRows.length}; rows starting with %: ${pctRows.length}`)
  for (const s of mbRows.slice(0, 4)) log(`  MB: t=${s.t}s ${s.stats}`)
  log(`  ... last 6 MB rows:`)
  for (const s of mbRows.slice(-6)) log(`  MB: t=${s.t}s ${s.stats}`)
  log(`VERDICT: warmDown=${sawWarmDown} warmDec=${sawWarmDec} matProgress=${sawMatProgress} done=${done}`)

  fs.writeFileSync(`${OUT}/cold-load.log`, LOG.join('\n'))
  fs.writeFileSync(`${OUT}/cold-load-series.json`, JSON.stringify(series, null, 1))
  await (ctx as any).close()
  await browser.close()
}
main().catch((e) => { LOG.push(`FATAL: ${e?.stack || e}`); fs.writeFileSync(`${OUT}/cold-load.log`, LOG.join('\n')); console.error(e); process.exit(1) })
