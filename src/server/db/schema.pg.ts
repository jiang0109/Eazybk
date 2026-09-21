/**
 * ---------------------------------------------------------------------------
 * 数据库初始化（PostgreSQL 版）
 * ---------------------------------------------------------------------------
 *   node src/server/db/schema.pg.ts           建表 + 应用迁移
 *   node src/server/db/schema.pg.ts --reset   删掉所有表重建（会丢数据！）
 *
 * 和 SQLite 版的两点不同：
 *
 *   1. **没有"删库文件"这个选项**。SQLite 是一个文件，删了就没了；
 *      Postgres 是服务，要"清空"只能 DROP SCHEMA public CASCADE 再重建。
 *      这在 Neon 上尤其要注意 —— 删错了就真没了（免费档有 6 小时恢复窗口，
 *      但不能指望它）。
 *
 *   2. **不能靠"运行 schema 文件"来实现幂等**。SQLite 的
 *      CREATE TABLE IF NOT EXISTS 让 schema.sql 可以反复执行；
 *      但 PG 的触发器和函数需要先 DROP，而且已有数据的库不该重跑建表。
 *      所以这里的逻辑是：
 *        - 空库 → 执行 schema.pg.sql 建出基线结构
 *        - 已有库 → 只跑缺失的迁移
 */

import { getPool, closePool, applyBaseSchema, hasBusinessTables, listTables, getConnectionString } from './pg.ts';
import { migrate, appliedVersions } from './migrate.pg.ts';

const reset = process.argv.includes('--reset');

// ⚠️ 这里必须用 getConnectionString() 而不是直接读 process.env.DATABASE_URL。
//    踩过的坑：我一开始直接读 DATABASE_URL 来打印"目标数据库"，
//    结果跑测试脚本时显示的是 neondb（开发库），让我以为变量没生效、
//    差点去改一堆没问题的地方。实际上连接用的是 getConnectionString()，
//    它正确地返回了 ledger_test —— **只是显示错了**。
//    教训：显示出来的调试信息如果和实际行为用的不是同一个来源，比没有还糟。
const url = getConnectionString();
const host = url.replace(/:\/\/[^@]+@/, '://***@').split('?')[0];
const isTest = url.includes('_test');

console.log(`目标数据库：${host}`);
if (isTest) console.log('  （这是测试库 —— 数据可以随便折腾）');

if (reset) {
  console.log('\n⚠️  --reset：将删除 public schema 下的所有对象（表、函数、触发器）。');
  console.log('    这个操作不可撤销。3 秒后继续，按 Ctrl+C 取消…');
  await new Promise((r) => setTimeout(r, 3000));

  await getPool().query('DROP SCHEMA public CASCADE');
  await getPool().query('CREATE SCHEMA public');
  console.log('  已清空 public schema');
}

const isFresh = !(await hasBusinessTables());

if (isFresh) {
  await applyBaseSchema();
  console.log('已按 schema.pg.sql 创建基础表结构。');
} else {
  console.log('检测到已有表结构，只应用缺失的迁移。');
}

// 无论如何都跑一遍迁移：新库会把 001 也执行一遍（它的 IF NOT EXISTS /
// ON CONFLICT 保证幂等），已有库则补齐缺的部分。
// 这里和 SQLite 版不同 —— SQLite 版会把 user_version 直接跳到最新来"假装执行过"，
// 而 PG 版选择**真的执行一遍**，因为迁移语句都写成了幂等的，
// 这样"新库"和"老库升级"走的是完全相同的代码路径，不容易出现结构差异。
await migrate();

const tables = await listTables();
const versions = await appliedVersions();

console.log(`\n数据库就绪：${host}`);
console.log(`  已应用迁移：v${versions.join(', v') || '(无)'}`);
console.log(`  表 (${tables.length})：${tables.join(', ')}`);
console.log('\n下一步：npm run db:seed  给演示账号灌示例数据');

await closePool();
