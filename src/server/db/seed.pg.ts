/**
 * ---------------------------------------------------------------------------
 * 示例数据生成器（PostgreSQL 版）
 * ---------------------------------------------------------------------------
 * 生成 14 个月的仿真记账数据（约 640 笔流水、4 个账户、16 个分类）。
 *
 * 和 SQLite 版逻辑完全一致，只有三处因方言/驱动而不同，都标了注释：
 *   1. 所有查询是 async，要 await
 *   2. 事务的回调拿到的是一个 client，查询要用它
 *   3. 用固定随机种子 —— 保证"重置"= 精确回到同一个初始状态
 *      （这一点在 SQLite 版是后来才修对的：随机种子导致重置后笔数会变，
 *       测试断言会随机失败，语义上也不对）
 */

import { get, run, tx, type SqlValue } from './pg.ts';
import {
  createAccount,
  createCategory,
  createTransaction,
  listAccounts,
  checkBalanceDrift,
  getMonthlySummary,
  getCategoryStats,
  getTrend,
} from './queries.pg.ts';
import { toLocalDate } from '../util.ts';
import { pathToFileURL } from 'node:url';
import type { AccountType } from '../../shared/types.ts';

// ---------------------------------------------------------------------------
// 可复现的伪随机数（mulberry32）
// ---------------------------------------------------------------------------
function makeRandom(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机种子。固定值 = 每次生成的数据完全一样（可复现） */
const DEFAULT_SEED = 20240301;

// ---------------------------------------------------------------------------
// 基础数据
// ---------------------------------------------------------------------------

const ACCOUNTS: { name: string; type: AccountType; initial: number }[] = [
  { name: '招商银行卡', type: 'bank', initial: 3_200_00 },
  { name: '微信零钱', type: 'ewallet', initial: 500_00 },
  { name: '支付宝', type: 'ewallet', initial: 300_00 },
  { name: '现金钱包', type: 'cash', initial: 200_00 },
];

/** 支出分类：名称 -> 图标、金额区间（元）、每月大致笔数 */
const EXPENSE_CATEGORIES: Record<string, { icon: string; min: number; max: number; perMonth: number }> = {
  餐饮: { icon: '🍜', min: 15, max: 90, perMonth: 18 },
  交通: { icon: '🚇', min: 3, max: 60, perMonth: 12 },
  购物: { icon: '🛍️', min: 50, max: 600, perMonth: 3 },
  房租: { icon: '🏠', min: 2500, max: 2500, perMonth: 1 },
  娱乐: { icon: '🎬', min: 30, max: 280, perMonth: 4 },
  水电燃气: { icon: '💡', min: 80, max: 260, perMonth: 1 },
  通讯: { icon: '📶', min: 39, max: 129, perMonth: 1 },
  医疗: { icon: '💊', min: 40, max: 500, perMonth: 1 },
  学习: { icon: '📚', min: 30, max: 300, perMonth: 2 },
};

const INCOME_CATEGORIES: Record<string, { icon: string; min: number; max: number; perMonth: number }> = {
  工资: { icon: '💼', min: 15000, max: 15000, perMonth: 1 },
  兼职: { icon: '🧑‍💻', min: 800, max: 3500, perMonth: 1 },
  理财收益: { icon: '📈', min: 50, max: 900, perMonth: 1 },
};

/** 备注库：让数据看起来像真的，而不是 "test1 test2" */
const FOOD_NOTES = ['公司楼下快餐', '外卖', '和同事聚餐', '便利店早餐', '咖啡', '周末下馆子'];
const TRAFFIC_NOTES = ['地铁', '打车', '公交', '共享单车', '高铁票'];
const SHOPPING_NOTES = ['日用品', '衣服', '数码配件', '护肤品', '超市采购'];
const FUN_NOTES = ['电影票', '剧本杀', 'KTV', '周末出游', '视频会员'];
const MISC_NOTES = ['定期缴费'];

const PAY_ACCOUNTS = ['微信零钱', '支付宝', '招商银行卡'] as const;
const WALLET_ACCOUNTS = ['微信零钱', '支付宝'] as const;
const TOP_UP_THRESHOLD = 300_00;

export interface SeedResult {
  accounts: number;
  categories: number;
  transactions: number;
  topUps: number;
}

// ===========================================================================
//  给某个用户灌数据
// ===========================================================================

/**
 * 给指定用户生成一整套示例数据。
 *
 * 整个过程包在一个事务里：中途出错就全部回滚，
 * 不会留下"账户建了但流水只灌了一半"的残缺数据。
 *
 * 注意事务的用法（这是 PG 和 SQLite 的关键差异之一）：
 *   回调拿到的是一个 **client**，事务内所有查询都必须用它。
 *   如果用全局的 all/get/run（它们各自从连接池取连接），
 *   那些查询会跑在**事务之外**，回滚时不会被撤销 —— 这是个很隐蔽的坑。
 */
export async function seedUserData(
  userId: number,
  opts: { randomSeed?: number } = {},
): Promise<SeedResult> {
  const rand = makeRandom(opts.randomSeed ?? DEFAULT_SEED);
  const yuan = (min: number, max: number) => (min + Math.floor(rand() * (max - min + 1))) * 100;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

  const today = new Date();
  const todayStr = toLocalDate(today);
  const totalMonths = 14;

  return tx(async (client) => {
    const q = <T = Record<string, unknown>>(sql: string, params: SqlValue[] = []) =>
      client.query(sql, params).then((r) => r.rows as T[]);

    const accountIds = new Map<string, number>();
    const categoryIds = new Map<string, number>();
    let txCount = 0;
    let topUpCount = 0;

    // --- 账户 ---
    for (const a of ACCOUNTS) {
      const acc = await createAccount({
        name: a.name,
        type: a.type,
        initialBalanceCents: a.initial,
        userId,
      });
      accountIds.set(a.name, acc.id);
    }

    // --- 分类 ---
    const mkCategory = (name: string, kind: 'expense' | 'income', icon: string, parentId: number | null) =>
      createCategory({ name, kind, parentId, icon, userId });

    for (const [name, cfg] of Object.entries(EXPENSE_CATEGORIES)) {
      categoryIds.set(name, await mkCategory(name, 'expense', cfg.icon, null));
    }
    for (const [name, cfg] of Object.entries(INCOME_CATEGORIES)) {
      categoryIds.set(name, await mkCategory(name, 'income', cfg.icon, null));
    }

    // 给"餐饮"加二级分类，演示 parent_id 自引用
    const foodParent = categoryIds.get('餐饮')!;
    for (const [name, icon] of [
      ['早餐', '🥐'],
      ['午餐', '🍚'],
      ['外卖', '🛵'],
    ] as const) {
      categoryIds.set(`餐饮/${name}`, await mkCategory(name, 'expense', icon, foodParent));
    }
    const trafficParent = categoryIds.get('交通')!;
    categoryIds.set('交通/打车', await mkCategory('打车', 'expense', '🚕', trafficParent));

    // -----------------------------------------------------------------------
    // 生成 14 个月的流水
    //
    // 仿真器要维护一个真实世界的不变量：**支付账户的余额不能变成负数**。
    // 第一版没管这件事，结果微信零钱和支付宝被刷成了 -1.2 万，数据一眼就假。
    // 所以这里边生成边跟踪余额，余额见底就从银行卡"转账"过去补充。
    // -----------------------------------------------------------------------
    const balance = new Map<string, number>();
    for (const a of ACCOUNTS) balance.set(a.name, a.initial);

    const pickPayAccount = (cents: number, candidates: readonly string[]) => {
      const affordable = candidates.filter((n) => (balance.get(n) ?? 0) >= cents);
      return affordable.length > 0 ? pick(affordable) : candidates[0];
    };

    for (let back = totalMonths - 1; back >= 0; back--) {
      const cursor = new Date(today.getFullYear(), today.getMonth() - back, 1);
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      const dateIn = (day: number) =>
        `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, daysInMonth)).padStart(2, '0')}`;

      const push = async (
        accountName: string,
        categoryKey: string,
        type: 'expense' | 'income',
        cents: number,
        day: number,
        note: string,
      ): Promise<boolean> => {
        const date = dateIn(day);
        // 本月只生成到今天，避免出现"未来的账"
        if (date > todayStr) return false;

        const amount = type === 'expense' ? -Math.abs(cents) : Math.abs(cents);
        await createTransaction(
          {
            accountId: accountIds.get(accountName)!,
            categoryId: categoryIds.get(categoryKey) ?? null,
            type,
            amountCents: amount,
            description: note,
            occurredOn: date,
          },
          userId,
        );
        balance.set(accountName, (balance.get(accountName) ?? 0) + amount);
        txCount += 1;
        return true;
      };

      // --- 固定收支 ---
      await push('招商银行卡', '工资', 'income', 15000_00, 10, `${year}年${month + 1}月工资`);
      await push('招商银行卡', '房租', 'expense', 2500_00, 5, `${month + 1}月房租`);

      // --- 按分类的随机消费 ---
      for (const [name, cfg] of Object.entries(EXPENSE_CATEGORIES)) {
        if (name === '房租') continue;
        const count = Math.max(1, Math.round(cfg.perMonth * (0.5 + rand())));
        for (let i = 0; i < count; i++) {
          const day = 1 + Math.floor(rand() * daysInMonth);
          const cents = yuan(cfg.min, cfg.max);

          let key = name;
          let note: string;
          if (name === '餐饮') {
            key = pick(['餐饮/早餐', '餐饮/午餐', '餐饮/外卖']);
            note = pick(FOOD_NOTES);
          } else if (name === '交通') {
            key = rand() < 0.3 ? '交通/打车' : '交通';
            note = pick(TRAFFIC_NOTES);
          } else if (name === '购物') {
            note = pick(SHOPPING_NOTES);
          } else if (name === '娱乐') {
            note = pick(FUN_NOTES);
          } else {
            note = pick(MISC_NOTES);
          }
          await push(pickPayAccount(cents, PAY_ACCOUNTS), key, 'expense', cents, day, note);
        }
      }

      // --- 非固定收入：有些月份没有，让数据更真实 ---
      if (rand() < 0.7) {
        const day = 15 + Math.floor(rand() * 10);
        await push(
          '招商银行卡',
          '兼职',
          'income',
          yuan(INCOME_CATEGORIES['兼职'].min, INCOME_CATEGORIES['兼职'].max),
          day,
          '接了个小项目',
        );
      }
      if (rand() < 0.8) {
        const day = 20 + Math.floor(rand() * 8);
        await push(
          '支付宝',
          '理财收益',
          'income',
          yuan(INCOME_CATEGORIES['理财收益'].min, INCOME_CATEGORIES['理财收益'].max),
          day,
          '基金收益到账',
        );
      }

      // --- 转账：钱包余额见底就从银行卡补一笔 ---
      // 转账不算收入也不算支出，所以它不影响月度汇总和分类统计 ——
      // 这正是我们要的：补钱不该被记成"赚了一笔"。
      for (const wallet of WALLET_ACCOUNTS) {
        const current = balance.get(wallet)!;
        if (current >= TOP_UP_THRESHOLD) continue;

        const topUp = TOP_UP_THRESHOLD - current + yuan(500, 1500);
        const day = 3 + Math.floor(rand() * 20);
        const date = dateIn(day);
        if (date > todayStr) continue;

        // 一次转账产生"两行相反数"，必须一起成功（这就是为什么要有事务）
        await createTransaction(
          {
            accountId: accountIds.get('招商银行卡')!,
            categoryId: null,
            type: 'transfer',
            amountCents: -topUp,
            description: `转到${wallet}`,
            occurredOn: date,
          },
          userId,
        );
        await createTransaction(
          {
            accountId: accountIds.get(wallet)!,
            categoryId: null,
            type: 'transfer',
            amountCents: topUp,
            description: '来自招商银行卡',
            occurredOn: date,
          },
          userId,
        );
        balance.set('招商银行卡', balance.get('招商银行卡')! - topUp);
        balance.set(wallet, current + topUp);
        txCount += 2;
        topUpCount += 1;
      }
    }

    void q; // 预留：需要直接写 SQL 时用它（绑定在事务 client 上）

    return {
      accounts: ACCOUNTS.length,
      categories: categoryIds.size,
      transactions: txCount,
      topUps: topUpCount,
    };
  });
}

// ===========================================================================
//  重置某个用户的数据
// ===========================================================================

/**
 * 把某个用户的数据清空并重新灌入示例数据。
 * 用在"演示数据被访客玩坏了，一键恢复"这个场景。
 *
 * 为什么用固定种子？见 DEFAULT_SEED 的说明 ——
 * 重置必须精确回到同一个初始状态，而不是"换一批数据"。
 */
export async function resetUserData(userId: number): Promise<SeedResult> {
  await tx(async (client) => {
    // 顺序无关紧要（外键都是 CASCADE），但显式删一遍更清楚。
    // $1 在每个语句里都指向同一个 userId。
    await client.query(`DELETE FROM transactions WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM categories WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM accounts WHERE user_id = $1`, [userId]);
  });

  return seedUserData(userId, { randomSeed: DEFAULT_SEED });
}

/** 某个用户当前有多少数据（判断要不要灌） */
export async function countUserData(userId: number): Promise<{ accounts: number; transactions: number }> {
  const accounts = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM accounts WHERE user_id = $1`,
    [userId],
  );
  const transactions = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1`,
    [userId],
  );
  return { accounts: accounts?.n ?? 0, transactions: transactions?.n ?? 0 };
}

