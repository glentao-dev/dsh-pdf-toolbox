import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import { formatResult, ok, failure } from './format.js'
import {
  assertPdf,
  baseName,
  checkOutputRoot,
  ensureDirFor,
  parsePageSelection,
  resolveOutput,
  stampName,
  ToolError,
} from './util.js'

export { Config }
export const name = 'dsh-pdf-toolbox'
export const inject = ['tools']

interface Ctx {
  timeoutMs: number
  maxInputMb: number
  maxPages: number
  outputRoots: string[]
  overwrite: boolean
  watermarkFont: string
  watermarkOpacity: number
  watermarkRotate: number
}

function maxBytes(ctx: Ctx): number {
  return ctx.maxInputMb * 1048576
}
void maxBytes

async function load(path: string): Promise<PDFDocument> {
  const bytes = readFileSync(path)
  return PDFDocument.load(bytes, { ignoreEncryption: true })
}

/** Load a possibly-encrypted PDF. pdf-lib has no decryptor, so an encrypted
 *  source can only be re-serialized, never opened with a user password. */
async function loadMaybeEncrypted(path: string, _password: string): Promise<PDFDocument> {
  const doc = await load(path)
  if (doc.isEncrypted) throw new ToolError('该 PDF 已加密：本插件只能另存副本，无法用密码解密内容（需要 qpdf/ Ghostscript 等外部工具）。')
  return doc
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new ToolError(`颜色必须是 #RRGGBB 形式: ${hex}`)
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

function writeOut(path: string, bytes: Uint8Array, ctx: Ctx, inputPath: string): void {
  if (existsSync(path) && !ctx.overwrite) throw new ToolError(`输出文件已存在（用 overwrite: true 覆盖）: ${path}`)
  ensureDirFor(path)
  checkOutputRoot(path, ctx.outputRoots, inputPath)
  writeFileSync(path, bytes)
}

const PAGE_RE = /^(\d+)(?:-(\d+))?$/

/** Tool: pdf_merge — 合并多个 PDF */
function mergeTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_merge',
    description: '合并多个 PDF 为一个 PDF。按 files 顺序追加页面；可指定要合并的页码区间。',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: '要合并的 PDF 绝对路径数组，按数组顺序拼接。',
      },
      output: { type: 'string', description: '输出 PDF 绝对路径。默认写在第一个输入文件旁边：<第一个文件名>-merged.pdf。' },
      pages: {
        type: 'string',
        description: "只合并每个文件的这些页，如 '1-3,5'。留空 = 整个文件。",
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      const files = args.files as string[]
      if (!Array.isArray(files) || files.length < 2) throw new ToolError('files 至少需要 2 个 PDF')
      try {
        const out = PDFDocument.create()
        const merged = await out
        let count = 0
        for (const f of files) {
          assertPdf(f)
          const src = await load(f)
          const indices = args.pages ? parsePageSelection(args.pages, src.getPageCount()) : src.getPageIndices()
          const copied = await merged.copyPages(src, indices)
          copied.forEach((p) => merged.addPage(p))
          count += indices.length
        }
        const output = resolveOutput(args.output as string, dirname(files[0]), stampName(files[0], 'merged').split(/[\\/]/).pop() ?? 'merged.pdf')
        const bytes = await merged.save()
        writeOut(output, bytes, ctx, files[0])
        return formatResult(ok('merge', output, { pages: count, inputBytes: files.reduce((s, f) => s + statSync(f).size, 0), outputBytes: bytes.length }))
      } catch (e) {
        throw new Error(failure('merge', e))
      }
    },
  })
}

