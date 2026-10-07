export async function register(): Promise<void> {
  // Archive warm-up is OPT-IN via REVCDOS_PRELOAD=1.
  //
  // Published containers are small and cold-start frequently. Eagerly
  // downloading the 1.08 GB archive at boot starved them of memory/bandwidth
  // seconds after deploy and got the whole site killed by the platform
  // (ERR_INVALID_RESPONSE). The lazy default keeps boot lightweight: the
  // first visitor triggers preparation via /api/archive/prepare (kicked off
  // by <ArchiveNotice/> on the entry page), with a progress bar while the
  // archive downloads. game.js also polls /api/archive/status and waits for
  // readiness before downloading game data.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.REVCDOS_PRELOAD === '1') {
      const { prepareArchive } = await import('./lib/archive-server')
      prepareArchive()
      console.log('[archive] boot-time preload enabled (REVCDOS_PRELOAD=1)')
    } else {
      console.log('[archive] lazy mode: archive prepares on first visitor (set REVCDOS_PRELOAD=1 to preload at boot)')
    }
  }
}
