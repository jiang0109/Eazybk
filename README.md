# 记账 App · Ledger

![CI](https://github.com/jiang0109/Eazybk/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

一个用来**练数据库**的完整小项目：记账 App。
不是玩具 demo —— 表结构、约束、索引、触发器、事务、认证、多用户隔离
都按真实项目的做法设计，而且**经历过一次真实的数据库迁移**（SQLite → PostgreSQL）。

技术栈：**React 19 + TypeScript + Vite 8 + Tailwind CSS v4 + Framer Motion + Zustand**，
数据库 **PostgreSQL**（托管在 Neon 免费档）。

> **零构建步骤**：Node 26 能直接运行 `.ts` 文件，前后端都不需要编译。

---

## 快速开始

### 1. 准备数据库（5 分钟）

本项目用 PostgreSQL。本地不需要装 —— 用 Neon 的免费档：

1. 打开 https://neon.com ，用 GitHub 账号登录
2. 创建项目（区域选 **Singapore**，离国内最近）
3. 在 Dashboard 点 **Connect**，Database 选 `neondb`，复制连接串
   （格式选 **PostgreSQL**，不要选 Prisma / Drizzle 那种）
4. 建议再建一个测试库：**Branches → Roles & Databases → Add database**，
   名字叫 `ledger_test`

### 2. 配置并启动

```bash
npm install

cp .env.example .env
# 编辑 .env，把 DATABASE_URL 填成你的连接串
# 再把 TEST_DATABASE_URL 填成 ledger_test 的连接串（推荐）

npm run db:init    # 建表 + 应用迁移
npm run db:seed    # 给演示账号灌入 14 个月的示例数据（约 640 笔流水）

npm run dev        # 启动开发服务器 http://localhost:5173
```

打开后是登录页，**点「一键体验演示账号」**就能进去 ——
不用注册、不用记密码，里面已经有 14 个月的仿真数据。

### 其他命令

| 命令 | 作用 |
|---|---|
| `npm run db:migrate` | 只应用缺失的迁移（`db:init` 的别名） |
| `npm run db:reset` | 清空库重建 + 重新灌数据（**会丢数据**） |
| `npm run db:seed -- --force` | 清空演示账号数据并重新生成 |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm run test:api` | API 测试（70 项断言，用 `ledger_test` 库） |
| `npm run build` | 构建前端到 `dist/` |
| `npm start` | 生产模式：构建 + 启动服务器（启动时自动迁移） |

### 直接看数据库

用 Neon 控制台的 **SQL Editor** 就能跑查询，不需要装 psql：

```sql
-- 看有哪些表
SELECT tablename FROM pg_tables WHERE schemaname = 'public';

-- 看流水表的完整定义（含约束）
\d transactions

-- 迁移执行到第几号了
SELECT * FROM schema_migrations;

-- 看索引有没有被用上（把 Seq Scan 变成 Index Scan 就是生效了）
EXPLAIN ANALYZE
SELECT * FROM transactions WHERE user_id = 1 ORDER BY occurred_on DESC LIMIT 20;

-- 对账：触发器维护的余额 vs 实时计算
SELECT a.name, a.balance_cents AS 存的余额,
       a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS 实时算的
  FROM accounts a
  LEFT JOIN transactions t ON t.account_id = a.id
 GROUP BY a.id
HAVING a.balance_cents - (a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0)) <> 0;
```

---

## 项目结构

```
src/
  shared/types.ts          前后端共用的领域类型（金额一律是"分"）
  server/
    index.ts               生产服务器（静态文件 + API + 启动时自动迁移）
    api.ts                 ★ HTTP 路由 + 认证闸门 + 权限校验
    body.ts                请求体解析与字段校验（元→分的精确转换在这里）
    http.ts                统一错误处理（按 PG 的 SQLSTATE 错误码翻译）
    auth/
      password.ts          scrypt 加盐哈希、恒定时间比较
      session.ts           会话管理、登录/注册、频率限制
      cookies.ts           Cookie 读写与安全属性（含 Secure 判断）
      guard.ts             ★ 越权防御（IDOR）：把 user_id 写进 WHERE
    db/
      pg.ts                ★ 连接池 + 类型解析器 + 事务封装
      schema.pg.sql        ★ 表结构 + 约束 + 索引 + 触发器
      queries.pg.ts        ★ 所有 SQL 都集中在这里
      migrate.pg.ts        ★ 迁移运行器（schema_migrations 表记录版本）
      migrations-pg/
        001_add_auth.sql   给已有数据库加登录功能（不重建）
      schema.pg.ts         建表 + 应用迁移
      seed.pg.ts           示例数据生成器（按用户灌数据，支持重置）
  client/
    components/            auth / layout / ledger / stats / manage / ui
    store/                 auth（认证状态）、ui（UI 状态）
    lib/                   API 客户端、格式化、数据拉取
