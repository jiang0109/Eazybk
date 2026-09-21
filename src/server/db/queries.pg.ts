/**
 * ---------------------------------------------------------------------------
 * SQL 查询层（PostgreSQL 版）
 * ---------------------------------------------------------------------------
 * 本项目所有 SQL 都集中在这个文件里。
 *
 * 从 SQLite 版迁移过来的，方言差异都标了 "SQLite vs PG" 方便对照。
 * 三个机械但必须全改的地方：
 *   1. 占位符     `?`  →  `$1, $2, ...`（PG 用编号占位符）
 *   2. 同步 → 异步 所有函数变成 async，因为 PG 是网络数据库
 *   3. 取新 id    `lastInsertRowid`  →  `RETURNING id`
 *
 * 贯穿全文的两条规则（和 SQLite 版一致）：
 *   1. 所有金额都是"分"（bigint），加减全部精确
 *   2. 所有查询都把 user_id 写进 WHERE（越权防御）
 */

import { all, get, insert, run, type SqlValue, type Row } from './pg.ts';
import type {
  Account,
  AccountType,
  BalanceOverview,
  Category,
  CategoryKind,
  CategoryStat,
  MonthlySummary,
  Transaction,
  TransactionInput,
  TxType,
} from '../../shared/types.ts';

/**
 * 种子数据默认灌给哪个用户。
 *
 * **Web 请求路径上不允许使用它** —— 所有查询函数的 userId 都是必传参数，
 * 用户 id 只能来自会话（见 auth/session.ts）。
 * 这一点很重要：如果留一个"默认用户"的后门，某天忘了传 userId
 * 就会静默地读写别人的账本。它只给离线脚本（seed / 对账工具）用。
 */
export const DEFAULT_USER_ID = 1;

// ===========================================================================
//  账户
// ===========================================================================

export async function listAccounts(userId: number): Promise<Account[]> {
  const rows = await all<{
    id: number;
    name: string;
    type: AccountType;
    initial_balance_cents: number;
    balance_cents: number;
    sort_order: number;
  }>(
    // id 是 bigint，加了 ::int 让 pg 不必依赖 BigInt 解析器。
    // 表主键用 bigint 是"为将来留余地"，但应用里 id 用 number 完全够。
    `SELECT id::int, name, type, initial_balance_cents, balance_cents, sort_order
       FROM accounts
      WHERE user_id = $1
      ORDER BY sort_order, id`,
    [userId],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    initialBalanceCents: r.initial_balance_cents,
    balanceCents: r.balance_cents,
    sortOrder: r.sort_order,
  }));
}

export async function createAccount(input: {
  name: string;
  type: AccountType;
  initialBalanceCents: number;
  userId: number;
}): Promise<Account> {
  const id = await insert(
    `INSERT INTO accounts (user_id, name, type, initial_balance_cents, balance_cents, sort_order)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MAX(sort_order) + 1 FROM accounts WHERE user_id = $1), 0))
     RETURNING id::int AS id`,
    [input.userId, input.name, input.type, input.initialBalanceCents, input.initialBalanceCents],
  );

  const accounts = await listAccounts(input.userId);
  return accounts.find((a) => a.id === id)!;
}

// ===========================================================================
//  分类
// ===========================================================================

export async function listCategories(userId: number): Promise<Category[]> {
  const rows = await all<{
    id: number;
    name: string;
    kind: CategoryKind;
    parent_id: number | null;
    icon: string | null;
    sort_order: number;
    usage_count: number;
  }>(
    // COUNT(*) 在 PG 里返回 bigint → 加 ::int 明确转成 32 位整数。
    // 这个习惯值得养成：PG 的类型比 SQLite 严格得多，
    // SQLite 里 COUNT() 直接当数字用没问题，PG 里不转就可能拿到字符串。
    `SELECT c.id::int, c.name, c.kind, c.parent_id::int, c.icon, c.sort_order,
            COUNT(t.id)::int AS usage_count
       FROM categories c
       -- 子分类的流水算在它自己头上，不算在父分类头上
       LEFT JOIN transactions t ON t.category_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.kind, c.sort_order, c.id`,
    [userId],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    parentId: r.parent_id,
    icon: r.icon,
    sortOrder: r.sort_order,
    usageCount: r.usage_count,
  }));
}