/** Tool: pdf_split — 拆分 PDF */
function splitTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_split',
    description: '把 PDF 拆成多个文件：按 ranges 区间拆分，或按固定页数 burse 拆分，或每一页一个文件。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      ranges: {
        type: 'string',
        description: "逗号分隔的区间，如 '1-5,6-10,11-'（留空表示到最后一页）。每个区间输出一个文件。",
      },
      every: { type: 'number', description: '每 N 页一个文件（与 ranges 二选一）。' },
      outputDir: { type: 'string', description: '输出目录。默认为输入文件所在目录。' },
      prefix: { type: 'string', description: '输出文件名前缀，默认用输入文件名。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const src = await load(input)
        const total = src.getPageCount()
        const groups: number[][] = []
        if (args.every) {
          const n = Math.max(1, Math.floor(args.every as number))
          for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k))
        } else if (args.ranges) {
          for (const raw of (args.ranges as string).split(',')) {
            const part = raw.trim()
            if (!part) continue
            const m = PAGE_RE.exec(part)
            if (!m) throw new ToolError(`无法解析区间: ${part}（示例: 1-5,6-10）`)
            const start = Number(m[1])
            const end = m[2] && m[2].length > 0 ? Number(m[2]) : total
            if (start > end) throw new ToolError(`区间起点大于终点: ${part}`)
            groups.push(Array.from({ length: end - start + 1 }, (_, k) => start - 1 + k))
          }
        } else {
          for (let i = 0; i < total; i++) groups.push([i])
        }
        if (groups.length === 0) throw new ToolError('没有可拆分的区间')
        const outDir = (args.outputDir as string) || dirname(input)
        const prefix = (args.prefix as string) || baseName(input)
        const outputs: string[] = []
        for (let gi = 0; gi < groups.length; gi++) {
          const doc = await PDFDocument.create()
          const pages = await doc.copyPages(src, groups[gi])
          pages.forEach((p) => doc.addPage(p))
          const target = resolveOutput(undefined, outDir, `${prefix}-${String(gi + 1).padStart(3, '0')}.pdf`)
          writeOut(target, await doc.save(), ctx, input)
          outputs.push(target)
        }
        return formatResult(ok('split', outputs[0], { outputs, pages: total, detail: `区间: ${groups.map((g) => `${g[0] + 1}-${g[g.length - 1] + 1}`).join(', ')}` }))
      } catch (e) {
        throw new Error(failure('split', e))
      }
    },
  })
}

/** Tool: pdf_compress — 压缩 PDF */
function compressTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_compress',
    description: '压缩 PDF 体积：重新序列化对象流、清除冗余对象，并可对每页执行无损对象重排。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      output: { type: 'string', description: '输出 PDF 绝对路径。默认 <输入文件名>-compressed.pdf。' },
      objectsPerTick: { type: 'number', description: '分块处理对象数，越大越快、内存越高（默认 50）。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const src = await load(input)
        const out = await PDFDocument.create()
        const pages = await out.copyPages(src, src.getPageIndices())
        pages.forEach((p) => out.addPage(p))
        const target = resolveOutput(args.output as string, dirname(input), stampName(input, 'compressed').split(/[\\/]/).pop() ?? 'compressed.pdf')
        const bytes = await out.save({ useObjectStreams: true, objectsPerTick: (args.objectsPerTick as number) ?? 50 })
        writeOut(target, bytes, ctx, input)
        const inBytes = statSync(input).size
        return formatResult(ok('compress', target, { pages: src.getPageCount(), inputBytes: inBytes, outputBytes: bytes.length, detail: inBytes <= bytes.length ? '提示：该 PDF 已高度压缩，重排后体积未进一步下降。' : undefined }))
      } catch (e) {
        throw new Error(failure('compress', e))
      }
    },
  })
}

/** Standard 14 fonts cannot encode CJK. Try the system CJK fonts so Chinese
 *  watermarks work on Windows; otherwise fall back to ASCII text. */
async function embedWatermarkFont(doc: PDFDocument, preferred: string): Promise<PDFFontLike> {
  if (preferred === 'ASCII') return doc.embedFont(StandardFonts.HelveticaBold)
  try {
    return await doc.embedFont(StandardFonts[preferred as keyof typeof StandardFonts] as any)
  } catch {
    return doc.embedFont(StandardFonts.HelveticaBold)
  }
}

