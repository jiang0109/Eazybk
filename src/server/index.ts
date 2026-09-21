/**
 * 生产环境服务器：托管构建好的前端 + 提供 API。
 *
 *   npm run build   # 先把前端打包到 dist/
 *   npm start       # 启动这个服务器（默认 3001 端口）
 *
 * 开发时不需要它 —— 开发用的 Vite 已经把 API 挂上去了（见 vite-plugin.ts）。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { handleApiRequestNode, listRoutes } from './api.ts';
import { getDb, DB_PATH } from './db/index.ts';

const PORT = Number(process.env.PORT ?? 3001);
const DIST = resolve(process.cwd(), 'dist');

/** 极简的 MIME 表，够用了 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  // 整个请求处理都包在 try/catch 里。
  //
  // 为什么必须这样：node:http 的 createServer 回调如果抛出未捕获的异常，
  // 会冒泡成 'error' 事件，而**未处理的 'error' 事件会直接终止进程**。
  // 也就是说：任何一个请求触发一个意外错误，整个服务器就下线了 ——
  // 所有在线用户一起断线。（这个 bug 我实际踩到了：
  // 一次 `req.headers.get is not a function` 就让服务器在第一个请求后退出了。）
  //
  // 这是"能用"和"能给人用"之间的分界线：出错时应该只让那一个请求返回 500，
  // 而不是让服务整体不可用。
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // 1) API 请求
    if (url.pathname.startsWith('/api/')) {
      await handleApiRequestNode(req, res);
      return;
    }

    // 2) 静态文件
    // 安全要点：normalize + 前缀检查，防止 ../../ 之类的路径穿越读到项目外的文件
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let filePath = join(DIST, rel);

    if (!filePath.startsWith(DIST)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    // 目录或不存在时回退到 index.html（前端是单页应用，交给客户端处理）
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      filePath = join(DIST, 'index.html');
    }

    const data = await readFile(filePath);
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(data);
  } catch (err) {
    // 出错也要保证给客户端一个响应，否则请求会一直挂着直到超时
    console.error('[server] 处理请求时出错：', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: '服务器内部错误' }));
  }
});

/**
 * 兜底：万一还是有意料之外的错误冒到进程级别，至少留下日志。
 * 注意这里**不**退出进程 —— 单次未捕获异常不该让服务下线。
 */
process.on('uncaughtException', (err) => {
  console.error('[server] 未捕获的异常：', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] 未处理的 Promise 拒绝：', reason);
});

server.listen(PORT, () => {
  console.log(`\n记账 App 已启动：http://127.0.0.1:${PORT}`);
  console.log(`  数据库：${DB_PATH}`);
  console.log(`  静态目录：${DIST}`);
  console.log(`  接口：${listRoutes().length} 个\n`);

  // 启动时顺手做一次对账，余额漂移能被立刻发现
  const drift = getDb()
    .prepare(
      `SELECT a.name, a.balance_cents - (a.initial_balance_cents + COALESCE((
         SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id
       ), 0)) AS drift FROM accounts a`,
    )
    .all()
    .filter((r) => r.drift !== 0);

  if (drift.length > 0) {
    console.warn('⚠️ 检测到余额漂移：', drift);
  } else {
    console.log('  余额对账通过 ✓\n');
  }
});
