/**
 * ---------------------------------------------------------------------------
 * 会话管理 + 登录频率限制
 * ---------------------------------------------------------------------------
 * 设计要点见 db/migrations-pg/001_add_auth.sql，这里说实现层面的迁移差异。
 *
 * 从 SQLite 版迁移到 PostgreSQL 的主要不同：
 *   1. 全部变成 async（PG 是网络数据库，查询要等 IO）
 *   2. 时间用真正的 timestamptz，比较靠时间运算而不是字符串比较
 *      （SQLite 是 datetime('now','localtime') 拼字符串，PG 是 now() ± interval）
 *   3. is_demo 是 boolean，不是 0/1
 *   4. 插入用 RETURNING id 而不是 lastInsertRowid
 */

import { createHash } from 'node:crypto';
import { get, run } from '../db/pg.ts';
import { generateSessionToken, hashPassword, verifyPassword } from './password.ts';
import { SESSION_DAYS } from './cookies.ts';

export interface AuthUser {
  id: number;
  name: string;
  username: string;
  isDemo: boolean;
}

/**
 * 令牌哈希。
 *
 * 存进数据库的不是令牌原文，而是它的 SHA-256。
 * 这里**不需要** scrypt 那种慢哈希，原因：
 *   - 令牌是 256 位随机数，不存在"弱令牌"被字典攻击的问题
 *   - 每个请求都要验一次，慢哈希会让所有请求都卡住
 * 密码需要慢哈希是因为人选的口令熵太低，令牌不是。
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 从数据库行构造对外的用户对象（注意：绝不返回 password_hash） */
function toAuthUser(row: {
  id: number;
  name: string;
  username: string | null;
  is_demo: boolean;
}): AuthUser {
  return {
    id: row.id,
    name: row.name,
    username: row.username ?? '',
    isDemo: row.is_demo,
  };
}

/** 统一的列清单。id 加 ::int，避免依赖 BigInt 解析器。 */
const USER_COLUMNS = 'id::int, name, username, is_demo';

// ===========================================================================
//  会话
// ===========================================================================

/** 创建会话并把令牌原文返回给调用方（它只在这一刻存在，之后数据库里只有哈希） */
export async function createSession(userId: number): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);

  // PG 的时间运算：now() + make_interval(days => $3)
  // SQLite 版是 datetime('now','localtime','+30 days') —— 字符串拼接式。
  // PG 的函数式写法语义更明确，也不会因为服务器时区设置而算错。
  await run(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [tokenHash, userId, SESSION_DAYS],
  );

  return token;
}

/**
 * 用令牌换用户。
 *
 * 顺便清理过期会话：这是唯一确定会被频繁调用的地方，
 * 借它做垃圾回收比单独起定时任务简单得多。
 * （真实项目通常两者都有：读路径兜底 + 定时任务批量清理。）
 */
