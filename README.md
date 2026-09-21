# 记账 App · Ledger

一个用来**练数据库**的完整小项目：记账 App。
不是玩具 demo —— 表结构、约束、索引、触发器、事务、认证、多用户隔离
都按真实项目的做法设计。

技术栈：**React 19 + TypeScript + Vite 8 + Tailwind CSS v4 + Framer Motion + Zustand**，
数据库 **SQLite**（用 Node 26 内置的 `node:sqlite`）。

> **零构建步骤、零原生依赖**：Node 26 能直接运行 `.ts` 文件，
> SQLite 是 Node 内置的。你不用装数据库、不用编译 C++、不用等打包。
> 整个项目只有前端运行时依赖。

---

## 快速开始

```bash
npm install        # 只需装前端依赖，没有数据库相关依赖

npm run db:init    # 建表 + 应用迁移（会创建演示账号）
npm run db:seed    # 给演示账号灌入 14 个月的示例数据（约 640 笔流水）

npm run dev        # 启动开发服务器 http://localhost:5173
```

打开后是一个登录页，**点「一键体验演示账号」**就能进去——
不用注册、不用记密码，里面已经有 14 个月的仿真数据。

想用自己的账号：在登录页切到「注册新账号」。新账号是空的
（这本身就是数据隔离生效的证明 —— 你看不到演示账号的数据）。

### 其他命令

| 命令 | 作用 |
|---|---|
| `npm run db:migrate` | 只应用缺失的迁移（`db:init` 的别名，用于已有数据库升级） |
| `npm run db:reset` | 删库重建 + 重新灌数据（**改过表结构后用它；会丢数据**） |
| `npm run db:seed -- --force` | 清空演示账号的数据并重新生成 |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm run test:api` | API 测试（68 项断言，重点覆盖认证与越权防御） |
| `npm run build` | 构建前端到 `dist/` |
| `npm start` | 生产模式：构建 + 启动 Node 服务器（默认 3001 端口） |

### 直接看数据库（推荐）

数据库就是一个文件 `data/ledger.db`，用 sqlite3 命令行打开它，
**这是理解这个项目最快的方式**：

```bash
sqlite3 data/ledger.db
```

```sql
.mode box          -- 输出成表格
.headers on
.tables            -- 看有哪些表
.schema transactions   -- 看流水表的完整定义（含约束）
PRAGMA user_version;   -- 看结构版本（迁移执行到第几号）

SELECT * FROM transactions ORDER BY occurred_on DESC LIMIT 10;
SELECT id, name, username, is_demo FROM users;

-- 看索引有没有被用上（把 SCAN 变成 SEARCH 就是生效了）
EXPLAIN QUERY PLAN
SELECT * FROM transactions WHERE user_id = 1 ORDER BY occurred_on DESC LIMIT 20;

-- 打开触发器维护的余额，和实时算出来的对比
SELECT a.name, a.balance_cents AS 存的余额,
       a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS 实时算的
  FROM accounts a
  LEFT JOIN transactions t ON t.account_id = a.id
 GROUP BY a.id;
