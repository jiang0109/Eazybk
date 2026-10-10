# 项目总结：从零到线上的记账应用

> 这份文档是这个项目的完整复盘：
> **技术选型的理由** → **数据库必备知识** → **数据库生态对比** → **部署全过程**。
>
> 写它的目的不是罗列做了什么，而是把"为什么这么做"和"踩过的坑"留下来。

| | |
|---|---|
| **项目** | 记账 App（Ledger / Eazybk） |
| **仓库** | https://github.com/jiang0109/Eazybk |
| **线上演示** | https://eazybk.onrender.com （点「一键体验演示账号」） |
| **规模** | 51 个文件；服务端 3191 行 TS + 前端 3167 行 TSX + 318 行 SQL；70 项 API 断言 |
| **技术栈** | React 19 + TypeScript + Vite 8 + Tailwind v4 + Framer Motion + Zustand / Node 原生 HTTP + PostgreSQL |

---

## 目录

1. [这个项目是什么](#一这个项目是什么)
2. [技术选型：为什么是这些](#二技术选型为什么是这些)
3. [数据库必备知识](#三数据库必备知识科普)
4. [数据库生态对比与选型指南](#四数据库生态对比与选型指南)
5. [部署全过程](#五部署全过程)
6. [踩坑清单汇总](#六踩坑清单汇总)
7. [如果重来一次](#七如果重来一次)
8. [延伸学习方向](#八延伸学习方向)

---

## 一、这个项目是什么

功能完整的记账应用：

- **认证**：注册 / 登录 / 一键体验演示账号（scrypt 密码哈希 + 数据库会话 + 登录限流）
- **多用户隔离**：每个用户只能看到自己的数据（有专门的越权攻击测试）
- **记账**：金额、类型（支出/收入/转账）、分类（支持二级）、账户、日期、备注
- **流水管理**：按月查看、按日分组、修改、删除
- **统计**：余额、月度汇总、分类占比环形图、近 6 个月趋势柱状图
- **管理**：账户与分类增删改、演示数据一键重置

---

## 二、技术选型：为什么是这些

选型的核心原则只有一条：**这个项目的目标是"练数据库"，所以技术栈要尽可能不遮挡数据库。**

### 2.1 前端

| 选择 | 理由 | 被否决的方案 |
|---|---|---|
| **React 19 + TypeScript** | 生态最大；类型能约束前后端接口契约 | Vue（也行，纯粹是熟悉度问题） |
| **Vite** | 启动构建都快；`vite.config.ts` 能挂自定义中间件 | Next.js ❌ SSR/RSC 会引入大量与数据库无关的复杂度 |
| **Tailwind CSS v4** | v4 改成 CSS-first 配置（`@theme`），不再需要 JS 配置文件；原子类让深色主题的一致性变简单 | CSS Modules（可行，但改主题要动很多文件） |
| **Framer Motion** | `AnimatePresence` 处理弹层**退出**动画是纯 CSS 做不到的 | 纯 CSS（做不了退出动画） |
| **Zustand** | 轻量；只放 UI 状态 | Redux ❌ 这个规模是杀鸡用牛刀 |

**一个关键设计：Zustand 里不存业务数据。**

```ts
// ❌ 常见做法：把流水列表也放进 store
//    → 你多了一份"数据库的副本"，得手动保证两份一致
// ✅ 本项目：store 只放 UI 状态 + 一个 version 计数器
//    任何写操作后 version+1，订阅它的组件重新查询数据库
```

为什么？**业务数据的唯一真相在数据库里。** 把副本放进 store 是大量前端 bug 的来源（"列表更新了但统计没更新"）。用"版本号触发重新查询"是最简单可靠的缓存失效机制。

### 2.2 后端：为什么不用框架，更不用 ORM

**不用 Web 框架**：Node 内置的 `node:http` 对这个规模完全够。自己写的路由表比引入 Express 再学它的中间件模型更透明，而且少一个依赖就少一层部署变数。

**不用 ORM —— 这条最重要。**

对比同一个需求：

```ts
// ORM（Prisma 风格）
const txs = await prisma.transaction.findMany({
  where: { userId: 1, amountCents: { lt: 0 } },
  include: { category: true },
  orderBy: { occurredOn: 'desc' },
  take: 20,
});
```

```sql
-- 手写 SQL
SELECT t.*, c.name AS category_name
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
WHERE t.user_id = $1 AND t.amount_cents < 0
ORDER BY t.occurred_on DESC
LIMIT 20;
```

ORM 的代价不是"不好"，而是**它把 SQL 藏起来了**：

- 你不知道它生成了什么 SQL，慢了查不出来
- 它替你建表，你就没机会想"这条约束该不该加"
- 它替你管事务，你学不会事务边界该划在哪
- 最坑的是 **N+1 查询**：你以为查一次，它背着你发了几百条 SQL

**ORM 的定位是给已经懂数据库的人提速用的。** 目标是学数据库时用 ORM，等于请了个代笔。

代价也要说清楚：手写 SQL 更啰嗦，动态条件拼接容易出错（本项目 `buildTxFilter` 里演示了那个坑——占位符编号必须和参数数组严格同步）。

### 2.3 数据库：SQLite → PostgreSQL 的两步走

这不是一开始就规划好的，是分两步的结果：

```
第一步（学习阶段）：SQLite
  理由：零安装零配置，一个文件。注意力能全放在建模和 SQL 上。
  代价：学不到并发、权限、严格类型。

第二步（部署阶段）：PostgreSQL（Neon 托管）
  触发点：部署时发现 SQLite 需要"持久化磁盘"，
          而免费托管平台的磁盘都是临时的。
  收益：顺便学到了 SQLite 给不了的东西。
```

**这个顺序本身是一条经验**：先用最简单的工具把核心概念搞懂，遇到真实约束（部署、并发、协作）再升级。反过来一开始就上 PostgreSQL，你会在还没搞懂 JOIN 的时候先被连接池和权限配置劝退。

### 2.4 部署：为什么是 Render + Neon

详细推理见[第五章](#五部署全过程)。结论：

- **Vercel 不行**：它跑无状态函数，没有持久磁盘、没有长驻进程
- **Supabase 只解决一半**：给数据库和登录，但**不跑你的 Node 代码**
- **Neon 的闲置行为最适合作品集**：计算挂起后**下次请求自动唤醒**
- **Render 免费档能跑 Node 进程**：虽有 15 分钟休眠，但可接受

### 2.5 为什么手写图表（一个被否决的依赖）

最初用了 Recharts，结果**在 React 19 下它渲染不出环形图的扇形**——`<g class="recharts-shape">` 是空的，DOM 里根本没有 `<path>`。界面上是一个空白圆环。

判断后**移除了这个 300 kB 的依赖**，改手写 SVG：

| 图表 | 实现 | 关键点 |
|---|---|---|
| 环形图 | 同心圆 + `stroke-dasharray` | **不用算三角函数**：周长 = 2πR，按比例切线段即可 |
| 柱状图 | `<rect>` + 刻度归整 | 纵轴刻度要归整到 1/2/5×10ⁿ，否则出现 "8347" 这种刻度 |

收益：产物从 763 kB 降到 411 kB，行为完全可控。

**经验**：依赖能省时间，但**渲染类依赖和框架版本强耦合**，最容易在升级时炸掉。两个简单图表不值得引入这个风险。

### 2.6 为什么"零构建"（Node 直接跑 `.ts`）

Node 22.18+ / 24+ 能**直接运行 `.ts` 文件**（类型剥离，不做类型检查）。

```bash
node src/server/index.ts    # 就这样，没有编译步骤
```

好处：改一行代码不用等构建；部署时只需构建前端。

代价（都是真实的）：

- **不能用 TS 的"参数属性"语法**：`constructor(public status: number)` 报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
- **相对导入必须写全 `.ts` 扩展名**：`./db/pg.ts` 而不是 `./db/pg`
- **不做类型检查**：类型错误只在 `npm run typecheck` 时暴露，所以 CI 必须跑这一步
- **必须锁 Node 版本**：`package.json` 加 `engines`，否则托管平台可能给你一个跑不了的版本

---

## 三、数据库必备知识（科普）

通用知识，每条都配了本项目的实例。

### 3.1 金额绝对不能用浮点数

新手第一大坑。

```sql
-- ❌ 千万不要
amount REAL  -- 存 19.99
```

浮点数用二进制表示小数，`0.1 + 0.2 !== 0.3`。误差会累积，最后出现"余额比流水加起来多 3 分钱"，而且**你没法用 `=` 比较，也没法用 `SUM` 对账**。

```sql
-- ✅ 正确：整数存最小货币单位
amount_cents BIGINT  -- 19.99 元 → 1999
```

好处：加减乘除全部精确；对账可用 `=` 精确比较；**元↔分的转换只发生在边界一处**。

**注意类型选择**：PostgreSQL 的 `INTEGER` 只有 32 位（上限约 2147 万），存"分"很容易溢出，**必须用 `BIGINT`**。SQLite 的 `INTEGER` 天生 64 位。

### 3.2 约束应该放在数据库，不是应用代码

核心问题：**有哪些事实绝对不能出错？该把约束放在哪一层？**

原则：**尽量放数据库**。应用代码可以被绕过（直接连库改数据、新脚本忘了校验、并发时两个请求同时通过检查），而数据库约束谁也绕不过去。

| 类型 | 实现 | 挡什么 |
|---|---|---|
| 类型正确 | `CHECK (type IN ('cash','bank',...))` | `'bandcard'` 这类拼写错误 |
| 关系正确 | `FOREIGN KEY` | 一笔账挂到不存在的账户 |
| 业务规则 | 更复杂的 `CHECK` | 转账居然带分类、金额为 0 |
| 派生数据不漂移 | `TRIGGER` | 账户余额和流水对不上 |

**最能说明问题的一条**：

```sql
CHECK (
  (type =  'transfer' AND category_id IS NULL)
  OR
  (type <> 'transfer' AND category_id IS NOT NULL)
)
```

它表达"字段 A 决定字段 B 是否必填"。没有它，报表里会出现"分类 = 转账"这种无意义的行——让数据库直接拒绝，你的统计 SQL 就永远不用写防御性的 `WHERE category_id IS NOT NULL`。

**分工**：数据库负责"不许你写错"，应用层负责"说清楚为什么错"。本项目在 `api.ts` 里把 PG 的英文报错翻译成人话。

**外键不是装饰**：SQLite 的 `PRAGMA foreign_keys` **默认是关的**！写了 `FOREIGN KEY` 以为有保护，实际压根不生效。这是 SQLite 最有名的坑之一。（PostgreSQL 不需要开。）

删除策略也要明确：`transactions.category_id` 用 `ON DELETE RESTRICT`（有引用就拒绝删）。改成 `CASCADE` 会连流水一起删——在记账应用里是灾难性的。

### 3.3 索引：原理和用法

索引让查询变快，代价是写入变慢、占空间。**不要凭感觉加索引。**

**正确顺序**：先写查询 → 用 `EXPLAIN` 看它怎么执行 → 再决定加什么索引。

```sql
EXPLAIN ANALYZE
SELECT * FROM transactions WHERE user_id = 1 ORDER BY occurred_on DESC LIMIT 20;
-- "Seq Scan" = 全表扫描；"Index Scan" = 用上了索引
```

**复合索引的列顺序有讲究**：

```sql
CREATE INDEX idx_tx_user_date ON transactions (user_id, occurred_on DESC);
```

- `(user_id, occurred_on)`：先按用户切块，块内已按日期排序 → 定位后顺序取前 20 条，**不用额外排序**
- `(occurred_on, user_id)`：全局按日期排列 → 要找出 user_id=1 的记录得全索引扫描

**口诀：等值条件的列放左边，范围/排序的列放右边。**

**部分索引**（`WHERE` 子句）有两种用途：

```sql
-- 用途一：不同层级用不同的唯一性规则
CREATE UNIQUE INDEX ux_categories_root_name
  ON categories (user_id, kind, name) WHERE parent_id IS NULL;

-- 用途二：只对非空值唯一
CREATE UNIQUE INDEX ux_users_username
  ON users (username) WHERE username IS NOT NULL;
-- 效果：没有用户名的旧用户不会被这个约束卡住
```

**两个容易忽略的点**：

1. **外键列不会自动建索引**（PostgreSQL 也不会）。没索引时，删除父行需全表扫描子表检查引用。
2. **索引不是越多越好**。每个索引都让 INSERT/UPDATE 变慢。

### 3.4 触发器与派生数据

**派生数据**：账户余额 = 初始余额 + 所有流水之和。既然能算，**为什么还要存一列？**

因为每次显示都全表聚合太慢。这是典型的**缓存/派生数据**权衡：存起来读得快但有漂移风险；不存永远正确但慢。

本项目选择：**存，但用触发器强制同步**。任何增删改都自动改余额，没有"应用代码忘了更新"这个可能。

**关键设计：留一条重建路径。** 因为余额是派生的，随时可以验算：

```sql
SELECT a.name, a.balance_cents AS 存的余额,
       a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS 实时算的,
       a.balance_cents - (a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0)) AS 漂移量
  FROM accounts a
  LEFT JOIN transactions t ON t.account_id = a.id
 GROUP BY a.id
HAVING a.balance_cents - (a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0)) <> 0;
```

**返回 0 行才说明数据库健康。** 本项目把它做成了接口 `GET /api/health/balance`。

**触发器也是"跨行约束"的唯一解法**。`CHECK` 只能看当前行，无法查询父行的值。所以"子分类类型必须和父分类一致"只能用触发器。

```sql
CREATE OR REPLACE FUNCTION fn_categories_kind_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_kind text;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT kind INTO parent_kind FROM categories WHERE id = NEW.parent_id;
    IF parent_kind IS NOT NULL AND parent_kind <> NEW.kind THEN
      RAISE EXCEPTION '子分类的类型必须和父分类一致';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
```

### 3.5 事务与 ACID

事务解决"**多个写操作必须全成功或全失败**"。最典型的例子是转账：

```
BEGIN
  1. 从 A 账户扣 500
  2. 给 B 账户加 500
COMMIT
```

如果第 1 步成功后程序崩溃，数据库里就凭空少了 500 元。事务保证这两步是**原子操作**。

| 特性 | 含义 |
|---|---|
| **A** 原子性 | 要么全做，要么全不做 |
| **C** 一致性 | 事务前后约束都满足 |
| **I** 隔离性 | 并发事务互不干扰 |
| **D** 持久性 | 提交成功后即使断电也不丢 |

**新手最容易忽略的点**：**事务边界应该由业务操作决定，不是由一条 SQL 决定。** "一次转账"是一个业务操作，所以它是一个事务。

**PostgreSQL 的关键细节**：事务绑定在**单个连接**上。用连接池时如果各发各的语句，`BEGIN`/`COMMIT` 根本不生效：

```ts
// ❌ 三条语句可能跑在三个不同连接上，事务无效
await pool.query('BEGIN');
await pool.query('INSERT ...');
await pool.query('COMMIT');

// ✅ 取一个专用 client，全程用它
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT ...');
  await client.query('COMMIT');
} finally {
  client.release();   // 必须归还，否则连接池会被耗尽
}
```

### 3.6 并发：丢失更新与隔离级别

**必考题**：两个人同时给你的账户转账 100 元，余额变成多少？

答案是 +200。因为 `UPDATE accounts SET balance = balance + 100` 是**原子**操作。

但新手常见写法会出错：

```
1. SELECT balance FROM accounts WHERE id = 1;   -- 读到 1000
2. 在程序里算 1000 + 100 = 1100
3. UPDATE accounts SET balance = 1100 WHERE id = 1;
```

两个请求可能都读到 1000、都写 1100，结果是 1100 而不是 1200——**少了 100**。这叫**丢失更新（lost update）**。

**结论：能用一条 SQL 表达"读-改-写"，就不要拆成"先读再算再写"。** 必须拆时，用事务 + `SELECT ... FOR UPDATE` 锁住行。

**隔离级别**：

| 级别 | 可能出现的问题 |
|---|---|
| Read Uncommitted | 脏读、不可重复读、幻读 |
| **Read Committed**（PostgreSQL 默认） | 不可重复读、幻读 |
| Repeatable Read | 幻读（PG 这级别实际能挡住） |
| Serializable | 无（但可能因冲突回滚，需要重试） |

**SQLite 的特殊性**：单写者模型，同一时刻只允许一个写事务。所以：

```sql
PRAGMA journal_mode = WAL;    -- 读不被写阻塞，写不被读阻塞
PRAGMA busy_timeout = 5000;   -- 遇到锁时最多等 5 秒，而不是立刻报错
```

"读-判断-写"的事务应该用 **`BEGIN IMMEDIATE`**（一开始就拿写锁），而不是默认的 `BEGIN`（延迟到第一条写语句才拿锁，并发时容易读完才发现冲突）。

### 3.7 数据库迁移（Schema 演进）

**问题**：表结构要改，但库里已有真实数据，不能删库重建。

**解法**：迁移。核心思想是**数据库里记录"执行到第几号了"，启动时只跑没跑过的。**

| 记录方式 | 适用 |
|---|---|
| SQLite 的 `PRAGMA user_version` | 数据库头部的一个整数，不用额外建表 |
| 自建 `schema_migrations` 表 | 通用做法，还能记录**什么时候**跑的 |

**写迁移的铁律**：

1. **只能追加，不能修改已发布过的迁移**（别人已跑过，改了不会重放）
2. **不依赖应用代码**，纯 SQL，这样它能在任何版本的应用下跑
3. **每个迁移单独一个事务**——中途失败不会留下"加了一半字段"的残缺结构
4. **先看清目标库的当前结构再写**，不要凭印象（本项目踩过：给已有 `created_at` 的列又 `ADD COLUMN` 了一次）

**迁移和基线 schema 的关系**：两种做法都常见。

- **只用迁移**：从空库跑一串迁移。结构 = 所有迁移的叠加，可读性差。
- **基线 + 迁移**（本项目）：`schema.pg.sql` 描述最新完整结构，新库直接建出最终形态；已有库只跑缺失的迁移。好处是打开一个文件就能看到表的**当前完整样子**。

代价：**每次加迁移，都要把结构改动同步回基线文件**，否则新库和老库会悄悄产生差异。

### 3.8 认证相关的数据库知识

**密码存储三条铁律**：

1. **永远不存明文。** 数据库泄露时，明文等于把所有用户密码（以及他们在别的网站复用的同一密码）送出去。
2. **不用 SHA-256 / MD5 这类"快"哈希。** GPU 每秒能算几十亿次，弱密码瞬间被破解。必须用**慢哈希**（scrypt / bcrypt / argon2），故意让每次计算耗时几十到几百毫秒。
3. **每个密码用独立随机 salt。** 否则两个用户设了同样的密码，哈希值一模一样——攻击者一眼看出"这两人密码相同"，还能用预计算的表同时破解。

**本项目格式**：`scrypt$<salt的hex>$<派生密钥的hex>`。参数和 salt 一起存，因为将来可能调高 cost 参数，必须知道当初用的是哪套才能验证。

**比较哈希必须用恒定时间比较**（`timingSafeEqual`），不能用 `===`。普通比较是"发现第一个不同的字符就返回 false"，耗时和"前多少个字符匹配"相关。攻击者可以精确测量响应时间，逐字符把哈希值试出来（**时序攻击**）。

**一个真实的取舍**：登录时如果用户不存在，理论上也该走一遍密码校验的耗时路径（避免通过响应时间判断用户名是否存在）。本项目为了代码简洁没做，是明确记录的取舍。

**会话为什么存数据库而不是 JWT？**

签名令牌（JWT）是"自证"的：只要签名对服务器就认，**没办法提前撤销**。用户点"退出登录"、或你发现账号被盗想踢下线，都做不到，只能等它过期。

存数据库就能随时删。代价是每次请求多查一次库——这个量级可忽略。

**关键细节：表里存的是令牌的哈希，不是原文。** 和密码同理——数据库泄露也不能直接拿去登录。

但这里**不需要** scrypt 那种慢哈希，因为：令牌是 256 位随机数，不存在"弱令牌"被字典攻击的问题；而且每请求都要验一次，慢哈希会让所有请求都卡住。**密码需要慢哈希是因为人选的口令熵太低，令牌不是。**

**登录限流为什么落库？** 内存计数在进程重启后就清空了，攻击者只要等你重启就能继续爆破。

**维度选择**：按 IP 会误伤同一出口 IP 的人，且攻击者换 IP 成本低；按用户名能保护特定账号，但挡不住"用大量用户名撞一个常用密码"（credential stuffing）。**真实系统两个维度都要做**，本项目只做了用户名，是明确取舍。

---

## 四、数据库生态对比与选型指南

### 4.1 先分大类

| 类型 | 代表 | 数据模型 | 典型场景 |
|---|---|---|---|
| **关系型（RDBMS）** | PostgreSQL, MySQL, SQLite | 表 + 行 + 外键 | 复杂关系和事务：财务、订单、ERP |
| **文档型** | MongoDB, CouchDB | JSON 文档 | 结构不固定、整体读写：CMS、日志 |
| **键值（KV）** | Redis, DynamoDB | key → value | 缓存、会话、计数器、排行榜 |
| **列族** | Cassandra, HBase | 宽表 | 海量写入、时序（IoT、监控） |
| **图** | Neo4j | 节点 + 边 | 社交关系、推荐、反欺诈 |
| **时序（TSDB）** | InfluxDB, TimescaleDB | 时间戳 + 指标 | 监控指标、传感器 |
| **搜索** | Elasticsearch, Meilisearch | 倒排索引 | 全文检索、日志分析 |
| **向量** | pgvector, Pinecone | 向量 | 语义搜索、RAG |

**给新手的一句话**：**默认选关系型。** 只有你能清晰说出"关系型为什么不行"时，才考虑其他类型。绝大多数"我们需要 NoSQL"的场合，用 PostgreSQL 就够，而且少踩很多坑。

### 4.2 主流关系型数据库对比

| | **SQLite** | **PostgreSQL** | **MySQL / MariaDB** |
|---|---|---|---|
| **架构** | 进程内嵌（一个文件） | 客户端-服务器 | 客户端-服务器 |
| **并发** | 单写者（WAL 下读写可并行） | MVCC，真正的并发控制 | MVCC（InnoDB） |
| **类型系统** | 弱（字符串能塞进 INT 列） | **严格** | 中等 |
| **JSON** | `json()` 函数 | **JSONB**（可索引可查询） | JSON 类型 |
| **全文检索** | FTS5 扩展 | 内置 `tsvector` | 内置（效果一般） |
| **扩展性** | 有限 | **极强**（PostGIS、pgvector、Timescale） | 一般 |
| **运维成本** | **零** | 中（调参、备份、监控） | 中 |
| **适合** | 移动/桌面应用、单机工具、**原型与学习**、边缘计算 | 生产首选；复杂查询、强一致、高并发 | 传统 Web 应用、已有生态依赖 |
| **不适合** | 多机部署、高并发写、细粒度权限 | 资源受限的嵌入式场景 | 需要高级 SQL 特性时 |

**为什么新项目大多选 PostgreSQL？**

- 类型最严格（帮你早发现 bug）
- SQL 特性最全（窗口函数、CTE、`RETURNING`、`ON CONFLICT`、`LATERAL`）
- 扩展生态强（一个数据库顶好几个：`pgvector` 做向量、`PostGIS` 做地理、`TimescaleDB` 做时序）
- 各家云都支持，迁移成本低

**SQLite 被严重低估**：它不是玩具。世界上部署量最大的数据库就是它（每部手机、每个浏览器里都有）。很多生产系统也在用。**它的限制是"单机"，不是"能力"。**

**MySQL 的定位**：生态最广、托管最便宜、文档最多。团队熟悉它、或要用只支持 MySQL 的工具时，完全够用。差距主要在 SQL 特性丰富度和类型严格度。

### 4.3 云托管服务对比（2026 年 9 月查证）

**这些数字会过时，用前请自行核实当前政策。**

| | **Neon** | **Supabase** | **Turso** | **Railway** | **自建 VPS** |
|---|---|---|---|---|---|
| **数据库** | PostgreSQL | PostgreSQL | SQLite (libSQL) | 任意（含 PG） | 任意 |
| **应用托管** | ❌ 只有数据库 | ❌ 只有数据库+登录 | ❌ 只有数据库 | ✅ 有 | ✅ 有 |
| **免费档闲置行为** | 计算挂起，**下次请求自动唤醒**（实测 ~2 秒） | **7 天不活动暂停，需手动去控制台恢复** | 不暂停 | 按用量计费 | 一直运行 |
| **免费额度** | 100 CU-hours/月、0.5 GB 存储、5 GB 传输 | 2 个项目、500 MB、5 万 MAU | 按读取行数计费 | 无永久免费（$5/月含 $5 额度） | 看机器（约 $5/月） |
| **超额后果** | **挂起，不删数据** | 挂起 | 返回 `BLOCKED` 错误 | 扣费 | 机器扛不住 |
| **免费档备份** | 6 小时恢复窗口 | **无** | 未确认 | — | 自己配 |

**关键选择维度不是"额度"，而是"闲置后会发生什么"。**

对作品集项目尤其如此：链接可能几周没人点。这时：

- **Neon**：下次访问自动唤醒，用户只觉得"慢了一下" ✓
- **Supabase**：项目已暂停，**必须你手动去控制台点恢复**——而你可能几周都不登录 ✗
- **Turso**：不会暂停，但只解决数据库，应用托管还得另找

### 4.4 数据访问层的三种方式

| 方式 | 代表 | 优点 | 缺点 | 什么时候用 |
|---|---|---|---|---|
| **原生 SQL** | `pg`, `node:sqlite` | 完全控制；性能可预测；**能看清数据库在干什么** | 啰嗦；动态查询要自己拼；无类型安全 | 学数据库；查询复杂或需精细优化 |
| **Query Builder** | Kysely, Knex, Drizzle | 类型安全；可组合；**仍贴近 SQL** | 多一层抽象；复杂查询会变难读 | 想要类型安全又不想放弃 SQL |
| **ORM** | Prisma, TypeORM, SQLAlchemy | 开发快；模型即代码；自带迁移工具 | **隐藏 SQL**；N+1 风险；复杂查询别扭 | 业务 CRUD 为主、查询简单 |

**建议**：

- **学数据库阶段**：原生 SQL，你需要看见每一行
- **生产 CRUD 应用**：Query Builder（Drizzle / Kysely），类型安全和 SQL 可见性兼得
- **ORM 可以用，但要在你懂 SQL 之后**——那时你能判断它生成的 SQL 好不好、什么时候该绕开它

### 4.5 决策速查表

| 你的情况 | 推荐 |
|---|---|
| 学习数据库 / 做原型 | **SQLite**（零配置，专注核心概念） |
| 单机桌面/移动应用 | SQLite |
| 生产 Web 应用 | **PostgreSQL**（首选）或 MySQL |
| 关系数据 + 全文检索 | PostgreSQL（内置，或 + Elasticsearch） |
| 向量搜索（AI 应用） | PostgreSQL + `pgvector` |
| 缓存 / 会话 / 排行榜 | Redis（量小可先用 PG） |
| 海量时序写入 | TimescaleDB（PG 扩展）或 InfluxDB |
| 要免费托管、可能长期闲置 | Neon（自动唤醒） |
| 要一站式（数据库+登录+存储） | Supabase（注意免费档手动恢复的限制） |
| 团队已有 MySQL 生态 | MySQL，别为了"最好"而迁移 |
| 数据量 < 1 GB、单机 | 别过度设计，SQLite 足够 |

---

## 五、部署全过程

### 5.1 先理解一个基本事实：应用托管 ≠ 数据库托管

这是最容易糊涂的地方。一个 Web 应用其实是**两个东西**：

```
① 静态文件（dist/ 里的 HTML/CSS/JS）
   → 不需要"运行"，只需要"发出去"。任何文件服务器都行

② 一个必须一直在跑的 Node 进程（src/server/index.ts）
   → createServer 开端口、handleApiRequest 现场执行代码、连接池握着数据库
   → 需要一个"活着"的进程 + 公网地址
```

而**托管平台分两类**，能做的事完全不同：

| | 静态托管 | 应用（Node）托管 |
|---|---|---|
| 做什么 | 把文件发出去 | **运行你的代码** |
| 例子 | GitHub Pages、Netlify | Render、Railway、Fly.io、VPS |
| 能跑本项目吗 | ❌ | ✅ |

**为什么 GitHub Pages 不行**：有人访问 `/api/balance`，它只会找有没有这个文件，找不到就 404。它不执行你的 `handleApiRequest`，也没有 Node 环境。

### 5.2 为什么 Vercel 不行（技术原因，不只是"不支持"）

Vercel 官方知识库有一篇 [Is SQLite supported in Vercel?](https://examples.vercel.com/kb/guide/is-sqlite-supported-in-vercel)，正文第一句就是答案：

> "While it can't be used with Vercel..."

但更根本的是**执行模型的差异**：

| | Vercel（Serverless） | 本项目需要 |
|---|---|---|
| 进程 | 来一个请求起一个函数，处理完销毁 | 一个**长期存活**的进程 |
| 磁盘 | 临时（函数结束就没了） | 连接池需要稳定环境 |
| 数据库连接 | 频繁新建/销毁（经典坑） | 复用连接池 |
| 会话 | 无状态，得靠外部存储 | 进程 + 数据库 |

**一句话**：Vercel 是"租一个函数执行环境"，不是"租一台机器"。本项目需要后者。

### 5.3 选型过程（逐个排除）

我的排查顺序和结论：

| 候选 | 结论 | 原因 |
|---|---|---|
| **Fly.io 免费额度** | ❌ 已取消 | 官方有专门的 [Discontinued Plans](https://fly.io/docs/about/discontinued-plans/) 页面记录这件事 |
| **Vercel** | ❌ 执行模型不匹配 | 见 5.2 |
| **Supabase** | ⚠️ 只解决一半 | 它是 BaaS：给数据库和登录，但**不跑你的 Node 代码**；而且免费档 7 天不活动要**手动恢复** |
| **Turso** | ⚠️ 只解决一半 | 托管 SQLite，不会暂停；但应用托管还得另找 |
| **Railway** | ⚠️ 额度有限 | 免费档每月只有 $1 额度，跑一个常驻服务大半个月就用完；Hobby $5/月 |
| **Render + Neon** | ✅ **采用** | Render 免费档能跑 Node 进程；Neon 免费档自动唤醒、超额不删数据 |

**一个重要的认知调整**：既然"跑代码"这件事跑不掉（Neon/Turso/Supabase 都只给数据库），最省事的组合是**一家跑代码 + 一家给数据库**。

**为什么数据库必须搬出去？** 因为托管平台的磁盘是**临时的**：

```
今天   用户记了 100 笔账 → 写进容器里的文件
明天   你改一行代码重新部署 → 旧容器销毁 → 文件跟着没了
       新容器是全新的 → 表都不存在 → 报错
```

（如果用 SQLite 又不想搬，就得找**支持持久卷**的平台——Render 免费档不支持持久磁盘，这是它和 Railway 的一个关键差别。）

### 5.4 部署前的代码准备（4 件事，缺一个就部署失败）

这一步最容易被忽略。本地能跑不代表线上能跑，因为**托管环境有几个本地的假设不成立**。

#### ① 启动时自动迁移

```ts
// src/server/index.ts —— 启动流程
await waitForDatabase();              // 带重试，应对 Neon 冷启动
const applied = await migrate({ silent: true });
console.log(applied.length > 0 ? `自动应用了 ${applied.length} 个迁移` : '数据库结构已是最新');
```

**为什么必需**：托管平台上你**没法 SSH 进去敲 `npm run db:init`**。应用必须自己保证表结构是对的。

#### ② 公开的健康检查接口

```ts
route('GET', '/api/health', async () => {
  const started = Date.now();
  await dbGet('SELECT 1 AS ok');
  return { ok: true, dbLatencyMs: Date.now() - started, uptimeSeconds: Math.round(process.uptime()) };
}, { isPublic: true });   // ← 必须公开
```

**为什么必需**：托管平台的健康检查**不带 cookie**。如果指向需要登录的接口，会永远返回 401，平台判定服务不健康并**反复重启你的服务**——一个很难查的坑。

返回内容刻意保持最少：不泄露数据库版本等内部信息，只回答"进程活着吗、能连数据库吗"。

#### ③ 锁定 Node 版本

```json
"engines": { "node": ">=22.18.0 <27.0.0" }
```

**为什么必需**：直接运行 `.ts` 需要 Node 22.18+。而 Render 的[默认版本取决于服务创建日期](https://render.com/docs/node-version)，显式锁定才可靠。官方文档还特别提醒**一定要写上界**，否则会永远解析到 latest，可能引入不兼容。

#### ④ 按主机名判断 SSL

```ts
function needsSsl(connectionString: string): boolean {
  if (/sslmode=disable/i.test(connectionString)) return false;
  const host = new URL(connectionString).hostname;
  return !['localhost', '127.0.0.1', '::1', ''].includes(host);
}
```

**为什么必需**：Neon **强制要求 TLS**，不加连不上；但本地/CI 的 Postgres 容器**不支持 TLS**，加了反而握手失败。无条件开或无条件关都会有一边挂掉。

### 5.5 准备 Neon 数据库（约 5 分钟）

1. 打开 https://neon.com ，用 GitHub 账号登录
2. 创建项目，**区域选 Singapore**（离国内最近，也是 Render 要选的区域）
3. 在 Dashboard 点 **Connect**，Database 选 `neondb`，复制连接串
   - 格式选 **PostgreSQL**（不要选 Prisma / Drizzle 那种带特殊参数的）
   - 连接串形如：`postgresql://<user>:<password>@<host>.neon.tech/<db>?sslmode=require&channel_binding=require`
4. **再建一个测试库**：Branches → Roles & Databases → Add database，名字 `ledger_test`
   - 目的是让自动化测试不污染开发数据
5. 复制两条连接串（区别只在末尾的库名）

**代码侧对连接串做了两件事**（见 `src/server/db/pg.ts`）：

```ts
// 1. 摘掉 sslmode 和 channel_binding —— SSL 由 needsSsl() 判断，避免两处配置打架
url.searchParams.delete('sslmode');
url.searchParams.delete('channel_binding');
```

**为什么摘掉**：`sslmode` 会让 pg-connection-string 发出语义变更警告（日志很吵），而且两处都说 SSL 容易不一致；`channel_binding` 是 libpq 参数，node-postgres 并不实现它，留着会造成"以为开了通道绑定、其实没有"的错觉。

### 5.6 本地验证（强烈建议，顺序很重要）

**不要先部署再调试。** 本地的验证顺序：

```bash
# 1. 建表 + 迁移（在测试库上，不碰开发库）
npm run db:init:test

# 2. 灌数据
npm run db:seed:test

# 3. 跑全部断言（70 项）
npm run test:api

# 4. 类型检查 + 构建
npm run typecheck && npm run build

# 5. 全部通过后，再初始化开发库
npm run db:init && npm run db:seed
```

**测试库和开发库怎么区分？** 用 `.env.test` + 一个显式开关：

```bash
# package.json
"test:api": "node --env-file-if-exists=.env --env-file-if-exists=.env.test scripts/smoke-test.ts"

# .env.test（已被 gitignore 挡住）
USE_TEST_DB=1
TEST_DATABASE_URL=postgresql://...neon.tech/ledger_test?sslmode=require
```

**为什么搞这么复杂**：我踩过一次——想用测试库跑建表，结果环境变量优先级搞错，**连到了开发库**。虽然只是建表（幂等操作）没造成损失，但如果是清库重灌，开发数据就没了。把"用哪个库"写死在文件里，就不依赖操作者每次记得传对变量。

### 5.7 部署到 Render（约 10 分钟）

#### 步骤 1：注册并连接 GitHub

https://dashboard.render.com/register → 用 **GitHub** 登录 → 授权访问 `Eazybk` 仓库。

#### 步骤 2：新建 Web Service

Dashboard → **New +** → **Web Service** → 选仓库。

#### 步骤 3：填配置

| 字段 | 值 | 说明 |
|---|---|---|
| **Name** | `eazybk` | 会成为 `eazybk.onrender.com` |
| **Region** | **Singapore** | 和 Neon 库同区域，延迟最低 |
| **Branch** | `main` | |
| **Language** | `Node` | |
| **Build Command** | `npm ci && npm run build` | 用 `ci` 而不是 `install`，严格按 lockfile |
| **Start Command** | `npm run api` | ⚠️ **不要用 `npm start`**——它会重复构建一次（`npm start` 里已经包含了 build） |
| **Instance Type** | `Free`（$0 / 0.1 CPU / 512 MB） | |
| **Health Check Path** | `/api/health` | ⚠️ 不要填 `/`——`/api/health` 会真的查一次数据库，能发现"进程活着但连不上库" |

#### 步骤 4：环境变量

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon 的 `neondb` 连接串 |

**不要加 `NODE_ENV`** —— 见 5.9 的那个坑。
**不用加 `PORT`** —— Render 会自动注入，代码里读的就是 `process.env.PORT`。

#### 步骤 5：绑卡验证（这一步容易误会）

如果 Render 要求绑卡：

- **它是账号风控，不是配置问题。** 我逐项排查过：Compute 选的是 $0 档 ✓、Workspace 是 Hobby ✓、Build Pipeline 显示 `starter` 且不可改 ✓（这个是**正常的**，官方文档写明"Hobby workspaces always use the Starter tier"，而且每月送 500 分钟）
- **$1 的扣款是卡片验证**，官方 FAQ 原文：*"A $1 USD transaction is performed as a credit security check... The charge is refunded after the transaction completes."*
- **卡的类型**：信用卡和借记卡都行，但必须能**境外在线支付**
- **关键**：CVC 是卡背面签名条上的**3 位**数字（国内叫"后三码"）。如果你看到的是 4 位，那通常是**卡号末四位**，不是 CVC。（美国运通是 4 位，但在**正面**）

#### 步骤 6：设置消费上限（绑卡后立刻做）

**这一步很重要，因为加卡改变了失败模式。** Render 官方 FAQ 原文：

> "**All of my services run on free instances. Can I still be billed?**
> **Yes, if you've added a payment method.**"
>
> "If you haven't added a payment method and you would incur charges, Render instead **disables your services**."

| | 不加卡 | 加了卡 |
|---|---|---|
| 免费额度用超了 | **服务被停，不扣钱** | **自动买超额部分，扣钱** |

所以绑卡后马上去：**Dashboard → Workspace Settings → Build Pipeline → Set spend limit**，填 `0` 或 `1`。

设完之后，超出 500 分钟构建时长只会**停止构建**，不会扣费。

**你这个项目的实际开销是 $0**：

```
构建：每次 1-2 分钟 × 免费 500 分钟/月 → 能用 250 次以上
带宽：5 GB/月 ÷ 每次页面约 170 KB ≈ 3 万次访问
```

#### 步骤 7：等待部署

Logs 里正常会看到：

```
正在启动…
  数据库：postgresql://***@ep-...neon.tech/neondb
  数据库连接正常
  数据库结构已是最新
记账 App 已启动：http://127.0.0.1:10000
  静态目录：/opt/render/project/src/dist
  接口：25 个
```

看到最后一行就成功了。**迁移是自动执行的**（见 5.4 ①）。

### 5.8 上线后的验证

**别只看界面。** 从外部做几个 HTTP 检查更可靠——我是这样验的：

```bash
curl -i https://你的服务.onrender.com/api/health
# 期望：HTTP 200  {"ok":true,"dbLatencyMs":2,"uptimeSeconds":1103}

curl -i https://你的服务.onrender.com/api/accounts
# 期望：HTTP 401  {"error":"请先登录"}   ← 这条最重要
```

**第二条为什么最重要**：它证明**认证闸门在生产环境真的生效**，而不只是在测试里。如果它返回了数据，说明你的应用把所有人的账本都公开了。

然后才是界面检查：

| 步骤 | 应该看到 |
|---|---|
| 打开首页 | 深色登录页，「一键体验演示账号」按钮 |
| 点该按钮 | 进入记账主页 |
| 主页 | 总余额、本月收入/支出/结余 |
| 流水列表 | 有「演示」标记和公开数据提示条 |
| 切到「统计」 | 环形图 + 最近 6 个月柱状图 |
| 切到「管理」 | 账户列表 + 「恢复演示数据」按钮 |

### 5.9 免费档的真相与代价

**必须提前知道的三件事：**

**① 15 分钟休眠 + 约 1 分钟冷启动。**
Render 免费 web service 在 15 分钟无请求后停掉容器，下次访问要等 30-60 秒（用户会看到 Render 的加载页）。叠加 Neon 唤醒（实测 ~2 秒），最坏情况是"点开等一分钟"。

**对 HR 场景可接受**（第一下慢，之后快），但要有心理准备。

**② 想要"永不休眠"的取舍。**
可以用免费监控（如 UptimeRobot）每 10 分钟 ping 一次 `/api/health`。但代价是 **Neon 的计算会一直保持唤醒，消耗 100 CU-hours/月的免费额度**（一直醒着约用掉 90%）。

- 不在乎偶尔冷启动 → **不 ping**，让两边都休眠（省额度）
- 在乎随时都快要快 → ping，但额度会紧

**建议先不 ping**，看实际访问情况再决定。

**③ 一个我差点踩的坑：`.env` 里不能写 `NODE_ENV`。**

```
症状：前端产物里 vendor-react 从 211 kB 涨到 396 kB
根因：Vite 构建时会读 .env，看到 NODE_ENV=development 就打包了**开发版 React**
特点：不报错、不警告，只是变大、带开发期代码
发现方式：对比产物大小 + 检查内容标记
         （开发版含 react.dev；生产版含 "Minified React error"）
修复：.env 里删掉 NODE_ENV，改用 SECURE_COOKIES 开关
```

**这件事的教训**：换掉环境变量或依赖之后，**值得重新看一眼构建产物的体积**。静默的体积膨胀是最容易漏掉的问题之一。

### 5.10 部署流程全景图

```
本地开发
  ├─ SQLite 学建模 → 迁移到 PostgreSQL
  ├─ npm run db:init:test / db:seed:test   （在 ledger_test 上验证）
  ├─ npm run test:api                      （70 项断言）
  └─ npm run typecheck && npm run build
              ↓
GitHub
  ├─ git push
  └─ GitHub Actions CI
       ├─ 起一个**临时 Postgres 容器**（不连 Neon）
       ├─ 建表 + 迁移 + 灌数据
       ├─ 类型检查 → 构建 → 70 项测试
       └─ 绿勾 ✓
              ↓
Neon（数据库）
  ├─ 项目 + neondb（开发/生产）
  └─ ledger_test（测试专用）
              ↓
Render（应用）
  ├─ 连 GitHub 仓库
  ├─ Build: npm ci && npm run build
  ├─ Start: npm run api
  ├─ Env: DATABASE_URL
  ├─ Health: /api/health
  ├─ Spend limit: $0
  └─ 部署 → 启动时自动迁移
              ↓
验证
  ├─ /api/health   → 200 ok
  ├─ /api/accounts → 401 未登录（安全边界）
  └─ 界面点「一键体验演示账号」
```

---

## 六、踩坑清单汇总

以下是这个项目**真实跑出来**的问题，不是预先想到的。

### 6.1 SQLite → PostgreSQL 迁移中发现的

| 问题 | 症状 | 根因 |
|---|---|---|
| 金额变成字符串 | `SUM` 返回 `"12345"`，`+` 变成拼接 | PG 的 `numeric`（`SUM(bigint)` 的返回类型）默认返回字符串，只注册 BIGINT 解析器会漏掉 |
| 日期查询报错 | `invalid input syntax for type date: "2026-10"` | **SQLite 版就潜伏的 bug**：`nextMonth()` 返回缺日的 `"2026-10"`，SQLite 靠字符串比较碰巧能用 |
| 递归 CTE 跑不了 | `LIMIT in a recursive query is not implemented` | PG 不支持递归 CTE 里的 LIMIT，改用 `generate_series` |
| `ON CONFLICT` 报错 | `no unique or exclusion constraint matching...` | 唯一索引是**部分索引**，冲突目标必须带上 `WHERE` 条件 |
| 事务可能静默失效 | 数据没回滚 | PG 事务绑定在**单个连接**上，用连接池各发各的会变成两个独立事务 |
| SSL 连不上 CI | 本地 Postgres 握手失败 | 无条件开 SSL；Neon 强制 TLS 但 CI 容器不支持 |

### 6.2 认证与安全

| 问题 | 根因 |
|---|---|
| `scrypt` 直接报错 | Node 默认 `maxmem` 是 32 MB，而 N=16384 需要约 128 MB |
| 转账带分类竟然成功了 | 解析阶段就把分类强制置空，本该拒绝的矛盾请求被静默接受 |
| **生产服务器收到第一个请求就退出** | 用了 Web 的 `headers.get()`，而 node 原生请求的 `headers` 是普通对象；且请求处理器没有 try/catch，异常直接终止进程 |
| 测试指向了错误的库 | 环境变量优先级搞错，测试连到了开发库 |

### 6.3 前端与构建

| 问题 | 根因 |
|---|---|
| **前端被打成开发版** | `.env` 里写了 `NODE_ENV=development`，而 **Vite 构建时会读 `.env`**。产物 211 kB → 396 kB，**不报错不警告** |
| 环形图是一块空白 | Recharts 3.10 在 React 19 下不生成扇形 `<path>`，最后移除整个图表库改手写 SVG |
| 悬浮按钮跑到屏幕外 | `right-[max(1rem,calc(50%-21rem))]` 含空格，Tailwind 不认这种任意值 |
| 登录页整体半透明 | 入场动画用 `opacity: 0`，动画没跑完时内容停在不可见状态 |
| dev server 莫名退出 | 编辑器原子写入的 `.tmpdir/` 被文件监听拿到抛 EBUSY，未捕获 |

### 6.4 数据与逻辑

| 问题 | 根因 |
|---|---|
| 余额对账误报 | 用 `MAX(cum)` 取"累计和的最后一个值"，负数时取到的是最大值而非最后一行 |
| 仿真数据里钱包余额变成 −1.2 万 | 数据生成器没维护"余额不能为负"这个不变量 |
| "重置演示数据"换了一批数据 | 用了随机种子，每次重置笔数都不同（测试还因此 flaky） |
| `db:seed` 静默不干活 | 手工拼的 `file://` URL 少了斜杠，入口判断永远为假；退出码 0、什么都不打印 |

### 6.5 这些坑的共同点

**大部分不报错，只是"没按预期工作"。**

- 金额变成字符串 → 加法悄悄变成拼接
- 前端打包成开发版 → 只是变大，一切正常
- 事务没生效 → 数据错了但不报错
- `db:seed` 不干活 → 退出码 0、没有输出
- 生产服务器第一个请求就退出 → 本地测试用的是 Web `Request`，**完全没覆盖 node 原生请求这条路径**

**这类静默失败比崩溃难查得多。** 这也是为什么这个项目里有 70 项自动化断言——它们的作用不是证明"代码能跑"，而是**盯住那些不会自己暴露的问题**。

---

## 七、如果重来一次

### 会保持的

1. **先用 SQLite 学，再迁 PostgreSQL** —— 学习曲线平缓，而且迁移本身成了最有价值的经历
2. **不用 ORM** —— 手写 SQL 让我看清了每一处
3. **把 SQL 集中在一个文件** —— 迁移时只需改一处方言
4. **一开始就写测试** —— 那 68 项原有断言在迁移时**一条都没改就跑通了**，它们变成了迁移的安全网
5. **认证用数据库会话而不是 JWT** —— 可撤销这一点省了很多事
6. **路由默认拒绝未登录** —— 新接口忘了标记只会"打不开"，不会"敞开"

### 会改的

1. **一开始就加 `engines` 字段** —— 部署时才发现缺，本可避免
2. **`.env` 只放密钥，不放 `NODE_ENV`** —— 这个坑太隐蔽（前端悄悄变成开发版）
3. **图表一开始就手写** —— 和框架版本强耦合的渲染库，性价比不高
4. **不要用 shell 做批量文本替换** —— 我用 PowerShell 替换导入路径，把几个文件的中文注释编码搞坏了，只能全部重写。**文本编辑永远用编辑器/工具**
5. **迁移工具链应该更早建立** —— 我是在需要加登录功能时才建的；如果一开始就用迁移文件管结构，就不会有"基线和迁移不同步"这个维护负担

### 最大的收获

**"测试的回报不在写它的那天，在你要动它的那天。"**

写那 70 项断言时，感觉是在做"额外工作"。但在 SQLite → PostgreSQL 迁移时，它们变成了唯一能可靠告诉我"哪里改错了"的东西。全部通过的那一刻，比任何手工验证都有说服力。

---

## 八、延伸学习方向

按投入产出比排序。

### 数据库

1. **`EXPLAIN ANALYZE` 读执行计划** —— 从"会写 SQL"到"会调优 SQL"的分水岭
2. **索引与查询计划**：复合索引列顺序、覆盖索引、为什么索引会失效
3. **事务隔离级别的实验** —— 开两个终端复现"不可重复读"和"幻读"
4. **窗口函数深入** —— `ROW_NUMBER` / `RANK` / `LAG` / 累计和 / 移动平均
5. **范式与反范式** —— 什么时候该冗余，什么时候该拆表
6. **`pgvector` + 向量检索** —— 现在 AI 应用的基础设施
7. **备份与恢复演练** —— 真的导出再导回一次

### 工程

8. **可观测性** —— 结构化日志、慢查询日志、监控指标
9. **优雅停机与滚动部署** —— 部署时不丢请求
10. **容器化（Docker）** —— 让"本地能跑"和"线上能跑"变成同一件事

### 本项目的自然延伸

11. **预算功能** —— 新表 `budgets(user_id, category_id, month, amount)`，练 `JOIN` + `HAVING` 写"超预算查询"
12. **标签功能** —— 多对多，需要中间表 `transaction_tags`，练聚合
13. **定期记账** —— 事务批量插入 + 幂等性设计
14. **软删除** —— 加 `deleted_at`，体会"每条查询都要记得过滤"的代价
15. **多币种** —— 汇率快照问题（历史报表必须冻结当时的汇率）

---

## 附：常用命令速查

```bash
# 开发
npm run dev                 # 启动开发服务器（API 挂在 Vite 上，同端口无跨域）

# 数据库
npm run db:init             # 建表 + 应用迁移
npm run db:seed             # 灌演示数据
npm run db:reset            # 清空重建（会丢数据）
npm run db:seed -- --force  # 清空演示账号数据并重新生成
npm run db:init:test        # 在 ledger_test 上建表（测试用）
npm run test:api            # 70 项 API 断言（打在 ledger_test 上）

# 质量
npm run typecheck           # 类型检查（零构建模式下必须靠它兜底）
npm run build               # 构建前端

# 生产
npm start                   # 构建 + 启动（启动时自动迁移）

# 部署
git push                    # 触发 CI + Render 自动部署
```

**线上地址**：https://eazybk.onrender.com
**看数据库**：Neon 控制台 → SQL Editor（不用装 psql）
**看日志**：Render 控制台 → 服务 → Logs

---

*本文档基于 2026 年 9 月的实测。平台政策（免费额度、闲置行为）变化频繁，引用前请自行核实。*
