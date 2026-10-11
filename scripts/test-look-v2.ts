/**
 * test-look-v2.ts — direct-drag camera layer end-to-end verification.
 *
 * Verifies (against the standalone prod server on :3100):
 *  1. REAL loading progress: the overlay's stats/numbers during download
 *     (SW materialisation progress via postMessage) — sampled timeseries.
 *  2. Touch look = PC mouse look: drags on #look inject deltas that reach
 *     the ENGINE (verified via the events.js __vcMouseLog hook).
 *  3. No first-person: axes 2/3 stay 0; camera changes are gradual and
 *     continuous (rotation), not a one-shot mode switch.
 *  4. Tap without drag does nothing.
 *  5. Multi-touch: walking (left stick) + camera drag at the same time.
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'

const URL = 'http://127.0.0.1:3100/?lang=zh&vcdebug=1'
const OUT = '/home/z/my-project/tool-results'
const LOG: string[] = []
const log = (s: string) => {
  LOG.push(s)
  console.log(s)
}
fs.mkdirSync(OUT, { recursive: true })

async function dataset(page: any) {
  return page.evaluate(() => {
    const ds: Record<string, string> = {}
    for (const a of Array.from(document.body.attributes)) {
      if (a.name.startsWith('data-')) ds[a.name] = a.value
    }
    const pad = navigator.getGamepads?.()[0]
    return { states: ds, axes: pad ? Array.from(pad.axes).map((v: number) => +v.toFixed(3)) : null }
  })
}

async function statesOnly(page: any) {
  const r = await dataset(page)
  return r.states
}

const readAxes = async () =>
  _page.evaluate(() => {
    const pad = navigator.getGamepads?.()[0]
    return pad ? Array.from(pad.axes).map((v) => +v.toFixed(2)) : null
  })

// helper indirection so readAxes can be used before page exists
let _page: any = null

async function main() {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const iphone = devices['iPhone 14'] as any
  const ctx = await browser.newContext({
    ...iphone,
    viewport: { width: 568, height: 320 }, // landscape, small raster = stability
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  _page = page
  page.on('crash', () => log('[!!] renderer CRASHED'))
  const cdp = await (ctx as any).newCDPSession(page)
  page.on('console', (m: any) => {
    const t = m.text()
    if (/error|Error|ERR|relay|sw\]/i.test(t)) log(`[console] ${t.slice(0, 180)}`)
  })
  page.on('pageerror', (e: any) => log(`[pageerror] ${String(e).slice(0, 250)}`))

  // ---------------------------------------------------------------- load
  log(`goto ${URL}`)
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // loading progress timeseries — the REAL-progress contract:
  // at some point stats must show "x MB / y MB" style numbers and the fill
  // width must advance; percentage readout must appear during download.
  const series: any[] = []
  const sampleLoad = async () => {
    const st = await page.evaluate(() => {
      const phase = (document.getElementById('vc-loading-phase') || {}) as any
      const stats = (document.getElementById('vc-loading-stats') || {}) as any
      const fill = (document.getElementById('vc-loading-fill') || {}) as any
      const pct = (document.getElementById('vc-loading-pct') || {}) as any
      const intro = document.querySelector('.intro-container') as HTMLElement | null
      return {
        phase: phase.textContent || '',
        stats: stats.textContent || '',
        fillW: fill.style ? fill.style.width : '',
        pct: pct.textContent || '',
        cursor: intro ? intro.style.cursor : '',
        err: !!(document.getElementById('vc-loading') || { className: '' } as any).className?.includes?.('vc-err'),
      }
    })
    series.push({ t: Date.now(), ...st })
    return st
  }

  await page.evaluate(() => {
    const btn = document.getElementById('click-to-play-button') as HTMLButtonElement
    btn?.click()
  })
  log('clicked play; sampling loading UI...')

  let continued = false
  for (let i = 0; i < 150 && !continued; i++) {
    await page.waitForTimeout(1500)
    const st = await sampleLoad()
    if (i % 3 === 0) log(`load t=${(i + 1) * 1.5}s ${JSON.stringify(st).slice(0, 220)}`)
    if (st.err) {
      log(`LOAD ERROR: ${JSON.stringify(st)}`)
      break
    }
    if (st.cursor === 'pointer') {
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch' }))
      })
      continued = true
      log('download finished; tapped to continue into the engine')
    }
  }
  const t0 = series.length ? series[0].t : Date.now()
  const withMb = series.filter((s) => /MB/.test(s.stats))
  const withSlash = series.filter((s) => /\d+\s*\/\s*\d+/.test(s.stats))
  const fillNums = series.map((s) => parseFloat(String(s.fillW || '').replace('%', '')) || 0)
  const maxFill = fillNums.length ? Math.max(...fillNums) : 0
  log(`LOAD-PROGRESS report: samples=${series.length} sawMB=${withMb.length} sawA/B=${withSlash.length} maxFill%=${maxFill.toFixed(1)} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (withMb.length) log(`  sample stats with MB: ${JSON.stringify(withMb.slice(0, 6).map((s: any) => s.stats))}`)
  if (withSlash.length < 1) log('  WARN: no "x / y" byte-pair stats seen (progress may not be real!)')

  // ---------------------------------------------------------------- boot
  let menuAt = -1
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(3000)
    const st = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      return {
        started: document.body.classList.contains('gameIsStarted'),
        menu: document.body.dataset.stateMenu,
        cw: c ? (c as HTMLCanvasElement).width : 0,
      }
    })
    if (i % 5 === 0) log(`boot t=${(i + 1) * 3}s ${JSON.stringify(st)}`)
    if (st.started && st.cw > 100 && st.menu === '1') {
      menuAt = (i + 1) * 3
      break
    }
  }
  if (menuAt < 0) throw new Error('engine never reached the menu')
  log(`menu reached at t=${menuAt}s`)
  await page.screenshot({ path: `${OUT}/v2-0-menu.png` })

  const pressBtn = async (idx: number, ms = 170) => {
    await page.evaluate((i) => {
      // top-level const emulator lives in the page's global lexical env
      // @ts-ignore
      if (typeof emulator !== 'undefined') {
        // @ts-ignore
        emulator.PressButton(0, i, 1, true)
        return
      }
      // fallback: tap the on-screen button
      const sel = i === 3 ? '.touch-control.car.getIn' : '.touch-control.run'
      const el = document.querySelector(sel)
      if (el) {
        const r = el.getBoundingClientRect()
        const fire = (type: string, buttons: number) =>
          el.dispatchEvent(new PointerEvent(type, {
            pointerId: 99, pointerType: 'touch', isPrimary: true, buttons,
            button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
            bubbles: true, cancelable: true,
          }))
        fire('pointerdown', 1)
        setTimeout(() => fire('pointerup', 0), 130)
      }
    }, idx)
    await page.waitForTimeout(ms)
    await page.evaluate((i) => {
      // @ts-ignore
      if (typeof emulator !== 'undefined') {
        // @ts-ignore
        emulator.PressButton(0, i, 0, false)
      }
    }, idx)
  }
  const confirm = () => pressBtn(0)

  await confirm() // Start game
  await page.waitForTimeout(1800)
  await confirm() // New game
  log('confirmed twice (Start game -> New game)')

  // wait for stable on-foot
  let stable = 0
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000)
    const st = await statesOnly(page)
    if (i % 4 === 0) log(`game-wait t=${(i + 1) * 2}s menu=${st['data-state-menu']} cutscene=${st['data-state-cutscene']} car=${st['data-state-car']} dl=${st['data-state-download']}`)
    if (st['data-state-cutscene'] === '1') {
      await confirm()
      stable = 0
      continue
    }
    if (st['data-state-menu'] === '1' && st['data-state-download'] !== '1') {
      await confirm()
      stable = 0
      continue
    }
    if (st['data-state-menu'] === '0' && st['data-state-cutscene'] === '0' && st['data-state-download'] !== '1') {
      stable++
      if (stable >= 3) break
    } else {
      stable = 0
    }
  }
  log(`on-foot states: ${JSON.stringify(await statesOnly(page))}`)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${OUT}/v2-1-baseline.png` })

  // arm the engine-side mouse log (events.js fillMouseEventData hook)
  await page.evaluate(() => {
    ;(window as any).__vcMouseLog = []
  })

  // ------------------------------------------------------------- helpers
  const dragLook = async (name: string, x0: number, y0: number, dx: number, dy: number, opts: { steps?: number; holdMs?: number; midShots?: number } = {}) => {
    const steps = opts.steps ?? 12
    const holdMs = opts.holdMs ?? 600
    await page.evaluate(
      ({ x0, y0, pid }) => {
        const look = document.getElementById('look')
        if (!look) return
        look.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: pid, pointerType: 'touch', isPrimary: true, buttons: 1,
            button: 0, clientX: x0, clientY: y0, bubbles: true, cancelable: true,
          }),
        )
      },
      { x0, y0, pid: 88 },
    )
    for (let i = 1; i <= steps; i++) {
      await page.evaluate(
        ({ x, y }) => {
          document.dispatchEvent(
            new PointerEvent('pointermove', {
              pointerId: 88, pointerType: 'touch', isPrimary: true, buttons: 1,
              button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true,
            }),
          )
        },
        { x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps },
      )
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, holdMs))
    await page.screenshot({ path: `${OUT}/v2-${name}-hold.png` })
    await page.evaluate(() => {
      document.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 88, pointerType: 'touch' }),
      )
    })
    await new Promise((r) => setTimeout(r, 900))
    await page.screenshot({ path: `${OUT}/v2-${name}-after.png` })
    const st = await statesOnly(page)
    log(`${name}: axes=${JSON.stringify(await readAxes())} car=${st['data-state-car']} gun=${st['data-state-gun']} scope=${st['data-state-scope-mode']},${st['data-state-scope-gun']}`)
  }

  const debugSnap = () =>
    page.evaluate(() => {
      const d = (window as any).__vcLookDebug || {}
      const ml = (window as any).__vcMouseLog
      return {
        lookEvents: d.events || 0,
        lastD: [d.dx, d.dy],
        blockedBy: d.blockedBy,
        engineMouse: Array.isArray(ml) ? ml.length : -1,
        engineSample: Array.isArray(ml) && ml.length ? [ml[ml.length - 1].mx, ml[ml.length - 1].my, ml[ml.length - 1].target] : null,
      }
    })

  // --------------------------------------------------------------- tests
  log(`pre-test debug: ${JSON.stringify(await debugSnap())}`)
  log(`baseline axes: ${JSON.stringify(await readAxes())}`)

  // T1: right drag → camera must rotate (scene change)
  await dragLook('t1-right', 370, 110, 200, 0, { steps: 14, holdMs: 500 })
  log(`T1 debug: ${JSON.stringify(await debugSnap())}`)

  // T2: up drag → pitch change
  await dragLook('t2-up', 370, 110, 0, -110, { steps: 10, holdMs: 500 })
  log(`T2 debug: ${JSON.stringify(await debugSnap())}`)

  // T3: sustained slide (continuous rotation, 3 progressive shots)
  await page.evaluate(() => {
    const look = document.getElementById('look')!
    look.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 89, pointerType: 'touch', isPrimary: true, buttons: 1,
        button: 0, clientX: 320, clientY: 120, bubbles: true, cancelable: true,
      }),
    )
  })
  for (let i = 1; i <= 30; i++) {
    await page.evaluate((x) => {
      document.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 89, pointerType: 'touch', isPrimary: true, buttons: 1,
          button: 0, clientX: x, clientY: 120, bubbles: true, cancelable: true,
        }),
      )
    }, 320 + i * 8)
    await new Promise((r) => setTimeout(r, 70))
    if (i === 10 || i === 20) await page.screenshot({ path: `${OUT}/v2-t3-slide-m${i}.png` })
  }
  await page.screenshot({ path: `${OUT}/v2-t3-slide-end.png` })
  await page.evaluate(() => {
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 89, pointerType: 'touch' }),
    )
  })
  await new Promise((r) => setTimeout(r, 800))
  log(`T3 (sustained slide) debug: ${JSON.stringify(await debugSnap())}`)

  // T4: bare tap on #look (no move) → nothing should change
  await page.evaluate(() => {
    const look = document.getElementById('look')!
    look.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 90, pointerType: 'touch', isPrimary: true, buttons: 1,
        button: 0, clientX: 400, clientY: 130, bubbles: true, cancelable: true,
      }),
    )
  })
  await new Promise((r) => setTimeout(r, 700))
  await page.screenshot({ path: `${OUT}/v2-t4-tap-hold.png` })
  await page.evaluate(() => {
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 90, pointerType: 'touch' }),
    )
  })
  await new Promise((r) => setTimeout(r, 900))
  await page.screenshot({ path: `${OUT}/v2-t4-tap-after.png` })
  log(`T4 (bare tap) debug: ${JSON.stringify(await debugSnap())}`)

  // T5: multi-touch — walk with left stick (pointer 21) WHILE dragging look
  await page.evaluate(() => {
    const move = document.getElementById('move')!
    move.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 21, pointerType: 'touch', isPrimary: true, buttons: 1,
        button: 0, clientX: 90, clientY: 240, bubbles: true, cancelable: true,
      }),
    )
  })
  await page.evaluate(() => {
    const look = document.getElementById('look')!
    look.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 22, pointerType: 'touch', isPrimary: false, buttons: 1,
        button: 0, clientX: 380, clientY: 110, bubbles: true, cancelable: true,
      }),
    )
  })
  for (let i = 1; i <= 16; i++) {
    await page.evaluate(({ ly, my, i }) => {
      // pointer 21 = walk stick (drag UP from its start), pointer 22 = camera
      document.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 21, pointerType: 'touch', isPrimary: true, buttons: 1,
          button: 0, clientX: 90, clientY: my, bubbles: true, cancelable: true,
        }),
      )
      document.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 22, pointerType: 'touch', isPrimary: false, buttons: 1,
          button: 0, clientX: 380 + i * 10, clientY: ly, bubbles: true, cancelable: true,
        }),
      )
    }, { ly: 110, my: 240 - i * 3, i })
    await new Promise((r) => setTimeout(r, 70))
  }
  const midMulti = await readAxes()
  await page.screenshot({ path: `${OUT}/v2-t5-multi-mid.png` })
  await page.evaluate(() => {
    for (const pid of [21, 22]) {
      document.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'touch' }),
      )
    }
  })
  await new Promise((r) => setTimeout(r, 800))
  log(`T5 (multi-touch) mid axes=${JSON.stringify(midMulti)} — expect move axes ~[0,-0.7] AND look events growing: ${JSON.stringify(await debugSnap())}`)

  // T6: armed + drag (weapon out, camera must stay 3rd person)
  await page.keyboard.type('THUGSTOOLS', { delay: 60 })
  await page.waitForTimeout(2500)
  await dragLook('t6-armed-right', 370, 110, 200, 0, { steps: 14, holdMs: 400 })
  const armedStates = await statesOnly(page)
  log(`T6 armed: gun=${armedStates['data-state-gun']} scope=${armedStates['data-state-scope-mode']},${armedStates['data-state-scope-gun']} debug=${JSON.stringify(await debugSnap())}`)

  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/v2-9-final.png` })

  // final engine-mouse-log audit: our injected deltas must be present with
  // target=canvas and movement matching finger deltas × gain
  const mouseAudit = await page.evaluate(() => {
    const ml = (window as any).__vcMouseLog as any[]
    if (!Array.isArray(ml)) return { total: -1 }
    const canvas = ml.filter((e) => e.target === 'canvas')
    const moved = canvas.filter((e) => Math.abs(e.mx) > 0 || Math.abs(e.my) > 0)
    return { total: ml.length, canvas: canvas.length, withDelta: moved.length, sample: moved.slice(0, 4) }
  })
  log(`ENGINE MOUSE AUDIT: ${JSON.stringify(mouseAudit)}`)

  fs.writeFileSync(`${OUT}/v2-test.log`, LOG.join('\n'))
  fs.writeFileSync(
    `${OUT}/v2-report.json`,
    JSON.stringify({ loadSeries: series.slice(0, 80), mouseAudit }, null, 2),
  )
  await (ctx as any).close()
  await browser.close()
}

main().catch((e) => {
  LOG.push(`FATAL: ${e?.stack || e}`)
  fs.writeFileSync(`${OUT}/v2-test.log`, LOG.join('\n'))
  console.error(e)
  process.exit(1)
})
