import {defineConfig} from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  outDir: 'dist',
  noExternal: id => {
    if (id === '@fro-bot/runtime' || id.startsWith('@fro-bot/runtime/')) return true
    return false
  },
})
