import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { apiPlugin } from './src/server/vite-plugin.ts';

/**
 * Vite 配置
 *
 * 这里最有意思的一点是 `apiPlugin()`：
 * 后端的 API 和数据库**直接挂在 Vite 的开发服务器上**，而不是另起一个进程。
 * 于是开发时只有一个端口（5173），前端 fetch('/api/...') 是同源请求，
 * 不需要配代理、不会有跨域。
 *
 * 生产环境（npm run build && npm start）则由 src/server/index.ts
 * 用同一份 API 代码同时托管静态文件和接口。
 */
export default defineConfig({
  // 路径别名（要和 tsconfig.json 里的 paths 保持一致）
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },

  plugins: [
    react(),
    tailwindcss(),
    // 自定义插件：把 /api/* 交给 Node 端的 SQL 查询处理
    apiPlugin(),
  ],

  server: {
    port: 5173,
    // 允许局域网访问，方便用手机打开真机调试移动端样式
    host: true,
    // 端口被占用时直接失败，而不是悄悄换一个端口
    // （悄悄换端口会让你以为打开的旧页面是新版本）
    strictPort: true,
    watch: {
      /**
       * 忽略编辑器原子写入产生的临时目录。
       *
       * 踩过的坑：某些编辑器（和 AI 编码工具）保存文件时会在同目录写一个
       * `.App.tsx.12304.<uuid>.tmpdir/` 再改名。Vite 的文件监听会去 watch 这个
       * 临时文件，而它在 Windows 上可能被锁住，于是抛出 EBUSY，
       * 未捕获的 'error' 事件直接把整个 dev server 干掉。
       * 加一条忽略规则，比每次崩溃后手动重启省事得多。
       */
      ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
    },
  },

  build: {
    outDir: 'dist',
    // 关掉 sourcemap 让构建更快；排查线上问题时可以临时打开
    sourcemap: false,
    rolldownOptions: {
      output: {
        // 把第三方库拆成独立的 chunk。
        // 单文件打包会把 recharts（图表库，体积大）+ react + 动画库塞进一个
        // 700 多 kB 的文件里，浏览器只能串行下载。
        // 拆开之后可以并行加载，而且这些库的 hash 很稳定 ——
        // 你改自己的业务代码时，用户不需要重新下载它们。
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) {
            return 'vendor-motion';
          }
          if (id.includes('react') || id.includes('scheduler') || id.includes('zustand')) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});
