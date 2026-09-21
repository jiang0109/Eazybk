/**
 * ---------------------------------------------------------------------------
 * SQL 查询层 —— 本项目所有 SQL 都集中在这个文件里
 * ---------------------------------------------------------------------------
 * 为什么要把 SQL 集中？因为数据库的真实复杂度就在这里。
 * 界面代码会变、API 会变，但"这个月花了多少"背后的 SQL 是稳定的。
 * 集中放一处，你读一个文件就能看到这张表被怎么用。
 *
 * 贯穿全文的两条规则：
 *   1. 所有金额都是"分"（INTEGER），加减乘除全部精确。
 *   2. 所有查询都带 user_id（多用户扩展位），方便以后支持多用户。
 */

// db/index.ts 提供查询与事务封装；shared/types.ts 是前后端共用的领域类型
import { all, get, run, type Db } from './index.ts';
import { escapeLike } from '../util.ts';
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
 * **Web 请求路径上不允许使用它** —— 所有查询函数的 userId
 * 现在都是必传参数，用户 id 只能来自会话（见 auth/session.ts）。
 * 这一点很重要：如果留一个“默认用户”的后门，某天忘了传 userId
 * 就会静默地读写别人的账本。
 * 它只给离线脚本（seed / 对账工具）用。
 */
export const DEFAULT_USER_ID = 1;

// ===========================================================================
//  账户
// ===========================================================================

/**
 * 账户列表。
 * 只取需要的列，不用 SELECT * —— 这是习惯问题：显式列名能让索引覆盖查询
 * （covering index）生效，也能在表结构变化时立刻发现哪里需要改。
 */
export function listAccounts(db: Db, userId: number): Account[] {
  return all<{
    id: number;
    name: string;
    type: AccountType;
    initial_balance_cents: number;
    balance_cents: number;
    sort_order: number;
  }>(
    db,
    `SELECT id, name, type, initial_balance_cents, balance_cents, sort_order
       FROM accounts
      WHERE user_id = ?
      ORDER BY sort_order, id`,
    userId,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    initialBalanceCents: r.initial_balance_cents,
    balanceCents: r.balance_cents,
    sortOrder: r.sort_order,
  }));
}

export function createAccount(
  db: Db,
  input: { name: string; type: AccountType; initialBalanceCents: number; userId: number },
): Account {
  const userId = input.userId;
  const { lastInsertRowid } = run(
    db,
    `INSERT INTO accounts (user_id, name, type, initial_balance_cents, balance_cents, sort_order)
     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM accounts WHERE user_id = ?), 0))`,
    userId,
    input.name,
    input.type,
    input.initialBalanceCents,
    // 余额初始 = 初始余额。之后由触发器随流水变化。
    input.initialBalanceCents,
    userId,
  );
  return listAccounts(db, userId).find((a) => a.id === lastInsertRowid)!;
}

// ===========================================================================
//  分类
// ===========================================================================

/**
 * 分类列表，附带每个分类被用了多少笔（usageCount）。
 *
 * 这个 LEFT JOIN + GROUP BY 的写法很典型：
 *   - LEFT JOIN 保证"一笔没用过的新分类"也会出现（用 JOIN 的话它会被静默丢掉）
 *   - usageCount 在界面上用来提示"这个分类下有 N 笔记录，删不掉"
 */
export function listCategories(db: Db, userId: number): Category[] {
  return all<{
    id: number;
    name: string;
    kind: CategoryKind;
    parent_id: number | null;
    icon: string | null;
    sort_order: number;
    usage_count: number;
  }>(
    db,
    `SELECT c.id, c.name, c.kind, c.parent_id, c.icon, c.sort_order,
            COUNT(t.id) AS usage_count
       FROM categories c
       -- 子分类的流水也算在它自己头上，不算在父分类头上
       LEFT JOIN transactions t
              ON t.category_id = c.id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY c.kind, c.sort_order, c.id`,
    userId,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    parentId: r.parent_id,
    icon: r.icon,
    sortOrder: r.sort_order,
    usageCount: r.usage_count,
  }));
}

