import './vc-game.css'
import GameShell from '@/components/game/GameShell'
import { ArchiveNotice } from '@/components/game/ArchiveStatusCard'

/**
 * Entry page = the game itself.
 *
 * There is no marketing/landing content anymore: the user lands directly on
 * the reVCDOS launcher (cover art + "Click to play") exactly like the upstream
 * dist/index.html, and one click starts the game.
 *
 * The only extra chrome is <ArchiveNotice/>, a slim status bar that appears
 * solely while the 1.08 GB server-side archive is still downloading/indexing
 * (it renders nothing once the archive is ready).
 */
export default function Home() {
  return (
    <main className="vc-entry" style={{ minHeight: '100dvh' }}>
      <GameShell />
      <ArchiveNotice />
    </main>
  )
}
