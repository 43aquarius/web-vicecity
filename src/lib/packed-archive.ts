/**
 * Node.js port of reVCDOS PackedArchive (utils/packer_brotli.py).
 *
 * Archive format (sequential):
 *   For each folder:
 *     - folder type byte: 0 = normal, 1 = copy of another folder
 *     - ULEB128 length + UTF-8 folder name
 *     - type 0: ULEB128 numFiles, then per file:
 *         ULEB128 len + UTF-8 filename
 *         file type byte: 0 = content, 1 = reference
 *         content:   ULEB128 compressedSize + brotli bytes (skipped while indexing)
 *         reference: ULEB128 len + sourceFolder, ULEB128 len + sourceFilename
 *     - type 1: ULEB128 len + source folder name
 *
 * Stored file bytes are always brotli-compressed content (.br files are stored
 * as-is so they are not double-compressed; decompression still yields the file).
 */

import { open, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { brotliDecompressSync, createBrotliDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
import type { FileHandle } from 'node:fs/promises'

const FOLDER_TYPE_NORMAL = 0
const FOLDER_TYPE_COPY = 1
const FILE_TYPE_CONTENT = 0
const FILE_TYPE_REFERENCE = 1

const WINDOW_SIZE = 4 * 1024 * 1024

interface FileEntry {
  folder: string
  filename: string
  fileType: number
  dataOffset: number
  compressedSize: number
  refFolder: string
  refFilename: string
}

/** Serialisable flat index: [path, dataOffset, compressedSize] per file. */
export interface PackedIndex {
  v: number
  size: number
  files: number
  folders: number
  totalCompressed: number
  entries: Array<[string, number, number]>
}

export interface ArchiveStats {
  folders: number
  files: number
  totalCompressed: number
  archiveSize: number
}

/** Sequential chunked reader over a file handle with a sliding window. */
class ChunkedReader {
  private buf: Buffer = Buffer.alloc(WINDOW_SIZE)
  private bufStart = 0
  private bufLen = 0
  pos = 0

  constructor(private fh: FileHandle) {}

  private async ensure(size: number): Promise<void> {
    if (this.pos >= this.bufStart && this.pos + size <= this.bufStart + this.bufLen) return
    const { bytesRead } = await this.fh.read(this.buf, 0, this.buf.length, this.pos)
    this.bufLen = bytesRead
    this.bufStart = this.pos
    if (bytesRead < size) {
      throw new Error(
        `Unexpected end of archive at ${this.pos} (needed ${size} bytes, got ${bytesRead})`,
      )
    }
  }

  async byte(): Promise<number> {
    await this.ensure(1)
    const v = this.buf[this.pos - this.bufStart]
    this.pos += 1
    return v
  }

  async bytes(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0)
    await this.ensure(n)
    const v = this.buf.subarray(this.pos - this.bufStart, this.pos - this.bufStart + n)
    this.pos += n
    return v
  }

  async uleb(): Promise<number> {
    let result = 0
    let shift = 0
    for (;;) {
      const b = await this.byte()
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
      if (shift > 35) throw new Error('ULEB128 value too large')
    }
    return result
  }

  skip(n: number): void {
    this.pos += n
  }
}

export class PackedArchive {
  private entries = new Map<string, FileEntry>()
  private folders = new Map<string, string[]>()
  private fh: FileHandle | null = null
  private initialized = false
  stats: ArchiveStats = { folders: 0, files: 0, totalCompressed: 0, archiveSize: 0 }

  constructor(private readonly archivePath: string) {}

  get isInitialized(): boolean {
    return this.initialized
  }

  /** Walk the archive and build the file index. */
  async init(): Promise<void> {
    if (this.initialized) return
    const st = await stat(this.archivePath)
    this.stats.archiveSize = st.size
    this.fh = await open(this.archivePath, 'r')

    const reader = new ChunkedReader(this.fh)
    let folderCount = 0

    while (reader.pos < st.size) {
      const folderType = await reader.byte()
      const nameLen = await reader.uleb()
      const folderName = (await reader.bytes(nameLen)).toString('utf-8')
      folderCount++

      if (folderType === FOLDER_TYPE_COPY) {
        const srcLen = await reader.uleb()
        const srcName = (await reader.bytes(srcLen)).toString('utf-8')
        const srcFiles = this.folders.get(srcName) ?? []
        this.folders.set(folderName, [...srcFiles])
        for (const filename of srcFiles) {
          const srcEntry = this.entries.get(`${srcName}/${filename}`)
          if (srcEntry) {
            this.entries.set(`${folderName}/${filename}`, { ...srcEntry, folder: folderName })
          }
        }
        continue
      }

      if (folderType !== FOLDER_TYPE_NORMAL) {
        throw new Error(`Unknown folder type ${folderType} at pos ${reader.pos}`)
      }

      const numFiles = await reader.uleb()
      const files: string[] = []
      for (let i = 0; i < numFiles; i++) {
        const fnLen = await reader.uleb()
        const filename = (await reader.bytes(fnLen)).toString('utf-8')
        const fileType = await reader.byte()
        const fullPath = `${folderName}/${filename}`
        files.push(filename)

        if (fileType === FILE_TYPE_REFERENCE) {
          const sfl = await reader.uleb()
          const refFolder = (await reader.bytes(sfl)).toString('utf-8')
          const sfnl = await reader.uleb()
          const refFilename = (await reader.bytes(sfnl)).toString('utf-8')
          this.entries.set(fullPath, {
            folder: folderName,
            filename,
            fileType: FILE_TYPE_REFERENCE,
            dataOffset: 0,
            compressedSize: 0,
            refFolder,
            refFilename,
          })
        } else if (fileType === FILE_TYPE_CONTENT) {
          const compressedSize = await reader.uleb()
          this.entries.set(fullPath, {
            folder: folderName,
            filename,
            fileType: FILE_TYPE_CONTENT,
            dataOffset: reader.pos,
            compressedSize,
            refFolder: '',
            refFilename: '',
          })
          reader.skip(compressedSize)
        } else {
          throw new Error(`Unknown file type ${fileType} in ${fullPath}`)
        }
      }
      this.folders.set(folderName, files)
    }

    let fileCount = 0
    let totalCompressed = 0
    for (const e of this.entries.values()) {
      if (e.fileType === FILE_TYPE_CONTENT) {
        fileCount++
        totalCompressed += e.compressedSize
      }
    }

    this.stats = { folders: folderCount, files: fileCount, totalCompressed, archiveSize: st.size }
    this.initialized = true
  }

  /** Resolve an entry, following references. */
  resolve(path: string): FileEntry | null {
    const normalized = path.replace(/^\/+/, '').replace(/\/+/g, '/')
    let entry = this.entries.get(normalized)
    let depth = 0
    while (entry && entry.fileType === FILE_TYPE_REFERENCE && depth < 16) {
      entry = this.entries.get(`${entry.refFolder}/${entry.refFilename}`)
      depth++
    }
    return entry && entry.fileType === FILE_TYPE_CONTENT ? entry : null
  }

  has(path: string): boolean {
    return this.resolve(path) !== null
  }

  /** Read the stored (brotli-compressed) bytes for a path. */
  async readRaw(path: string): Promise<Buffer | null> {
    const entry = this.resolve(path)
    if (!entry || !this.fh) return null
    const buf = Buffer.alloc(entry.compressedSize)
    const { bytesRead } = await this.fh.read(buf, 0, entry.compressedSize, entry.dataOffset)
    if (bytesRead !== entry.compressedSize) {
      throw new Error(`Short read for ${path}: ${bytesRead}/${entry.compressedSize}`)
    }
    return buf
  }

  /** Read and decompress a file. keepBrotli=true returns the raw stored bytes. */
  async open(path: string, keepBrotli = false): Promise<Buffer | null> {
    const raw = await this.readRaw(path)
    if (raw === null) return null
    if (keepBrotli) return raw
    return brotliDecompressSync(raw)
  }

  /** Stream the raw stored bytes (for brotli passthrough serving). */
  streamRaw(path: string): ReadableStream<Uint8Array> | null {
    const entry = this.resolve(path)
    if (!entry) return null
    const nodeStream = createReadStream(this.archivePath, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
    })
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
  }

  /**
   * Stream the DECOMPRESSED content with bounded memory.
   *
   * Unlike open(), which decompresses the whole file synchronously into one
   * buffer (fine for small files, a memory bomb for large ones), this pipes
   * the stored bytes through zlib's streaming brotli decoder, so memory stays
   * at a few pipe buffers regardless of file size. Semantics are identical to
   * open(path, false) — including for .br files (stored as-is), where
   * decompressing yields the original file.
   */
  streamDecompressed(path: string): ReadableStream<Uint8Array> | null {
    const entry = this.resolve(path)
    if (!entry) return null
    const nodeStream = createReadStream(this.archivePath, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
    })
    const decoder = createBrotliDecompress()
    const piped = nodeStream.pipe(decoder)
    // Surface decompression errors on the web stream instead of letting an
    // unhandled 'error' event take the process down.
    const errored = new Promise<never>((_, reject) => {
      piped.on('error', reject)
    })
    const web = Readable.toWeb(piped) as ReadableStream<Uint8Array>
    return new ReadableStream<Uint8Array>({
      start(controller) {
        errored.catch((err) => {
          try {
            controller.error(err)
          } catch {
            /* controller already closed */
          }
        })
        const reader = web.getReader()
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              controller.close()
              return
            }
            controller.enqueue(value)
            return pump()
          })
        pump().catch((err: unknown) => {
          try {
            controller.error(err)
          } catch {
            /* controller already closed */
          }
        })
      },
      cancel(reason) {
        return web.cancel(reason)
      },
    })
  }

  listFiles(folder?: string): string[] {
    if (folder) return this.folders.get(folder) ?? []
    return [...this.entries.keys()]
  }

  /**
   * Flat, JSON-serialisable index of every servable path.
   *
   * References and folder copies are resolved away, so the loader (server
   * RemoteArchive or the browser Service Worker) can serve any path with a
   * plain table lookup: entries[path] → [dataOffset, compressedSize] inside
   * the archive byte stream.
   */
  dumpIndex(): PackedIndex {
    const entries: Array<[string, number, number]> = []
    for (const [path, e] of this.entries) {
      const resolved = e.fileType === FILE_TYPE_CONTENT ? e : this.resolve(path)
      if (resolved && resolved.fileType === FILE_TYPE_CONTENT) {
        entries.push([path, resolved.dataOffset, resolved.compressedSize])
      }
    }
    return {
      v: 1,
      size: this.stats.archiveSize,
      files: entries.length,
      folders: this.stats.folders,
      totalCompressed: this.stats.totalCompressed,
      entries,
    }
  }

  listFolders(): string[] {
    return [...this.folders.keys()]
  }

  async close(): Promise<void> {
    if (this.fh) {
      await this.fh.close()
      this.fh = null
    }
    this.initialized = false
  }
}
