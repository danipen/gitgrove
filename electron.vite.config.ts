import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        // electron is a devDependency, so externalizeDepsPlugin won't catch it;
        // it must stay external (it's provided by the runtime).
        external: ['electron'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The askpass shim is a standalone program (git execs it through a
          // generated wrapper, with the app binary as plain Node) — its own
          // entry, emitted as out/main/askpass.js next to the main bundle. It
          // imports nothing from the app on purpose, so it bundles to a single
          // self-contained file that electron-builder can asarUnpack alone.
          askpass: resolve(__dirname, 'src/main/git/askpass-main.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        external: ['electron'],
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    // @pierre/diffs ships a worker that shiki tokenizes in; bundle deps for the browser.
    optimizeDeps: {
      include: ['@pierre/diffs', '@pierre/diffs/react']
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
