import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // 本项目有 Electron loadFile 打包场景，统一使用相对路径，避免 file:///assets/* 白屏。
  base: './',
  plugins: [tailwindcss()],
})