```

> 把 `.mode box` / `.headers on` 写进 `~/.sqliterc`，以后打开就自动生效。

---

## 项目结构

```
src/
  shared/
    types.ts            前后端共用的领域类型（金额一律是"分"）
  server/
    index.ts            生产服务器（静态文件 + API，含错误隔离）
    api.ts              ★ HTTP 路由 + 认证闸门 + 权限校验
    body.ts             请求体解析与字段校验（元→分的精确转换在这里）
    http.ts             统一错误处理 + 兼容两种请求对象的头部读取
    auth/
      password.ts       scrypt 加盐哈希、恒定时间比较
      session.ts        会话管理、登录/注册、频率限制
      cookies.ts        Cookie 读写与安全属性
      guard.ts          ★ 越权防御（IDOR）：把 user_id 写进 WHERE
    db/
      index.ts          连接与事务封装（PRAGMA、WAL、BEGIN IMMEDIATE）
      schema.sql        ★ 表结构 + 约束 + 索引 + 触发器
      queries.ts        ★ 所有 SQL 都集中在这里
      migrate.ts        ★ 迁移运行器（基于 PRAGMA user_version）
      migrations/
        001_add_auth.sql  给已有数据库加登录功能（不重建）
      schema.ts         建表 + 应用迁移
      seed.ts           示例数据生成器（按用户灌数据，支持重置）
  client/
    components/
      auth/             登录页、登录闸门
      layout/           应用外壳
      ledger/           记一笔、流水列表、月份选择
      stats/            统计页 + 手写 SVG 环形图/柱状图
      manage/           账户与分类管理、演示数据重置
      ui/               通用组件（底部弹层、按钮、进场动画）
    store/
      auth.ts           认证状态
      ui.ts             UI 状态（Zustand）
    lib/                API 客户端、格式化、数据拉取
```

---

## 功能

- **登录 / 注册 / 一键体验** —— 会话存数据库（可随时撤销），密码 scrypt 加盐哈希
- **记一笔账** —— 金额、类型（支出/收入/转账）、分类、账户、日期、备注
- **记录列表** —— 按月查看，按日期分组，可修改、可删除（带二次确认）
- **分类管理** —— 支持二级分类（餐饮 → 早餐/午餐/外卖），可增删改
- **账户管理** —— 多账户（银行卡/微信/支付宝/现金），余额自动维护
- **转账** —— 账户间搬钱，**不计入收支统计**
- **余额查看** —— 收入总额 − 支出总额 = 结余，另加各账户余额分布
- **月度汇总 / 分类统计 / 趋势图**
- **演示数据一键重置** —— 只有演示账号能看到这个按钮

界面是深色主题、移动端优先（底部导航 + 安全区适配），带滚动进场动画。

---

## 这个项目里最值得看的东西

如果你是为了学数据库来的，按这个顺序读：

1. **`src/server/db/schema.sql`** —— 每条 `CHECK`、每个索引、每个触发器的
   "为什么"都写在注释里。重点看：
   - `CHECK` 怎么表达业务规则（"转账不能有分类"）
   - 部分唯一索引（`WHERE parent_id IS NULL`）怎么让不同层级的重名规则不同
   - 触发器怎么维护"余额"这个派生数据
2. **`src/server/db/queries.ts`** —— 所有 SQL 集中一处。重点看：
   - 条件聚合 `SUM(CASE WHEN ... END)`（等于数据透视表）
   - 窗口函数：算占比 `SUM(SUM(x)) OVER ()`、算环比 `LAG()`
   - 递归 CTE 补齐没有数据的月份
3. **`src/server/db/migrate.ts` + `migrations/`** —— 怎么给**已有数据**的库
   加字段而不重建。这是真实项目里天天在做、但练手项目常常跳过的事。
4. **`src/server/auth/`** —— 认证与授权：
   - 为什么密码要用慢哈希 + 每用户独立 salt
   - 为什么比较哈希要用 `timingSafeEqual`（时序攻击）
   - 为什么会话存数据库而不是塞进 JWT（可撤销）
   - `guard.ts` 里的 IDOR 防御：把 `user_id` 写进 `WHERE` 而不是靠 `if` 判断
5. **`src/server/db/index.ts`** —— SQLite 的几个必踩坑：WAL、`busy_timeout`、
   `foreign_keys` 默认关闭、`BEGIN IMMEDIATE`。

### 四条贯穿全项目的原则

1. **约束放数据库，不放应用层。** 应用代码可以被绕过、会并发、有 bug；
   `CHECK` / `FOREIGN KEY` / `UNIQUE` 不会。分工是"数据库不许你写错，
   应用负责说清楚为什么"。
2. **金额一律用整数存"分"。** 浮点数存钱会累积误差，最后余额和流水对不上。
   元↔分的转换只发生在一处（`body.ts` 入参、`format.ts` 显示）。
3. **派生数据（余额）用触发器维护，并留一条对账 SQL。**
   `GET /api/health/balance` 返回 `ok: true` 就说明余额没有漂移。
4. **安全上默认拒绝（deny by default）。** 新接口默认就是"需要登录"，
   要公开必须显式标记。忘了标记最多是"该公开的打不开"（立刻能发现），
   反过来忘了标记则是"该保护的敞开了"（可能很久没人发现）。

---

## 开发过程中真实踩到的坑（都留了注释）

这些不是编的，是这个项目实际写出来、跑出来、修掉的问题：

| 问题 | 原因 | 在哪 |
|---|---|---|
| 余额对账报警 | 用 `MAX(cum)` 取"累计和的最后一个值"，负数时取到的是最大值而非最后一行 | `queries.ts` `checkBalanceDrift` |
| 仿真数据里钱包余额变成 −1.2 万 | 数据生成器没维护"余额不能为负"，改成余额见底自动补款 | `db/seed.ts` |
| 转账带分类竟然成功了 | 解析阶段就把分类强制置空，导致本该拒绝的矛盾请求被静默接受 | `api.ts` `normalizeCategory` |
| 悬浮按钮跑到屏幕外、右侧内容被切 | `right-[max(1rem,calc(50%-21rem))]` 含空格，Tailwind 不认这种任意值 | `layout/AppShell.tsx` |
| 环形图是一块空白 | Recharts 3.10 在 React 19 下不生成扇形 `<path>`。**最后去掉整个图表库改成手写 SVG** | `stats/DonutChart.tsx` |
| dev server 莫名退出 | 编辑器原子写入的 `.tmpdir/` 被文件监听拿到抛 EBUSY，未捕获 | `vite.config.ts` |
| scrypt 直接报错 | 默认 `maxmem` 是 32 MB，而 N=16384 需要约 128 MB，必须显式放宽 | `auth/password.ts` |
| **生产服务器收到第一个请求就退出** | 用了 Web 的 `headers.get()`，而 node 原生请求的 `headers` 是普通对象；且请求处理器没有 try/catch，异常直接终止进程 | `http.ts` `getHeader` + `index.ts` |
| 迁移报 duplicate column | 基线 schema 里本来就有 `created_at`，我在迁移里又加了一次 | `migrations/001_add_auth.sql` |
| `db:seed` 静默不干活 | 手工拼的 `file://` URL 少了斜杠，入口判断永远为假；退出码 0、什么都不打印 | `db/seed.ts` |
| 登录页整体半透明 | 入场动画用 `opacity: 0`，动画没跑完时内容就停在不可见状态 | `ui/FadeIn.tsx` |
| 测试莫名其妙失败 | 上一次失败的运行留下残留数据，污染了下一次运行 | `scripts/smoke-test.ts` |

