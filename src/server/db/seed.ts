/**
 * ---------------------------------------------------------------------------
 * 示例数据生成器
 * ---------------------------------------------------------------------------
 * 生成 14 个月的仿真记账数据（约 600 笔流水、4 个账户、16 个分类）。
 *
 * 为什么需要它：表建好后是空的，报表和图表的 SQL 跑出来全是 0，看不出对错。
 * 有一批形状真实的数据（多账户、多分类、跨月、含转账、有收入有支出），
 * 你才能验证 SQL 到底算对了没有。
 *
 * 三个刻意的设计：
 *   1. **可复现的伪随机**（固定种子），每次生成的数据完全一样。
 *      这样你改 SQL 前后能对比结果；否则数据一直在变，根本没法判断对错。
 *   2. **不直接 INSERT，而是复用查询层的 createTransaction**。
 *      数据流和运行时完全一致，触发器照常工作。
 *      如果 seed 绕开触发器写库，之后的余额就会漂移。
 *   3. **按用户灌数据**（seedUserData(db, userId)）。
 *      这样"重置演示数据"只要把该用户的数据删掉再灌一次就行，
 *      不会碰到其他用户的真实数据。
 */

import { getDb, get, run, tx } from './index.ts';
import type { Db } from './index.ts';
import {
  createAccount,
  createCategory,
  createTransaction,
  listAccounts,
  checkBalanceDrift,
  getMonthlySummary,
  getCategoryStats,
  getTrend,
} from './queries.ts';
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

/** 支出主要走这几个账户 */
const PAY_ACCOUNTS = ['微信零钱', '支付宝', '招商银行卡'] as const;

/** 需要"从银行卡补钱"的钱包（现金钱包自给自足，不用补） */
const WALLET_ACCOUNTS = ['微信零钱', '支付宝'] as const;

/** 钱包余额低于这个值（分）就从银行卡转账补充 */
const TOP_UP_THRESHOLD = 300_00;

// ===========================================================================
//  给某个用户灌数据
// ===========================================================================

/** 随机种子。固定值 = 每次生成的数据完全一样（可复现） */
const DEFAULT_SEED = 20240301;

export interface SeedResult {
  accounts: number;
  categories: number;
  transactions: number;
  /** 仿真器中途补了几次钱包余额（这些会产生 transfer 流水） */
  topUps: number;
}

/**
 * 给指定用户生成一整套示例数据。
 *
 * 整个生成过程包在一个事务里：中途出错就全部回滚，
 * 不会留下"账户建了但流水只灌了一半"的残缺数据。
 */