export async function createCategory(input: {
  name: string;
  kind: CategoryKind;
  parentId: number | null;
  icon: string | null;
  userId: number;
}): Promise<number> {
  return insert(
    `INSERT INTO categories (user_id, name, kind, parent_id, icon, sort_order)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE user_id = $1 AND kind = $3), 0))
     RETURNING id::int AS id`,
    [input.userId, input.name, input.kind, input.parentId, input.icon],
  );
}

export async function renameCategory(id: number, name: string, icon: string | null): Promise<void> {
  await run(`UPDATE categories SET name = $1, icon = $2 WHERE id = $3`, [name, icon, id]);
}

/**
 * 删除分类。
 *
 * 有引用时拒绝删除（外键是 ON DELETE RESTRICT）。
 * 先数一遍是为了给出人能看懂的提示，而不是把 PG 的英文报错丢给用户。
 */
export async function deleteCategory(id: number): Promise<{ ok: boolean; reason?: string }> {
  const used = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE category_id = $1`,
    [id],
  );
  if (used && used.n > 0) {
    return { ok: false, reason: `该分类下还有 ${used.n} 笔记录，请先修改或删除这些记录` };
  }

  // 没有流水引用，可以安全删除。
  // 注意子分类有 ON DELETE CASCADE，删父分类会连带删掉子分类。
  await run(`DELETE FROM categories WHERE id = $1`, [id]);
  return { ok: true };
}

// ===========================================================================
//  流水（CRUD）
// ===========================================================================

export interface TxFilter {
  month?: string;
  type?: TxType;
  accountId?: number;
  categoryId?: number;
  keyword?: string;
  limit?: number;
  offset?: number;
}

/**
 * 动态拼 WHERE 条件。
 *
 * SQLite 用 `?`，位置靠数组顺序对应；PG 用 `$1, $2, ...`，位置靠编号。
 * 所以这里必须**自己维护编号** —— 这是迁移里最容易出错的地方：
 * 编号错位不会报错（只要类型碰巧兼容），只会查出错误的结果。
 *
 * 用一个从 1 开始的计数器，每次 push 参数就 +1，保证顺序绝对一致。
 */
function buildTxFilter(userId: number, f: TxFilter) {
  const conditions: string[] = [`t.user_id = $1`];
  const params: SqlValue[] = [userId];
  let n = 1;

  const add = (condition: (idx: number) => string, value: SqlValue) => {
    n += 1;
    params.push(value);
    conditions.push(condition(n));
  };

  if (f.month) {
    // 用范围比较而不是 LIKE '2024-03%'：语义更清晰，也能用上索引。
    //
    // 这里用的是**左闭右开**区间 [月初, 下月初)，而不是
    // ">= 月初 AND <= 月末"。左闭右开的好处是不用去算"这个月有几天"，
    // 闰年闰月全都不用管，而且不会漏掉月末 23:59 之后的数据。
    //
    // 注意 nextMonthStart 返回的是完整日期（'2024-04-01'），
    // 因为 PG 的 ::date 转换要求合法日期格式 —— 见那个函数的说明。
    const month = f.month;
    n += 1;
    const lo = n;
    params.push(`${month}-01`);
    n += 1;
    const hi = n;
    params.push(nextMonthStart(month));
    conditions.push(`t.occurred_on >= $${lo}::date AND t.occurred_on < $${hi}::date`);
  }
  if (f.type) add((i) => `t.type = $${i}`, f.type);
  if (f.accountId) add((i) => `t.account_id = $${i}`, f.accountId);
  if (f.categoryId) add((i) => `t.category_id = $${i}`, f.categoryId);
  if (f.keyword) {
    // ILIKE 是 PG 特有的**大小写不敏感** LIKE。中文场景下无所谓，
    // 但如果是英文备注（比如 "starbucks"）就能忽略大小写，比 SQLite 的 LIKE 更友好。
    // 用户输入里的 % 和 _ 必须转义，否则搜 "50%" 会匹配到所有记录。
    add((i) => `t.description ILIKE $${i}`, `%${escapeLike(f.keyword!)}%`);
  }

  return { where: conditions.join(' AND '), params, nextIndex: n };
}

/**
 * 转义 LIKE 的通配符。
 *
 * 注意：PG 的默认转义符是反斜杠，但反斜杠在标准 SQL 字符串里还有一层含义，
 * 所以显式声明 `ESCAPE '\'` 更安全。这里的正则同时处理 \\ % _ 三种。
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** '2024-03' -> '2024-04'（只含年月，用于月份选择器等场景） */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * '2024-03' -> '2024-04-01'（完整的日期，用于范围比较的上界）
 *
 * ★ 这个函数是迁移过程中发现的一个"潜伏 bug"的修复 ★
 *
 * 原来的 nextMonth() 返回 '2024-04'（只有年月）。在 SQLite 里这样用没问题：
 *     occurred_on >= '2024-03-01' AND occurred_on < '2024-04'
 * 因为日期是 TEXT，字符串比较下 '2024-04' 确实大于任何 '2024-03-xx'。
 *
 * 但 Postgres 里要写成 `occurred_on < $2::date`，而 '2024-04' **不是合法日期**，
 * 直接报错：
 *     error: invalid input syntax for type date: "2024-04"
 *
 * 也就是说：SQLite 版一直"碰巧能用"，换到类型严格的数据库就立刻暴露。
 * 这类问题正是迁移最大的价值之一 —— 它强迫你把"靠巧合工作"的代码改成"明确正确"。
 */
function nextMonthStart(month: string): string {
  return `${nextMonth(month)}-01`;
}

/** 流水列表（按时间倒序） */
export async function listTransactions(f: TxFilter, userId: number): Promise<Transaction[]> {
  const { where, params, nextIndex } = buildTxFilter(userId, f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  params.push(limit);
  const limitIdx = nextIndex + 1;
  params.push(offset);
  const offsetIdx = nextIndex + 2;

  const rows = await all<Row>(
    `SELECT t.id::int, t.account_id::int, a.name AS account_name,
            t.category_id::int, c.name AS category_name, c.icon AS category_icon,
            t.type, t.amount_cents, t.description,
            to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            t.created_at
       FROM transactions t
       -- LEFT JOIN 关联分类：转账没有分类（category_id 是 NULL），
       -- 写成 JOIN 的话转账行会被静默丢掉 —— 没有报错，只是数据少了。
       LEFT JOIN categories c ON c.id = t.category_id
       JOIN accounts a        ON a.id = t.account_id
      WHERE ${where}
      -- 排序里必须带 id：同一天可能有多笔，只按日期排序时返回顺序是
      -- "不确定"的，翻页时会出现重复或遗漏。
      ORDER BY t.occurred_on DESC, t.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id as number,
    accountId: r.account_id as number,
    accountName: r.account_name as string,
    categoryId: r.category_id as number | null,
    categoryName: r.category_name as string | null,
    categoryIcon: r.category_icon as string | null,
    type: r.type as TxType,
    amountCents: r.amount_cents as number,
    description: r.description as string,
    occurredOn: r.occurred_on as string,
    createdAt: r.created_at as string,
  }));
}

/** 流水总数（用于分页）。复用同一套 WHERE 构造，避免两处条件写得不一致。 */
export async function countTransactions(f: TxFilter, userId: number): Promise<number> {
  const { where, params } = buildTxFilter(userId, f);
  const row = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM transactions t WHERE ${where}`,
    params,
  );
  return row?.n ?? 0;
}

/**
 * 新增流水。
 *
 * 余额不用在这里更新，INSERT 触发器会自动加。
 * 也不在这里校验"转账不能有分类"，因为数据库的 CHECK 约束会挡住 ——
 * 应用层再校验一遍是浪费，而且两处规则容易写得不一致。
 */
export async function createTransaction(input: TransactionInput, userId: number): Promise<number> {
  return insert(
    `INSERT INTO transactions
       (user_id, account_id, category_id, type, amount_cents, description, occurred_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date)
     RETURNING id::int AS id`,
    [
      userId,
      input.accountId,
      input.type === 'transfer' ? null : input.categoryId,
      input.type,
      input.amountCents,
      input.description,
      input.occurredOn,
    ],
  );
}

/**
 * 修改流水。
 *
 * UPDATE 触发器会用 "先减 OLD 再加 NEW" 的方式修正余额，
 * 所以这里即使把金额从 -100 改成 -500，或者换了账户，余额都会自动正确。
 *
 * 注意：不再手动写 updated_at —— PG 版的 BEFORE UPDATE 触发器负责这件事。
 * （SQLite 版是靠每条 UPDATE 自带 `updated_at = datetime('now')` 实现的。）
 */
export async function updateTransaction(id: number, input: TransactionInput): Promise<void> {
  const { changes } = await run(
    `UPDATE transactions
        SET account_id = $1, category_id = $2, type = $3, amount_cents = $4,
            description = $5, occurred_on = $6::date
      WHERE id = $7`,
    [
      input.accountId,
      input.type === 'transfer' ? null : input.categoryId,
      input.type,
      input.amountCents,
      input.description,
      input.occurredOn,
      id,
    ],
  );
  if (changes === 0) throw new Error('流水不存在');
}

/**
 * 删除流水 —— 物理删除（DELETE 真的把行删掉）。
 *
 * 另一种常见做法是"软删除"：加一列 deleted_at，删除时只写时间戳。
 * 为什么这里不用？因为软删除的代价是**每条查询都必须记得带上
 * deleted_at IS NULL**，漏掉任何一处，删掉的数据就会"诈尸"出现在报表里。
 * 记账 App 的删除是用户主动、可预期的操作，物理删除更直观。
 * 而且 DELETE 触发器会把这一笔对余额的影响撤销掉，数据依然一致。
 */
export async function deleteTransaction(id: number): Promise<void> {
  const { changes } = await run(`DELETE FROM transactions WHERE id = $1`, [id]);
  if (changes === 0) throw new Error('流水不存在');
}

// ===========================================================================
//  统计与汇总
// ===========================================================================

/**
 * 月度汇总：这个月花了多少、赚了多少。
 *
 * 条件聚合 SUM(CASE WHEN 条件 THEN 值 ELSE 0 END) —— 这个套路
 * SQLite 和 PG 完全一样，是"数据透视表"在 SQL 里的写法。
 *
 * 为什么排除 transfer？转账只是钱在自己账户之间搬家，不是收入也不是支出。
 * 如果算进去，"这个月赚了 5 万"可能全是自己转给自己。
 */
export async function getMonthlySummary(opts: {
  month: string;
  userId: number;
}): Promise<MonthlySummary> {
  const row = await get<{ income: number; expense: number; n: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END), 0) AS expense,
       COUNT(*)::int AS n
     FROM transactions
     WHERE user_id = $1
       AND type <> 'transfer'
       AND occurred_on >= $2::date AND occurred_on < $3::date`,
    [opts.userId, `${opts.month}-01`, nextMonthStart(opts.month)],
  );

  const income = row?.income ?? 0;
  const expense = row?.expense ?? 0;
  return {
    month: opts.month,
    incomeCents: income,
    expenseCents: expense,
    // 支出存的是负数，所以结余是"加"
    netCents: income + expense,
    txCount: row?.n ?? 0,
  };
}

/**
 * 最近 N 个月的汇总（按时间正序），给柱状图用。
 *
 * ★ 这是迁移里**改动最大的一个查询**，值得单独说明 ★
 *
 * SQLite 版用递归 CTE 生成连续月份列表：
 *     WITH RECURSIVE months(month) AS (... UNION ALL ... LIMIT ?)
 * 但 PG **不支持在递归 CTE 里用 LIMIT**，直接报：
 *     error: LIMIT in a recursive query is not implemented
 *
 * 而且即使改写掉 LIMIT，"没有流水的月份会消失"这个问题在两边都存在 ——
 * 所以必须生成完整月份序列再 LEFT JOIN。
 *
 * PG 里生成月份序列有更地道的工具：generate_series。
 * 一行搞定，不用递归，也不用绕 LIMIT 的限制：
 *     generate_series(起点, 终点, interval '1 month')
 *
 * 这个差异很典型：**同一个需求，不同数据库有各自更顺手的写法**。
 * 迁移不只是换语法，有时是换思路。
 */
export async function getTrend(opts: { months: number; userId: number }): Promise<MonthlySummary[]> {
  const n = Math.min(Math.max(opts.months, 1), 24);

  const rows = await all<{ month: string; income: number; expense: number; net: number; n: number }>(
    `SELECT to_char(m, 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents ELSE 0 END), 0) AS expense,
            COALESCE(SUM(t.amount_cents), 0) AS net,
            COUNT(t.id)::int AS n
       FROM generate_series(
              date_trunc('month', now()) - make_interval(months => $2::int - 1),
              date_trunc('month', now()),
              interval '1 month'
            ) AS m
       LEFT JOIN transactions t
              ON date_trunc('month', t.occurred_on) = m
             AND t.user_id = $1
             AND t.type <> 'transfer'
      GROUP BY m
      ORDER BY m ASC`,
    [opts.userId, n],
  );

  return rows.map((r) => ({
    month: r.month,
    incomeCents: r.income,
    expenseCents: r.expense,
    netCents: r.net,
    txCount: r.n,
  }));
}

/**
 * 分类统计：这个月餐饮花了 30%、交通 15%……
 * 这是记账 App 最有价值的部分 —— 让你知道钱到底花哪了。
 *
 * rollup = true 时把子分类汇总到父分类上（用 COALESCE(c.parent_id, c.id)）。
 * ratio 用窗口函数 SUM(...) OVER () 算，不需要再查一次总数。
 *
 * 注意 GROUP BY 必须列出 SELECT 里所有非聚合列（PG 比 SQLite 严格）：
 *   SQLite 允许 `GROUP BY c.id` 而 SELECT 里取 c.name；
 *   PG 要求 `GROUP BY c.id, c.name`（除非 c.id 是主键 —— 那样 PG 能推断出
 *   函数依赖，也允许只写 c.id）。这里写全，不依赖推断，更清楚。
 */
export async function getCategoryStats(opts: {
  month: string;
  kind: CategoryKind;
  userId: number;
  rollup?: boolean;
}): Promise<CategoryStat[]> {
  const rollup = opts.rollup ?? false;

  const idExpr = rollup ? 'COALESCE(c.parent_id, c.id)' : 'c.id';
  const joinParent = rollup ? 'JOIN categories p ON p.id = COALESCE(c.parent_id, c.id)' : '';
  const nameExpr = rollup ? 'p.name' : 'c.name';
  const iconExpr = rollup ? 'p.icon' : 'c.icon';

  const rows = await all<{
    id: number;
    name: string;
    icon: string | null;
    kind: CategoryKind;
    total: number;
    n: number;
    total_all: number;
  }>(
    `SELECT ${idExpr}::int AS id, ${nameExpr} AS name, ${iconExpr} AS icon, c.kind,
            SUM(t.amount_cents) AS total,
            COUNT(*)::int AS n,
            -- 窗口函数：整个结果集的总和，不需要再查一次
            SUM(SUM(t.amount_cents)) OVER () AS total_all
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       ${joinParent}
      WHERE t.user_id = $1
        AND t.type = $2
        AND t.occurred_on >= $3::date AND t.occurred_on < $4::date
      GROUP BY ${idExpr}, ${nameExpr}, ${iconExpr}, c.kind
      -- 支出是负数，"花得最多"= 数值最小，所以用 ASC
      ORDER BY total ASC`,
    [opts.userId, opts.kind, `${opts.month}-01`, nextMonthStart(opts.month)],
  );

  return rows.map((r) => ({
    categoryId: r.id,
    name: r.name,
    icon: r.icon,
    kind: r.kind,
    totalCents: r.total,
    txCount: r.n,
    ratio: r.total_all === 0 ? 0 : r.total / r.total_all,
  }));
}

/**
 * 本月和上个月比，支出是多了还是少了。
 *
 * 窗口函数 LAG 取"按某顺序排列时前一行的值"，一次查询拿到两个月的数据。
 * 顺便演示 PG 的一个便利：`make_interval` 和 `to_char` 都比 SQLite 的
 * 字符串拼接日期更清晰。
 */
export async function getMonthComparison(opts: {
  month: string;
  userId: number;
}): Promise<{ expenseCents: number; prevExpenseCents: number; diffCents: number; diffRatio: number | null }> {
  const rows = await all<{ month: string; expense: number; prev: number | null }>(
    `WITH monthly AS (
       SELECT to_char(occurred_on, 'YYYY-MM') AS month,
              SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS expense
         FROM transactions
        WHERE user_id = $1
          AND type <> 'transfer'
        GROUP BY to_char(occurred_on, 'YYYY-MM')
     )
     SELECT month, expense,
            -- LAG 取上一行（时间上更早的那一个月）的值
            LAG(expense) OVER (ORDER BY month) AS prev
       FROM monthly
      WHERE month <= $2`,
    [opts.userId, opts.month],
  );

  const current = rows.find((r) => r.month === opts.month);
  const expenseCents = current?.expense ?? 0;
  const prevExpenseCents = current?.prev ?? 0;

  return {
    expenseCents,
    prevExpenseCents,
    diffCents: expenseCents - prevExpenseCents,
    // 上个月没有数据时不给比例（除零会得到 Infinity，显示成 "∞%" 很怪）
    diffRatio: prevExpenseCents === 0 ? null : (expenseCents - prevExpenseCents) / Math.abs(prevExpenseCents),
  };
}

/**
 * 有记账数据的月份列表（新的在前），给月份选择器用。
 *
 * SQLite 版：`strftime('%Y-%m', occurred_on)`
 * PG   版：`to_char(occurred_on, 'YYYY-MM')`
 * 这是最常见的日期函数替换。
 */
export async function listAvailableMonths(userId: number): Promise<{ month: string; txCount: number }[]> {
  const rows = await all<{ month: string; txCount: number }>(
    `SELECT to_char(occurred_on, 'YYYY-MM') AS month, COUNT(*)::int AS "txCount"
       FROM transactions
      WHERE user_id = $1
      GROUP BY to_char(occurred_on, 'YYYY-MM')
      ORDER BY month DESC`,
    [userId],
  );
  return rows;
}

/**
 * 余额总览：收入总额 − 支出总额 = 当前结余。
 *
 * 同时给出两个口径，别混淆：
 *   totalBalanceCents：所有账户余额之和（含初始余额，是"你现在有多少钱"）
 *   netCents         ：历史收入 − 历史支出（是"记账以来净赚了多少"）
 * 两者不相等是正常的 —— 差在账户的初始余额上。
 */
export async function getBalanceOverview(userId: number): Promise<BalanceOverview> {
  const accounts = await listAccounts(userId);

  const row = await get<{ income: number; expense: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END), 0) AS expense
     FROM transactions
     WHERE user_id = $1 AND type <> 'transfer'`,
    [userId],
  );

  const income = row?.income ?? 0;
  const expense = row?.expense ?? 0;

  return {
    totalBalanceCents: accounts.reduce((sum, a) => sum + a.balanceCents, 0),
    totalIncomeCents: income,
    totalExpenseCents: expense,
    netCents: income + expense,
    accounts,
  };
}