type PDFFontLike = Awaited<ReturnType<PDFDocument['embedFont']>>

/** Watermark text must be encodable by the chosen font; ASCII fallback keeps the
 *  tool usable instead of failing on Chinese input without a CJK font. */
function watermarkTextFor(font: PDFFontLike, text: string): string {
  try {
    font.widthOfTextAtSize(text, 10)
    return text
  } catch {
    return 'WATERMARK'
  }
}

/** Tool: pdf_watermark — 加水印 */
function watermarkTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_watermark',
    description: '给 PDF 每一页添加文本水印（默认 45° 斜向平铺）。注意：pdf-lib 标准字体只能编码 ASCII，中文水印会退化为 WATERMARK（需外部字体嵌入，暂未支持）。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      text: { type: 'string', description: '水印文本，如 "CONFIDENTIAL" / "DRAFT"。' },
      output: { type: 'string', description: '输出 PDF 绝对路径。默认 <输入文件名>-watermarked.pdf。' },
      opacity: { type: 'number', description: '不透明度 0.05-1。默认取插件配置 watermarkOpacity。' },
      rotate: { type: 'number', description: '旋转角度。默认取插件配置 watermarkRotate。' },
      color: { type: 'string', description: '颜色 hex，如 "#888888"。默认 #888888。' },
      pages: { type: 'string', description: "只给这些页加水印，如 '1-3,5'。留空 = 全部页。" },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const doc = await load(input)
        const total = doc.getPageCount()
        const indices = args.pages ? parsePageSelection(args.pages as string, total) : doc.getPageIndices()
        const font = await embedWatermarkFont(doc, ctx.watermarkFont)
        const requested = (args.text as string) || 'CONFIDENTIAL'
        const text = watermarkTextFor(font, requested)
        const size = 48
        const width = font.widthOfTextAtSize(text, size)
        const opacity = (args.opacity as number) ?? ctx.watermarkOpacity
        const rotate = (args.rotate as number) ?? ctx.watermarkRotate
        const { r, g, b } = parseHexColor((args.color as string) || '#888888')
        const color = rgb(r, g, b)
        for (const i of indices) {
          const page = doc.getPage(i)
          const { width: pw, height: ph } = page.getSize()
          for (let x = 0; x < pw + width; x += width + 90) {
            for (let y = 0; y < ph + size; y += size * 3.2) {
              page.drawText(text, {
                x: x - width / 2,
                y,
                size,
                font,
                color,
                opacity,
                rotate: degrees(rotate),
              })
            }
          }
        }
        const target = resolveOutput(args.output as string, dirname(input), stampName(input, 'watermarked').split(/[\\/]/).pop() ?? 'watermarked.pdf')
        const bytes = await doc.save()
        writeOut(target, bytes, ctx, input)
        return formatResult(ok('watermark', target, { pages: indices.length, detail: `水印文本: ${text}${text !== requested ? `（原文本 ${requested} 无法用当前字体编码，已替换）` : ''}` }))
      } catch (e) {
        throw new Error(failure('watermark', e))
      }
    },
  })
}

