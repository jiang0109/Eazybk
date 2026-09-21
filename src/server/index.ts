/**
 * ---------------------------------------------------------------------------
 * 生产环境服务器
 * ---------------------------------------------------------------------------
 *   npm run build   # 先把前端打包到 dist/
 *   npm start       # 启动这个服务器
 *
 * 开发时不需要它 —— 开发用的 Vite 已经把 API 挂上去了（见 vite-plugin.ts）。
 *
 * 迁移带来的两个重要变化：
 *   1. **启动时自动跑迁移**。SQLite 版可以让你 SSH 上去敲 npm run db:init，
 *      但部署到托管平台后没有这个机会。所以应用必须自己保证表结构是对的。
 *   2. 启动时**不能假设数据库一定可用**。Neon 的计算会在闲置后挂起，
 *      第一次连接可能需要等它唤醒（几百毫秒到几秒），所以要有重试。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { handleApiRequestNode, listRoutes } from './api.ts';
import { getPool, closePool, getConnectionString } from './db/pg.ts';
import { migrate } from './db/migrate.pg.ts';

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

/**
 * 等数据库可用。
 *
 * 为什么需要：Neon 免费版的计算在闲置后会挂起，下次连接要等它唤醒。
 * 如果启动时正好赶上这个状态，直接失败会让部署看起来"挂了"，
 * 而实际上再等两秒就好了。
 */
async function waitForDatabase(attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await getPool().query('SELECT 1');
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts) throw err;
      console.warn(`  数据库连接失败（第 ${i}/${attempts} 次）：${msg.slice(0, 80)}`);
      console.warn('  可能正在从闲置状态唤醒，2 秒后重试…');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const server = createServer(async (req, res) => {
  // 整个请求处理都包在 try/catch 里。
  //
  // 为什么必须这样：node:http 的 createServer 回调如果抛出未捕获的异常，
  // 会冒泡成 'error' 事件，而**未处理的 'error' 事件会直接终止进程**。
  // 也就是说：任何一个请求触发一个意外错误，整个服务器就下线了 ——
  // 所有在线用户一起断线。（这个 bug 我实际踩到了，见前面几轮的记录。）
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

// ---------------------------------------------------------------------------
//  启动流程
// ---------------------------------------------------------------------------
const dbHost = getConnectionString().replace(/:\/\/[^@]+@/, '://***@').split('?')[0];

console.log('\n正在启动…');
console.log(`  数据库：${dbHost}`);

try {
  await waitForDatabase();
  console.log('  数据库连接正常');

  // 启动时自动迁移：部署到托管平台后没法手动执行脚本，
  // 所以应用必须自己保证表结构是最新的。
  // migrate() 是幂等的 —— 已经应用过的迁移不会重复执行。
  const applied = await migrate({ silent: true });
  if (applied.length > 0) {
    console.log(`  自动应用了 ${applied.length} 个迁移：${applied.map((m) => `v${m.version}`).join(', ')}`);
  } else {
    console.log('  数据库结构已是最新');
  }
} catch (err) {
  console.error('\n启动失败：数据库不可用或迁移失败');
  console.error(err instanceof Error ? err.message : err);
  console.error('\n排查建议：');
  console.error('  1. 确认 .env（或平台的环境变量）里的 DATABASE_URL 正确');
  console.error('  2. 去 Neon 控制台看一眼项目是不是被挂起了');
  console.error('  3. 本地可以跑 npm run db:init 单独验证连接\n');
  await closePool();
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`\n记账 App 已启动：http://127.0.0.1:${PORT}`);
  console.log(`  静态目录：${DIST}`);
  console.log(`  接口：${listRoutes().length} 个\n`);
});

/**
 * 优雅退出：关掉 HTTP 服务和连接池。
 * 不关连接池的话，Node 进程可能因为还有活动连接而无法退出 ——
 * 在容器环境里表现为"部署卡住不动"。
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