export function seedUserData(db: Db, userId: number, opts: { randomSeed?: number } = {}): SeedResult {
  const rand = makeRandom(opts.randomSeed ?? DEFAULT_SEED);

  /** 在 [min, max] 之间取整数元，返回"分" */
  const yuan = (min: number, max: number) => (min + Math.floor(rand() * (max - min + 1))) * 100;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

  const accountIds = new Map<string, number>();
  const categoryIds = new Map<string, number>();
  let txCount = 0;
  let topUpCount = 0;

  tx(db, () => {
    // --- 账户 ---
    for (const a of ACCOUNTS) {
      const acc = createAccount(db, {
        name: a.name,
        type: a.type,
        initialBalanceCents: a.initial,
        userId,
      });
      accountIds.set(a.name, acc.id);
    }

    // --- 分类 ---
    for (const [name, cfg] of Object.entries(EXPENSE_CATEGORIES)) {
      categoryIds.set(name, createCategory(db, { name, kind: 'expense', parentId: null, icon: cfg.icon, userId }));
    }
    for (const [name, cfg] of Object.entries(INCOME_CATEGORIES)) {
      categoryIds.set(name, createCategory(db, { name, kind: 'income', parentId: null, icon: cfg.icon, userId }));
    }

    // 给"餐饮"加二级分类，演示 parent_id 自引用
    const foodParent = categoryIds.get('餐饮')!;
    for (const [name, icon] of [
      ['早餐', '🥐'],
      ['午餐', '🍚'],
      ['外卖', '🛵'],
    ] as const) {
      categoryIds.set(`餐饮/${name}`, createCategory(db, { name, kind: 'expense', parentId: foodParent, icon, userId }));
    }
    // 给"交通"加二级分类
    const trafficParent = categoryIds.get('交通')!;
    categoryIds.set(
      '交通/打车',
      createCategory(db, { name: '打车', kind: 'expense', parentId: trafficParent, icon: '🚕', userId }),
    );

    // -----------------------------------------------------------------------
    // 生成 14 个月的流水
    //
    // 仿真器要维护一个真实世界的不变量：**支付账户的余额不能变成负数**。
    // 第一版没管这件事，结果微信零钱和支付宝被刷成了 -1.2 万，数据一眼就假。
    // 所以这里边生成边跟踪余额，余额见底就从银行卡"转账"过去补充 ——
    // 这也顺便让转账数据变得有意义（而不是硬塞两行假数据）。
    // -----------------------------------------------------------------------
    const today = new Date();
    const todayStr = toLocalDate(today);
    const totalMonths = 14;

    /** 跟数据库触发器同步维护的余额快照 */
    const balance = new Map<string, number>();
    for (const a of ACCOUNTS) balance.set(a.name, a.initial);

    /** 要花这笔钱，从哪儿付？优先挑余额够的账户 */
    const pickPayAccount = (cents: number, candidates: readonly string[]) => {
      const affordable = candidates.filter((n) => (balance.get(n) ?? 0) >= cents);
      return affordable.length > 0 ? pick(affordable) : candidates[0];
    };

    for (let back = totalMonths - 1; back >= 0; back--) {
      const cursor = new Date(today.getFullYear(), today.getMonth() - back, 1);
      const year = cursor.getFullYear();
      const month = cursor.getMonth(); // 0-11
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      const dateIn = (day: number) =>
        `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, daysInMonth)).padStart(2, '0')}`;

      /** 记一笔账并同步余额快照。返回是否真的写入（本月未来的日期会跳过） */
      const push = (
        accountName: string,
        categoryKey: string,
        type: 'expense' | 'income',
        cents: number,
        day: number,
        note: string,
      ): boolean => {
        const date = dateIn(day);
        // 本月只生成到今天，避免出现"未来的账"
        if (date > todayStr) return false;

        const amount = type === 'expense' ? -Math.abs(cents) : Math.abs(cents);
        createTransaction(
          db,
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
      push('招商银行卡', '工资', 'income', 15000_00, 10, `${year}年${month + 1}月工资`);
      push('招商银行卡', '房租', 'expense', 2500_00, 5, `${month + 1}月房租`);

      // --- 按分类的随机消费 ---
      for (const [name, cfg] of Object.entries(EXPENSE_CATEGORIES)) {
        if (name === '房租') continue; // 已经单独生成
        // 笔数波动 ±50%，避免每个月长得一模一样
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
          push(pickPayAccount(cents, PAY_ACCOUNTS), key, 'expense', cents, day, note);
        }
      }

      // --- 非固定收入：有些月份没有，让数据更真实 ---
      if (rand() < 0.7) {
        const day = 15 + Math.floor(rand() * 10);
        push(
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
        push(
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

        // 补到"阈值 + 随机缓冲"，避免下个月又立刻见底
        const topUp = TOP_UP_THRESHOLD - current + yuan(500, 1500);
        const day = 3 + Math.floor(rand() * 20);
        const date = dateIn(day);
        if (date > todayStr) continue;

        // 一次转账产生"两行相反数"，必须一起成功（这就是为什么要有事务）
        createTransaction(
          db,
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
        createTransaction(
          db,
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
  });

  return {
    accounts: ACCOUNTS.length,
    categories: categoryIds.size,
    transactions: txCount,
    topUps: topUpCount,
  };
}

// ===========================================================================
//  重置某个用户的数据
// ===========================================================================

/**
 * 把某个用户的数据清空并重新灌入示例数据。
 *
 * 用在"演示数据被访客玩坏了，一键恢复"这个场景。
 *
 * 删除顺序很重要：categories 被 transactions 引用，accounts 也被引用。
 * 不过这里其实**顺序无关紧要**，因为外键都配了 ON DELETE CASCADE ——
 * 删 users 一行就会级联删掉该用户的所有账户、分类、流水。
 *
 * 那为什么不直接删用户再重建？因为会话（sessions）里存着 user_id，
 * 删用户会把当前访客的登录状态一起干掉，他会莫名其妙被登出。
 * 所以这里保留用户行，只清业务数据。
 *
 * ⚠️ 重置必须用**固定的随机种子**。
 *    第一版我让它每次重新随机生成，后果是：
 *      - 每次重置后的笔数都不一样（639 / 642 / 640…），
 *        "恢复数据"变成了"换一批数据"，语义上就不对了
 *      - 测试里"重置后笔数应回到原值"这条断言会随机失败（flaky）
 *      - 访客每次看到的报表分布都不同，反而让人怀疑是不是坏了
 *    固定种子后，重置 = 精确回到同一个初始状态，这才是"恢复出厂设置"。
 */
export function resetUserData(db: Db, userId: number): SeedResult {
  tx(db, () => {
    // transactions 会被 accounts / categories 的级联删除带走，
    // 但显式删一遍更清楚，也不依赖级联行为。
    run(db, `DELETE FROM transactions WHERE user_id = ?`, userId);
    run(db, `DELETE FROM categories WHERE user_id = ?`, userId);
    run(db, `DELETE FROM accounts WHERE user_id = ?`, userId);
  });

  // 和 CLI 首次灌数据用同一个种子，保证"重置后"与"首次生成"完全一致
  return seedUserData(db, userId, { randomSeed: DEFAULT_SEED });
}

/** 某个用户当前有多少数据（判断要不要灌） */
export function countUserData(db: Db, userId: number): { accounts: number; transactions: number } {
  const accounts = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?`, userId);
  const transactions = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?`, userId);
  return { accounts: accounts?.n ?? 0, transactions: transactions?.n ?? 0 };
}

// ===========================================================================
//  命令行入口：node src/server/db/seed.ts
// ===========================================================================

/**
 * 判断当前模块是不是被直接执行的。
 *
 * 为什么要这个判断？因为 api.ts 会 `import { resetUserData } from './seed.ts'`
 * 来支持"重置演示数据"接口。如果本文件一被导入就执行下面的 CLI 逻辑，
 * 那么服务器启动时就会顺手灌一遍数据 —— 那是灾难性的副作用。
 *
 * ⚠️ 这里有个 Windows 特有的坑：
 *   我第一版写的是 `import.meta.url === \`file://${process.argv[1].replace(/\\\\/g, '/')}\``，
 *   看起来合理，但拼出来的字符串是 `file://D:/...`（主机名成了 "D"），
 *   而 `import.meta.url` 是 `file:///D:/...`（三个斜杠）。
 *   两者永远不相等，于是 CLI 部分**静默不执行**（什么都不打印、退出码 0）——
 *   这种"不报错但也不干活"的 bug 最难发现。
 *   正确做法是用 pathToFileURL 让 Node 自己处理平台差异。
 */
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const db = getDb();

  // 找演示账号（migration 001 会创建它）
  const demo = get<{ id: number; name: string }>(
    db,
    `SELECT id, name FROM users WHERE is_demo = 1 ORDER BY id LIMIT 1`,
  );

  if (!demo) {
    console.error('找不到演示账号。请先执行迁移：npm run db:migrate');
    db.close();
    process.exit(1);
  }

  const existing = countUserData(db, demo.id);
  if (existing.transactions > 0) {
    console.log(`演示账号（${demo.name}）已经有 ${existing.transactions} 笔流水了。`);
    console.log('如需重新生成，请执行：npm run db:seed -- --force');
    if (!process.argv.includes('--force')) {
      db.close();
      process.exit(0);
    }
    console.log('检测到 --force，先清空再重新生成…');
    run(db, `DELETE FROM transactions WHERE user_id = ?`, demo.id);
    run(db, `DELETE FROM categories WHERE user_id = ?`, demo.id);
    run(db, `DELETE FROM accounts WHERE user_id = ?`, demo.id);
  }

  console.log(`开始为演示账号（id=${demo.id}）生成示例数据…`);
  const result = seedUserData(db, demo.id);
  console.log(`  （仿真器补了 ${result.topUps} 次钱包余额，所以数据里会有转账记录）`);

  const stats = get<{
    total: number;
    expenses: number;
    incomes: number;
    transfers: number;
    first_day: string;
    last_day: string;
  }>(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN type = 'expense' THEN 1 ELSE 0 END) AS expenses,
            SUM(CASE WHEN type = 'income' THEN 1 ELSE 0 END) AS incomes,
            SUM(CASE WHEN type = 'transfer' THEN 1 ELSE 0 END) AS transfers,
            MIN(occurred_on) AS first_day,
            MAX(occurred_on) AS last_day
       FROM transactions WHERE user_id = ?`,
    demo.id,
  )!;

  console.log('\n生成完成：');
  console.log(
    `  流水 ${stats.total} 笔（支出 ${stats.expenses} / 收入 ${stats.incomes} / 转账 ${stats.transfers}）`,
  );
  console.log(`  时间范围：${stats.first_day} ~ ${stats.last_day}`);

  console.log('\n账户余额（由触发器自动维护）：');
  for (const a of listAccounts(db, demo.id)) {
    console.log(
      `  ${a.name.padEnd(12, '　')} ${(a.balanceCents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元`,
    );
  }

  const drift = checkBalanceDrift(db, demo.id);
  if (drift.length === 0) {
    console.log('\n对账检查通过：触发器维护的余额与实时计算结果完全一致 ✓');
  } else {
    console.error('\n⚠️ 发现余额漂移：', drift);
  }

  const fmt = (cents: number) => `${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元`;
  const thisMonth = toLocalDate(new Date()).slice(0, 7);
  const summary = getMonthlySummary(db, { month: thisMonth, userId: demo.id });
  console.log(`\n${thisMonth} 月度汇总：`);
  console.log(`  收入 ${fmt(summary.incomeCents)}   支出 ${fmt(summary.expenseCents)}   结余 ${fmt(summary.netCents)}`);

  const expenseStats = getCategoryStats(db, { month: thisMonth, kind: 'expense', userId: demo.id });
  console.log(`\n${thisMonth} 支出分类排行（转账不计入）：`);
  for (const s of expenseStats.slice(0, 6)) {
    const bar = '█'.repeat(Math.max(1, Math.round(s.ratio * 24)));
    console.log(`  ${(s.icon ?? '') + s.name}`.padEnd(10, '　') + `${bar} ${(s.ratio * 100).toFixed(1)}%  ${fmt(s.totalCents)}`);
  }

  const trend = getTrend(db, { months: 6, userId: demo.id });
  console.log(`\n最近 ${trend.length} 个月趋势：`);
  for (const t of trend) {
    console.log(`  ${t.month}  收入 ${fmt(t.incomeCents).padStart(14)}  支出 ${fmt(t.expenseCents).padStart(14)}  ${t.txCount} 笔`);
  }

  console.log('\n下一步：npm run dev');
  db.close();
}
