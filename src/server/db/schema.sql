-- =============================================================================
--  记账 App —— 数据库表结构
-- =============================================================================
--  这是整个项目里最该逐行读的文件。所有业务规则都尽量写成数据库约束，
--  而不是靠应用代码"记得校验"—— 因为代码可以被绕过、会并发、会有 bug，
--  而 CHECK / FOREIGN KEY / UNIQUE 谁也绕不过去。
--
--  执行：npm run db:init   （可重复执行，幂等）
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 用户
--
-- 这份 schema.sql 描述的是**最新完整结构**，所以它已经包含了迁移 001 加上的
-- 登录字段。新库直接建出最终形态，就不需要再跑一遍 ALTER TABLE 了
-- （见 schema.ts 里"新库把版本号直接标到最新"的处理）。
--
-- 判断已有数据库要不要加字段，靠的是 PRAGMA user_version，不是这张表长什么样。
-- 所以每次加迁移，都要记得把对应的结构改动同步回这个文件 ——
-- 否则新库和老库的结构会悄悄产生差异。这是"同时维护 schema 和 migrations"
-- 的真实代价，值得知道（也是有人干脆只用迁移的原因）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  -- 登录名。用 username 而不是 email：这个 App 不发邮件
  -- （免费托管平台的邮件额度很低），拿用户名当登录标识最省事。
  username      TEXT,
  -- scrypt 派生的密码哈希，**永远不存明文**。
  -- 允许 NULL：演示账号没有密码（只能一键体验），迁移前的旧用户也没有。
  password_hash TEXT,
  -- 演示账号：给访客一键体验用，可随意增删改，所以额外提供"重置数据"能力
  is_demo       INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 用户名唯一。用部分索引跳过 NULL —— 没有用户名的行（旧用户）不该被这个约束卡住。
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username
  ON users (username) WHERE username IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 会话
--
-- 为什么用表存会话，而不是把用户信息签名后放进 Cookie（JWT 那种做法）？
--   签名令牌是"自证"的：只要签名对服务器就认，**没办法提前撤销**。
--   用户点"退出登录"、或者你发现账号被盗想踢下线，都做不到。
--   存数据库就能随时删。代价是每次请求多查一次库 —— 这个量级可以忽略。
--
-- 关键：**表里存的是令牌的哈希，不是令牌原文。**
-- 和密码同理 —— 万一数据库泄露，攻击者拿到哈希也没法直接拿去登录。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  -- 用令牌的 SHA-256 做主键：查会话时手里只有令牌，拿哈希直接命中，不用额外索引
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);

-- 外键列**不会**自动建索引，这是 SQLite 和 MySQL 不一样的地方，必须手写
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- 登录尝试记录（防暴力破解）
--
-- 为什么记在数据库而不是内存？内存计数在进程重启后就没了，
-- 攻击者只要等你重启就能继续爆破。落库才能形成持续的限流。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  success      INTEGER NOT NULL CHECK (success IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
  ON login_attempts (username, attempted_at DESC);

-- -----------------------------------------------------------------------------
-- 演示账号
--
-- password_hash 故意留成 NULL：演示账号**不允许通过密码登录**，
-- 只能通过专门的"一键体验"接口进入。这样设计的原因：
--   - 不需要在代码或仓库里硬编码一个演示密码（那等于公开一个可登录凭据）
--   - 一键体验走的是另一条明确标记的路径，权限检查更清楚
--
-- 它也是 `npm run db:seed` 默认灌数据的对象。
-- -----------------------------------------------------------------------------
INSERT INTO users (name, username, password_hash, is_demo)
SELECT '演示账号', 'demo', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'demo');

-- -----------------------------------------------------------------------------
-- 账户（现金 / 银行卡 / 信用卡 / 电子钱包 / 投资）
--
-- 关键点 1：金额一律用 INTEGER 存"分"，绝不用 REAL 存"元"。
--           浮点数会累积误差（0.1+0.2 != 0.3），最后导致余额对不上账。
--           19.99 元存成 1999，显示时再除以 100。
--
-- 关键点 2：balance_cents 是"派生数据"（= 初始余额 + 所有流水之和）。
--           明明能算出来为什么还存一列？因为每次显示余额都全表聚合太慢。
--           代价是必须保证它不漂移 —— 所以用触发器强制同步（见文件末尾）。
--           兜底手段：它随时可以用一条 SQL 重建（见 queries.ts 的 checkBalanceDrift）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  -- CHECK 把合法取值写进数据库：挡住 'bandcard' 这类拼写错误。
  type                  TEXT NOT NULL CHECK (type IN ('cash','bank','credit','ewallet','investment')),
  -- 建账户时的初始余额，比如把招行卡里现有的 3200.50 元记进来 → 320050
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  -- 由触发器维护的当前余额
  balance_cents         INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'CNY',
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),

  -- 同一用户下账户名不重复。约束粒度是 (user_id, name)，不是全局唯一的 name。
  UNIQUE (user_id, name)
);

