/**
 * ---------------------------------------------------------------------------
 * PostgreSQL 连接池与类型映射
 * ---------------------------------------------------------------------------
 * 这个文件是数据库访问的最底层，所有 SQL 都从这里拿到连接。
 *
 * 迁移自 SQLite 版本。SQLite 是"进程内嵌数据库"，没有连接概念；
 * Postgres 是"网络数据库"，每次查询都要经过连接，所以需要连接池。
 */

import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool } = pg;

// ===========================================================================
//  类型映射（**迁移里最关键的一处**）
// ===========================================================================
/**
 * 为什么必须显式配置这些？
 *
 * node-postgres 的默认行为为了"绝不丢精度"，把大数字类型都当**字符串**返回。
 * 这对通用场景是安全的，但对这个项目是灾难性的 ——
 * 我们的金额是 `bigint`，如果返回字符串：
 *
 *     balance - amount   →  "96500" - "3500"  = 93000   （碰巧对）
 *     balance + amount   →  "96500" + "3500"  = "965003500"  （拼接！静默错误）
 *
 * 而且 `typeof x === 'number'` 的判断会全部失效，前端拿到字符串也会出错。
 *
 * 实测确认过需要处理三个 OID（见 scripts/pg-types-probe.ts）：
 *   20   int8 / bigint  —— 金额、余额、自增主键
 *   1700 numeric        —— SUM(bigint) 的返回类型！这个最容易漏
 *   1082 date           —— 日期，默认会变成 Date 对象并引入时区问题
 *
 * 关于精度：把 bigint 转成 JS number 在超过 2^53（约 9007 万亿）时会丢精度。
 * 本项目的金额上限是单笔 1 亿元 = 10^10 分，加上余额汇总也远小于 2^53，
 * 所以安全。这是**有意接受的取舍**：换来的是类型简单、运算直观。
 * 如果哪天要处理超大数值（比如金融级账目），应该保留字符串并用 BigInt 运算。
 */
pg.types.setTypeParser(20, (v) => Number(v)); // bigint → number
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric → number

/**
 * date → 原样返回 'YYYY-MM-DD' 字符串。
 *
 * 为什么不让它变成 Date 对象？
 *   因为 Date 对象带时区语义。数据库里的 date 是"没有时区的日历日期"，
 *   一旦转成 Date，'2026-09-21' 在东八区会被解释为 09-21 08:00（UTC 00:00），
 *   在 GMT-5 时区又可能显示成 09-20。日期统计、按月分组都会因此错位。
 *   保留字符串就完全避开了这个问题 —— 而且在 SQL 里依然可以当日期比较和运算。
 */
pg.types.setTypeParser(1082, (v) => v); // date → 'YYYY-MM-DD'

// ===========================================================================
//  连接池
// ===========================================================================

export type SqlValue = string | number | boolean | null | Date;

/** 查询返回的一行（列名 → 值） */
export type Row = Record<string, unknown>;

/**
 * 从环境变量取连接串。
 *
 * 有三种方式指定目标库，优先级从高到低：
 *   1. `USE_TEST_DB=1` 环境变量 → 强制用 TEST_DATABASE_URL
 *      （npm run db:init:test 这类脚本用它，跨平台、不依赖 shell 语法）
 *   2. `TEST_DATABASE_URL` 存在且 DATABASE_URL 不存在 → 用它（兜底）
 *   3. 默认用 DATABASE_URL
 *
 * 为什么要搞这个区分？
 *   自动化测试会大量增删数据。如果测试和开发共用一个库，
 *   迟早出现"跑完测试发现演示数据被改乱了"。
 *   我第一次把测试指向了错误的库（连到了开发库 neondb），
 *   所以这个机制必须做得明确、不依赖操作者的记忆。
 */
