import { humanSize } from './util.js'

/** Shared result envelope for every pdf tool. */
export interface PdfResult {
  ok: boolean
  action: string
  output: string
  outputs?: string[]
  pages?: number
  inputBytes?: number
  outputBytes?: number
  detail?: string
}

export function ok(action: string, output: string, extra: Partial<PdfResult> = {}): PdfResult {
  return { ok: true, action, output, ...extra }
}

export function failure(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `pdf ${action} 失败: ${message}`
}

export function formatResult(result: PdfResult): string {
  const lines = [`✓ pdf ${result.action}`, `输出: ${result.output}`]
  if (result.outputs && result.outputs.length > 1) lines.push(`共 ${result.outputs.length} 个文件: ${result.outputs.join(', ')}`)
  if (result.pages !== undefined) lines.push(`页数: ${result.pages}`)
  if (result.inputBytes !== undefined && result.outputBytes !== undefined) {
    const ratio = result.inputBytes > 0 ? (100 - (result.outputBytes * 100) / result.inputBytes).toFixed(1) : '0'
    lines.push(`大小: ${humanSize(result.inputBytes)} → ${humanSize(result.outputBytes)}${result.action === 'compress' ? `（减少 ${ratio}%）` : ''}`)
  }
  if (result.detail) lines.push(result.detail)
  return lines.join('\n')
}
