/**
 * Verify the vendored IIFE brotli decoder (public/game/brotli-dec.js)
 * against real archive data, exactly the way the Service Worker will use it.
 */
import { readFileSync } from 'node:fs'

const glueSrc = readFileSync('public/game/brotli-dec.js', 'utf-8')
const wasm = readFileSync('public/game/brotli_dec_wasm_bg.wasm')

// Emulate the SW top-level scope: `var __BrotliDec = ...` becomes a global.
const fn = new Function('importScripts', glueSrc + '\nreturn __BrotliDec;')
const BrotliDec = fn(() => {})
if (!BrotliDec) throw new Error('IIFE did not attach __BrotliDec')

// initSync with an ArrayBuffer (same as SW: fetch → arrayBuffer → initSync)
BrotliDec.initSync(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))
if (typeof BrotliDec.decompress !== 'function') throw new Error('glue decompress missing')

// Real compressed bytes from the local archive: small asset
const { PackedArchive } = await import('../src/lib/packed-archive')
const arc = new PackedArchive('.revcdos-cache/revcdos.bin')
await arc.init()

const small = 'vcsky/fetched/anim/cuts.img/ass_1.ifp'
const rawBr = await arc.readRaw(small)
const out = BrotliDec.decompress(new Uint8Array(rawBr))
const ref = await arc.open(small, false)
console.log(`${small}: dec=${out.length} ref=${ref.length} equal=${Buffer.compare(Buffer.from(out), ref) === 0}`)
if (Buffer.compare(Buffer.from(out), ref) !== 0) throw new Error('mismatch')

// wasm package (7.6MB) — size-class representative
const wasmPath = 'vcbr/vc-sky-en-v6.wasm.br'
const wasmBr = await arc.readRaw(wasmPath)
const t0 = Date.now()
const out2 = BrotliDec.decompress(new Uint8Array(wasmBr))
console.log(`${wasmPath}: dec=${out2.length} in ${Date.now() - t0}ms`)
const ref2 = await arc.open(wasmPath, false)
if (Buffer.compare(Buffer.from(out2), ref2) !== 0) throw new Error('wasm mismatch')
console.log('ALL OK')
