/**
 * ---------------------------------------------------------------------------
 * 数据库连接与事务封装
 * ---------------------------------------------------------------------------
 * 用的是 Node 内置的 node:sqlite（Node 22.5+ 提供），所以本项目
 * 不需要装任何数据库依赖，也没有 C++ 编译步骤。
 *
 * 这里集中处理 SQLite 最容易踩的几个坑，注释里都写清了原因。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 数据库文件路径：<项目根>/data/ledger.db */
export const DB_PATH = process.env.DB_PATH ?? `${process.cwd()}/data/ledger.db`;

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;
export type Db = DatabaseSync;

/** 记录一条 SQL 失败的日志，方便排查（生产项目会写进日志系统，这里简化成 console） */
function logSqlError(sql: string, err: unknown) {
  console.error('[sql error]', err instanceof Error ? err.message : err);
  console.error('[sql]', sql.replace(/\s+/g, ' ').trim().slice(0, 200));
}

/**
 * 打开数据库连接。
 *
 * 注意：每个连接都要单独设置 PRAGMA，它们是"连接级"配置而不是数据库级配置。
 * 最典型的坑是 foreign_keys —— **SQLite 默认是关的**，
 * 你以为写了 FOREIGN KEY 就有保护，实际上它压根不生效。
 */
export function openDb(path: string = DB_PATH): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // 外键约束：默认关闭，必须每个连接显式打开
  db.exec('PRAGMA foreign_keys = ON');
  // WAL 模式：读操作不被写操作阻塞，并发表现好得多
  db.exec('PRAGMA journal_mode = WAL');
  // 遇到锁时不立刻报 SQLITE_BUSY，而是最多等 5 秒（SQLite 是单写者模型）
  db.exec('PRAGMA busy_timeout = 5000');
  // 让查询能返回真正的 NULL 而不是 undefined
  db.exec('PRAGMA encoding = "UTF-8"');

  return db;
}

/** 查询多行 */
export function all<T = Row>(db: Db, sql: string, ...params: SqlValue[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (err) {
    logSqlError(sql, err);
    throw err;
  }
}

/** 查询单行（没有匹配时返回 undefined） */
export function get<T = Row>(db: Db, sql: string, ...params: SqlValue[]): T | undefined {
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch (err) {
    logSqlError(sql, err);
    throw err;
  }
}

/** 执行写入语句，返回自增主键与影响行数 */
export function run(db: Db, sql: string, ...params: SqlValue[]) {
  try {
    const result = db.prepare(sql).run(...params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: Number(result.changes),
    };
  } catch (err) {
    logSqlError(sql, err);
    throw err;
  }
}

/** 判断错误是不是 SQLite 的"数据库忙" */
function isBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY|database is locked/i.test(err.message);
}

/**
 * ---------------------------------------------------------------------------
 * 事务
 * ---------------------------------------------------------------------------
 * 事务解决的是"多个写操作必须要么全成功、要么全失败"。
 *
 * 为什么必须用 BEGIN IMMEDIATE 而不是默认的 BEGIN？
 *   - 默认的 BEGIN 是 DEFERRED：先不拿写锁，等第一条写语句才尝试获取。
 *     并发时可能出现"读的时候没被拦，要写的时候才发现别人改了"，直接报 SQLITE_BUSY。
 *   - IMMEDIATE：一开始就获取写锁，把冲突提前暴露。
 *     在 SQLite 里做"读-判断-写"的事务，默认就该用 IMMEDIATE。
 *
 * 加上忙等重试，是为了让并发写入不至于直接失败。
 */
export function tx<T>(db: Db, fn: () => T, retries = 5): T {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusyError(err) && attempt < retries) {
        sleep(20 * (attempt + 1));
        continue;
      }
      throw err;
    }

    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      // 回滚也要保护：万一 COMMIT 已经隐式结束了事务，ROLLBACK 会报错，
      // 不能让它盖住真正的业务错误。
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 事务可能已结束，忽略 */
      }
      throw err;
    }
  }
}

/** 同步等待（Atomics.wait 比忙循环省 CPU）。SQLite 是同步 API，所以这里同步 sleep 是合理的。 */
function sleep(ms: number) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** 单例连接：整个 Node 进程共用一个，SQLite 本来就是进程内嵌数据库 */
let singleton: Db | null = null;

export function getDb(): Db {
  if (!singleton) singleton = openDb();
  return singleton;
}
