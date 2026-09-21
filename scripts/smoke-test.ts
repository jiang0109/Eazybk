/**
 * ---------------------------------------------------------------------------
 * API 冒烟测试（PostgreSQL 版）
 * ---------------------------------------------------------------------------
 *   npm run test:api        （用 .env.test 里的 ledger_test 库）
 *
 * 这不只是"接口能通"的测试，重点在**安全边界**：
 *   - 未登录时所有业务接口必须拒绝
 *   - A 用户不能读、改、删 B 用户的数据（IDOR 防御）
 *   - 密码哈希、会话撤销、登录限流是否真的生效
 *
 * 这些断言的价值在于：多用户系统出问题时，症状往往是"某个人看到了别人的数据"
 * 这种静默错误 —— 它不会报错、不会崩溃，只会悄悄泄露。
 * 所以必须用自动化的方式把它们盯住。
 *
 * 迁移说明：这个文件从 SQLite 版改过来，改动主要是
 *   1. 直接查库的地方从 db.prepare(...) 改成 await get/run(...)
 *   2. 断言里的 boolean 字段：SQLite 是 0/1，PG 是 true/false
 *   3. 最后要 closePool()，否则进程不退出
 * 断言本身一条没改 —— 这也说明"测试是迁移的安全网"这个说法是实在的。
 */

import { handleApiRequest } from '../src/server/api.ts';
import { get, run, closePool } from '../src/server/db/pg.ts';
import { SESSION_COOKIE } from '../src/server/auth/cookies.ts';

let passed = 0;
let failed = 0;

interface CallResult {
  status: number;
  data: any;
  cookie: string | null;
}

/** 发一个请求。cookie 用来模拟"已登录的浏览器" */
async function call(method: string, path: string, body?: unknown, cookie?: string | null): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;

  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleApiRequest(req, new URL(`http://localhost${path}`));
  const text = await res.text();

  // 从 Set-Cookie 里抽出会话 cookie，后续请求带上它
  const setCookie = res.headers.get('set-cookie');
  const sessionCookie = setCookie ? setCookie.split(';')[0] : null;

  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, cookie: sessionCookie };
}

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
  }
}

/**
 * 记录测试开始前的用户数，最后用它验证"清理干净了"。
 *
 * 为什么不写死一个数字（比如 2）？
 *   因为用户数取决于数据库是怎么来的：
 *     - 全新库（CI 就是这样）：只有 db:init 建的演示账号 → 1 个
 *     - 从旧版本迁移过来的库：可能还有迁移前的遗留用户 → 2 个
 *   我第一次写成了 `=== 2`，本地全绿，但在干净库上跑就失败。
 *   **这正是 CI 的意义**：它暴露了"只在我的机器上成立"的假设。
 */
