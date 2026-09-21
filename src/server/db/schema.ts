/**
 * ---------------------------------------------------------------------------
 * 数据库初始化
 * ---------------------------------------------------------------------------
 *   node src/server/db/schema.ts           建表 + 应用所有迁移
 *   node src/server/db/schema.ts --reset   删库重建（会丢数据！）
 *
 * 这里区分两种"从零开始"：
 *   1. **全新的库**：直接执行 schema.sql（它描述的是最新完整结构），
 *      然后把 user_version 标到最新，迁移就不需要再跑一遍。
 *   2. **已存在的库**：只跑没执行过的迁移（见 migrate.ts）。
 *
 * 为什么保留 schema.sql 而不是"从空库开始跑一串迁移"？
 *   两种做法在真实项目里都常见。用 schema.sql 的好处是：
 *   你打开一个文件就能看到表的**当前完整样子**，不用把十几个迁移在脑子里叠加。
 *   这也是 Rails / Django 都同时保留 schema 文件和 migrations 的原因。
 *
 * 注意 schema.sql 是"最新结构"的快照，所以每次加迁移后，
 * 也应该把对应的结构改动同步进 schema.sql —— 否则新库和老库的结构会不一致。
 * 这是个真实存在的维护负担（也是有人干脆只用迁移的原因），值得知道。
 */

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, DB_PATH, get } from './index.ts';
import { migrate, getSchemaVersion } from './migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes('--reset');

if (reset && existsSync(DB_PATH)) {
  // WAL 模式会额外产生 -wal / -shm 文件，一起删掉
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${DB_PATH}${suffix}`;
    if (!existsSync(f)) continue;
    try {
      rmSync(f);
    } catch (err) {
      // Windows 上如果还有进程连着数据库（最常见的是 dev server 还开着），
      // 删文件会报 EPERM。原始报错只有一行 errno，看不懂，
      // 所以这里翻译成能直接照做的提示。
      if (err instanceof Error && /EPERM|EBUSY/.test(err.message)) {
        console.error(`\n无法删除数据库文件：${f}`);
        console.error('原因：还有进程正在使用它（通常是 npm run dev 还开着）。');
        console.error('解决：先停掉开发服务器（Ctrl+C），再执行 npm run db:reset。\n');
        process.exit(1);
      }
      throw err;
    }
  }
  console.log(`已删除旧数据库：${DB_PATH}`);
}

const db = openDb();

/** 这个库里有没有已经建过表？用来区分"全新库"和"已有库" */
function hasExistingTables(): boolean {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  return (row?.n ?? 0) > 0;
}

const isFresh = !hasExistingTables();

if (isFresh) {
  // 全新库：直接建出最新结构
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(sql);
  console.log('已按 schema.sql 创建基础表结构。');

  // 把版本号推到最新的迁移编号 —— 因为 schema.sql 已经包含了所有迁移的结果。
  // 不做这一步的话，接下来的 migrate() 会尝试往刚建好的表上再 ALTER 一次，
  // 报 "duplicate column name" 之类的错误。
  const { listMigrations } = await import('./migrate.ts');
  const latest = listMigrations().at(-1)?.version ?? 0;
  if (latest > 0) {
    db.exec(`PRAGMA user_version = ${latest}`);
    console.log(`已将结构版本标记为 v${latest}（schema.sql 已包含这些迁移的结果）。`);
  }
} else {
  console.log(`检测到已有数据库（当前结构版本 v${getSchemaVersion(db)}），只应用缺失的迁移。`);
}

// 无论如何都跑一遍迁移：新库会直接跳过（版本号已是最新），
// 老库会补齐缺的部分。
migrate(db);

const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((r) => r.name as string);

const triggers = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
  .all()
  .map((r) => r.name as string);

console.log(`\n数据库就绪：${DB_PATH}`);
console.log(`  结构版本：v${getSchemaVersion(db)}`);
console.log(`  表 (${tables.length})：${tables.join(', ')}`);
console.log(`  触发器 (${triggers.length})：${triggers.join(', ')}`);
console.log('\n下一步：npm run db:seed  灌入演示账号的示例数据');

db.close();
