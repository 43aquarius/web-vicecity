/**
 * 列出 revcdos.bin 归档中的文件清单，重点排查语言资源包：
 * - 顶层目录结构
 * - vc-sky-* 语言数据包（en / ru / 其他）
 * - 游戏内文本资源（TEXT/*.gxt 等）
 * - 中文相关文件名（chinese / zh / cn / chi）
 */
import { PackedArchive } from '../src/lib/packed-archive'

const ARCHIVE = '/home/z/my-project/.revcdos-cache/revcdos.bin'

async function main() {
  const arc = new PackedArchive(ARCHIVE)
  await arc.init()
  const folders = arc.listFolders()
  console.log('=== 文件夹清单 ===')
  for (const f of folders) console.log('  ' + f)

  const files = arc.listFiles()
  console.log(`\n=== 共 ${files.length} 个文件 ===`)

  // 顶层文件（不属于任何子文件夹的，即 folder 名 == 文件名前缀的部分）
  console.log('\n=== 顶层 / 根级条目（非目录形式） ===')
  for (const p of files) {
    const parts = p.split('/')
    if (parts.length <= 2 && !p.startsWith('vc-sky-')) {
      // 只打印浅层，避免刷屏
      console.log('  ' + p)
    }
  }

  console.log('\n=== vc-sky 语言数据包 ===')
  for (const p of files) {
    if (/^vc-sky-/i.test(p)) console.log('  ' + p)
  }

  console.log('\n=== 语言/本地化相关文件（gxt / lang / text） ===')
  for (const p of files) {
    if (/(\.gxt$|lang|locale|[/\\]text[/\\]|translation)/i.test(p)) console.log('  ' + p)
  }

  console.log('\n=== 中文相关文件名（chinese / zh / cn / chi / cn_） ===')
  const zh = files.filter((p) => /(chinese|[-_.]zh|[-_.]cn|chi[-_.]|cn_|_cn)/i.test(p))
  if (zh.length === 0) console.log('  （未找到中文相关文件）')
  for (const p of zh.slice(0, 200)) console.log('  ' + p)

  // 统计各顶层文件夹的文件数
  console.log('\n=== 各文件夹文件数 ===')
  for (const f of folders) {
    const n = arc.listFiles(f).length
    console.log(`  ${f}: ${n}`)
  }

  await arc.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
