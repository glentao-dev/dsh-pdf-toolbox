import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export function assertFile(path: string, maxBytes: number): void {
  if (!path || path.trim().length === 0) throw new ToolError('路径不能为空')
  if (!existsSync(path)) throw new ToolError(`文件不存在: ${path}`)
  const st = lstatSync(path)
  if (!st.isFile()) throw new ToolError(`不是普通文件: ${path}`)
  if (st.size > maxBytes) throw new ToolError(`文件超过大小上限 (${(maxBytes / 1048576).toFixed(0)} MB): ${path}`)
}

export function assertPdf(path: string): void {
  assertFile(path, Number.MAX_SAFE_INTEGER)
  // pdf-lib will throw on non-PDF content; a cheap magic check gives a better message.
  const head = readFileSync(path).subarray(0, 1024).toString('latin1')
  if (!head.startsWith('%PDF-')) throw new ToolError(`不是有效的 PDF 文件: ${path}`)
}

export function resolveOutput(output: string | undefined, defaultDir: string, defaultName: string): string {
  if (!output || output.trim().length === 0) return join(defaultDir, defaultName)
  if (!isAbsolute(output)) throw new ToolError(`输出路径必须是绝对路径: ${output}`)
  return resolve(output)
}

export function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Guard an explicit output path against configured output roots. */
export function checkOutputRoot(output: string, roots: string[], inputPath: string): void {
  if (roots.length === 0) return
  const defaultNextToInput = resolve(dirname(inputPath))
  if (startsWithPath(resolve(output), defaultNextToInput)) return
  const real = safeRealpath(resolve(output))
  const ok = roots.some((root) => {
    const realRoot = safeRealpath(resolve(root))
    return startsWithPath(real, realRoot)
  })
  if (!ok) throw new ToolError(`输出路径不在允许的目录内: ${roots.join(', ')}`)
}

function startsWithPath(path: string, prefix: string): boolean {
  if (path === prefix) return true
  const p = prefix.endsWith(sep) ? prefix : prefix + sep
  return path.startsWith(p)
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** "1-5,8,10-12" -> [0,1,2,3,4,7,9,10,11]
 *  Returns ZERO-BASED indices, matching pdf-lib's page-index vocabulary. */
export function parsePageSelection(selection: string, total: number): number[] {
  if (!selection || selection.trim().length === 0) return []
  const out = new Set<number>()
  for (const raw of selection.split(',')) {
    const part = raw.trim()
    if (part.length === 0) continue
    if (part === 'all' || part === '*') {
      for (let i = 1; i <= total; i++) out.add(i)
      continue
    }
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) throw new ToolError(`无法解析页码: ${part}（示例: 1-3,5,8-10）`)
    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : start
    if (start < 1 || end < 1) throw new ToolError(`页码必须 >= 1: ${part}`)
    if (start > end) throw new ToolError(`页码区间起点大于终点: ${part}`)
    for (let i = start; i <= end; i++) out.add(i)
  }
  const pages = [...out].filter((p) => p <= total).sort((a, b) => a - b)
  if (pages.length === 0) throw new ToolError(`页码选择 ${selection} 未命中任何页（共 ${total} 页）`)
  return pages.map((p) => p - 1)
}

export function stampName(path: string, suffix: string, ext = '.pdf'): string {
  const dir = dirname(path)
  const base = path.slice(0, path.length - ext.length).split(sep).pop() ?? 'output'
  return join(dir, `${base}-${suffix}${ext}`)
}

/** Input file name without extension, for deriving output prefixes. */
export function baseName(path: string, ext = '.pdf'): string {
  return (path.slice(0, path.length - ext.length).split(sep).pop() ?? 'output').replace(/\.[^.]+$/, '')
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(2)} MB`
}