其中好几条有个共同点：**它们都不报错，只是"没按预期工作"**。
这类静默失败比崩溃难查得多，也是为什么这个项目里塞了 68 项自动化断言。

---

## 关于图表

最初用了 Recharts，但在 React 19 下它渲染不出扇形路径，界面上环形图是一块空白。
判断之后**移除了这个依赖**，改成手写 SVG：

- `stats/DonutChart.tsx` —— 用 `stroke-dasharray` 画环，不用算三角函数
- `stats/BarChart.tsx` —— 分组柱状图，带刻度归整和进场动画

好处：少一个 300 kB 量级的依赖、行为完全可控。
构建产物因此从 763 kB 降到约 410 kB（gzip 约 134 kB）。

---

## 认证与安全设计

这部分是给"想认真看"的人准备的：

| 关注点 | 做法 | 原因 |
|---|---|---|
| 密码存储 | `crypto.scrypt`（N=16384）+ 每用户独立 16 字节 salt | 慢哈希抵抗暴力破解；salt 让相同密码产生不同哈希 |
| 哈希比较 | `timingSafeEqual` | 普通 `===` 会因为提前返回而泄露"前几个字符是否匹配" |
| 会话 | 存数据库的 `sessions` 表，Cookie 里只有随机令牌 | 可随时撤销（退出登录、改密码踢下线）；JWT 做不到 |
| 令牌存储 | 表里存的是令牌的 **SHA-256**，不是原文 | 数据库泄露也不能直接拿去登录 |
| Cookie | `HttpOnly` + `SameSite=Lax` +（生产）`Secure` | 防 XSS 偷令牌、防 CSRF |
| 注册校验 | 用户名白名单字符 + 密码至少 8 位 | 服务端校验才是权威，前端校验只是体验 |
| 错误文案 | "用户名或密码不正确"，不区分两种情况 | 否则等于免费告诉攻击者哪些用户名存在 |
| 频率限制 | 15 分钟内失败 5 次锁定，记录落库 | 内存计数一重启就失效，挡不住有耐心的爆破 |
| 越权防御 | 所有按 id 的操作都把 `user_id` 写进 `WHERE` | 比"先查再 if 判断"更难写错 |
| 认证闸门 | 路由默认需要登录，公开的要显式标记 | 默认拒绝；漏标只会"打不开"，不会"敞开" |

