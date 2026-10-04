#!/usr/bin/env node
/**
 * Replace text inside a file, safely, on Windows.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four core modules of a sibling plugin were destroyed by one PowerShell loop:
 *
 *   $new = $text -replace 'pattern', 'replacement'
 *   Set-Content -Path $f -Value $new -NoNewline -Encoding UTF8
 *
 * `Get-Content -Raw` on Windows PowerShell 5.1 decodes a BOM-less UTF-8 file as the system ANSI
 * code page (936 on a Simplified Chinese machine), and `Set-Content -Encoding UTF8` then writes
 * those mis-decoded characters back. Every Chinese string in every processed file became mojibake,
 * and there was no clean copy to restore from. The lesson is not "be careful with PowerShell" — it
 * is "do in-place text edits with a tool that cannot do that".
 *
 * This is that tool. It reads UTF-8, writes UTF-8 without a BOM, refuses to touch a file that
 * already contains a replacement character (a sign it has been damaged once already), and reports
 * exactly how many replacements it made.
 *
 *   node scripts/replace-in-file.mjs <file> <search> <replacement> [--regex] [--all] [--dry-run]
 *
 * Without `--all` it requires exactly one match, because a global replace is the thing that turns
 * one intended edit into eight unintended ones.
 *
 * @module dsh-tts/scripts/replace-in-file
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [file, search, replacement, ...flags] = process.argv.slice(2)
if (file === undefined || search === undefined || replacement === undefined) {
  console.error('用法：node scripts/replace-in-file.mjs <file> <search> <replacement> [--regex] [--all] [--dry-run]')
  process.exitCode = 2
} else {
  const useRegex = flags.includes('--regex')
  const replaceAll = flags.includes('--all')
  const dryRun = flags.includes('--dry-run')

  const before = readFileSync(file, 'utf8')
  if (before.includes('\uFFFD')) {
    console.error(`拒绝改写：${file} 里已经含有 U+FFFD（替换字符），说明它此前被错误地重编码过。`)
    console.error('先找到干净副本，或从 git 恢复；在已损坏的文件上继续改写只会让损失不可逆。')
    process.exitCode = 1
  } else {
    const pattern = useRegex ? new RegExp(search, 'gu') : search
    const count = useRegex ? (before.match(new RegExp(search, 'gu')) ?? []).length : before.split(search).length - 1
    if (count === 0) {
      console.error(`没有匹配：${useRegex ? '正则' : '字面量'} ${JSON.stringify(search)}`)
      process.exitCode = 1
    } else if (count > 1 && !replaceAll) {
      console.error(`匹配到 ${count} 处；确认要全部替换时加 --all。`)
      process.exitCode = 1
    } else {
      const after = useRegex ? before.replace(pattern, replacement) : before.split(search).join(replacement)
      if (!dryRun) writeFileSync(file, after, { encoding: 'utf8' })
      console.log(`${dryRun ? '（dry-run）' : ''}改写 ${count} 处：${file}`)
      console.log(`字节：${Buffer.byteLength(before, 'utf8')} → ${Buffer.byteLength(after, 'utf8')}；写回为 UTF-8 无 BOM`)
    }
  }
}
