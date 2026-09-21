-- =============================================================================
--  迁移 001：加上登录功能
-- =============================================================================
--  为什么这次不重建数据库？
--
--  前面练手的阶段用的是"删了重建"（npm run db:reset），因为库里全是示例数据，
--  丢了不可惜。但现在有两个理由必须改成迁移：
--    1. 库里已经有真实数据了（哪怕只有你一份），不能再随便删
--    2. 真实项目里"给线上正在使用的库加字段"是家常便饭，这是必须会的技能
--
--  迁移的核心思想：**数据库里记录"我执行到第几号了"，启动时只跑没跑过的。**
--  这样同一个脚本在本地、测试、线上都能安全重复执行。
--  我们用 SQLite 内置的 PRAGMA user_version 存这个版本号（它就是数据库头部的一个整数，
--  不需要额外建表）。
--
--  写迁移文件的铁律：
--    - 只能追加，不能修改已经发布过的迁移（别人已经跑过了，改了不会重放）
--    - 每一步都要能重复执行或明确只执行一次（runner 用版本号保证后者）
--    - 不要在这里依赖应用代码，纯 SQL，因为迁移要能在任何版本的应用下跑
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. users 表加登录字段
-- -----------------------------------------------------------------------------
-- SQLite 的 ALTER TABLE 能力有限（能 ADD COLUMN，但不能改列类型或加约束到已有列），
-- 所以这里用"加列 + 唯一索引"的方式，而不是改列定义。

-- 登录名。注意是 username 而不是 email：
--   这个 App 不发邮件（免费版的邮件额度很低，见 README 的部署讨论），
--   所以拿用户名当登录标识最省事。
ALTER TABLE users ADD COLUMN username TEXT;

-- 密码哈希。存的是 scrypt 派生出的字符串（含 salt），**永远不存明文**。
-- 允许 NULL 是为了兼容迁移前就存在的旧用户（他们没有密码，也就无法登录）。
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- 等这个用户是不是"演示账号"。
-- 演示账号的用途：给面试官/访客一键体验，可以被随意增删改，但多两个限制：
--   1. 不能改密码（否则下一个人进不来）
--   2. 可以一键重置数据（否则被玩坏了之后别人看到的是空界面）
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));

-- 注意：不要在这里再 ADD COLUMN created_at。
-- 基线 schema 里 users 表本来就有这一列，重复加会报 "duplicate column name"。
-- 这个错我第一次就踩了 —— 好在这类错误发生在事务里，会被完整回滚，
-- 不会留下"加了一半字段"的残缺结构（见 migrate.ts 里每个迁移单独一个事务）。
-- 写迁移时一定要先看清目标库**当前**的结构，而不是凭印象写。

-- 用户名唯一。用部分索引跳过 NULL —— 旧用户没有用户名，不该被这个约束卡住。
-- 这也是"部分唯一索引"的第二个真实用例（第一个是分类表的同名规则）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username
  ON users (username) WHERE username IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. 会话表
-- -----------------------------------------------------------------------------
-- 为什么要用表存会话，而不是把用户信息签名后放进 Cookie（JWT 那种做法）？
--
--   放进 Cookie 的令牌是"自证"的：只要签名对，服务器就认，**没办法提前撤销**。
--   用户点了"退出登录"、或者你发现账号被盗想踢下线，都做不到（只能等它过期）。
--
--   存在数据库里就能随时删。代价是每次请求多查一次库 ——
--   对我们这个量级（< 50 用户）完全可以忽略。
--
-- 另一个关键点：**表里存的是令牌的哈希，不是令牌原文。**
-- 和密码同理 —— 万一数据库泄露，攻击者拿到哈希也没法直接拿去登录。
CREATE TABLE IF NOT EXISTS sessions (
  -- 用令牌的 SHA-256 十六进制串做主键。
  -- 为什么不用自增 id？因为查会话时我们手里只有令牌，
  -- 拿哈希直接当主键能一次命中，不需要额外建索引。
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  expires_at TEXT NOT NULL
);

-- 退出登录 / 清理过期会话时按用户查，所以要索引。
-- 注意：外键列**不会**自动建索引，这是 SQLite 和 MySQL 都不一样的地方，必须手写。
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- 清理过期会话时按时间扫
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- 3. 登录尝试记录（防暴力破解）
-- -----------------------------------------------------------------------------
-- 为什么要记在数据库里而不是内存里？
--   内存计数在进程重启后就没了，攻击者只要等你重启就能继续爆破。
--   落库才能形成持续的限流。
--
-- 真实的做法通常会按 IP + 用户名两个维度限流（避免有人用大量用户名刷爆某个 IP，
-- 或者反过来）。这里为了简洁只按用户名，注释里说明取舍。
CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  success      INTEGER NOT NULL CHECK (success IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
  ON login_attempts (username, attempted_at DESC);

-- -----------------------------------------------------------------------------
-- 4. 创建演示账号
-- -----------------------------------------------------------------------------
-- 演示账号是给访客用的，所以这里直接建好。
--
-- password_hash 故意留成 NULL：演示账号**不允许通过密码登录**，
-- 只能通过专门的"一键体验"接口进入（见 src/server/auth/routes.ts）。
-- 这样设计的原因：
--   - 不需要在代码或仓库里硬编码一个演示密码（那等于公开一个可登录凭据）
--   - 一键体验走的是另一条明确标记的路径，权限检查更清楚
INSERT INTO users (name, username, password_hash, is_demo)
SELECT '演示账号', 'demo', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'demo');
