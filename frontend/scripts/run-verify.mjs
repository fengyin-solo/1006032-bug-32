// 专用通道占用（要客保障单派生）的内层回归脚本。
// 用 esbuild 在内存里解析 TS 与「@/」别名后直接交给 node 执行，不落临时文件。
import { build } from 'esbuild'
import path from 'node:path'

const entry = path.resolve('scripts/verify-channel.mts')
const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@': path.resolve('src') },
})
const code = result.outputFiles[0].text
await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
