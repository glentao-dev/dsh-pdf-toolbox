import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  timeoutMs: Schema.number().min(1000).default(180_000).description('单个 PDF 操作的协作超时（毫秒）。大文件合并/OCR 建议 600000。'),
  maxInputMb: Schema.number().min(1).default(1024).description('拒绝超过此大小（MB）的输入 PDF。'),
  maxPages: Schema.number().min(1).default(2000).description('单次操作允许的最大页数上限。'),
  outputRoots: Schema.array(Schema.string()).default([]).description('显式输出路径限制在这些目录内。空 = 不限制。符号链接会被解析；默认的「输入旁边」输出不受限。'),
  overwrite: Schema.boolean().default(false).description('输出文件已存在时是否覆盖。默认 false。'),
  watermarkFont: Schema.string().default('Helvetica-Bold').description('文本水印字体（pdf-lib 标准字体）。'),
  watermarkOpacity: Schema.number().min(0.05).max(1).default(0.3).description('文本水印不透明度。'),
  watermarkRotate: Schema.number().min(0).max(360).default(45).description('文本水印旋转角度。'),
})
