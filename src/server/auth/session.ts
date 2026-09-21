/**
 * ---------------------------------------------------------------------------
 * 会话管理 + 登录频率限制
 * ---------------------------------------------------------------------------
 * 设计要点见 001_add_auth.sql 里的注释，这里说实现层面的事。
 */

import { createHash } from 'node:crypto';
import { get, run } from '../db/index.ts';
import type { Db } from '../db/index.ts';
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
 * 这里**不需要**用 scrypt 那种慢哈希，原因：
 *   - 令牌是 256 位随机数，不存在"弱令牌"被字典攻击的问题
 *   - 每个请求都要验一次，慢哈希会让所有请求都卡住
 * 密码需要慢哈希是因为人选的口令熵太低，令牌不是。
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 从数据库行构造对外的用户对象（注意：绝不返回 password_hash） */
function toAuthUser(row: { id: number; name: string; username: string | null; is_demo: number }): AuthUser {
  return {
    id: row.id,
    name: row.name,
    username: row.username ?? '',
    isDemo: row.is_demo === 1,
  };
}

const USER_COLUMNS = 'id, name, username, is_demo';

// ===========================================================================
//  会话
// ===========================================================================

/** 创建会话并把令牌原文返回给调用方（它只在这一刻存在，之后数据库里只有哈希） */
export function createSession(db: Db, userId: number): string {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);

  run(
    db,
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', 'localtime', ?))`,
    tokenHash,
    userId,
    `+${SESSION_DAYS} days`,
  );

  return token;
}

/**
 * 用令牌换用户。
 *
 * 这里做了两件事：查会话 + 顺手清理过期会话。
 * 为什么在"读"的路径里做清理？因为这是唯一确定会被频繁调用的地方，
 * 借它做顺手的垃圾回收，比单独起一个定时任务简单得多。
 * （真实项目里通常两者都有：读路径兜底 + 定时任务批量清理。）
 */
export function getSessionUser(db: Db, token: string | undefined): AuthUser | null {
  if (!token) return null;

  const tokenHash = hashToken(token);

  const row = get<{
    id: number;
    name: string;
    username: string | null;
    is_demo: number;
    expires_at: string;
  }>(
    db,
    `SELECT u.id, u.name, u.username, u.is_demo, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        -- 过期判断放在 SQL 里，而不是取出来再用 JS 比较
        AND s.expires_at > datetime('now', 'localtime')`,
    tokenHash,
  );

  if (!row) {
    // 顺手删掉这张表里所有过期的会话（一次一条语句，不遍历）
    run(db, `DELETE FROM sessions WHERE expires_at <= datetime('now', 'localtime')`);
    return null;
  }

  return toAuthUser(row);
}

/** 退出登录：删掉这一个会话（不影响该用户在其他设备上的登录） */
export function destroySession(db: Db, token: string | undefined): void {
  if (!token) return;
  run(db, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token));
}

/** 踢掉某个用户的所有会话（改密码后应该调用它） */
export function destroyAllSessions(db: Db, userId: number): void {
  run(db, `DELETE FROM sessions WHERE user_id = ?`, userId);
}

/** 清理过期会话。启动时调用一次即可，日常靠 getSessionUser 兜底 */
export function purgeExpiredSessions(db: Db): number {
  const { changes } = run(db, `DELETE FROM sessions WHERE expires_at <= datetime('now', 'localtime')`);
  return changes;
}

// ===========================================================================
//  登录
// ===========================================================================

export type LoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'credentials' | 'rate_limited' | 'demo_not_allowed'; retryAfterMinutes?: number };

/** 频率限制参数：15 分钟内最多失败 5 次 */
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
 *
 * 只统计**失败**的尝试：成功登录不该把人挡在门外。
 */
function checkRateLimit(db: Db, username: string): number | null {
  const row = get<{ fail_count: number; oldest: string | null }>(
    db,
    `SELECT COUNT(*) AS fail_count, MIN(attempted_at) AS oldest
       FROM login_attempts
      WHERE username = ?
        AND success = 0
        AND attempted_at > datetime('now', 'localtime', ?)`,
    username,
    `-${WINDOW_MINUTES} minutes`,
  );

  if (!row || row.fail_count < MAX_ATTEMPTS) return null;

  // 算出还要等多久：最老的一次失败 + 窗口时长 - 现在
  const until = get<{ minutes: number }>(
    db,
    `SELECT CAST((julianday(datetime(?, '+${WINDOW_MINUTES} minutes')) - julianday('now', 'localtime')) * 24 * 60 AS INTEGER) + 1 AS minutes`,
    row.oldest,
  );
  return Math.max(until?.minutes ?? WINDOW_MINUTES, 1);
}

