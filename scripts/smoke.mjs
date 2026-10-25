// Smoke test: register the plugin into a minimal ctx and exercise every tool.
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')
const { name, inject, apply, Config } = mod

if (typeof name !== 'string' || !Array.isArray(inject) || typeof apply !== 'function') {
  console.error('FAIL: plugin must export name (string), inject (array), apply (function)')
  process.exit(1)
}
console.log(`plugin name=${name} inject=[${inject.join(',')}]`)

const registered = new Map()
const ctx = {
  tools: { register: (t) => registered.set(t.name, t) },
  logger: { info: (m) => console.log(`[log] ${m}`), warn: () => {}, error: () => {} },
}
apply(ctx, {})
console.log(`registered tools (${registered.size}): ${[...registered.keys()].join(', ')}`)

const dir = mkdtempSync(join(tmpdir(), 'pdf-smoke-'))
const enc = new TextEncoder()

async function makePdf(path, pages, title) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([300, 400])
    p.drawText(`${title} page ${i + 1}`, { x: 40, y: 360, size: 20, font })
  }
  doc.setTitle(title)
  doc.setAuthor('smoke')
  writeFileSync(path, await doc.save())
  return path
}

let failures = 0
async function run(tool, args, expect = (r) => typeof r === 'string' && r.startsWith('✓')) {
  const t = registered.get(tool)
  if (!t) { console.error(`FAIL: tool ${tool} not registered`); failures++; return null }
  try {
    const r = await t.execute(args, { signal: new AbortController().signal })
    const ok = expect(r)
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${tool} ${JSON.stringify(args).slice(0, 90)}`)
    if (!ok) { console.error('  result:', String(r).slice(0, 300)); failures++ }
    return r
  } catch (e) {
    console.error(`FAIL: ${tool} threw: ${e.message}`)
    failures++
    return null
  }
}

const a = await makePdf(join(dir, 'a.pdf'), 3, 'Alpha')
const b = await makePdf(join(dir, 'b.pdf'), 2, 'Beta')

await run('pdf_info', { input: a })
const merged = join(dir, 'merged.pdf')
await run('pdf_merge', { files: [a, b], output: merged }, (r) => existsSync(merged) && statSync(merged).size > 0)

const splitDir = join(dir, 'split')
await run('pdf_split', { input: merged, every: 2, outputDir: splitDir }, () => existsSync(join(splitDir, 'merged-001.pdf')) && existsSync(join(splitDir, 'merged-002.pdf')) && existsSync(join(splitDir, 'merged-003.pdf')))

const comp = join(dir, 'comp.pdf')
await run('pdf_compress', { input: merged, output: comp }, () => existsSync(comp))

const wm = join(dir, 'wm.pdf')
await run('pdf_watermark', { input: a, text: '内部资料', output: wm }, () => existsSync(wm))

const ex = join(dir, 'ex.pdf')
await run('pdf_pages', { input: a, action: 'extract', pages: '2-3', output: ex }, () => existsSync(ex))
const del = join(dir, 'del.pdf')
await run('pdf_pages', { input: a, action: 'delete', pages: '1', output: del }, () => existsSync(del))
const rot = join(dir, 'rot.pdf')
await run('pdf_pages', { input: a, action: 'rotate', angle: 90, pages: '1', output: rot }, () => existsSync(rot))
const ins = join(dir, 'ins.pdf')
await run('pdf_pages', { input: a, action: 'insert', source: b, atPage: 2, output: ins }, () => existsSync(ins))

const meta = join(dir, 'meta.pdf')
await run('pdf_metadata', { input: a, action: 'write', title: '新标题', author: 'taole', keywords: 'pdf, 测试', output: meta }, () => existsSync(meta))
await run('pdf_metadata', { input: meta, action: 'read' })

await run('pdf_encrypt', { input: a, action: 'check' })
const txt = join(dir, 'out.txt')
await run('pdf_text', { input: a, output: txt }, () => existsSync(txt))

// error paths must be reported, not silently swallowed
const t = registered.get('pdf_merge')
try {
  await t.execute({ files: [join(dir, 'missing.pdf')] }, { signal: new AbortController().signal })
  console.error('FAIL: missing input should throw'); failures++
} catch {
  console.log('PASS: missing input throws a readable error')
}

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