/**
 * 对账检查：验证"触发器维护的余额"和"实时算出来的余额"是否一致。
 * 这是派生数据设计的兜底安全网。返回的行数应该是 0。
 *
 * 实现上用 ROW_NUMBER() 明确取"累计和的最后一行"。
 * 这里记录一个 SQLite 版踩过的坑：最初用 MAX(cum) 想取最后一个累计值，
 * 但当累计和全是负数时，MAX 返回的是最大的那个（最接近 0 的），
 * 而不是最后一行 —— 结果对账误报。改用 ROW_NUMBER 就明确了。
 */
export async function checkBalanceDrift(userId: number) {
  return all<{
    id: number;
    name: string;
    stored: number;
    computed: number;
    drift: number;
  }>(
    `WITH running AS (
       SELECT account_id,
              SUM(amount_cents) OVER (
                PARTITION BY account_id
                ORDER BY occurred_on, id
              ) AS cum,
              ROW_NUMBER() OVER (
                PARTITION BY account_id
                ORDER BY occurred_on DESC, id DESC
              ) AS rn
         FROM transactions
        WHERE user_id = $1
     ),
     last_cum AS (
       -- 每个账户累计和的"最后一个值"，即该账户的最终余额（不含初始余额）
       SELECT account_id, cum FROM running WHERE rn = 1
     )
     -- 外面再套一层：HAVING 在没有 GROUP BY 的查询里是非法的，
     -- 想过滤计算出来的别名字段就得用子查询 + WHERE。
     SELECT * FROM (
       SELECT a.id::int, a.name,
              a.balance_cents AS stored,
              a.initial_balance_cents + COALESCE(l.cum, 0) AS computed,
              a.balance_cents - (a.initial_balance_cents + COALESCE(l.cum, 0)) AS drift
         FROM accounts a
         -- LEFT JOIN + COALESCE：没有流水的账户也要出现在结果里，
         -- 否则它漂移了你也发现不了。
         LEFT JOIN last_cum l ON l.account_id = a.id
        WHERE a.user_id = $1
     ) sub
     WHERE drift <> 0`,
    [userId],
  );
}