// ===========================================================================
//  命令行入口：node src/server/db/seed.pg.ts
// ===========================================================================

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const { closePool } = await import('./pg.ts');

  const demo = await get<{ id: number; name: string }>(
    `SELECT id::int, name FROM users WHERE is_demo = true ORDER BY id LIMIT 1`,
  );

  if (!demo) {
    console.error('找不到演示账号。请先执行迁移：npm run db:migrate');
    await closePool();
    process.exit(1);
  }

  const existing = await countUserData(demo.id);
  const force = process.argv.includes('--force');

  if (existing.transactions > 0 && !force) {
    console.log(`演示账号（${demo.name}）已经有 ${existing.transactions} 笔流水了。`);
    console.log('如需重新生成，请执行：npm run db:seed -- --force');
    await closePool();
    process.exit(0);
  }

  if (existing.transactions > 0 && force) {
    console.log('检测到 --force，先清空再重新生成…');
    await run(`DELETE FROM transactions WHERE user_id = $1`, [demo.id]);
    await run(`DELETE FROM categories WHERE user_id = $1`, [demo.id]);
    await run(`DELETE FROM accounts WHERE user_id = $1`, [demo.id]);
  }

  // 用 getConnectionString() 而不是直接读 DATABASE_URL ——
  // 否则跑测试脚本时会显示错误的库名（见 schema.pg.ts 里的踩坑说明）
  const { getConnectionString } = await import('./pg.ts');
  const host = getConnectionString().replace(/:\/\/[^@]+@/, '://***@').split('?')[0];
  console.log(`开始为演示账号（id=${demo.id}）生成示例数据…`);
  console.log(`  目标库：${host}`);

  const result = await seedUserData(demo.id);
  console.log(`  （仿真器补了 ${result.topUps} 次钱包余额，所以数据里会有转账记录）`);

  const stats = await get<{
    total: number;
    expenses: number;
    incomes: number;
    transfers: number;
    first_day: string;
    last_day: string;
  }>(
    `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN type = 'expense' THEN 1 ELSE 0 END)::int AS expenses,
            SUM(CASE WHEN type = 'income' THEN 1 ELSE 0 END)::int AS incomes,
            SUM(CASE WHEN type = 'transfer' THEN 1 ELSE 0 END)::int AS transfers,
            to_char(MIN(occurred_on), 'YYYY-MM-DD') AS first_day,
            to_char(MAX(occurred_on), 'YYYY-MM-DD') AS last_day
       FROM transactions WHERE user_id = $1`,
    [demo.id],
  );

  console.log('\n生成完成：');
  console.log(
    `  流水 ${stats!.total} 笔（支出 ${stats!.expenses} / 收入 ${stats!.incomes} / 转账 ${stats!.transfers}）`,
  );
  console.log(`  时间范围：${stats!.first_day} ~ ${stats!.last_day}`);

  console.log('\n账户余额（由触发器自动维护）：');
  for (const a of await listAccounts(demo.id)) {
    console.log(
      `  ${a.name.padEnd(12, '　')} ${(a.balanceCents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元`,
    );
  }

  const drift = await checkBalanceDrift(demo.id);
  if (drift.length === 0) {
    console.log('\n对账检查通过：触发器维护的余额与实时计算结果完全一致 ✓');
  } else {
    console.error('\n⚠️ 发现余额漂移：', drift);
  }

  const fmt = (cents: number) => `${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元`;
  const thisMonth = toLocalDate(new Date()).slice(0, 7);
  const summary = await getMonthlySummary({ month: thisMonth, userId: demo.id });
  console.log(`\n${thisMonth} 月度汇总：`);
  console.log(
    `  收入 ${fmt(summary.incomeCents)}   支出 ${fmt(summary.expenseCents)}   结余 ${fmt(summary.netCents)}`,
  );

  const expenseStats = await getCategoryStats({ month: thisMonth, kind: 'expense', userId: demo.id });
  console.log(`\n${thisMonth} 支出分类排行（转账不计入）：`);
  for (const s of expenseStats.slice(0, 6)) {
    const bar = '█'.repeat(Math.max(1, Math.round(s.ratio * 24)));
    console.log(
      `  ${(s.icon ?? '') + s.name}`.padEnd(10, '　') + `${bar} ${(s.ratio * 100).toFixed(1)}%  ${fmt(s.totalCents)}`,
    );
  }

  const trend = await getTrend({ months: 6, userId: demo.id });
  console.log(`\n最近 ${trend.length} 个月趋势：`);
  for (const t of trend) {
    console.log(
      `  ${t.month}  收入 ${fmt(t.incomeCents).padStart(14)}  支出 ${fmt(t.expenseCents).padStart(14)}  ${t.txCount} 笔`,
    );
  }

  console.log('\n下一步：npm run dev');
  await closePool();
}
