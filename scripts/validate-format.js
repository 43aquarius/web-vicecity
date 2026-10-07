// Quick format validation: parse the first folders of the partial archive
const fs = require('fs')

const path = '/home/z/my-project/.revcdos-cache/revcdos.bin'
const fd = fs.openSync(path, 'r')
const stat = fs.fstatSync(fd)
console.log('file size:', stat.size)

const buf = Buffer.alloc(1 << 20) // 1MB window
let bufStart = -1, bufLen = 0
let pos = 0

function ensure(n) {
  if (pos >= bufStart && pos + n <= bufStart + bufLen) return
  const want = Math.max(n, buf.length)
  bufLen = fs.readSync(fd, buf, 0, want, pos)
  bufStart = pos
}

function byte() {
  ensure(1)
  const v = buf[pos - bufStart]
  pos += 1
  return v
}

function bytes(n) {
  if (n === 0) return Buffer.alloc(0)
  ensure(n)
  const v = buf.subarray(pos - bufStart, pos - bufStart + n)
  pos += n
  return v
}

function uleb() {
  let result = 0, shift = 0
  for (;;) {
    const b = byte()
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return result
}

// Walk folders (limited count for validation)
let folderCount = 0, fileCount = 0, totalCompressed = 0
while (pos < stat.size && folderCount < 500000) {
  const folderType = byte()
  const nameLen = uleb()
  const folderName = bytes(nameLen).toString('utf-8')
  if (folderType === 1) {
    const srcLen = uleb()
    const srcName = bytes(srcLen).toString('utf-8')
    folderCount++
    if (folderCount <= 5) console.log(`COPY folder: "${folderName}" <- "${srcName}"`)
  } else {
    const numFiles = uleb()
    for (let i = 0; i < numFiles; i++) {
      const fnLen = uleb()
      const filename = bytes(fnLen).toString('utf-8')
      const fileType = byte()
      if (fileType === 1) {
        const sfl = uleb(), sf = bytes(sfl).toString('utf-8')
        const sfnl = uleb(), sfn = bytes(sfnl).toString('utf-8')
        if (folderCount < 3 && i < 3) console.log(`  REF: ${folderName}/${filename} -> ${sf}/${sfn}`)
      } else {
        const clen = uleb()
        if (folderCount < 3 && i < 5) console.log(`  FILE: ${folderName}/${filename} compressed=${clen} at=${pos}`)
        totalCompressed += clen
        pos += clen
        fileCount++
      }
    }
    folderCount++
    if (folderCount <= 5) console.log(`FOLDER "${folderName}" files=${numFiles}`)
  }
}

console.log(`\nparsed: pos=${pos} of ${stat.size}`)
console.log(`folders=${folderCount} files=${fileCount} compressedBytes(total)=${totalCompressed}`)
