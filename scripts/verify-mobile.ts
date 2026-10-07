/**
 * Mobile emulation test: verifies touch detection + portrait rotate hint
 * with a REAL iPhone context (hasTouch/isMobile/coarse pointer),
 * which `agent-browser set device` cannot fully emulate.
 */
import { chromium, devices } from 'playwright'

const URL = 'http://localhost:3000/?lang=zh'

async function main() {
  const browser = await chromium.launch()
  const results: string[] = []

  // --- Portrait iPhone ---
  const iphone = devices['iPhone 14']
  const ctxP = await browser.newContext({ ...iphone })
  const pageP = await ctxP.newPage()
  await pageP.goto(URL, { waitUntil: 'domcontentloaded' })
  await pageP.waitForTimeout(5000)

  const portrait = await pageP.evaluate(() => ({
    viewport: `${innerWidth}x${innerHeight}`,
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
    isTouch: document.body.dataset.isTouch,
    rotateHintVisible:
      document.querySelector('.rotate-hint') &&
      getComputedStyle(document.querySelector('.rotate-hint')).display !== 'none',
    clickToPlay: document.getElementById('click-to-play-button')?.textContent,
    startVisible: !!document.querySelector('.start-container'),
  }))
  results.push(`PORTRAIT  ${JSON.stringify(portrait)}`)

  await pageP.screenshot({ path: '/home/z/my-project/scripts/verify-mobile-portrait.png' })

  // --- Scroll sanity on portrait: top content must stay reachable ---
  const scroll = await pageP.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
    const maxScroll = window.scrollY
    window.scrollTo(0, 0)
    const hintTop = document
      .querySelector('.rotate-hint')
      ?.getBoundingClientRect().top
    return { maxScroll, hintTopAtTop: Math.round(hintTop ?? -1) }
  })
  results.push(`SCROLL    ${JSON.stringify(scroll)}`)

  // --- Landscape iPhone (rotate) ---
  await pageP.setViewportSize({ width: 844, height: 390 })
  await pageP.waitForTimeout(800)
  const landscape = await pageP.evaluate(() => ({
    viewport: `${innerWidth}x${innerHeight}`,
    rotateHintVisible:
      document.querySelector('.rotate-hint') &&
      getComputedStyle(document.querySelector('.rotate-hint')).display !== 'none',
  }))
  results.push(`LANDSCAPE ${JSON.stringify(landscape)}`)

  await pageP.screenshot({ path: '/home/z/my-project/scripts/verify-mobile-landscape.png' })

  // --- Desktop with touch-capable laptop sanity (fine pointer + maxTouch>0) ---
  const ctxD = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true, // touch-capable laptop
  })
  const pageD = await ctxD.newPage()
  await pageD.goto(URL, { waitUntil: 'domcontentloaded' })
  await pageD.waitForTimeout(5000)
  const desktop = await pageD.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    isTouch: document.body.dataset.isTouch,
  }))
  results.push(`DESKTOP-touchscreen ${JSON.stringify(desktop)}`)

  await ctxP.close()
  await ctxD.close()
  await browser.close()

  console.log(results.join('\n'))
  console.log('\nPASS/FAIL checks:')
  console.log('  portrait.isTouch=1:', portrait.isTouch === '1')
  console.log('  portrait rotate hint shown:', !!portrait.rotateHintVisible)
  console.log('  landscape rotate hint hidden:', !landscape.rotateHintVisible)
  console.log('  desktop touchscreen stays 0 (mouse-primary):', desktop.isTouch === '0')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