export async function getSessionUser(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;

  const tokenHash = hashToken(token);

  const row = await get<{
    id: number;
    name: string;
    username: string | null;
    is_demo: boolean;
  }>(
    // 过期判断放在 SQL 里（expires_at > now()），而不是取出来再用 JS 比较。
    // 这样用的是数据库的时钟，不受应用服务器时区影响。
    `SELECT ${USER_COLUMNS}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [tokenHash],
  );

  if (!row) {
    // 顺手删掉所有过期会话（一条语句，不遍历）
    await run(`DELETE FROM sessions WHERE expires_at <= now()`);
    return null;
  }

  return toAuthUser(row);
}

/** 退出登录：删掉这一个会话（不影响该用户在其他设备上的登录） */
export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await run(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

/** 踢掉某个用户的所有会话（改密码后应该调用它） */
export async function destroyAllSessions(userId: number): Promise<void> {
  await run(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

/** 清理过期会话。启动时调用一次即可，日常靠 getSessionUser 兜底 */
export async function purgeExpiredSessions(): Promise<number> {
  const { changes } = await run(`DELETE FROM sessions WHERE expires_at <= now()`);
  return changes;
}

// ===========================================================================
//  登录
// ===========================================================================

export type LoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'credentials' | 'rate_limited' | 'demo_not_allowed'; retryAfterMinutes?: number };

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

/**
 * 检查是否已被限流。
 *
 * 为什么按"用户名"而不是按 IP？
 *   - 按 IP：同一个办公室/学校出口 IP 的人会互相影响（误伤），
 *     而且攻击者换 IP 成本很低。
 *   - 按用户名：能有效保护特定账号不被爆破，但攻击者可以用大量用户名
 *     去撞一个常用密码（credential stuffing），这种要另外按 IP 限。
 * 真实系统两个维度都要做。这里为了保持代码可读只做了用户名维度，
 * 这是一个明确记录的取舍，不是遗漏。
 */
async function checkRateLimit(username: string): Promise<number | null> {
  const row = await get<{ fail_count: number; oldest: Date | null }>(
    // interval 运算比 SQLite 的字符串时间计算清晰：
    //   attempted_at > now() - make_interval(mins => 15)
    `SELECT COUNT(*)::int AS fail_count, MIN(attempted_at) AS oldest
       FROM login_attempts
      WHERE username = $1
        AND success = false
        AND attempted_at > now() - make_interval(mins => $2)`,
    [username, WINDOW_MINUTES],
  );

  if (!row || row.fail_count < MAX_ATTEMPTS) return null;

  // 算出还要等多久：最老的一次失败 + 窗口时长 - 现在
  const until = await get<{ minutes: number }>(
    `SELECT GREATEST(
              CEIL(EXTRACT(EPOCH FROM ($1::timestamptz + make_interval(mins => $2) - now())) / 60),
              1
            )::int AS minutes`,
    [row.oldest, WINDOW_MINUTES],
  );
  return until?.minutes ?? WINDOW_MINUTES;
}

async function recordAttempt(username: string, success: boolean): Promise<void> {
  await run(`INSERT INTO login_attempts (username, success) VALUES ($1, $2)`, [username, success]);

  // 顺手清掉窗口期之外的旧记录。
  // 如果只写不删，这张表会随每次登录尝试无限增长，
  // 几年后连"统计某用户最近的失败次数"这个查询都会变慢。
  await run(
    `DELETE FROM login_attempts WHERE attempted_at <= now() - make_interval(mins => $1)`,
    [WINDOW_MINUTES],
  );
}

/** 登录成功后清掉失败记录，避免"曾经失败过几次"一直累积到被限流 */
async function clearAttempts(username: string): Promise<void> {
  await run(`DELETE FROM login_attempts WHERE username = $1`, [username]);
}

/** 用户名 + 密码登录 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const normalized = username.trim().toLowerCase();

  const retryAfter = await checkRateLimit(normalized);
  if (retryAfter !== null) {
    return { ok: false, reason: 'rate_limited', retryAfterMinutes: retryAfter };
  }

  const row = await get<{
    id: number;
    name: string;
    username: string | null;
    is_demo: boolean;
    password_hash: string | null;
  }>(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(username) = $1`, [normalized]);

  // 注意：即使用户不存在，也应该走一遍 verifyPassword 的耗时路径吗？
  // 理想情况下是的（避免通过响应时间判断用户名是否存在）。
  // 这里为了代码简洁没做，但要知道这是一个真实存在的信息泄露点。
  const valid = row ? verifyPassword(password, row.password_hash) : false;

  // 演示账号不允许用密码登录（它没有密码），只能走"一键体验"
  if (row && row.is_demo) {
    await recordAttempt(normalized, false);
    return { ok: false, reason: 'demo_not_allowed' };
  }

  if (!row || !valid) {
    await recordAttempt(normalized, false);
    return { ok: false, reason: 'credentials' };
  }

  await recordAttempt(normalized, true);
  await clearAttempts(normalized);
  return { ok: true, user: toAuthUser(row) };
}

/** 注册 */
export async function register(input: {
  name: string;
  username: string;
  password: string;
}): Promise<{ ok: true; user: AuthUser } | { ok: false; reason: 'taken' | 'username_taken_by_demo' }> {
  const username = input.username.trim().toLowerCase();

  // 演示账号的用户名不能被注册占用，否则"一键体验"就失效了。
  // 显式检查而不是依赖唯一索引报错 —— 因为报错信息对用户来说是
  // "用户名已被占用"，而实际原因是另一回事，提示会误导。
  if (username === 'demo') return { ok: false, reason: 'username_taken_by_demo' };

  const exists = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM users WHERE lower(username) = $1`,
    [username],
  );
  if (exists && exists.n > 0) return { ok: false, reason: 'taken' };

  const passwordHash = hashPassword(input.password);

  // 用 ON CONFLICT 处理并发注册：两个请求同时通过上面的检查时，
  // 唯一索引会挡住第二个。这比"先查再插"更可靠 ——
  // 后者在并发下有竞态窗口（查的时候还没有，插入时就撞了）。
  //
  // ⚠️ 注意 ON CONFLICT 的冲突目标必须和索引定义匹配。
  //    ux_users_username 是**部分唯一索引**（带 WHERE username IS NOT NULL），
  //    所以这里必须写上同样的 WHERE 条件，否则 PG 会报
  //    "there is no unique or exclusion constraint matching the ON CONFLICT specification"。
  //    这个坑我在迁移 001 里踩过一次，值得记住。
  const row = await get<{ id: number; name: string; username: string | null; is_demo: boolean }>(
    `INSERT INTO users (name, username, password_hash, is_demo)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (username) WHERE username IS NOT NULL DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [input.name.trim(), username, passwordHash],
  );

  if (!row) return { ok: false, reason: 'taken' };
  return { ok: true, user: toAuthUser(row) };
}

/** 取出演示账号（"一键体验"用） */
export async function getDemoUser(): Promise<AuthUser | null> {
  const row = await get<{ id: number; name: string; username: string | null; is_demo: boolean }>(
    `SELECT ${USER_COLUMNS} FROM users WHERE is_demo = true ORDER BY id LIMIT 1`,
  );
  return row ? toAuthUser(row) : null;
}

/** 按 id 取用户（调试与后台用） */
export async function findUserById(id: number): Promise<AuthUser | null> {
  const row = await get<{ id: number; name: string; username: string | null; is_demo: boolean }>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  return row ? toAuthUser(row) : null;
}
