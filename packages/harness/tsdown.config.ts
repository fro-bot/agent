import {defineConfig} from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts', 'src/postinstall.ts'],
  format: 'esm',
  outDir: 'dist',
})
