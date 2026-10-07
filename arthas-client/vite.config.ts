import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // ogg-opus-decoder 动态 import 这个 ~4MB 的 ML 解码器，但只在传入
      // speechQualityEnhancement 时才会执行。我们不用该选项，却仍会被打进
      // dist/ —— 而 dist/ 会被 go:embed 嵌入服务器二进制，直接变成镜像体积。
      // 用空实现替换；要启用语音增强时删掉这一条即可。
      '@wasm-audio-decoders/opus-ml': fileURLToPath(
        new URL('./src/voice/opus-ml-stub.ts', import.meta.url)
      ),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
})