function recordAttempt(db: Db, username: string, success: boolean): void {
  run(db, `INSERT INTO login_attempts (username, success) VALUES (?, ?)`, username, success ? 1 : 0);

  // 顺手清掉窗口期之外的旧记录。
  //
  // 为什么必须做：如果只写不删，这张表会随每次登录尝试无限增长，
  // 几年后连"统计某用户最近的失败次数"这个查询都会变慢。
  // 限流只需要最近一个窗口内的数据，更早的没有用处。
  //
  // 频率很低（只在登录时触发），这点开销可以忽略。
  run(
    db,
    `DELETE FROM login_attempts WHERE attempted_at <= datetime('now', 'localtime', ?)`,
    `-${WINDOW_MINUTES} minutes`,
  );
}

/** 登录成功后清掉失败记录，避免"曾经失败过几次"一直累积到被限流 */
function clearAttempts(db: Db, username: string): void {
  run(db, `DELETE FROM login_attempts WHERE username = ?`, username);
}

/** 用户名 + 密码登录 */
export function login(db: Db, username: string, password: string): LoginResult {
  const normalized = username.trim().toLowerCase();

  const retryAfter = checkRateLimit(db, normalized);
  if (retryAfter !== null) {
    return { ok: false, reason: 'rate_limited', retryAfterMinutes: retryAfter };
  }

  const row = get<{
    id: number;
    name: string;
    username: string | null;
    is_demo: number;
    password_hash: string | null;
  }>(db, `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(username) = ?`, normalized);

  // 注意：即使用户不存在，也要走一遍 verifyPassword 的耗时路径吗？
  // 理想情况下是的（避免通过响应时间判断用户名是否存在）。
  // 这里为了代码简洁没做，但要知道这是一个真实存在的信息泄露点。
  const valid = row ? verifyPassword(password, row.password_hash) : false;

  // 演示账号不允许用密码登录（它没有密码），只能走"一键体验"
  if (row && row.is_demo === 1) {
    recordAttempt(db, normalized, false);
    return { ok: false, reason: 'demo_not_allowed' };
  }

  if (!row || !valid) {
    recordAttempt(db, normalized, false);
    return { ok: false, reason: 'credentials' };
  }

  recordAttempt(db, normalized, true);
  clearAttempts(db, normalized);
  return { ok: true, user: toAuthUser(row) };
}

/** 注册（自动登录） */
export function register(
  db: Db,
  input: { name: string; username: string; password: string },
): { ok: true; user: AuthUser } | { ok: false; reason: 'taken' | 'username_taken_by_demo' } {
  const username = input.username.trim().toLowerCase();

  // 演示账号的用户名不能被注册占用，否则"一键体验"就失效了。
  // 这里显式检查，而不是依赖唯一索引报错 —— 因为报错信息对用户来说
  // 是"用户名已被占用"，而实际原因是另一回事，提示会误导。
  if (username === 'demo') return { ok: false, reason: 'username_taken_by_demo' };

  const exists = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE lower(username) = ?`, username);
  if (exists && exists.n > 0) return { ok: false, reason: 'taken' };

  const passwordHash = hashPassword(input.password);

  const { lastInsertRowid } = run(
    db,
    `INSERT INTO users (name, username, password_hash, is_demo) VALUES (?, ?, ?, 0)`,
    input.name.trim(),
    username,
    passwordHash,
  );

  const row = get<{ id: number; name: string; username: string | null; is_demo: number }>(
    db,
    `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    lastInsertRowid,
  )!;

  return { ok: true, user: toAuthUser(row) };
}

/** 取出演示账号（"一键体验"用） */
export function getDemoUser(db: Db): AuthUser | null {
  const row = get<{ id: number; name: string; username: string | null; is_demo: number }>(
    db,
    `SELECT ${USER_COLUMNS} FROM users WHERE is_demo = 1 ORDER BY id LIMIT 1`,
  );
  return row ? toAuthUser(row) : null;
}