export function createCategory(
  db: Db,
  input: { name: string; kind: CategoryKind; parentId: number | null; icon: string | null; userId: number },
): number {
  const userId = input.userId;
  const { lastInsertRowid } = run(
    db,
    `INSERT INTO categories (user_id, name, kind, parent_id, icon, sort_order)
     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE user_id = ? AND kind = ?), 0))`,
    userId,
    input.name,
    input.kind,
    input.parentId,
    input.icon,
    userId,
    input.kind,
  );
  return lastInsertRowid;
}

export function renameCategory(db: Db, id: number, name: string, icon: string | null): void {
  run(db, `UPDATE categories SET name = ?, icon = ? WHERE id = ?`, name, icon, id);
}

/**
 * 删除分类。
 *
 * 这里演示一个真实的取舍：分类被流水引用时，数据库层面有两种策略 ——
 *   ON DELETE CASCADE   ：连流水一起删（记账 App 里绝对不行，会莫名丢账）
 *   ON DELETE RESTRICT  ：有引用就拒绝删除（我们选的）
 *
 * 因为 schema 里选了 RESTRICT，直接 DELETE 会抛外键错误。
 * 所以这里先数一遍，给出人能看懂的提示，而不是把 SQLite 的英文报错丢给用户。
 */
export function deleteCategory(db: Db, id: number): { ok: boolean; reason?: string } {
  const used = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?`,
    id,
  );
  if (used && used.n > 0) {
    return { ok: false, reason: `该分类下还有 ${used.n} 笔记录，请先修改或删除这些记录` };
  }

  // 没有流水引用，可以安全删除。
  // 注意子分类有 ON DELETE CASCADE，删父分类会连带删掉子分类。
  run(db, `DELETE FROM categories WHERE id = ?`, id);
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
 * 关键点：**条件值和占位符 ? 必须同步 push**。
 * 这是手写动态 SQL 最容易出错的地方 —— 顺序错位会导致参数错配，
 * 而且不一定报错，只是查出错误的结果（静默 bug）。
 */
function buildTxFilter(userId: number, f: TxFilter) {
  const conditions = ['t.user_id = ?'];
  const params: (string | number)[] = [userId];

  if (f.month) {
    // 用范围比较而不是 LIKE '2024-03%'：语义更清晰，也能用上索引
    conditions.push(`t.occurred_on >= ? AND t.occurred_on < ?`);
    params.push(`${f.month}-01`, nextMonth(f.month));
  }
  if (f.type) {
    conditions.push('t.type = ?');
    params.push(f.type);
  }
  if (f.accountId) {
    conditions.push('t.account_id = ?');
    params.push(f.accountId);
  }
  if (f.categoryId) {
    conditions.push('t.category_id = ?');
    params.push(f.categoryId);
  }
  if (f.keyword) {
    // 用户输入里的 % 和 _ 必须转义，否则搜 "50%" 会匹配到所有记录
    conditions.push(`t.description LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(f.keyword)}%`);
  }

  return { where: conditions.join(' AND '), params };
}

/** '2024-03' -> '2024-04'，用于月份范围查询的上界（左闭右开，比 <= 月末更安全） */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * 流水列表（按时间倒序）。
 *
 * 注意 userId 是**必传参数**，这不是为了好看，而是故意的设计。
 * 如果给它一个默认值，那么某天有人加新接口时忘了传，代码照样能跑 ——
 * 只是会静默地把别人的数据当成"我的"返回。
 * 必传会让这种疏漏在编译期暴露，而不是等上线后发现数据串了。
 */
export function listTransactions(db: Db, f: TxFilter, userId: number): Transaction[] {
  const { where, params } = buildTxFilter(userId, f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  return all<Record<string, unknown>>(
    db,
    `SELECT t.id, t.account_id, a.name AS account_name,
            t.category_id, c.name AS category_name, c.icon AS category_icon,
            t.type, t.amount_cents, t.description, t.occurred_on, t.created_at
       FROM transactions t
       -- 用 LEFT JOIN 关联分类：转账没有分类（category_id 是 NULL），
       -- 写成 JOIN 的话转账行会被静默丢掉 —— 没有报错，只是数据少了。
       LEFT JOIN categories c ON c.id = t.category_id
       JOIN accounts a        ON a.id = t.account_id
      WHERE ${where}
      -- 排序里必须带 id：同一天可能有多笔，只按日期排序时数据库返回顺序是
      -- "不确定"的，会导致翻页时某条记录重复出现或从不出现。
      ORDER BY t.occurred_on DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  ).map((r) => ({
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
export function countTransactions(db: Db, f: TxFilter, userId: number): number {
  const { where, params } = buildTxFilter(userId, f);
  const row = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions t WHERE ${where}`, ...params);
  return row?.n ?? 0;
}

/**
 * 新增流水。
 *
 * 注意：余额不用在这里更新，INSERT 触发器会自动加。
 * 也不在这里校验"转账不能有分类"，因为数据库的 CHECK 约束会挡住 ——
 * 应用层再校验一遍是浪费，而且两处规则容易写得不一致。
 */
export function createTransaction(db: Db, input: TransactionInput, userId: number): number {
  const { lastInsertRowid } = run(
    db,
    `INSERT INTO transactions
       (user_id, account_id, category_id, type, amount_cents, description, occurred_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId,
    input.accountId,
    input.type === 'transfer' ? null : input.categoryId,
    input.type,
    input.amountCents,
    input.description,
    input.occurredOn,
  );
  return lastInsertRowid;
}

/**
 * 修改流水。
 *
 * UPDATE 触发器会用 "先减 OLD 再加 NEW" 的方式修正余额，
 * 所以这里即使把金额从 -100 改成 -500，或者换了账户，余额都会自动正确。
 */
export function updateTransaction(db: Db, id: number, input: TransactionInput): void {
  const { changes } = run(
    db,
    `UPDATE transactions
        SET account_id = ?, category_id = ?, type = ?, amount_cents = ?,
            description = ?, occurred_on = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    input.accountId,
    input.type === 'transfer' ? null : input.categoryId,
    input.type,
    input.amountCents,
    input.description,
    input.occurredOn,
    id,
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
 *
 * 真实项目里两种都常见，选择取决于是否需要"撤销删除"和审计留痕。
 * 如果想动手试试软删除：给 transactions 加回 deleted_at 列，
 * 把这里改成 UPDATE，然后你会立刻体会到"每条查询都要记得过滤"有多烦。
 */
export function deleteTransaction(db: Db, id: number): void {
  const { changes } = run(db, `DELETE FROM transactions WHERE id = ?`, id);
  if (changes === 0) throw new Error('流水不存在');
}

// ===========================================================================
//  统计与汇总
// ===========================================================================

/**
 * 月度汇总：这个月花了多少、赚了多少。
 *
 * 这里用了"条件聚合"这个必须掌握的套路：
 *   SUM(CASE WHEN 条件 THEN 值 ELSE 0 END)
 * 它等于数据透视表 —— 把不同方向的钱算到同一行的不同列里。
 *
 * 为什么排除 transfer？
 * 转账只是钱在自己账户之间搬家，不是收入也不是支出。
 * 如果算进去，"这个月赚了 5 万"可能全是自己转给自己。
 */
export function getMonthlySummary(
  db: Db,
  opts: { month: string; userId: number },
): MonthlySummary {
  const userId = opts.userId;
  const row = get<{ income: number; expense: number; n: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END), 0) AS expense,
       COUNT(*) AS n
     FROM transactions
     WHERE user_id = ?
       AND type <> 'transfer'
       AND occurred_on >= ? AND occurred_on < ?`,
    userId,
    `${opts.month}-01`,
    nextMonth(opts.month),
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
 * 分成两步：
 *   1. 用递归 CTE 生成一个"连续月份"列表
 *   2. LEFT JOIN 真实数据
 *
 * 第 1 步是重点：如果直接对 transactions 做 GROUP BY，
 * **没有流水的月份会直接消失**（比如 2 月忘了记账），图表就会缺一格。
 * 生成完整月份序列再 LEFT JOIN，才能保证"每个月都有数据点"。
 * 这是做时间序列报表的必备技巧。
 */
export function getTrend(db: Db, opts: { months: number; userId: number }): MonthlySummary[] {
  const userId = opts.userId;
  const n = Math.min(Math.max(opts.months, 1), 24);

  return all<{ month: string; income: number; expense: number; net: number; n: number }>(
    db,
    `WITH RECURSIVE months(month) AS (
       SELECT strftime('%Y-%m', 'now', 'localtime')
       UNION ALL
       SELECT strftime('%Y-%m', month || '-01', '-1 month') FROM months
       LIMIT ?
     )
     SELECT m.month,
            COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents ELSE 0 END), 0) AS expense,
            COALESCE(SUM(t.amount_cents), 0) AS net,
            COUNT(t.id) AS n
       FROM months m
       LEFT JOIN transactions t
              ON strftime('%Y-%m', t.occurred_on) = m.month
             AND t.user_id = ?
             AND t.type <> 'transfer'
      GROUP BY m.month
      ORDER BY m.month ASC`,
    n,
    userId,
  ).map((r) => ({
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
 * rollup = true 时把子分类汇总到父分类上。
 * 这里用 COALESCE(c.parent_id, c.id) 简化成"用父分类的 id 来分组"，
 * 但 SELECT 的分类名也要跟着换成父分类的名字，
 * 所以额外 JOIN 了一次 categories（别名 p）。
 *
 * ratio 用**窗口函数**算：SUM(...) OVER () 的含义是"所有行的合计"。
 * 用窗口函数的好处是不用再查一次总数（否则就要么发两条 SQL，
 * 要么在应用层算比例）。
 */
export function getCategoryStats(
  db: Db,
  opts: { month: string; kind: CategoryKind; userId: number; rollup?: boolean },
): CategoryStat[] {
  const userId = opts.userId;
  const rollup = opts.rollup ?? false;

  // 汇总到父分类时，展示的 id / 名字 / 图标都取父分类的
  const idExpr = rollup ? 'COALESCE(c.parent_id, c.id)' : 'c.id';
  const joinParent = rollup ? 'JOIN categories p ON p.id = COALESCE(c.parent_id, c.id)' : '';
  const nameExpr = rollup ? 'p.name' : 'c.name';
  const iconExpr = rollup ? 'p.icon' : 'c.icon';

  return all<{
    id: number;
    name: string;
    icon: string | null;
    kind: CategoryKind;
    total: number;
    n: number;
    total_all: number;
  }>(
    db,
    `SELECT ${idExpr} AS id, ${nameExpr} AS name, ${iconExpr} AS icon, c.kind,
            SUM(t.amount_cents) AS total,
            COUNT(*)            AS n,
            -- 窗口函数：整个结果集的总和，不需要再查一次
            SUM(SUM(t.amount_cents)) OVER () AS total_all
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       ${joinParent}
      WHERE t.user_id = ?
        AND t.type = ?
        AND t.occurred_on >= ? AND t.occurred_on < ?
      GROUP BY ${idExpr}
      -- 支出是负数，"花得最多"= 数值最小，所以用 ASC
      ORDER BY total ASC`,
    userId,
    opts.kind,
    `${opts.month}-01`,
    nextMonth(opts.month),
  ).map((r) => ({
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
 * 这里演示窗口函数 LAG：它取"按某个顺序排列时，前一行的值"。
 * 用它可以在一次查询里同时拿到本月和上月的数据，不用查两次再在应用层配对。
 */
export function getMonthComparison(
  db: Db,
  opts: { month: string; userId: number },
): { expenseCents: number; prevExpenseCents: number; diffCents: number; diffRatio: number | null } {
  const userId = opts.userId;
  const target = nextMonth(opts.month); // 要算到目标月的下一个月，才能拿到它的上一行

  const rows = all<{ month: string; expense: number; prev: number | null }>(
    db,
    `WITH monthly AS (
       SELECT strftime('%Y-%m', occurred_on) AS month,
              SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS expense
         FROM transactions
        WHERE user_id = ?
          AND type <> 'transfer'
        GROUP BY month
     )
     SELECT month, expense,
            -- LAG 取上一行（时间上更早的那一个月）的值
            LAG(expense) OVER (ORDER BY month) AS prev
       FROM monthly
      WHERE month < ?`,
    userId,
    target,
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
 * 为什么不让前端自己从 2020 年遍历到今年？因为那样会列出大量空月份，
 * 用户选了却是空白页。让数据库告诉我们"哪些月份真的有数据"。
 */
export function listAvailableMonths(db: Db, userId: number) {
  return all<{ month: string; txCount: number }>(
    db,
    `SELECT strftime('%Y-%m', occurred_on) AS month, COUNT(*) AS txCount
       FROM transactions
      WHERE user_id = ?
      GROUP BY month
      ORDER BY month DESC`,
    userId,
  ).map((r) => ({ month: r.month, txCount: r.txCount }));
}

/**
 * 余额总览：收入总额 − 支出总额 = 当前结余。
 *
 * 这里同时给出两个口径，别混淆：
 *   totalBalanceCents：所有账户余额之和（含初始余额，是"你现在有多少钱"）
 *   netCents         ：历史收入 − 历史支出（是"记账以来净赚了多少"）
 * 两者不相等是正常的 —— 差在账户的初始余额上。
 */
export function getBalanceOverview(db: Db, userId: number): BalanceOverview {
  const accounts = listAccounts(db, userId);

  const row = get<{ income: number; expense: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END), 0) AS expense
     FROM transactions
     WHERE user_id = ? AND type <> 'transfer'`,
    userId,
  );

  const income = row?.income ?? 0;
  const expense = row?.expense ?? 0;

  return {
    totalBalanceCents: accounts.reduce((sum, a) => a.balanceCents + sum, 0),
    totalIncomeCents: income,
    totalExpenseCents: expense,
    netCents: income + expense,
    accounts,
  };
}

/**
 * 对账检查：验证"触发器维护的余额"和"实时算出来的余额"是否一致。
 *
 * 这是"派生数据"设计的兜底安全网。返回的行数应该是 0。
 * 如果返回了行，说明有人绕过触发器改了数据 —— 这时候可以用返回的
 * real_balance 把余额修回去。
 *
 * 同时也演示了窗口函数的一个常见用途：算累计值（running total）。
 * initial_balance + 按时间累计的流水 = 该账户在每一时刻的余额。
 *
 * 这里有个值得记下来的坑：取"累计和的最后一个值"时，
 * 用 MAX(cum) 是错的 —— 当累计和全是负数时，MAX 返回的是最大的那个
 * （也就是最接近 0 的，而不是最后一行）。
 * 正确做法是用 ROW_NUMBER() 明确标出最后一行再取。
 * 我第一版就是这么写错的，被这条对账查询自己抓出来了。
 */
export function checkBalanceDrift(db: Db, userId: number) {
  return all<{
    id: number;
    name: string;
    stored: number;
    computed: number;
    drift: number;
  }>(
    db,
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
        WHERE user_id = ?
     ),
     last_cum AS (
       -- 每个账户累计和的"最后一个值"，即该账户的最终余额（不含初始余额）
       SELECT account_id, cum FROM running WHERE rn = 1
     )
     -- 外面再套一层：HAVING 在没有 GROUP BY 的查询里是非法的，
     -- 想过滤计算出来的别名字段就得用子查询 + WHERE。
     SELECT * FROM (
       SELECT a.id, a.name,
              a.balance_cents AS stored,
              a.initial_balance_cents + COALESCE(l.cum, 0) AS computed,
              a.balance_cents - (a.initial_balance_cents + COALESCE(l.cum, 0)) AS drift
         FROM accounts a
         -- LEFT JOIN + COALESCE：没有流水的账户也要出现在结果里，
         -- 否则它漂移了你也发现不了。
         LEFT JOIN last_cum l ON l.account_id = a.id
        WHERE a.user_id = ?
     )
     WHERE drift <> 0`,
    userId,
    userId,
  );
}