```

---

## 功能

- **登录 / 注册 / 一键体验** —— 会话存数据库（可随时撤销），密码 scrypt 加盐哈希
- **记一笔账** —— 金额、类型（支出/收入/转账）、分类、账户、日期、备注
- **记录列表** —— 按月查看，按日期分组，可修改、可删除
- **分类管理** —— 支持二级分类（餐饮 → 早餐/午餐/外卖）
- **账户管理** —— 多账户，余额由触发器自动维护
- **转账** —— 账户间搬钱，**不计入收支统计**
- **余额 / 月度汇总 / 分类统计 / 趋势图**
- **演示数据一键重置** —— 只有演示账号能看到这个按钮

界面是深色主题、移动端优先，带滚动进场动画。

---

## 这个项目里最值得看的东西

按这个顺序读：

1. **`src/server/db/schema.pg.sql`** —— 每条 `CHECK`、每个索引、每个触发器的
   "为什么"都写在注释里。重点看：
   - `CHECK` 怎么表达业务规则（"转账不能有分类"）
   - 部分唯一索引（`WHERE parent_id IS NULL`）怎么让不同层级的重名规则不同
   - plpgsql 触发器怎么维护"余额"这个派生数据
2. **`src/server/db/queries.pg.ts`** —— 所有 SQL 集中一处。重点看：
   - 条件聚合 `SUM(CASE WHEN ... END)`（等于数据透视表）
   - 窗口函数：算占比 `SUM(SUM(x)) OVER ()`、算环比 `LAG()`
   - `generate_series` 补齐没有数据的月份
3. **`src/server/db/pg.ts`** —— **类型映射**（迁移里最容易出错的地方）：
   为什么 BIGINT 和 numeric 必须注册解析器、为什么 date 不能变成 Date 对象
4. **`src/server/db/migrate.pg.ts` + `migrations-pg/`** —— 怎么给**已有数据**的库
   加字段而不重建
5. **`src/server/auth/guard.ts`** —— IDOR 防御：把 `user_id` 写进 `WHERE`
   而不是靠 `if` 判断

### 四条贯穿全项目的原则

1. **约束放数据库，不放应用层。** 应用代码可以被绕过、会并发、有 bug；
   `CHECK` / `FOREIGN KEY` / `UNIQUE` 不会。分工是"数据库不许你写错，
   应用负责说清楚为什么"。
2. **金额一律用整数存"分"。** 浮点数存钱会累积误差，最后余额和流水对不上。
   元↔分的转换只发生在一处。
3. **派生数据（余额）用触发器维护，并留一条对账 SQL。**
   `GET /api/health/balance` 返回 `ok: true` 就说明余额没有漂移。
4. **安全上默认拒绝（deny by default）。** 新接口默认就是"需要登录"，
   要公开必须显式标记。忘了标记最多是"该公开的打不开"（立刻能发现），
   反过来忘了标记则是"该保护的敞开了"（可能很久没人发现）。

---

## SQLite → PostgreSQL 迁移记

这个项目最初是 SQLite（用 Node 内置的 `node:sqlite`，零依赖、零构建），
后来迁到 Neon 上的 PostgreSQL。**这次迁移本身就是项目里最有价值的一段经历**，
因为它把很多"靠巧合工作"的代码暴露了出来。

### 迁移涉及的范围

| 层 | 改动 |
|---|---|
| 表结构 | 方言改写：`AUTOINCREMENT` → `IDENTITY`、触发器改成 plpgsql 函数 |
| 类型映射 | BIGINT/numeric 默认返回**字符串**、date 默认返回 **Date 对象** —— 都要注册解析器 |
| SQL | `?` → `$1`、`strftime` → `to_char`、递归 CTE → `generate_series`、去掉所有 PRAGMA |
| 访问层 | `node:sqlite` 同步 API → `pg` 异步 API（**所有函数变成 async**） |
| 迁移机制 | `PRAGMA user_version` → `schema_migrations` 表 |
| 认证 | 时间从字符串比较改成 `timestamptz` 运算、`is_demo` 从 0/1 改成 boolean |

### 迁移中发现并修掉的真问题

这些都是**实际跑出来才发现的**，不是我预先想到的：

| 问题 | 症状 | 根因 |
|---|---|---|
| 金额变成字符串 | `SUM` 返回 `"12345"` 而不是数字，`+` 变成拼接 | PG 的 `numeric`（`SUM(bigint)` 的返回类型）默认返回字符串，我只注册了 BIGINT 解析器 |
| 日期查询直接报错 | `invalid input syntax for type date: "2026-10"` | **SQLite 版就潜伏的 bug**：`nextMonth()` 返回 `"2026-10"`（缺日），SQLite 用字符串比较碰巧能用，PG 的 `::date` 直接拒绝 |
| 递归 CTE 跑不了 | `LIMIT in a recursive query is not implemented` | PG 不支持递归 CTE 里用 LIMIT；改用 `generate_series` |
| `ON CONFLICT` 报错 | `no unique or exclusion constraint matching the ON CONFLICT specification` | 唯一索引是**部分索引**（带 `WHERE`），`ON CONFLICT` 的目标必须和它完全匹配 |
| 事务可能失效 | 数据没回滚 | PG 是网络数据库，事务绑定在**单个连接**上；用连接池各发各的 query 会变成两个独立事务 |
| SSL 连不上 CI | 本地/CI 的 Postgres 握手失败 | 无条件开 SSL；Neon 强制 TLS 但 CI 容器不支持，必须按主机判断 |
| **前端打成了开发版** | `vendor-react` 从 211 kB 涨到 396 kB | `.env` 里写了 `NODE_ENV=development`，而 **Vite 构建时会读 `.env`** |

最后一条特别值得记：它**不报错、不警告**，只是产物变大、带开发期代码。
我是对比构建产物大小和内容标记（开发版含 `react.dev`，生产版含
`Minified React error`）才发现的。**换掉环境变量或依赖后，值得重新看一眼产物大小。**

### 迁移的意外收获

**那 70 项断言一条都没改就跑通了**（只把直接查库的地方改成 await）。
写测试当初是为了防回归，结果它变成了迁移的安全网 —— 每次改错方言，
它立刻指出是哪一条断言、哪个接口。这是我在这件事上最实在的一个体会：
**测试的回报不在写它的那天，在你要动它的那天。**

---

## 开发过程中真实踩到的坑（都留了注释）

| 问题 | 原因 | 在哪 |
|---|---|---|
| 余额对账误报 | 用 `MAX(cum)` 取"累计和的最后一个值"，负数时取到的是最大值而非最后一行 | `queries.pg.ts` `checkBalanceDrift` |
| 仿真数据里钱包余额变成 −1.2 万 | 数据生成器没维护"余额不能为负" | `seed.pg.ts` |
| 转账带分类竟然成功了 | 解析阶段就把分类强制置空，本该拒绝的矛盾请求被静默接受 | `api.ts` `normalizeCategory` |
| "重置演示数据"结果换了一批数据 | 用了随机种子，每次重置笔数都不同（测试还因此 flaky） | `seed.pg.ts` |
| 悬浮按钮跑到屏幕外、右侧内容被切 | `right-[max(1rem,calc(50%-21rem))]` 含空格，Tailwind 不认这种任意值 | `layout/AppShell.tsx` |
| 环形图是一块空白 | Recharts 3.10 在 React 19 下不生成扇形 `<path>`。**最后去掉整个图表库改成手写 SVG** | `stats/DonutChart.tsx` |
| dev server 莫名退出 | 编辑器原子写入的 `.tmpdir/` 被文件监听拿到抛 EBUSY，未捕获 | `vite.config.ts` |
| scrypt 直接报错 | 默认 `maxmem` 是 32 MB，而 N=16384 需要约 128 MB | `auth/password.ts` |
| 生产服务器收到第一个请求就退出 | 用了 Web 的 `headers.get()`，而 node 原生请求的 `headers` 是普通对象；且请求处理器没有 try/catch | `http.ts` + `index.ts` |
| 迁移报 duplicate column | 基线 schema 里已有 `created_at`，迁移里又加了一次 | `migrations-pg/001_add_auth.sql` |
| `db:seed` 静默不干活 | 手工拼的 `file://` URL 少了斜杠，入口判断永远为假；退出码 0、什么都不打印 | `db/seed.pg.ts` |
| 登录页整体半透明 | 入场动画用 `opacity: 0`，动画没跑完时内容停在不可见状态 | `ui/FadeIn.tsx` |
| 测试指向了错误的库 | 环境变量优先级搞错，测试连到了开发库 | `db/pg.ts` `getConnectionString` |

