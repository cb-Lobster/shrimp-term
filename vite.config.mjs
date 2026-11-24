import { defineConfig } from 'vite'

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'renderer/generated',
    emptyOutDir: true,
    lib: {
      entry: 'renderer/ui/workspace.tsx',
      name: 'shrimpWorkspace',
      formats: ['iife'],
      fileName: () => 'workspace.js',
    },
  },
  esbuild: { jsx: 'automatic' },
})