export function getConnectionString(): string {
  const useTest = process.env.USE_TEST_DB === '1';
  const dev = process.env.DATABASE_URL;
  const test = process.env.TEST_DATABASE_URL;

  const url = useTest ? (test ?? dev) : (dev ?? test);

  if (!url) {
    throw new Error(
      '没有找到数据库连接串。请设置环境变量 DATABASE_URL（或 TEST_DATABASE_URL）。\n' +
        '本地开发：cp .env.example .env 然后填入 Neon 的连接串。',
    );
  }

  if (useTest && !test) {
    console.warn('[db] USE_TEST_DB=1 但没有设置 TEST_DATABASE_URL，回退到 DATABASE_URL（注意会动开发数据）');
  }

  return url;
}

/**
 * 清理连接串里那些"由代码接管"的参数。
 *
 * 为什么要做这件事：
 *   Neon 给的连接串末尾带 `?sslmode=require&channel_binding=require`。
 *   但 SSL 我们已经按主机名显式判断并用 `ssl` 选项配置了（见 needsSsl），
 *   再让 `sslmode` 参数走一遍 pg-connection-string 会导致两个问题：
 *     1. 它会对 sslmode 的语义发出警告（说 pg v9 会改行为），日志很吵
 *     2. 两处配置 SSL 容易出现不一致（一个说 require、一个说不要）
 *   `channel_binding` 是 libpq 的参数，node-postgres 并不实现它，
 *   留着只会造成"以为开了通道绑定、其实没有"的错觉。
 *
 * 处理原则：**同一个设置只在一个地方管**。SSL 由代码判断，参数就摘掉。
 * 连接串原样保留在 .env 里，方便直接粘到 Neon 控制台或 psql 用。
 */
function sanitizeConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    // URL 类会把 sslmode 之外的东西原样保留；末尾多余的 ? 会被自动处理
    return url.toString();
  } catch {
    return connectionString;
  }
}

let pool: pg.Pool | null = null;

/**
 * 判断是否需要 SSL。
 *
 * 为什么不能无条件开 SSL？
 *   托管数据库（Neon / Supabase）**强制**要求 TLS，不加就连不上；
 *   但本地或 CI 里的 Postgres 容器通常**不支持** TLS，加了反而握手失败。
 *   所以要根据目标主机判断 —— 这正是"本地能跑、CI 就挂"这类问题的典型来源。
 *
 * 判断方式：主机不是本机地址（localhost / 127.0.0.1 / ::1）就认为需要 SSL。
 * 比解析 sslmode 参数更简单，而且对"连接串里忘了写 sslmode"的情况也安全。
 */
function needsSsl(connectionString: string): boolean {
  if (/sslmode=disable/i.test(connectionString)) return false;
  try {
    const host = new URL(connectionString).hostname;
    return !['localhost', '127.0.0.1', '::1', ''].includes(host);
  } catch {
    return true; // 解析不了就按需要 SSL 处理（联网数据库更常见）
  }
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = getConnectionString();

    pool = new Pool({
      connectionString: sanitizeConnectionString(connectionString),

      // 连接池大小。免费版 Neon 对并发连接有限制，小池子足够这个应用用，
      // 而且不易触发限制。
      max: 5,

      // 空闲连接回收（毫秒）。Neon 的计算会在闲置后挂起，
      // 保持一堆空闲连接没有意义，反而让"挂起"来得更晚。
      idleTimeoutMillis: 30_000,

      // 建立连接的超时。Neon 从挂起状态唤醒需要几百毫秒，
      // 但网络不好时可能更久，给 10 秒容错。
      connectionTimeoutMillis: 10_000,

      // SSL：只在需要时启用（见 needsSsl 的说明）。
      // rejectUnauthorized: false 是因为 Neon 用的是它自己的 CA，
      // Node 默认的信任链里没有，严格校验会直接拒绝连接。
      ...(needsSsl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {}),
    });

    // 池级别的错误（比如空闲连接被服务端断开）不该让进程崩掉。
    // 没有这个监听器时，'error' 事件会变成未捕获异常。
    pool.on('error', (err) => {
      console.error('[db] 空闲连接出错（已忽略，池会自动重建）：', err.message);
    });
  }
  return pool;
}

