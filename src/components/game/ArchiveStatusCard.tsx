'use client'

import { useEffect, useState } from 'react'

interface ArchiveStatus {
  state: 'idle' | 'downloading' | 'indexing' | 'ready' | 'error'
  downloaded: number
  total: number
  progress: number
  files: number
  folders: number
  error?: string
}

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0)
}

const STATE_LABELS: Record<ArchiveStatus['state'], string> = {
  idle: '等待启动',
  downloading: '正在拉取游戏资源包',
  indexing: '正在建立资源索引',
  ready: '游戏数据已就绪',
  error: '初始化失败',
}

export function ArchiveStatusCard() {
  const [status, setStatus] = useState<ArchiveStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    // Kick off preparation, then poll until terminal state.
    fetch('/api/archive/prepare', { method: 'POST' }).catch(() => {})

    const poll = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/archive/status', { cache: 'no-store' })
        const data: ArchiveStatus = await res.json()
        if (!cancelled) setStatus(data)
        return data.state === 'ready' || data.state === 'error'
      } catch {
        return false
      }
    }

    const tick = async () => {
      const done = await poll()
      if (!done && !cancelled) {
        setTimeout(tick, 1200)
      } else if (!cancelled) {
        // One final refresh a bit later to confirm.
        setTimeout(() => {
          if (!cancelled) poll()
        }, 3000)
      }
    }
    tick()

    return () => {
      cancelled = true
    }
  }, [])

  const state = status?.state ?? 'idle'
  const isReady = state === 'ready'
  const isError = state === 'error'
  const pct = status?.progress ?? 0

  return (
    <div
      className="vc-status-card"
      role="status"
      aria-live="polite"
      style={{
        margin: '0 auto 1.5rem auto',
        maxWidth: 560,
        borderRadius: 12,
        border: '1px solid rgba(255, 77, 166, 0.35)',
        background: 'rgba(16, 10, 54, 0.75)',
        padding: '14px 18px',
        textAlign: 'left',
        boxShadow: '0 0 24px rgba(255, 77, 166, 0.12)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: isReady ? '#4ade80' : isError ? '#f87171' : '#24c6ff',
              boxShadow: `0 0 10px ${isReady ? '#4ade80' : isError ? '#f87171' : '#24c6ff'}`,
              animation:
                isReady || isError ? 'none' : 'vcPulse 1.2s ease-in-out infinite',
            }}
          />
          <span style={{ color: '#cbb8ff', fontWeight: 600, fontSize: 15 }}>
            {STATE_LABELS[state]}
          </span>
        </div>
        <span style={{ color: '#8975c3', fontSize: 13 }}>
          {isReady
            ? `${status?.files.toLocaleString()} 个资源文件`
            : state === 'downloading' && status
              ? `${formatMB(status.downloaded)} / ${formatMB(status.total)} MB · ${pct}%`
              : state === 'error'
                ? '—'
                : '…'}
        </span>
      </div>

      {!isReady && !isError && (
        <div
          style={{
            marginTop: 10,
            height: 6,
            borderRadius: 999,
            background: 'rgba(137, 117, 195, 0.25)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${Math.max(pct, state === 'indexing' ? 100 : 2)}%`,
              borderRadius: 999,
              background: 'linear-gradient(90deg, #ff4da6, #24c6ff)',
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      )}

      {isError && (
        <p style={{ margin: '8px 0 0', color: '#f8a7a7', fontSize: 13 }}>
          {status?.error ?? '未知错误'} — 请刷新页面重试。
        </p>
      )}

      {isReady && (
        <p style={{ margin: '8px 0 0', color: '#7ee2a8', fontSize: 13 }}>
          首次游玩需下载约 130 MB 引擎数据（自动缓存到浏览器），之后即可秒开。
        </p>
      )}
    </div>
  )
}

/**
 * Slim, non-intrusive variant used on the game-only entry page:
 * renders NOTHING once the archive is ready, and a fixed bottom bar while
 * the archive is still downloading/indexing (so the player knows why
 * "Click to play" may stall on a cold server).
 */
export function ArchiveNotice() {
  const [status, setStatus] = useState<ArchiveStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    // Kick off preparation, then poll until terminal state.
    fetch('/api/archive/prepare', { method: 'POST' }).catch(() => {})

    const poll = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/archive/status', { cache: 'no-store' })
        const data: ArchiveStatus = await res.json()
        if (!cancelled) setStatus(data)
        return data.state === 'ready' || data.state === 'error'
      } catch {
        return false
      }
    }

    const tick = async () => {
      const done = await poll()
      if (!done && !cancelled) {
        setTimeout(tick, 1500)
      }
    }
    tick()

    return () => {
      cancelled = true
    }
  }, [])

  const state = status?.state ?? 'idle'
  // Ready → render nothing; early idle ticks also stay invisible for a moment
  // to avoid a flash before the first status response arrives.
  if (state === 'ready' || state === 'idle') return null

  const isError = state === 'error'
  const pct = status?.progress ?? 0

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        zIndex: 2000,
        maxWidth: 'min(92vw, 480px)',
        width: 'max-content',
        borderRadius: 999,
        border: '1px solid rgba(255, 77, 166, 0.4)',
        background: 'rgba(16, 10, 54, 0.92)',
        backdropFilter: 'blur(12px)',
        padding: '9px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: '#cbb8ff',
        fontSize: 13,
        lineHeight: 1.4,
        boxShadow: '0 0 24px rgba(255, 77, 166, 0.18)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          flex: 'none',
          background: isError ? '#f87171' : '#24c6ff',
          boxShadow: `0 0 10px ${isError ? '#f87171' : '#24c6ff'}`,
          animation: isError ? 'none' : 'vcPulse 1.2s ease-in-out infinite',
        }}
      />
      {isError ? (
        <span style={{ color: '#f8a7a7' }}>
          游戏资源初始化失败：{status?.error ?? '未知错误'}，请刷新重试
        </span>
      ) : state === 'downloading' ? (
        <span>
          服务器正在拉取游戏资源包 {formatMB(status?.downloaded ?? 0)}/{formatMB(status?.total ?? 0)} MB · {pct}%
        </span>
      ) : (
        <span>正在建立资源索引，马上就好…</span>
      )}
    </div>
  )
}
