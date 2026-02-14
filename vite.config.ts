import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import alchemy from 'alchemy/cloudflare/tanstack-start'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { fileURLToPath, URL } from 'node:url'

const config = defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    devtools(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    alchemy(),
    tanstackStart({ router: { generatedRouteTree: 'route-tree.gen.ts' } }),
    viteReact(),
  ],
})

export default config