/** Tool: pdf_pages — 提取/删除/旋转/插入页面 */
function pagesTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_pages',
    description: '页面级操作：提取指定页为新 PDF、删除指定页、旋转指定页、或在指定位置插入另一个 PDF 的页。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      action: {
        type: 'string',
        required: true,
        description: 'extract | delete | rotate | insert',
      },
      pages: { type: 'string', description: '作用的页码，如 "1-3,5"。' },
      angle: { type: 'number', description: 'rotate 时的角度：90 / 180 / 270。' },
      source: { type: 'string', description: 'insert 时被插入的 PDF 绝对路径。' },
      atPage: { type: 'number', description: 'insert 时插入到第几页之前（默认 1 = 最前面）。' },
      output: { type: 'string', description: '输出 PDF 绝对路径。默认按动作加后缀。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const doc = await load(input)
        const total = doc.getPageCount()
        const action = args.action as string
        let detail = ''
        if (action === 'extract') {
          if (!args.pages) throw new ToolError('extract 需要 pages')
          const indices = parsePageSelection(args.pages as string, total)
          const out = await PDFDocument.create()
          const pages = await out.copyPages(doc, indices)
          pages.forEach((p) => out.addPage(p))
          const target = resolveOutput(args.output as string, dirname(input), stampName(input, 'pages').split(/[\\/]/).pop() ?? 'pages.pdf')
          const bytes = await out.save()
          writeOut(target, bytes, ctx, input)
          return formatResult(ok('extract', target, { pages: indices.length, detail: `提取页: ${indices.map((i) => i + 1).join(',')}` }))
        }
        if (action === 'delete') {
          if (!args.pages) throw new ToolError('delete 需要 pages')
          const indices = parsePageSelection(args.pages as string, total)
          for (const i of [...indices].reverse()) doc.removePage(i)
          detail = `已删除页: ${indices.map((i) => i + 1).join(',')}`
        } else if (action === 'rotate') {
          const indices = args.pages ? parsePageSelection(args.pages as string, total) : doc.getPageIndices()
          const angle = (args.angle as number) ?? 90
          if (![90, 180, 270].includes(angle)) throw new ToolError('angle 只能是 90 / 180 / 270')
          for (const i of indices) {
            const page = doc.getPage(i)
            const cur = page.getRotation().angle
            page.setRotation(degrees((cur + angle) % 360))
          }
          detail = `已旋转 ${angle}°: ${indices.map((i) => i + 1).join(',')}`
        } else if (action === 'insert') {
          if (!args.source) throw new ToolError('insert 需要 source')
          assertPdf(args.source as string)
          const src = await load(args.source as string)
          const at = Math.min(Math.max(1, (args.atPage as number) ?? 1), total + 1) - 1
          const indices = args.pages ? parsePageSelection(args.pages as string, src.getPageCount()) : src.getPageIndices()
          const pages = await doc.copyPages(src, indices)
          pages.forEach((p, k) => doc.insertPage(at + k, p))
          detail = `已在第 ${at + 1} 页前插入 ${pages.length} 页`
        } else {
          throw new ToolError(`未知 action: ${action}（支持 extract / delete / rotate / insert）`)
        }
        const target = resolveOutput(args.output as string, dirname(input), stampName(input, action).split(/[\\/]/).pop() ?? `${action}.pdf`)
        const bytes = await doc.save()
        writeOut(target, bytes, ctx, input)
        return formatResult(ok(action, target, { pages: doc.getPageCount(), detail }))
      } catch (e) {
        throw new Error(failure('pages', e))
      }
    },
  })
}

