'use client'

/**
 * GameShell — reproduces the exact DOM contract that the reVCDOS client
 * (public/game/game.js + engine modules) expects, then boots the engine
 * scripts in the same order as the upstream dist/index.html:
 *
 *   GamepadEmulator.js → jsdos-cloud-sdk(.local).js → idbfs.js → game.js
 *
 * The engine scripts are plain global scripts: they query the DOM at load
 * time and attach their own listeners, so every element below keeps the
 * original ids and class names. Do not rename.
 */

import { useEffect } from 'react'

declare global {
  interface Window {
    __vcGameBooted?: boolean
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-vc-src="${src}"]`,
    )
    if (existing) {
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = false
    s.setAttribute('data-vc-src', src)
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load module: ${src}`))
    document.body.appendChild(s)
  })
}

export default function GameShell() {
  useEffect(() => {
    const body = document.body

    // Register the archive Service Worker: it serves /vcsky and /vcbr
    // requests directly from the static mirror (browser-side ranged reads +
    // WASM brotli), falling back to the server proxy. see public/sw.js.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.warn('[sw] registration failed:', err))
    }

    // Initial touch-state machine attributes (the engine mutates these later).
    const stateDefaults: Record<string, string> = {
      'data-is-touch': '0',
      'data-state-car': '0',
      'data-state-car-gun': '0',
      'data-state-gun': '0',
      'data-state-bike': '0',
      'data-state-menu': '1',
      'data-state-cutscene': '0',
      'data-state-mobring': '0',
      'data-state-job': '0',
      'data-state-disable-controls': '0',
      'data-state-panzer': '0',
      'data-state-car-with-weapon': '0',
      'data-state-hunter': '0',
      'data-state-scope-mode': '0',
      'data-state-scope-gun': '0',
    }
    for (const [key, value] of Object.entries(stateDefaults)) {
      if (!body.hasAttribute(key)) body.setAttribute(key, value)
    }

    // Mirror the upstream inline script: force touch controls on touch devices.
    const forceEnableTouchControls = () => body.setAttribute('data-is-touch', '1')
    if (
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      window.matchMedia('(pointer: coarse)').matches
    ) {
      forceEnableTouchControls()
    }
    window.addEventListener('touchstart', forceEnableTouchControls, { once: true })

    if (window.__vcGameBooted) return
    window.__vcGameBooted = true

    const params = new URLSearchParams(window.location.search)
    const customSaves = params.get('custom_saves') === '1'
    const scripts = [
      '/game/GamepadEmulator.js',
      customSaves ? '/game/jsdos-cloud-sdk-local.js' : '/game/jsdos-cloud-sdk.js',
      '/game/idbfs.js',
      '/game/game.js',
    ]

    void (async () => {
      for (const src of scripts) {
        try {
          await loadScript(src)
        } catch (err) {
          console.error(err)
        }
      }
    })()
  }, [])

  return (
    <>
      {/* Portrait-orientation hint for phones (CSS shows it only pre-game) */}
      <div className="rotate-hint" aria-hidden>
        <span>建议横屏游玩，体验更佳</span>
      </div>

      {/* Game-over overlay (engine shows it via showWasted) */}
      <div className="wasted-container" hidden />

      {/* Intro video + loader (shown while the engine downloads data) */}
      <div className="intro-container" hidden>
        <video className="intro" src="/game/intro.mp4" playsInline />
        <div className="loader-container">
          <div className="progress-bar-container" id="spinner">
            <div className="progress-bar-fill" />
          </div>
          <div id="status">Downloading...</div>
          <div>
            <progress id="progress" />
          </div>
        </div>
      </div>

      {/* Start screen — the original reVCDOS launcher UI */}
      <div className="start-container">
        <div className="button-container">
          <div className="cover" />

          <div id="config-panel" className="config-panel" style={{ display: 'none' }}>
            <div className="config-option">
              <label htmlFor="config-lang">
                <span id="config-lang-label">Language:</span>
                <select
                  id="config-lang"
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid #2a1759',
                    color: '#fff',
                    padding: '0.3em',
                    borderRadius: '0.3em',
                    marginLeft: '0.5em',
                  }}
                >
                  <option value="zh">简体中文（界面）</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <div className="config-option">
              <label htmlFor="config-cheats">
                <input type="checkbox" id="config-cheats" />
                <span id="config-cheats-label">Cheats (F3)</span>
              </label>
            </div>
            <div className="config-option">
              <label htmlFor="config-fullscreen">
                <input type="checkbox" id="config-fullscreen" defaultChecked />
                <span id="config-fullscreen-label">Fullscreen</span>
              </label>
            </div>
            <div className="config-option">
              <label htmlFor="config-max-fps">
                <span id="config-max-fps-label">Max FPS:</span>
                <input
                  type="number"
                  id="config-max-fps"
                  min={0}
                  max={240}
                  defaultValue={0}
                  style={{ width: '60px' }}
                />
                <span id="config-max-fps-unlimited" style={{ fontSize: '0.8em' }}>
                  (0 = unlimited)
                </span>
              </label>
            </div>
          </div>

          <div className="click-to-play">
            <button id="click-to-play-button">Click to play</button>
            <div id="demo-off-disclaimer" />
          </div>
        </div>

        <div className="follow-container">
          <a id="follow" href="https://dos.zone/revcdos" target="_blank" rel="noreferrer">
            Vice City by DOS Zone Team
          </a>
        </div>

        <div className="jsdos-key">
          <div>
            <span>
              <a id="cloud-saves-link" href="https://v8.js-dos.com/key" target="_blank" rel="noreferrer">
                Cloud saves:
              </a>
            </span>
            <span id="cloud-saves-status" className="jsdos-key-status">
              checking...
            </span>
          </div>
          <input
            type="text"
            className="jsdos-key-input"
            placeholder="Enter js-dos key (5 len)"
            maxLength={32}
          />
        </div>

        <div className="disclaimer">
          <span id="disclaimer-text" className="warning">
            DISCLAIMER:
          </span>
          <span className="eula">
            <span id="disclaimer-sources">
              This game is based on an open source version of GTA: Vice City. It is not a
              commercial release and is not affiliated with Rockstar Games.
            </span>
            (
            <a href="https://github.com/SugaryHull/re3/tree/miami" target="_blank" rel="noreferrer">
              github
            </a>
            )
            <p id="play-demo-text" className="warning">
              You can play the DEMO version, or provide the original game files to continue
              playing.
            </p>
            <p style={{ marginBottom: 0 }}>
              <input type="checkbox" id="disclaimer-checkbox" />
              <label id="disclaimer-checkbox-label" htmlFor="disclaimer-checkbox">
                I own the original game
              </label>
            </p>
          </span>
        </div>

        <div className="developed-by">
          <span id="port-by">HTML5 port by:</span>
          <a href="https://github.com/okhmanyuk-ev" target="_blank" rel="noreferrer">
            @specialist003
          </a>
          ,{' '}
          <a href="https://www.youtube.com/caiiiycuk" target="_blank" rel="noreferrer">
            @caiiiycuk
          </a>
          ,{' '}
          <a href="https://t.me/ser_var" target="_blank" rel="noreferrer">
            @SerGen
          </a>
          <div style={{ marginTop: '0.5em' }}>
            <span>
              Deobfuscated by:{' '}
              <a href="https://github.com/Lolendor" target="_blank" rel="noreferrer">
                @Lolendor
              </a>
            </span>
          </div>
          <div>
            <span>
              Repo:{' '}
              <a href="https://github.com/Lolendor/reVCDOS" target="_blank" rel="noreferrer">
                GitHub (Lolendor/reVCDOS)
              </a>
            </span>
          </div>
        </div>
      </div>

      {/* Ownership verification file input */}
      <input type="file" id="original-game-file" hidden />

      {/* The game canvas */}
      <canvas
        className="emscripten"
        id="canvas"
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Mobile touch controls (visible only while the game runs on touch devices) */}
      <div className="touch-controls-wrapper">
        <div id="move" />
        <div id="look" />
        <div className="touch-control radio" />
        <div className="touch-control weapon" />
        <div className="touch-control menu" />
        <div className="touch-control fist" />
        <div className="touch-control drift" />
        <div className="touch-control run" />
        <div className="touch-control car getIn" />
        <div className="touch-control left" />
        <div className="touch-control right" />
        <div className="touch-control jump" />
        <div className="touch-control car getOut" />
        <div className="touch-control camera" />
        <div className="touch-control mobile" />
        <div className="touch-control job" />
        <div className="touch-control horn" />
        <div className="touch-control fireRight" />
        <div className="touch-control fireLeft" />
      </div>
    </>
  )
}
