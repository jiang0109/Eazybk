/**
 * Vite 插件：把 API 挂到开发服务器上。
 *
 * 这样做的三个好处：
 *   1. 只跑一个进程、一个端口（5173），前端 fetch('/api/...') 直接命中，
 *      **没有跨域问题**，也不用配代理。
 *   2. 开发环境和生产环境**执行同一份 handleApiRequest**，
 *      不会出现"本地能跑、上线就挂"。
 *   3. 改后端代码时自动重启 dev server，改完立刻生效。
 */

import type { Plugin, ViteDevServer } from 'vite';
import { handleApiRequestNode, listRoutes } from './api.ts';

export function apiPlugin(): Plugin {
  return {
    name: 'ledger-api',

    // 只在开发服务器启动时应用；构建（vite build）时不需要数据库
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api', (req, res, next) => {
        // connect 的 use('/api', ...) 会把 req.url 里的挂载前缀去掉，
        // 而 api.ts 需要完整路径，所以这里补回来。
        req.url = `/api${req.url ?? ''}`;

        handleApiRequestNode(req, res).catch((err: unknown) => {
          console.error('[api] 处理请求时出错：', err);
          if (!res.headersSent) res.statusCode = 500;
          res.end(JSON.stringify({ error: '服务器内部错误' }));
        });

        // 明确不使用 next：/api 下的请求全部由我们处理，不交给 Vite 的静态文件逻辑
        void next;
      });

      // 打印接口清单，方便直接用 curl 或浏览器试
      server.httpServer?.once('listening', () => {
        console.log('\n  API 已挂载在 /api（与前端同端口，无跨域）：');
        for (const r of listRoutes()) console.log(`    ${r}`);
        console.log('');
      });
    },

    /**
     * 后端代码变更时重启 dev server。
     *
     * 为什么必须重启？因为数据库连接和 SQL 查询都是 Node 进程里的模块，
     * Vite 的 HMR 只处理前端模块。改完 SQL 不重启的话，你看到的还是旧逻辑 ——
     * 这类"改了没生效"的困惑很浪费时间，所以直接自动重启。
     */
    handleHotUpdate({ file, server }) {
      if (file.includes('/src/server/') || file.endsWith('schema.sql')) {
        console.log(`\n[api] ${file.split(/[\\/]/).pop()} 变更，重启开发服务器…\n`);
        server.restart();
        return [];
      }
      return undefined;
    },
  };
}