好几条有个共同点：**它们都不报错，只是"没按预期工作"**。
这类静默失败比崩溃难查得多，也是为什么这个项目里塞了 70 项自动化断言。

---

## 认证与安全设计

| 关注点 | 做法 | 原因 |
|---|---|---|
| 密码存储 | `crypto.scrypt`（N=16384）+ 每用户独立 salt | 慢哈希抵抗暴力破解；salt 让相同密码产生不同哈希 |
| 哈希比较 | `timingSafeEqual` | 普通 `===` 会因提前返回而泄露"前几个字符是否匹配" |
| 会话 | 存数据库的 `sessions` 表，Cookie 里只有随机令牌 | 可随时撤销；JWT 做不到 |
| 令牌存储 | 表里存令牌的 **SHA-256**，不是原文 | 数据库泄露也不能直接拿去登录 |
| Cookie | `HttpOnly` + `SameSite=Lax` +（HTTPS 时）`Secure` | 防 XSS 偷令牌、防 CSRF |
| 错误文案 | "用户名或密码不正确"，不区分两种情况 | 否则等于免费告诉攻击者哪些用户名存在 |
| 频率限制 | 15 分钟内失败 5 次锁定，记录落库 | 内存计数一重启就失效 |
| 越权防御 | 所有按 id 的操作都把 `user_id` 写进 `WHERE` | 比"先查再 if 判断"更难写错 |
| 认证闸门 | 路由默认需要登录，公开的要显式标记 | 默认拒绝；漏标只会"打不开"，不会"敞开" |

