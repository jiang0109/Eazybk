/**
 * ---------------------------------------------------------------------------
 * 迁移运行器（PostgreSQL 版）
 * ---------------------------------------------------------------------------
 * SQLite 版用 `PRAGMA user_version` 存版本号（数据库头部的一个整数）。
 * Postgres **没有**这个机制，所以标准做法是自己建一张表来记录：
 *
 *     CREATE TABLE schema_migrations (version bigint PRIMARY KEY, applied_at timestamptz)
 *
 * 这张表本身就是"哪些迁移跑过了"的唯一真相 —— 比 user_version 更好的一点是
 * 它还能记录**什么时候**跑的，出问题时能对着时间线排查。
 *
 * 事务处理：
 *   多数情况下每个迁移文件包在一个事务里执行。Postgres 的 DDL 是事务性的
 *   （这一点比 MySQL 强，MySQL 的 DDL 会隐式提交），所以"要么全成功要么全回滚"
 *   在 PG 里是天然可靠的。
 *
 *   但有例外：`CREATE INDEX CONCURRENTLY` 不能放在事务里。
 *   如果将来需要它，要在迁移文件里写 `-- migrate:no-transaction`，
 *   运行器会为那个文件跳过事务（下面实现了这个约定）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool } from './pg.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations-pg');

interface Migration {
  version: number;
  name: string;
  file: string;
  /** 是否需要在事务外执行（比如 CREATE INDEX CONCURRENTLY） */
  noTransaction: boolean;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!match) {
        throw new Error(`迁移文件名不符合规范：${f}\n正确格式：001_add_auth.sql`);
      }
      const file = join(MIGRATIONS_DIR, f);
      const sql = readFileSync(file, 'utf8');
      return {
        version: Number(match[1]),
        name: match[2],
        file,
        noTransaction: sql.includes('-- migrate:no-transaction'),
      };
    })
    .sort((a, b) => a.version - b.version);
}

/** 确保记录表存在。这是迁移机制的"引导"步骤，必须先于一切。 */
async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    bigint PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** 已经应用过哪些版本 */
export async function appliedVersions(): Promise<number[]> {
  await ensureMigrationsTable();
  const result = await getPool().query<{ version: string }>(
    `SELECT version FROM schema_migrations ORDER BY version`,
  );
  return result.rows.map((r) => Number(r.version));
}

/**
 * 应用所有未执行的迁移。
 * 返回实际执行了哪些，方便调用方打日志。
 */
export async function migrate(opts: { silent?: boolean } = {}): Promise<Migration[]> {
  const migrations = loadMigrations();
  await ensureMigrationsTable();
  const applied = new Set(await appliedVersions());

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    if (!opts.silent) console.log('数据库已是最新版本，无需迁移。');
    return [];
  }

  if (!opts.silent) console.log(`准备执行 ${pending.length} 个迁移…`);

  const done: Migration[] = [];
  const pool = getPool();

  for (const m of pending) {
    const sql = readFileSync(m.file, 'utf8');

    if (m.noTransaction) {
      // 需要独立执行的迁移（如 CREATE INDEX CONCURRENTLY）
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
    } else {
      // 取一个专用连接，保证 BEGIN / COMMIT / INSERT 记录都在同一连接上。
      // 如果用 pool.query 各发各的，事务根本不会生效。
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* 事务可能已中止 */
        }
        console.error(`\n迁移失败：${m.file}`);
        console.error(err instanceof Error ? err.message : err);
        // 抛出去让进程退出。带病继续比直接失败更危险。
        throw err;
      } finally {
        client.release();
      }
    }

    done.push(m);
    if (!opts.silent) console.log(`  ✓ v${m.version} ${m.name}`);
  }

  if (!opts.silent) console.log(`迁移完成，已完成 ${(await appliedVersions()).length} 个迁移。`);
  return done;
}

/** 给 npm run db:migrate 用：列出所有迁移及是否已应用 */
export async function listMigrations(): Promise<{ version: number; name: string; applied: boolean }[]> {
  const applied = new Set(await appliedVersions());
  return loadMigrations().map((m) => ({
    version: m.version,
    name: m.name,
    applied: applied.has(m.version),
  }));
}
