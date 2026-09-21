/**
 * ---------------------------------------------------------------------------
 * 迁移（migration）运行器
 * ---------------------------------------------------------------------------
 * 数据库怎么知道"我执行到第几号迁移了"？
 * 用 SQLite 内置的 `PRAGMA user_version` —— 它就是数据库文件头部的一个整数，
 * 不占表、不需要额外建表，天生适合干这个。读取和写入都是 O(1)。
 *
 * 工作流程：
 *   1. 读 user_version（0 表示全新库）
 *   2. 扫描 migrations/ 目录，查出所有编号大于它的迁移文件
 *   3. 按编号顺序，在一个事务里执行，成功后把 user_version 推进
 *
 * 为什么每个迁移要单独一个事务？
 *   这样"某个迁移执行到一半失败"时，user_version 不会前进，
 *   下次重跑会从同一个迁移重新开始，不会出现"一半应用了、版本号却说没应用"的
 *   中间状态。数据库里的迁移记录和实际结构必须始终一致。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './index.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface Migration {
  version: number;
  name: string;
  file: string;
}

/** 扫描迁移目录，并按编号排序 */
function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      // 文件名约定：001_add_auth.sql → 版本号 1
      const match = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!match) {
        throw new Error(
          `迁移文件名不符合规范：${f}\n正确格式：001_add_auth.sql（三位数字编号 + 下划线 + 描述）`,
        );
      }
      return { version: Number(match[1]), name: match[2], file: join(MIGRATIONS_DIR, f) };
    })
    .sort((a, b) => a.version - b.version);
}

/** 读出数据库当前的迁移版本 */
export function getSchemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * 应用所有未执行的迁移。
 * 返回实际执行了哪些，方便调用方打印日志。
 */
export function migrate(db: Db, opts: { silent?: boolean } = {}): Migration[] {
  const migrations = loadMigrations();
  const current = getSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > current);

  if (pending.length === 0) {
    if (!opts.silent) console.log(`数据库已是最新版本（v${current}），无需迁移。`);
    return [];
  }

  if (!opts.silent) {
    console.log(`当前版本 v${current}，准备执行 ${pending.length} 个迁移…`);
  }

  const applied: Migration[] = [];

  for (const m of pending) {
    const sql = readFileSync(m.file, 'utf8');

    // 每个迁移一个事务：要么这个迁移整体生效，要么整体不生效
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      // user_version 不能用参数占位符（PRAGMA 不支持绑定参数），
      // 所以这里拼字符串。版本号来自文件名解析出的整数，不是用户输入，没有注入风险。
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`\n迁移失败：${m.file}`);
      console.error(err instanceof Error ? err.message : err);
      // 抛出去让进程退出。带病继续跑比直接失败更危险。
      throw err;
    }

    applied.push(m);
    if (!opts.silent) console.log(`  ✓ v${m.version} ${m.name}`);
  }

  if (!opts.silent) {
    console.log(`迁移完成，当前版本 v${getSchemaVersion(db)}。`);
  }
  return applied;
}

/** 给 npm run db:migrate 用 */
export function listMigrations(): { version: number; name: string }[] {
  return loadMigrations().map((m) => ({ version: m.version, name: m.name }));
}