/** 关闭连接池（脚本结束时调用，否则进程可能不退出） */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ===========================================================================
//  查询封装
// ===========================================================================
/**
 * 这层的存在意义：让上层代码不用关心"是哪个数据库"。
 * SQLite 版这里是 all/get/run 三个同步函数；Postgres 版它们是异步的，
 * 所以调用方要加 await —— 这是迁移里波及面最广的机械改动。
 */

export async function all<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
  const result = await getPool().query(sql, params);
  return result.rows[0] as T | undefined;
}

/** 执行写入语句，返回影响行数 */
export async function run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
  const result = await getPool().query(sql, params);
  return { changes: result.rowCount ?? 0 };
}

/**
 * 执行写入并拿回自增主键。
 * SQLite 用 `lastInsertRowid`，Postgres 用 `RETURNING id` —— 后者更明确，
 * 而且能做到"插入和取值是一次往返"，SQLite 的写法实际上是两次。
 */
export async function insert(sql: string, params: SqlValue[] = []): Promise<number> {
  const result = await getPool().query(sql, params);
  const row = result.rows[0] as { id?: number } | undefined;
  if (!row || typeof row.id !== 'number') {
    throw new Error('INSERT 没有返回 id —— 语句末尾要加 RETURNING id');
  }
  return row.id;
}

/**
 * 在事务里执行一组操作。
 *
 * 和 SQLite 版的关键差异：
 *   1. **必须用同一个连接**。Postgres 的连接池每次 query 可能给不同连接，
 *      而事务是绑定在单个连接上的 —— 从池里拿两次会变成两个独立事务，
 *      起不到原子性作用。所以这里显式取一个 client 全程用它。
 *   2. 不需要 SQLite 那套"BEGIN IMMEDIATE + 忙等重试"。
 *      Postgres 有自己的锁和隔离级别，`BEGIN` 就够了。
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // 回滚失败不能掩盖真正的业务错误
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 事务可能已经中止，忽略 */
    }
    throw err;
  } finally {
    // 必须归还连接，否则连接池会被耗尽
    client.release();
  }
}

/** 事务内用的查询辅助（绑定到指定 client） */
export const txHelpers = {
  all: async <T = Row>(client: pg.PoolClient, sql: string, params: SqlValue[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[],
  get: async <T = Row>(client: pg.PoolClient, sql: string, params: SqlValue[] = []): Promise<T | undefined> =>
    (await client.query(sql, params)).rows[0] as T | undefined,
  run: async (client: pg.PoolClient, sql: string, params: SqlValue[] = []): Promise<{ changes: number }> => {
    const r = await client.query(sql, params);
    return { changes: r.rowCount ?? 0 };
  },
  insert: async (client: pg.PoolClient, sql: string, params: SqlValue[] = []): Promise<number> => {
    const r = await client.query(sql, params);
    const row = r.rows[0] as { id?: number } | undefined;
    if (!row || typeof row.id !== 'number') throw new Error('INSERT 没有返回 id，语句末尾要加 RETURNING id');
    return row.id;
  },
};

// ===========================================================================
//  表结构初始化
// ===========================================================================

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 在空库上建表（执行 schema.pg.sql）。
 *
 * 注意：这个脚本不是幂等的（PG 没有 CREATE TABLE IF NOT EXISTS 带来的
 * 全部便利，尤其是触发器和函数需要先 DROP）。所以只在"库里没有表"时调用。
 * 已经有了的结构变更，走迁移（见 migrate.pg.ts）。
 */
export async function applyBaseSchema(): Promise<void> {
  const sql = readFileSync(join(here, 'schema.pg.sql'), 'utf8');
  await getPool().query(sql);
}

/** 库里有没有业务表？用来区分"全新库"和"已有库" */
export async function hasBusinessTables(): Promise<boolean> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('users','accounts','categories','transactions')`,
  );
  return (row?.n ?? 0) > 0;
}

/** 列出 public schema 里的表（调试用） */
export async function listTables(): Promise<string[]> {
  const rows = await all<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

/** 供迁移目录扫描使用 */
export const MIGRATIONS_DIR = join(here, 'migrations-pg');

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}