-- -----------------------------------------------------------------------------
-- 分类（支持二级分类：parent_id 自引用）
--
-- 一级分类（parent_id IS NULL）：餐饮、交通、购物、房租、娱乐 / 工资、兼职、理财收益
-- 二级分类：餐饮 → 早餐、午餐、外卖、下馆子
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- kind 区分收入/支出。注意它和分类名要一起看：支出里的"餐饮"和
  -- 收入里的"退餐饮"是两条不同的记录。
  kind       TEXT NOT NULL CHECK (kind IN ('expense','income')),
  parent_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),

  -- 不允许自己当自己的父级
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- 部分唯一索引：WHERE 让它只覆盖"一级分类"这些行。
-- 好处：同一 kind 下不允许两个"餐饮"，但不同类型的同名分类可以共存。
-- 它同时也是性能优化 —— 索引只覆盖部分行，更小更快。
CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_root_name
  ON categories (user_id, kind, name) WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_child_name
  ON categories (user_id, parent_id, name) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id);

-- -----------------------------------------------------------------------------
-- 流水（核心表）
--
-- 设计要点 1：收入和支出放在同一张表，用"符号"表示方向。
--             amount_cents > 0 流入，< 0 流出。
--             于是 SUM(amount_cents) 天然就是净额，不用 UNION 两张表，
--             统计报表的 SQL 也能统一处理。
--
-- 设计要点 2：转账 = 同一账户下两行相反数（本项目的转账是"支出被标记为
--             账户间搬运"，用 type='transfer' 表示它不计入收支统计）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id  INTEGER          REFERENCES categories(id) ON DELETE RESTRICT,
  type         TEXT NOT NULL CHECK (type IN ('expense','income','transfer')),
  -- 带符号金额（分）。不允许为 0：0 元流水没有意义，还会污染"记了几笔"的统计。
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  -- 备注可选
  description  TEXT NOT NULL DEFAULT '',
  -- 记账日期（业务日期，YYYY-MM-DD），和 created_at（录入时间）是两回事：
  -- 你可能今天补记上周日的消费。所有报表一律按 occurred_on 统计。
  -- GLOB 是 SQLite 的模式匹配，这里用来强制日期格式，防止写入 '2024/3/5' 这种脏数据。
  occurred_on  TEXT NOT NULL CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),

  -- 【本表最重要的一条约束】业务规则：分类该不该填，由 type 决定。
  --   转账 -> category_id 必须是 NULL（转账没有"花在哪儿"的概念）
  --   收支 -> category_id 必须有值（否则报表里会出现无分类的黑洞）
  -- 在数据库层挡住它，统计 SQL 就永远不用写防御性的 WHERE category_id IS NOT NULL。
  CHECK (
    (type =  'transfer' AND category_id IS NULL)
    OR
    (type <> 'transfer' AND category_id IS NOT NULL)
  )
);

-- 索引：对应三个高频查询。
-- 复合索引的列顺序有讲究 —— 等值条件的列在前（user_id），排序的列在后（occurred_on），
-- 这样索引本身就排好序，"ORDER BY occurred_on DESC LIMIT 20" 可以直接顺序取，不用额外排序。
CREATE INDEX IF NOT EXISTS idx_tx_user_date     ON transactions (user_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_tx_account_date  ON transactions (account_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_tx_category_date ON transactions (category_id, occurred_on DESC);

-- 注意：FOREIGN KEY 列不会自动建索引。上面三个索引里已经覆盖了 account_id
-- 和 category_id，所以删除父行时的引用检查不会退化成全表扫描。

-- =============================================================================
--  触发器
-- =============================================================================
--  为什么余额必须由触发器维护？
--  如果靠应用代码"记完账顺手改一下余额"，只要有一条写入路径忘了改，
--  余额就永久错了 —— 而且没有任何报错，是静默的数据损坏，最难排查。
--  放进数据库，"忘记"这个可能性就不存在了。
-- =============================================================================

-- 新增流水 -> 加到余额上
CREATE TRIGGER IF NOT EXISTS trg_tx_ai_balance
AFTER INSERT ON transactions
BEGIN
  UPDATE accounts
     SET balance_cents = balance_cents + NEW.amount_cents
   WHERE id = NEW.account_id;
END;

-- 删除流水 -> 从余额里扣掉
CREATE TRIGGER IF NOT EXISTS trg_tx_ad_balance
AFTER DELETE ON transactions
BEGIN
  UPDATE accounts
     SET balance_cents = balance_cents - OLD.amount_cents
   WHERE id = OLD.account_id;
END;

-- 修改流水 -> 先撤销旧值的影响，再施加新值的影响。
-- 这个"减法技巧"同时正确处理三种情况：改金额、改账户、金额和账户都改。
CREATE TRIGGER IF NOT EXISTS trg_tx_au_balance
AFTER UPDATE ON transactions
BEGIN
  UPDATE accounts
     SET balance_cents = balance_cents - OLD.amount_cents
   WHERE id = OLD.account_id;

  UPDATE accounts
     SET balance_cents = balance_cents + NEW.amount_cents
   WHERE id = NEW.account_id;
END;

-- 子分类的 kind 必须和父分类一致（"餐饮"下不能挂一个"收入"子分类）。
-- 为什么用触发器？因为 CHECK 只能看当前这一行，无法查询父行的 kind。
-- 遇到"约束需要跨行比较"的场景，触发器就是标准答案。
CREATE TRIGGER IF NOT EXISTS trg_categories_kind_match_ai
BEFORE INSERT ON categories
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '子分类的类型必须和父分类一致')
  WHERE NEW.kind <> (SELECT kind FROM categories WHERE id = NEW.parent_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_categories_kind_match_au
BEFORE UPDATE OF kind, parent_id ON categories
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '子分类的类型必须和父分类一致')
  WHERE NEW.kind <> (SELECT kind FROM categories WHERE id = NEW.parent_id);
END;
