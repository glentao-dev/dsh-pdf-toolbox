# dsh-pdf-toolbox

PDF 结构操作 DSH 插件，**9 个工具覆盖 14 项操作**：合并、拆分、压缩、加水印、提取/删除/旋转/插入页面、元数据、加密检测、文本提取、文档信息。
纯本地运行，无 API key，无上传，无 token 成本。
底层依赖 [`pdf-lib`](https://pdf-lib.js.org/)（结构操作）+ [`pdfjs-dist`](https://mozilla.github.io/pdf.js/)（文本层读取）。

---

## 安装

```bash
dsh plugin --profile <你的档案> add dsh-pdf-toolbox
```

本地开发 / 未发布时：

```bash
dsh plugin --profile <你的档案> add "file:D:/软件/自制软件/PDF 工具新版本"
```

卸载：`dsh plugin --profile <你的档案> remove dsh-pdf-toolbox`

> **注意**：`dsh plugin` 会写入 `$DSH_HOME/profiles/<档案>/package.json`。
> 如果该操作报 `EPERM: operation not permitted`，说明当前进程的沙箱只允许写工作区，
> 需要在允许写 `~/.dsh` 的模式下重跑。

---

## 工具一览（9 个工具覆盖 14 项操作）

| 工具 | 覆盖的操作 |
| --- | --- |
| `pdf_info` | 页数、每页尺寸、元数据概览 |
| `pdf_merge` | 多文件合并（可限定每文件页码范围） |
| `pdf_split` | 按区间拆分 / 每 N 页拆分 / 每页一个文件 |
| `pdf_compress` | 对象流重排压缩 |
| `pdf_watermark` | 文本水印平铺（角度/透明度/颜色/页码可选） |
| `pdf_pages` | `extract` 提取页、`delete` 删除页、`rotate` 旋转页、`insert` 插入页 |
| `pdf_metadata` | 读/写标题、作者、主题、关键词、创建/修改时间 |
| `pdf_encrypt` | 检测是否加密、输出无保护副本 |
| `pdf_text` | 提取文本层为文本或 .txt |

### 页码语法

所有 `pages` 参数统一使用 **1 开始的页码**，逗号分隔、支持区间：

```
1-3,5,8-10     # 第 1~3、5、8~10 页
all            # 全部页（等价于留空）
```

---

## 使用示例

```
把 D:\reports\a.pdf 和 D:\reports\b.pdf 合并成 D:\out\merged.pdf
→ pdf_merge { files: ["D:\\reports\\a.pdf", "D:\\reports\\b.pdf"], output: "D:\\out\\merged.pdf" }

只合并 a.pdf 的第 1-5 页和 b.pdf 全文
→ pdf_merge { files: ["D:\\reports\\a.pdf", "D:\\reports\\b.pdf"], pages: "1-5" }
  （pages 会应用到每个输入文件）

把 report.pdf 每 10 页拆一个文件
→ pdf_split { input: "D:\\r\\report.pdf", every: 10, outputDir: "D:\\out" }

给合同.pdf 打上 "CONFIDENTIAL" 水印，只要第 1 页
→ pdf_watermark { input: "D:\\c\\合同.pdf", text: "CONFIDENTIAL", pages: "1" }

把 scan.pdf 的第 2-4 页抽出来
→ pdf_pages { input: "D:\\s\\scan.pdf", action: "extract", pages: "2-4", output: "D:\\out\\ex.pdf" }

删除 book.pdf 的第 1 页
→ pdf_pages { input: "D:\\b\\book.pdf", action: "delete", pages: "1" }
  （先用 pdf_info 看总页数，再算要删的页码；不支持负数页码）

读取 meta.pdf 的标题和作者
→ pdf_metadata { input: "D:\\m\\meta.pdf", action: "read" }

提取 report.pdf 全文到 txt
→ pdf_text { input: "D:\\r\\report.pdf", output: "D:\\out\\report.txt" }
```

---

## 输出路径规则

- 不给 `output` 时，默认写在**输入文件旁边**，文件名加动作后缀（如 `a-merged.pdf`）。
- 给了 `output` 时**必须是绝对路径**；相对路径会直接报错，避免写丢。
- 已存在的输出文件默认**拒绝覆盖**，需要显式传插件配置 `overwrite: true` 或在调用时先删旧文件。
- 插件配置 `outputRoots` 可把显式输出限制在指定目录内（默认输入旁边不受限）。

---

## 配置

在档案的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-pdf-toolbox
  config:
    timeoutMs: 600000        # 单个操作超时（大文件合并/超大文档时调大）
    maxInputMb: 1024         # 输入大小上限
    overwrite: true          # 允许覆盖已存在输出
    watermarkOpacity: 0.25   # 水印不透明度
    watermarkRotate: 45      # 水印角度
```

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | 180000 | 单次操作协作超时 |
| `maxInputMb` | 1024 | 输入 PDF 大小上限 |
| `maxPages` | 2000 | 页数上限 |
| `outputRoots` | `[]` | 限制显式输出目录，空 = 不限制 |
| `overwrite` | `false` | 是否覆盖已存在输出 |
| `watermarkFont` | `Helvetica-Bold` | 水印字体 |
| `watermarkOpacity` | `0.3` | 水印不透明度 |
| `watermarkRotate` | `45` | 水印旋转角度 |

---

## 已知边界（重要）

以下限制来自底层库能力，插件不会伪造结果：

1. **中文水印**：`pdf-lib` 的标准 14 字体（Helvetica 等）只能编码 ASCII。
   传中文文本时会自动退化为 `WATERMARK`，并在结果里说明原因。
   要做中文水印，需要外部字体嵌入，暂未实现。
2. **设置打开密码**：`pdf-lib` 1.x 不能写 `/Encrypt` 字典。
   `pdf_encrypt` 只做**检测**和**无保护副本输出**；真正加密请用本机
   `qpdf --encrypt in.pdf out.pdf <密码>` 或 Ghostscript。
3. **解密**：同样不支持用密码解密内容，只能重排输出。
4. **PDF → Word/Excel/PPT/图片**：本插件不做格式转换（那是 `dsh-file-convert` 的职责）。
   本插件专注 PDF 结构操作 + 文本层提取。
5. **OCR**：本插件不做 OCR（那是 `dsh-pdf-extractor` 的职责）。
   扫描件先用 OCR 工具得到带文字层的 PDF，再用本插件处理。

---

## 开发

```bash
npm install
npm run build      # tsc → lib/
npm run smoke      # 生成临时 PDF，跑通 9 个工具的全部动作
```

插件入口约定（与 `@deepseek-ai/dsh-tool-fs` 等官方插件一致）：

```js
export const name = 'dsh-pdf-toolbox'
export const inject = ['tools']
export function apply(ctx, config) { ctx.tools.register(...) }
export { Config }
```

---

## License

MIT