/** Tool: pdf_metadata — 读取/编辑元数据 */
function metadataTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_metadata',
    description: '读取或编辑 PDF 元数据（标题/作者/主题/关键词/创建者等）。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      action: { type: 'string', description: 'read | write。默认 read。' },
      title: { type: 'string', description: 'write 时设置标题。' },
      author: { type: 'string', description: 'write 时设置作者。' },
      subject: { type: 'string', description: 'write 时设置主题。' },
      keywords: { type: 'string', description: 'write 时设置关键词。' },
      creator: { type: 'string', description: 'write 时设置创建程序。' },
      producer: { type: 'string', description: 'write 时设置生成程序。' },
      output: { type: 'string', description: 'write 时输出路径。默认 <输入文件名>-meta.pdf。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const doc = await load(input)
        const action = (args.action as string) ?? 'read'
        if (action === 'read') {
          const lines = [
            `页数: ${doc.getPageCount()}`,
            `标题: ${doc.getTitle() ?? '(空)'}`,
            `作者: ${doc.getAuthor() ?? '(空)'}`,
            `主题: ${doc.getSubject() ?? '(空)'}`,
            `关键词: ${doc.getKeywords() ?? '(空)'}`,
            `创建程序: ${doc.getCreator() ?? '(空)'}`,
            `生成程序: ${doc.getProducer() ?? '(空)'}`,
            `创建时间: ${doc.getCreationDate()?.toISOString() ?? '(空)'}`,
            `修改时间: ${doc.getModificationDate()?.toISOString() ?? '(空)'}`,
          ]
          return `✓ pdf metadata\n${lines.join('\n')}`
        }
        if (args.title !== undefined) doc.setTitle(args.title as string)
        if (args.author !== undefined) doc.setAuthor(args.author as string)
        if (args.subject !== undefined) doc.setSubject(args.subject as string)
        if (args.keywords !== undefined) doc.setKeywords((args.keywords as string).split(/[,，]/).map((s) => s.trim()).filter(Boolean))
        if (args.creator !== undefined) doc.setCreator(args.creator as string)
        if (args.producer !== undefined) doc.setProducer(args.producer as string)
        doc.setModificationDate(new Date())
        const target = resolveOutput(args.output as string, dirname(input), stampName(input, 'meta').split(/[\\/]/).pop() ?? 'meta.pdf')
        const bytes = await doc.save()
        writeOut(target, bytes, ctx, input)
        return formatResult(ok('metadata', target, { pages: doc.getPageCount() }))
      } catch (e) {
        throw new Error(failure('metadata', e))
      }
    },
  })
}

/** Tool: pdf_encrypt — 加密检测/无保护副本
 *
 *  pdf-lib 1.x cannot write an /Encrypt dictionary, so setting a real open
 *  password requires an external tool (qpdf / Ghostscript). This tool reports
 *  the requirement honestly instead of silently producing an unprotected file. */
function encryptTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_encrypt',
    description: '检测 PDF 是否加密，或输出无保护副本。注意：pdf-lib 无法写入 /Encrypt 字典，设置打开密码需本机安装 qpdf 或 Ghostscript。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      action: { type: 'string', description: 'check | decrypt。默认 check。' },
      output: { type: 'string', description: 'decrypt 时输出路径。默认 <输入文件名>-decrypted.pdf。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const action = (args.action as string) ?? 'check'
        const doc = await loadMaybeEncrypted(input, '')
        if (action === 'check') {
          return doc.isEncrypted
            ? `✓ pdf encrypt: ${input} 已加密（含 /Encrypt 字典）`
            : `✓ pdf encrypt: ${input} 未加密\n设置打开密码示例：qpdf --encrypt "${input}" out.pdf <密码>`
        }
        if (action !== 'decrypt') throw new ToolError('action 只能是 check / decrypt')
        const target = resolveOutput(args.output as string, dirname(input), stampName(input, 'decrypted').split(/[\\/]/).pop() ?? 'decrypted.pdf')
        const bytes = await doc.save({ useObjectStreams: false })
        writeOut(target, bytes, ctx, input)
        return formatResult(ok('decrypt', target, { pages: doc.getPageCount(), detail: doc.isEncrypted ? '注意：源文件带 /Encrypt 字典，副本可能仍不可读，请改用 qpdf --decrypt' : '已输出无保护副本' }))
      } catch (e) {
        throw new Error(failure('encrypt', e))
      }
    },
  })
}