**测试覆盖**：`npm run test:api` 里 70 项断言，其中一多半是攻击模拟 ——
B 用户拿着 A 的 id 去读、改、删、转账，全部必须失败，
并且最后要验证 A 的数据**一个字节都没变**。

CI（GitHub Actions）每次 push 都会：起一个**临时 Postgres 容器** →
建表迁移 → 类型检查 → 构建 → 跑这 70 项测试。
用临时容器而不是连真实 Neon，好处是不需要在仓库里存密钥、
不消耗免费额度、而且每次结果完全可复现。

---

## 部署

已经为部署做好了准备：路由默认需要登录、错误不会打挂进程、
`npm start` 启动时会自动跑迁移（托管平台上没法 SSH 进去敲脚本）。

### 推荐组合：Render（应用）+ Neon（数据库）

**为什么不能只用一个平台？**
应用需要一个"一直运行、能读文件、能跑 Node"的环境；数据库需要独立于它存在。
很多平台的免费档磁盘是**临时的** —— 重启或重新部署就清空，
所以数据库必须放在外面。

**为什么不用 Vercel？**
它的官方文档明确写了 [SQLite 不受支持](https://examples.vercel.com/kb/guide/is-sqlite-supported-in-vercel)，
而更根本的原因是：Vercel 跑的是**无状态函数**（来一个请求起一个、处理完销毁），
不是"一个一直运行的服务器"。本项目需要长驻进程（连接池、会话）和持久存储。

**Render 免费档的代价**：闲置一段时间会把进程停掉，**下次访问要等 30-60 秒冷启动**。
对作品集 demo 可以接受。数据库侧的 Neon 免费档不会有这个问题 ——
它的计算挂起后**下次请求自动唤醒**（几百毫秒），而且**触到限额不会删数据**。

### 部署步骤概要

1. 把仓库推到 GitHub（`.env` 和 `.env.test` 已被 gitignore，不会泄露连接串）
2. 在 Render 建 **Web Service**，连你的仓库
3. 构建命令 `npm ci && npm run build`，启动命令 `npm start`
4. 在 Render 的 **Environment** 里加环境变量：
   - `DATABASE_URL` = 你的 Neon 连接串（指向 `neondb`）
   - `PORT` 不用设，Render 会自动注入
   - **不要设 `NODE_ENV`**（原因见 `.env.example` 里的说明）
5. 部署后应用会**自动建表并跑迁移**，然后就能访问了
6. 灌演示数据：本地跑 `npm run db:seed`（`.env` 指向线上库即可）

---

## 已知限制

- **没有邮箱验证 / 找回密码**（没有邮件服务；免费平台的邮件额度很低）
- **没有 CSRF token**：目前靠 `SameSite=Lax` 缓解
- **频率限制只按用户名**，没有按 IP（防 credential stuffing 需要两个维度）
- **登录时没有做"恒定时间响应"**：用户不存在时会比密码错误快一点，
  理论上可用来枚举用户名（代码里有注释标注这个取舍）
- **转账在界面上不能改**（只能删了重记）。转账是成对的两行，改单行会破坏配对
- **没有分页 UI**：接口支持 `limit`/`offset`，但列表一次取 200 条
- **分类不能"停用"**：有流水的分类只能改不能删（`ON DELETE RESTRICT`）
- **连接池只有单个实例**：够这个量级用，多实例部署需要换成 Neon 的 pooled 连接串