**测试覆盖**：`npm run test:api` 里有 68 项断言，其中一多半是攻击模拟 ——
B 用户拿着 A 的 id 去读、改、删、转账，全部必须失败，
并且最后要验证 A 的数据**一个字节都没变**。

---

## 已知限制

这是个练手项目，有意保持简洁。真实产品还需要：

- **没有邮箱验证 / 找回密码**（因为没有邮件服务；免费平台的邮件额度很低）
- **没有 CSRF token**：目前靠 `SameSite=Lax` 缓解。真实项目里表单类接口
  建议再加上 CSRF token 或要求自定义请求头
- **频率限制只按用户名**，没有按 IP（防 credential stuffing 需要两个维度都做）
- **登录时没有做"恒定时间响应"**：用户不存在时会比密码错误快一点，
  理论上可用来枚举用户名（代码里有注释标注这个取舍）
- **转账在界面上不能改**（只能删了重记）。转账是成对的两行，改单行会破坏配对
- **没有分页 UI**：接口支持 `limit`/`offset`，但列表一次取 200 条
- **分类不能"停用"**：有流水的分类只能改不能删（`ON DELETE RESTRICT`）

---

## 部署提示（如果要放到网上）

**SQLite 是一个文件，所以必须放在"重启后还在"的存储上。**
Vercel / Netlify / Cloudflare Pages 这类平台的文件系统是临时的，
部署上去数据会丢；而且它们跑 serverless 函数，用不了 Node 内置的 `node:sqlite`。

三条路：

| 方案 | 数据库 | 代价 |
|---|---|---|
| 持久化 Node 服务 + 挂载卷 | 就是这个 SQLite 文件 | 要有持久卷的平台（Fly.io 免费额度已取消，自己买 VPS 约 $5/月） |
| 换 Neon / Supabase | 托管 Postgres | 要改数据库访问层（`?` → `$1`、去掉 PRAGMA 等），好处是顺带得到托管登录 |
| 换 Turso | 托管 SQLite（libSQL） | SQL 方言基本不变，但登录和 Node 托管还得自己解决 |

免费版最该看的一点是**闲置行为**：

- **Supabase 免费版**：7 天不活动会暂停项目，**要去控制台手动恢复** ——
  对"放几个月后还有人点开"的作品集项目很不友好
- **Neon 免费版**：计算会在闲置后挂起，但**下次请求自动唤醒**（几百毫秒）——
  更适合这个场景
- 两者免费版的邮件发送额度都很低，所以**演示账号比注册流程更可靠**

代码里已经为部署做了准备：路由默认需要登录、错误不会打挂进程、
`npm start` 可以直接跑生产模式。
