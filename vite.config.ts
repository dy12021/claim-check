import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    // 不压缩：商店审核要看代码，也方便用户自己读/改。
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        result: 'src/result/index.html',
        background: 'src/bg/index.ts',
      },
    },
  },
});