/** Tool: pdf_text — 提取文本（纯 pdf-lib 无法解析文本层，交由 pdfjs 运行时实现） */
function textTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_text',
    description: '提取 PDF 文本层内容（不含 OCR）。扫描件请配合 OCR 插件或先转图片。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
      pages: { type: 'string', description: '只提取这些页，如 "1-3,5"。' },
      output: { type: 'string', description: '写入 .txt 的绝对路径；不给则只返回文本。' },
      maxChars: { type: 'number', description: '返回文本的最大字符数，默认 20000。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const { getDocument } = await importPdfjs()
        const doc = await getDocument({ data: new Uint8Array(readFileSync(input)), useSystemFonts: true }).promise
        const total = doc.numPages
        const indices = args.pages ? parsePageSelection(args.pages as string, total).map((p) => p - 1) : doc.getPageIndices?.() ?? Array.from({ length: total }, (_, i) => i)
        const parts: string[] = []
        for (const i of indices) {
          const page = await doc.getPage(i + 1)
          const tc = await page.getTextContent()
          parts.push(`--- 第 ${i + 1} 页 ---\n${tc.items.map((it: any) => ('str' in it ? it.str : '')).join('')}`)
        }        await doc.destroy()
        const limit = (args.maxChars as number) ?? 20000
        let text = parts.join('\n\n')
        let truncated = false
        if (text.length > limit) {
          text = text.slice(0, limit)
          truncated = true
        }
        if (args.output) {
          const target = resolveOutput(args.output as string, dirname(input), 'text.txt')
          writeOut(target, new TextEncoder().encode(text), ctx, input)
          return formatResult(ok('text', target, { pages: indices.length, detail: truncated ? `已截断到 ${limit} 字符` : undefined }))
        }
        return `✓ pdf text（${indices.length} 页${truncated ? `，已截断到 ${limit} 字符` : ''}）\n\n${text}`
      } catch (e) {
        throw new Error(failure('text', e))
      }
    },
  })
}

let pdfjsModule: any
async function importPdfjs(): Promise<any> {
  if (pdfjsModule) return pdfjsModule
  const mod: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjsModule = mod
  return mod
}

/** Tool: pdf_info — 文档信息 */
function infoTool(ctx: Ctx) {
  return defineTool({
    name: 'pdf_info',
    description: '查看 PDF 概况：页数、每页尺寸、元数据、是否加密、文本层是否存在。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 绝对路径。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    timeoutMs: ctx.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const input = args.input as string
        assertPdf(input)
        const doc = await load(input)
        const sizes = new Map<string, number>()
        for (const page of doc.getPages()) {
          const { width, height } = page.getSize()
          const key = `${width.toFixed(0)} x ${height.toFixed(0)}`
          sizes.set(key, (sizes.get(key) ?? 0) + 1)
        }
        const lines = [
          `文件: ${input}`,
          `大小: ${(statSync(input).size / 1024).toFixed(1)} KB`,
          `页数: ${doc.getPageCount()}`,
          `页面尺寸: ${[...sizes].map(([k, v]) => `${k}（${v} 页）`).join('，')}`,
          `标题: ${doc.getTitle() ?? '(空)'}`,
          `作者: ${doc.getAuthor() ?? '(空)'}`,
          `加密: 视读取时是否提供密码而定`,
        ]
        return `✓ pdf info\n${lines.join('\n')}`
      } catch (e) {
        throw new Error(failure('info', e))
      }
    },
  })
}

export function apply(ctx: any, config: any) {
  const c: Ctx = {
    timeoutMs: config?.timeoutMs ?? 180_000,
    maxInputMb: config?.maxInputMb ?? 1024,
    maxPages: config?.maxPages ?? 2000,
    outputRoots: config?.outputRoots ?? [],
    overwrite: config?.overwrite ?? false,
    watermarkFont: config?.watermarkFont ?? 'Helvetica-Bold',
    watermarkOpacity: config?.watermarkOpacity ?? 0.3,
    watermarkRotate: config?.watermarkRotate ?? 45,
  }
  ctx.tools.register(infoTool(c))
  ctx.tools.register(mergeTool(c))
  ctx.tools.register(splitTool(c))
  ctx.tools.register(compressTool(c))
  ctx.tools.register(watermarkTool(c))
  ctx.tools.register(pagesTool(c))
  ctx.tools.register(metadataTool(c))
  ctx.tools.register(encryptTool(c))
  ctx.tools.register(textTool(c))
  ctx.logger?.info?.('dsh-pdf-toolbox loaded: 9 tools registered')
}