const usersBeforeTest = (await get<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users`))!.n;

console.log(`\n测试库用户数（基准）：${usersBeforeTest}`);

// ===========================================================================
console.log('\n=== 1. 未登录时必须全部拒绝 ===');
// ===========================================================================
// 这是最重要的一组断言。默认拒绝（deny by default）如果实现错了，
// 界面看起来完全正常，但数据已经对外敞开了。

const guarded: [string, string][] = [
  ['GET', '/api/accounts'],
  ['GET', '/api/categories'],
  ['GET', '/api/transactions'],
  ['GET', '/api/balance'],
  ['GET', '/api/months'],
  ['GET', '/api/summary'],
  ['GET', '/api/stats/categories'],
  ['GET', '/api/stats/trend'],
  ['GET', '/api/stats/compare'],
  ['GET', '/api/health/balance'],
  ['POST', '/api/transactions'],
  ['POST', '/api/transfers'],
  ['POST', '/api/categories'],
  ['POST', '/api/accounts'],
];

for (const [method, path] of guarded) {
  const res = await call(method, path, method === 'POST' ? {} : undefined);
  check(`未登录 ${method} ${path} → 401`, res.status === 401, res);
}

const meAnon = await call('GET', '/api/auth/me');
check('未登录 GET /api/auth/me → 200 且 user 为 null', meAnon.status === 200 && meAnon.data.user === null, meAnon);

// ===========================================================================
console.log('\n=== 2. 注册与登录 ===');
// ===========================================================================

const uniqueName = `tester_${Date.now().toString(36)}`;
const password = 'test-password-123';

const weak = await call('POST', '/api/auth/register', { username: uniqueName, password: '123' });
check('密码太短被拒绝', weak.status === 400, weak);

const badName = await call('POST', '/api/auth/register', { username: 'a b!', password });
check('非法用户名被拒绝', badName.status === 400, badName);

const reserved = await call('POST', '/api/auth/register', { username: 'demo', password });
check('保留用户名 demo 不能被注册', reserved.status === 409, reserved);

const reg = await call('POST', '/api/auth/register', { username: uniqueName, password, name: '测试用户' });
check('注册成功并返回用户', reg.status === 200 && reg.data.user?.username === uniqueName, reg);
check('注册响应带会话 cookie', Boolean(reg.cookie), reg.cookie);
check('注册响应**不含**密码哈希', !JSON.stringify(reg.data).includes('scrypt'), reg.data);

const userAId = reg.data.user.id as number;

// 密码哈希是否真的落库、且不是明文
const stored = await get<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userAId]);
check('数据库里存的是 scrypt 哈希', stored!.password_hash.startsWith('scrypt$'), stored!.password_hash.slice(0, 20));
check('数据库里**没有**明文密码', !stored!.password_hash.includes(password), null);

const dup = await call('POST', '/api/auth/register', { username: uniqueName, password });
check('重复用户名被拒绝', dup.status === 409, dup);

const wrongPass = await call('POST', '/api/auth/login', { username: uniqueName, password: 'wrong-password' });
check('错误密码被拒绝', wrongPass.status === 401, wrongPass);

const noSuchUser = await call('POST', '/api/auth/login', { username: 'nobody_here', password });
check(
  '不存在的用户返回**同样**的报错（不泄露用户名是否存在）',
  noSuchUser.status === 401 && noSuchUser.data.error === wrongPass.data.error,
  { noSuchUser: noSuchUser.data, wrongPass: wrongPass.data },
);

const loginOk = await call('POST', '/api/auth/login', { username: uniqueName, password });
check('正确密码登录成功', loginOk.status === 200 && loginOk.data.user.id === userAId, loginOk);
const cookieA2 = loginOk.cookie;

const demoPassLogin = await call('POST', '/api/auth/login', { username: 'demo', password: 'anything' });
check('演示账号不能用密码登录', demoPassLogin.status === 403, demoPassLogin);

// ===========================================================================
console.log('\n=== 3. 一键体验与退出登录 ===');
// ===========================================================================

const demoLogin = await call('POST', '/api/auth/demo');
check('一键体验成功', demoLogin.status === 200 && demoLogin.data.user.isDemo === true, demoLogin);
const demoCookie = demoLogin.cookie;

const demoMe = await call('GET', '/api/auth/me', undefined, demoCookie);
check('演示会话有效', demoMe.data.user?.isDemo === true, demoMe);

const logout = await call('POST', '/api/auth/logout', undefined, cookieA2);
check('退出登录返回 200', logout.status === 200, logout);

const afterLogout = await call('GET', '/api/accounts', undefined, cookieA2);
check('退出后旧会话立即失效（这就是选数据库会话而不是 JWT 的原因）', afterLogout.status === 401, afterLogout);

const fakeCookie = `${SESSION_COOKIE}=totally-made-up-token`;
const forged = await call('GET', '/api/accounts', undefined, fakeCookie);
check('伪造的会话令牌无法通过', forged.status === 401, forged);

const tampered = await call('GET', '/api/accounts', undefined, `${SESSION_COOKIE}=${'a'.repeat(43)}`);
check('随机猜测的令牌无法通过', tampered.status === 401, tampered);

// ===========================================================================
console.log('\n=== 4. 演示账号有数据、新用户是空的 ===');
// ===========================================================================

const demoAccounts = await call('GET', '/api/accounts', undefined, demoCookie);
check('演示账号能看到 4 个账户', demoAccounts.data.length === 4, demoAccounts.data?.length);

const demoBalance = await call('GET', '/api/balance', undefined, demoCookie);
check('演示账号余额不为 0', demoBalance.data.totalBalanceCents !== 0, demoBalance.data?.totalBalanceCents);

const freshAccounts = await call('GET', '/api/accounts', undefined, reg.cookie);
check(
  '新注册用户看不到任何账户（全新账号）',
  Array.isArray(freshAccounts.data) && freshAccounts.data.length === 0,
  freshAccounts.data,
);

const freshTx = await call('GET', '/api/transactions', undefined, reg.cookie);
check('新注册用户的流水为 0 笔', freshTx.data.total === 0, freshTx.data);

// ===========================================================================
console.log('\n=== 5. 多用户数据隔离（最关键的测试）===');
// ===========================================================================
// 模拟一次真实的越权攻击：B 用户拿到 A 用户的资源 id，尝试直接访问。

const accA = await call(
  'POST',
  '/api/accounts',
  { name: 'A的银行卡', type: 'bank', initialBalance: '1000' },
  reg.cookie,
);
check('A 创建账户成功', accA.status === 200, accA);
const accountAId = accA.data.id as number;

const catA = await call(
  'POST',
  '/api/categories',
  { name: 'A的分类', kind: 'expense', parentId: null, icon: '🔒' },
  reg.cookie,
);
check('A 创建分类成功', catA.status === 200, catA);
const categoryAId = catA.data.id as number;

const txA = await call(
  'POST',
  '/api/transactions',
  {
    accountId: accountAId,
    categoryId: categoryAId,
    type: 'expense',
    amount: '100',
    description: 'A的支出',
    occurredOn: '2026-01-15',
  },
  reg.cookie,
);
check('A 记账成功', txA.status === 200, txA);
const txAId = txA.data.id as number;

// 建第二个用户 B
const nameB = `attacker_${Date.now().toString(36)}`;
const regB = await call('POST', '/api/auth/register', { username: nameB, password, name: '测试用户B' });
const cookieB = regB.cookie;
check('B 注册成功', regB.status === 200, regB);

// B 试图用 A 的 id 操作 —— 全部必须失败
const bReadTx = await call('GET', '/api/transactions', undefined, cookieB);
check('B 的流水列表里没有 A 的记录', bReadTx.data.total === 0, bReadTx.data);

const bInsertWithAAccount = await call(
  'POST',
  '/api/transactions',
  { accountId: accountAId, categoryId: null, type: 'expense', amount: '50', description: '越权尝试', occurredOn: '2026-01-16' },
  cookieB,
);
check(
  'B 不能用 A 的账户记账',
  bInsertWithAAccount.status === 400 || bInsertWithAAccount.status === 401,
  bInsertWithAAccount,
);

const bUpdateATx = await call(
  'PATCH',
  `/api/transactions/${txAId}`,
  {
    accountId: accountAId,
    categoryId: categoryAId,
    type: 'expense',
    amount: '9999',
    description: '被篡改',
    occurredOn: '2026-01-15',
  },
  cookieB,
);
check('B 不能修改 A 的流水', bUpdateATx.status === 404 || bUpdateATx.status === 400, bUpdateATx);

const bDeleteATx = await call('DELETE', `/api/transactions/${txAId}`, undefined, cookieB);
check('B 不能删除 A 的流水', bDeleteATx.status === 404 || bDeleteATx.status === 400, bDeleteATx);

const bRenameACat = await call('PATCH', `/api/categories/${categoryAId}`, { name: '被改名了' }, cookieB);
check('B 不能改 A 的分类名', bRenameACat.status === 400 || bRenameACat.status === 404, bRenameACat);

const bDeleteACat = await call('DELETE', `/api/categories/${categoryAId}`, undefined, cookieB);
check('B 不能删 A 的分类', bDeleteACat.status === 400 || bDeleteACat.status === 404, bDeleteACat);

const bTransferFromAAccount = await call(
  'POST',
  '/api/transfers',
  { fromAccountId: accountAId, toAccountId: accountAId + 1, amount: '100', occurredOn: '2026-01-17' },
  cookieB,
);
check('B 不能从 A 的账户转账（否则等于偷钱）', bTransferFromAAccount.status === 400, bTransferFromAAccount);

// 关键验证：A 的数据在 B 的一系列攻击后**完全没有变化**
const aTxAfter = await call('GET', '/api/transactions', undefined, reg.cookie);
const aRow = aTxAfter.data.items.find((t: { id: number }) => t.id === txAId);
check('A 的流水仍然存在且金额未被篡改', aRow && aRow.amountCents === -10000, aRow);

const aCatAfter = await call('GET', '/api/categories', undefined, reg.cookie);
const catStillNamed = JSON.stringify(aCatAfter.data).includes('A的分类');
check('A 的分类名未被篡改', catStillNamed, null);

const aBalanceAfter = await call('GET', '/api/balance', undefined, reg.cookie);
const accABalance = aBalanceAfter.data.accounts.find((a: { id: number }) => a.id === accountAId)?.balanceCents;
check('A 的账户余额未被篡改（1000 元初始 - 100 元支出 = 90000 分）', accABalance === 90000, accABalance);

// ===========================================================================
console.log('\n=== 6. 演示数据重置 ===');
// ===========================================================================

const notDemoReset = await call('POST', '/api/auth/demo/reset', undefined, reg.cookie);
check('普通用户不能重置演示数据', notDemoReset.status === 403, notDemoReset);

// 演示账号先删一笔，再重置，看是否恢复
const demoTxBefore = await call('GET', '/api/transactions?limit=1', undefined, demoCookie);
const demoTxCountBefore = demoTxBefore.data.total as number;
await call('DELETE', `/api/transactions/${demoTxBefore.data.items[0].id}`, undefined, demoCookie);

const demoAfterDelete = await call('GET', '/api/transactions?limit=1', undefined, demoCookie);
check('演示账号可以删除自己的数据（演示才是真演示）', demoAfterDelete.data.total === demoTxCountBefore - 1, {
  before: demoTxCountBefore,
  after: demoAfterDelete.data.total,
});

const reset = await call('POST', '/api/auth/demo/reset', undefined, demoCookie);
check('演示账号重置成功', reset.status === 200 && reset.data.transactions > 0, reset);

const demoAfterReset = await call('GET', '/api/transactions?limit=1', undefined, demoCookie);
check('重置后数据恢复到完全相同的笔数（固定随机种子的意义）', demoAfterReset.data.total === demoTxCountBefore, {
  expected: demoTxCountBefore,
  actual: demoAfterReset.data.total,
});

const demoBalanceAfterReset = await call('GET', '/api/health/balance', undefined, demoCookie);
check('重置后余额没有漂移（触发器正确工作）', demoBalanceAfterReset.data.ok === true, demoBalanceAfterReset.data);

// 重置不能影响其他用户
const aStillThere = await call('GET', '/api/transactions', undefined, reg.cookie);
check('重置演示数据不影响其他用户的数据', aStillThere.data.total === 1, aStillThere.data.total);

// ===========================================================================
console.log('\n=== 7. 登录频率限制 ===');
// ===========================================================================

const rateUser = `ratelimit_${Date.now().toString(36)}`;
const rateReg = await call('POST', '/api/auth/register', { username: rateUser, password });
check('被限流的测试账号注册成功', rateReg.status === 200, rateReg);

let got429 = false;
let lastStatus = 0;
for (let i = 0; i < 8; i++) {
  const attempt = await call('POST', '/api/auth/login', { username: rateUser, password: 'definitely-wrong' });
  lastStatus = attempt.status;
  if (attempt.status === 429) {
    got429 = true;
    break;
  }
}
check(`连续失败后触发限流（最后一次状态码 ${lastStatus}）`, got429, { lastStatus });

// 清理限流记录，避免影响后续测试
await run(`DELETE FROM login_attempts WHERE username = $1`, [rateUser]);

// ===========================================================================
console.log('\n=== 8. 业务功能在登录后仍然正常 ===');
// ===========================================================================

const demoAccounts2 = await call('GET', '/api/accounts', undefined, demoCookie);
const demoAccountId = demoAccounts2.data[0].id as number;
const demoCats = await call('GET', '/api/categories', undefined, demoCookie);
const demoExpenseCat = demoCats.data.find((c: { kind: string }) => c.kind === 'expense');
const demoExpenseCatId = (demoExpenseCat.children?.[0]?.id ?? demoExpenseCat.id) as number;

const demoSummary = await call('GET', '/api/summary', undefined, demoCookie);
check('月度汇总正常', typeof demoSummary.data.incomeCents === 'number', demoSummary.data);

const demoStats = await call('GET', '/api/stats/categories?kind=expense', undefined, demoCookie);
const ratioSum = demoStats.data.items.reduce((s: number, i: { ratio: number }) => s + i.ratio, 0);
check('分类统计占比之和 ≈ 1', Math.abs(ratioSum - 1) < 0.001, ratioSum);

const demoRollup = await call('GET', '/api/stats/categories?kind=expense&rollup=1', undefined, demoCookie);
check('rollup 汇总正常', demoRollup.data.items.length <= demoStats.data.items.length, {
  rollup: demoRollup.data.items.length,
  plain: demoStats.data.items.length,
});

const demoMonths = await call('GET', '/api/months', undefined, demoCookie);
check('月份列表非空', Array.isArray(demoMonths.data) && demoMonths.data.length > 0, demoMonths.data?.length);

const demoCompare = await call('GET', '/api/stats/compare', undefined, demoCookie);
check('环比接口返回 diffRatio 字段（LAG 窗口函数）', demoCompare.data && 'diffRatio' in demoCompare.data, demoCompare.data);

const demoTrend = await call('GET', '/api/stats/trend?months=6', undefined, demoCookie);
check('趋势接口补齐 6 个月（generate_series）', demoTrend.data.length === 6, demoTrend.data?.length);

// 金额精度（这个 bug 以前犯过，留着防回归）
const precise = await call(
  'POST',
  '/api/transactions',
  {
    accountId: demoAccountId,
    categoryId: demoExpenseCatId,
    type: 'expense',
    amount: '19.99',
    description: '精度',
    occurredOn: '2026-01-15',
  },
  demoCookie,
);
const preciseRow = await get<{ amount_cents: number }>(
  `SELECT amount_cents FROM transactions WHERE id = $1`,
  [precise.data.id],
);
check('金额 19.99 元精确存成 -1999 分', preciseRow!.amount_cents === -1999, preciseRow);
check('金额从数据库读出来是 number（BIGINT 解析器生效）', typeof preciseRow!.amount_cents === 'number', preciseRow);

await call('DELETE', `/api/transactions/${precise.data.id}`, undefined, demoCookie);

const drift = await call('GET', '/api/health/balance', undefined, demoCookie);
check('全部操作后余额仍无漂移', drift.data.ok === true, drift.data);

// ===========================================================================
console.log('\n=== 清理测试数据 ===');
// ===========================================================================
// 按用户名前缀清理，而不是只删本次记住的那几个 id。
// 原因：如果某次运行中途断言失败，后面的清理代码就不会执行，
// 残留的测试用户会污染下一次运行。
const cleanup = await run(
  `DELETE FROM users
    WHERE username LIKE 'tester_%'
       OR username LIKE 'attacker_%'
       OR username LIKE 'ratelimit_%'`,
);
await run(`DELETE FROM login_attempts`);
console.log(`  已清理 ${cleanup.changes} 个测试用户及其数据（外键级联会带走账户/分类/流水/会话）`);

const remaining = await get<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users`);
check(
  `清理后用户数回到测试前的 ${usersBeforeTest} 个（没有残留测试账号）`,
  remaining!.n === usersBeforeTest,
  { before: usersBeforeTest, after: remaining!.n },
);

await closePool();

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
