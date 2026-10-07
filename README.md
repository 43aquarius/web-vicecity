# web-vicecity — archive data branch

This branch holds the reVCDOS packed game archive (`revcdos.bin`, 1,084,364,719 bytes)
split into 96,000,000-byte parts (`revcdos.bin.part00` … `revcdos.bin.part11`).

It exists so the browser Service Worker (`public/sw.js` of the `main` branch) can
fetch arbitrary byte ranges of the archive directly via
`raw.githubusercontent.com` (cross-origin ranged reads), with no game server involved.

Do NOT clone this branch casually — it is ~1.1 GB. If you need the archive:

    curl -O https://raw.githubusercontent.com/43aquaris/web-vicecity/archive-data/revcdos.bin.partNN
    cat revcdos.bin.part* > revcdos.bin
    sha256sum -c SHA256SUMS

The main branch README has full details.
