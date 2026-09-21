/**
 * ---------------------------------------------------------------------------
 * HTTP API
 * ---------------------------------------------------------------------------
 * 这一层刻意做得很薄：只负责"解析参数 → 校验 → 调用 SQL → 返回 JSON"。
 *
 * 为什么业务逻辑不写在这里？
 * 因为一旦把计算写进 API 层，就会有人忍不住在接口里用 JS 算月支出、
 * 算分类占比 —— 那时候数据库就退化成文件柜了，"练数据库"也就无从谈起。
 * 所以规矩是：**能算的都让 SQL 算**，API 层只搬运数据。
 *
 * 迁移差异：所有 handler 变成 async（PG 是网络数据库）。
 * 这是本次迁移里波及最广的机械改动 —— 但也是最能体现"封装价值"的地方：
 * 因为 SQL 都集中在 queries 层，这里只需要加 await，不用改 SQL 逻辑。
 */

import { HttpError, getHeader, translateSqliteError, type ApiError } from './http.ts';
import { readJsonBody, asObject, asString, asInt, asEnum, asDate, optionalMonth, parseYuanToCents, TX_TYPES, CATEGORY_KINDS, ACCOUNT_TYPES } from './body.ts';
import { currentMonth } from './util.ts';
import * as q from './db/queries.pg.ts';
import * as auth from './auth/session.ts';
import { parseCookies, serializeSessionCookie, serializeClearCookie, SESSION_COOKIE, shouldUseSecureCookie } from './auth/cookies.ts';
import { requireOwnedAccount, requireOwnedCategory, requireOwnedCategoryWithParent, requireOwnedTransaction } from './auth/guard.ts';
import type { AuthUser } from './auth/session.ts';
import type { Category, TxType } from '../shared/types.ts';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface Ctx {
  /**
   * 当前登录用户。**只有公开路由**（登录/注册/一键体验）允许它是 null，
   * 其余路由在分发阶段就已经拦掉了未登录请求。
   */
  user: AuthUser | null;
  /** URL 路径参数，比如 /api/transactions/:id 里的 id（仍是字符串） */
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** 原始请求：cookie 等场景需要 */
  req: Request;
}

interface Route {
  method: Method;
  segments: string[];
  /** 是否允许未登录访问。默认 false —— 新增路由默认就是受保护的 */
  isPublic?: boolean;
  handler: (ctx: Ctx) => Promise<unknown> | unknown;
}

const routes: Route[] = [];
function route(
  method: Method,
  path: string,
  handler: (ctx: Ctx) => Promise<unknown> | unknown,
  opts: { isPublic?: boolean } = {},
) {
  routes.push({ method, segments: path.split('/').filter(Boolean), isPublic: opts.isPublic ?? false, handler });
}

/**
 * 取出当前用户，未登录直接 401。
 *
 * 为什么业务 handler 里要显式调用它，而不是靠 `ctx.user!`？
 *   因为 `!` 只是让 TypeScript 闭嘴，运行时并不检查。
 *   万一将来有人在分发逻辑里改了公开路由判断，非空断言会让一个未登录请求
 *   带着 user = null 走进业务代码，然后可能出现 `user.id` 报错（500）
 *   或者更糟 —— 被当成某个默认用户。显式抛 401 才是安全的失败方式。
 */
function currentUser(user: AuthUser | null): AuthUser {
  if (!user) throw new HttpError(401, '请先登录');
  return user;
}

/** 把路径规则和是否公开的对应关系集中列出，一眼能看清哪些接口不需要登录 */
export const PUBLIC_ROUTES = [
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/demo',
  'GET /api/auth/me',
  'POST /api/auth/logout',
] as const;

// ===========================================================================
//  辅助
// ===========================================================================

/** 把别名的字段名（snake_case）转成前端的 camelCase */
const yuan = (cents: number) => cents / 100;

/** 支出/收入的金额符号由 type 决定，前端只填正数 */
function signedAmount(type: TxType, cents: number): number {
  return type === 'expense' ? -Math.abs(cents) : Math.abs(cents);
}

/**
 * 校验分类与类型的匹配关系。
 *
 * 数据库里已经有 CHECK 约束挡着（转账不能有分类、收支必须有分类），
 * 那为什么这里还要再查一次？
 * 因为数据库查不到"这个分类是收入还是支出"，也查不到"它属不属于当前用户"。
 * 前者只有查一次 categories 表才知道，后者是权限问题。
 *
 * 分工是：数据库约束负责**最后一道防线**（谁也绕不过去），
 * 应用层负责**能给出好提示的第一道防线**。
 */
async function normalizeCategory(
  userId: number,
  type: TxType,
  categoryId: number | null,
): Promise<number | null> {
  if (type === 'transfer') {
    // 转账没有"花在哪儿"的概念。这里选择**明确拒绝**而不是静默丢掉分类：
    // 用户传了分类，说明请求本身自相矛盾，悄悄忽略会掩盖调用方的 bug。
    if (categoryId !== null) throw new HttpError(400, '转账不需要分类，请去掉分类后再试');
    return null;
  }

  if (categoryId === null) throw new HttpError(400, '请选择一个分类');

  // 注意用的是 requireOwnedCategory：它把 user_id 写进了 WHERE 条件，
  // 所以"别人的分类"会直接表现为"不存在"，而不是先查出来再判断。
  const row = await requireOwnedCategory(userId, categoryId);

  if (row.kind !== type) {
    const label = (k: string) => (k === 'income' ? '收入' : '支出');
    throw new HttpError(400, `分类类型不匹配：这是${label(row.kind)}分类，不能用于${label(type)}`);
  }
  return categoryId;
}

/**
 * 统一解析流水表单。
 * 新增和修改共用一套校验逻辑 —— 否则两边规则容易写得不一致（改的时候少校验一项）。
 */
async function parseTransactionInput(userId: number, body: unknown) {
  const o = asObject(body);

  const type = asEnum(o.type, '类型', TX_TYPES);
  const amountCents = parseYuanToCents(o.amount, '金额');
  const accountId = asInt(o.accountId, '账户', { min: 1 });

  // 账户必须属于当前用户（IDOR 防御）
  await requireOwnedAccount(userId, accountId);

  const categoryId =
    o.categoryId === null || o.categoryId === undefined ? null : asInt(o.categoryId, '分类', { min: 1 });

  return {
    type,
    amountCents: signedAmount(type, amountCents),
    accountId,
    // 转账时 normalizeCategory 会强制返回 null 并拒绝带分类的请求
    categoryId: await normalizeCategory(userId, type, categoryId),
    description: asString(o.description, '备注', { required: false, max: 200 }),
    occurredOn: asDate(o.occurredOn, '日期'),
  };
}

// ===========================================================================
//  认证
// ===========================================================================
//  只有这几个接口允许未登录访问。逻辑本身在 auth/session.ts 里，
//  这里只负责"解析表单 → 调用 → 设置/清除 cookie"。

/** 登录成功后统一套上会话 cookie */
async function withSessionCookie(user: AuthUser, req: Request): Promise<Response> {
  const token = await auth.createSession(user.id);
  const secure = shouldUseSecureCookie(req);

  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': serializeSessionCookie(token, { secure }),
    },
  });
}

route(
  'POST',
  '/api/auth/register',
  async ({ body, req }) => {
    const o = asObject(body);
    // 用户名规则：3-20 位，只允许字母数字下划线。
    // 限制字符集不只为了好看 —— 还顺便避免了各种同形字/空白字符混淆登录名的问题。
    const username = asString(o.username, '用户名', { max: 20 });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      throw new HttpError(400, '用户名需要 3-20 位，只能包含字母、数字和下划线');
    }

    const password = asString(o.password, '密码', { max: 72 });
    if (password.length < 8) throw new HttpError(400, '密码至少 8 位');

    const name = o.name === undefined || o.name === '' ? username : asString(o.name, '昵称', { max: 20 });

    const result = await auth.register({ name, username, password });
    if (!result.ok) {
      if (result.reason === 'username_taken_by_demo') {
        throw new HttpError(409, '这个用户名是保留的，请换一个');
      }
      throw new HttpError(409, '这个用户名已经被注册了');
    }

    // 注册后直接给会话，省掉"注册完再登录一次"的步骤
    return withSessionCookie(result.user, req);
  },
  { isPublic: true },
);

route(
  'POST',
  '/api/auth/login',
  async ({ body, req }) => {
    const o = asObject(body);
    const username = asString(o.username, '用户名', { max: 20 });
    const password = asString(o.password, '密码', { max: 72 });

    const result = await auth.login(username, password);

    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        throw new HttpError(429, `登录失败次数过多，请 ${result.retryAfterMinutes} 分钟后再试`);
      }
      if (result.reason === 'demo_not_allowed') {
        throw new HttpError(403, '演示账号不支持密码登录，请点「一键体验」进入');
      }
      // 统一的错误文案：不区分"用户不存在"和"密码错误"，
      // 否则等于免费告诉攻击者哪些用户名是有效的。
      throw new HttpError(401, '用户名或密码不正确');
    }

    return withSessionCookie(result.user, req);
  },
  { isPublic: true },
);

/** 一键体验：不校验任何凭据，直接以演示账号身份登录 */
route(
  'POST',
  '/api/auth/demo',
  async ({ req }) => {
    const demo = await auth.getDemoUser();
    if (!demo) throw new HttpError(503, '演示账号还没有初始化，请先执行 npm run db:seed');
    return withSessionCookie(demo, req);
  },
  { isPublic: true },
);

/** 当前登录状态。前端启动时用它判断该显示登录页还是主界面 */
route('GET', '/api/auth/me', ({ user }) => ({ user }), { isPublic: true });

route(
  'POST',
  '/api/auth/logout',
  async ({ req }) => {
    const token = parseCookies(getHeader(req, 'cookie'))[SESSION_COOKIE];
    await auth.destroySession(token);
    const secure = shouldUseSecureCookie(req);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': serializeClearCookie({ secure }),
      },
    });
  },
  { isPublic: true },
);

/**
 * 重置演示数据。
 *
 * 为什么需要它：演示账号可以随便增删改（不然访客体验不到功能），
 * 但被玩坏之后下一个访客打开就是空界面。这个接口把演示数据恢复原样。
 *
 * 两个安全限制：
 *   1. 只有演示账号能调用（拿自己的真实账号去重置别人的数据是绝对不行的）
 *   2. 重置在一个事务里完成 —— 中途失败不会留下"删了一半"的残缺数据
 */
route('POST', '/api/auth/demo/reset', async ({ user }) => {
  const me = currentUser(user);
  if (!me.isDemo) throw new HttpError(403, '只有演示账号可以重置演示数据');

  const { resetUserData } = await import('./db/seed.pg.ts');
  const result = await resetUserData(me.id);
  return { ok: true, ...result };
});

// ===========================================================================
//  账户
// ===========================================================================

route('GET', '/api/accounts', async ({ user }) => q.listAccounts(currentUser(user).id));

route('POST', '/api/accounts', async ({ user, body }) => {
  const me = currentUser(user);
  const o = asObject(body);
  const initialBalanceCents =
    o.initialBalance === undefined || o.initialBalance === ''
      ? 0
      : parseYuanToCents(o.initialBalance, '初始余额') * (o.initialBalanceNegative === true ? -1 : 1);

  return q.createAccount({
    name: asString(o.name, '账户名', { max: 30 }),
    type: asEnum(o.type, '账户类型', ACCOUNT_TYPES),
    initialBalanceCents,
    userId: me.id,
  });
});

// ===========================================================================
//  分类
// ===========================================================================

/** 分类在界面上的展示形态：一级分类带出它的子分类 */
interface CategoryNode extends Category {
  children: Category[];
}

route('GET', '/api/categories', async ({ user }) => {
  const all = await q.listCategories(currentUser(user).id);
  const roots = all.filter((c) => c.parentId === null);
  const nodes: CategoryNode[] = roots.map((r) => ({
    ...r,
    children: all.filter((c) => c.parentId === r.id),
  }));
  return nodes;
});

route('POST', '/api/categories', async ({ user, body }) => {
  const me = currentUser(user);
  const o = asObject(body);
  const kind = asEnum(o.kind, '分类类型', CATEGORY_KINDS);
  const parentId =
    o.parentId === null || o.parentId === undefined ? null : asInt(o.parentId, '父分类', { min: 1 });

  if (parentId !== null) {
    // 二级分类必须和父分类同类型（数据库触发器也会挡，这里给出更好的提示）。
    // requireOwnedCategoryWithParent 同时保证了父分类属于当前用户 ——
    // 否则就能把分类挂到别人的分类下面，制造出越权数据。
    const parent = await requireOwnedCategoryWithParent(me.id, parentId);
    if (parent.kind !== kind) throw new HttpError(400, '子分类的类型必须和父分类一致');
    if (parent.parentId !== null) throw new HttpError(400, '最多支持两级分类');
  }

  const id = await q.createCategory({
    name: asString(o.name, '分类名', { max: 20 }),
    kind,
    parentId,
    icon: o.icon === undefined || o.icon === null ? null : asString(o.icon, '图标', { required: false, max: 4 }),
    userId: me.id,
  });
  return { id };
});

route('PATCH', '/api/categories/:id', async ({ user, params, body }) => {
  const me = currentUser(user);
  const id = asInt(params.id, '分类 id', { min: 1 });
  // 先确认这个分类是我的，再改（否则能改别人的分类名）
  await requireOwnedCategory(me.id, id);

  const o = asObject(body);
  const icon = o.icon === undefined || o.icon === null ? null : asString(o.icon, '图标', { required: false, max: 4 });
  await q.renameCategory(id, asString(o.name, '分类名', { max: 20 }), icon);
  return { ok: true };
});

route('DELETE', '/api/categories/:id', async ({ user, params }) => {
  const me = currentUser(user);
  const id = asInt(params.id, '分类 id', { min: 1 });
  await requireOwnedCategory(me.id, id);

  const result = await q.deleteCategory(id);
  if (!result.ok) throw new HttpError(409, result.reason ?? '删除失败');
  return { ok: true };
});

// ===========================================================================
//  流水
// ===========================================================================

route('GET', '/api/transactions', async ({ user, query }) => {
  const me = currentUser(user);
  const filter: q.TxFilter = {
    month: optionalMonth(query.get('month')),
    type: query.get('type') ? asEnum(query.get('type'), '类型', TX_TYPES) : undefined,
    accountId: query.get('accountId') ? asInt(query.get('accountId'), '账户', { min: 1 }) : undefined,
    categoryId: query.get('categoryId') ? asInt(query.get('categoryId'), '分类', { min: 1 }) : undefined,
    keyword: query.get('keyword')?.trim() || undefined,
    limit: query.get('limit') ? asInt(query.get('limit'), 'limit', { min: 1, max: 500 }) : 50,
    offset: query.get('offset') ? asInt(query.get('offset'), 'offset', { min: 0 }) : 0,
  };

  // 两个查询并发跑：它们互不依赖，串行等待没有意义。
  // 在本地文件数据库上这点差异看不出来，但经过网络访问托管数据库时，
  // "并行两次往返"比"串行两次往返"能省掉一半延迟。
  const [items, total] = await Promise.all([
    q.listTransactions(filter, me.id),
    q.countTransactions(filter, me.id),
  ]);

  return { items, total };
});

route('POST', '/api/transactions', async ({ user, body }) => {
  const me = currentUser(user);
  const input = await parseTransactionInput(me.id, body);
  const id = await q.createTransaction(input, me.id);
  return { id };
});

route('PATCH', '/api/transactions/:id', async ({ user, params, body }) => {
  const me = currentUser(user);
  const id = asInt(params.id, '流水 id', { min: 1 });
  // 关键：先确认这笔流水属于我。少了这一步，攻击者就能改别人的账，
  // 而且因为是"改"而不是"插入"，触发器会连别人账户的余额一起改错。
  await requireOwnedTransaction(me.id, id);

  const input = await parseTransactionInput(me.id, body);
  await q.updateTransaction(id, input);
  return { ok: true };
});

route('DELETE', '/api/transactions/:id', async ({ user, params }) => {
  const me = currentUser(user);
  const id = asInt(params.id, '流水 id', { min: 1 });
  await requireOwnedTransaction(me.id, id);
  await q.deleteTransaction(id);
  return { ok: true };
});

// ===========================================================================
//  统计
// ===========================================================================

route('GET', '/api/months', async ({ user }) => q.listAvailableMonths(currentUser(user).id));

route('GET', '/api/balance', async ({ user }) => {
  const overview = await q.getBalanceOverview(currentUser(user).id);
  // 顺便给出"元"版本，前端就不用重复做除法（但图表仍然用分，避免浮点误差）
  return {
    ...overview,
    totalBalanceYuan: yuan(overview.totalBalanceCents),
    totalIncomeYuan: yuan(overview.totalIncomeCents),
    totalExpenseYuan: yuan(overview.totalExpenseCents),
    netYuan: yuan(overview.netCents),
  };
});

route('GET', '/api/summary', async ({ user, query }) => {
  const month = optionalMonth(query.get('month')) ?? currentMonth();
  return q.getMonthlySummary({ month, userId: currentUser(user).id });
});

route('GET', '/api/stats/categories', async ({ user, query }) => {
  const me = currentUser(user);
  const month = optionalMonth(query.get('month')) ?? currentMonth();
  const kind = query.get('kind') ? asEnum(query.get('kind'), '类型', CATEGORY_KINDS) : 'expense';
  // rollup=1 时把子分类汇总到父分类（饼图看大项更清楚，列表可以看明细）
  const rollup = query.get('rollup') === '1';

  const stats = await q.getCategoryStats({ month, kind, rollup, userId: me.id });
  const totalCents = stats.reduce((s, x) => s + x.totalCents, 0);
  const txCount = stats.reduce((s, x) => s + x.txCount, 0);

  // 金额用绝对值返回给前端（图表和列表都只关心"多大"），
  // 但 totalCents 保留原始符号 —— 支出是负数，前端要用来判断颜色。
  return {
    month,
    kind,
    rollup,
    totalCents,
    txCount,
    items: stats.map((s) => ({ ...s, totalYuan: Math.abs(yuan(s.totalCents)) })),
  };
});

/** 和上个月对比（用 LAG 窗口函数一次算出两个月的值） */
route('GET', '/api/stats/compare', async ({ user, query }) => {
  const month = optionalMonth(query.get('month')) ?? currentMonth();
  return q.getMonthComparison({ month, userId: currentUser(user).id });
});

route('GET', '/api/stats/trend', async ({ user, query }) => {
  const months = query.get('months') ? asInt(query.get('months'), 'months', { min: 1, max: 24 }) : 6;
  return q.getTrend({ months, userId: currentUser(user).id });
});

/** 对账检查：返回空数组表示余额没有漂移（只检查自己的账户） */
route('GET', '/api/health/balance', async ({ user }) => {
  const drift = await q.checkBalanceDrift(currentUser(user).id);
  return { ok: drift.length === 0, drift };
});

/** 建一笔转账：两行相反数，必须在一个事务里 */
route('POST', '/api/transfers', async ({ user, body }) => {
  const me = currentUser(user);
  const o = asObject(body);
  const fromAccountId = asInt(o.fromAccountId, '转出账户', { min: 1 });
  const toAccountId = asInt(o.toAccountId, '转入账户', { min: 1 });
  if (fromAccountId === toAccountId) throw new HttpError(400, '转出和转入不能是同一个账户');

  const amountCents = parseYuanToCents(o.amount, '转账金额');
  const occurredOn = asDate(o.occurredOn, '日期');
  const description = asString(o.description, '备注', { required: false, max: 200 });

  // 两个账户都必须是我的。少了这个检查，就能把钱"转"到别人的账户
  // （或者从别人的账户转出来 —— 那等于直接偷钱）。
  const from = await requireOwnedAccount(me.id, fromAccountId);
  const to = await requireOwnedAccount(me.id, toAccountId);

  // ⚠️ 事务里必须用同一个连接。PG 是网络数据库，连接池每次 query
  //    可能给不同连接，而事务绑定在单个连接上 —— 用池跑两次会变成
  //    两个独立事务，起不到原子性作用。tx() 封装已经处理了这一点。
  const { tx } = await import('./db/pg.ts');
  await tx(async (client) => {
    const insertTx = (accountId: number, cents: number, desc: string) =>
      client.query(
        `INSERT INTO transactions (user_id, account_id, category_id, type, amount_cents, description, occurred_on)
         VALUES ($1, $2, NULL, 'transfer', $3, $4, $5::date)`,
        [me.id, accountId, cents, desc, occurredOn],
      );

    // 一次转账产生"两行相反数"，必须一起成功
    await insertTx(fromAccountId, -amountCents, description || `转到${to.name}`);
    await insertTx(toAccountId, amountCents, description || `来自${from.name}`);
  });

  return { ok: true, amountCents };
});

// ===========================================================================
//  路由分发
// ===========================================================================

function matchRoute(
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);

  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.segments.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

/**
 * 处理一个 API 请求。
 *
 * 这个函数被两种运行方式共用：
 *   - 开发：被 Vite 的中间件直接调用（见 vite-plugin.ts），所以不需要跨域
 *   - 生产：被 node:http 服务器调用（见 index.ts）
 * 同一份 handler 两种跑法，避免"开发环境正常、上线就挂"。
 */
export async function handleApiRequest(req: Request, url: URL): Promise<Response> {
  const method = req.method.toUpperCase();

  if (!url.pathname.startsWith('/api/')) {
    return json({ error: 'Not Found' }, 404);
  }

  const matched = matchRoute(method, url.pathname);
  if (!matched) {
    return json({ error: `没有这个接口：${method} ${url.pathname}` }, 404);
  }

  // 先解析会话，让每个 handler 都能拿到当前用户。
  // 注意这里**不**在解析失败时直接 401 —— 公开路由（登录、注册）本来就没有会话，
  // 需要放行。是否强制登录交给下面的 isPublic 判断。
  const token = parseCookies(getHeader(req, 'cookie'))[SESSION_COOKIE];
  const user = await auth.getSessionUser(token);

  // 认证闸门：**默认要求登录**，只有显式标记 isPublic 的路由放行。
  //
  // 这个默认值的方向很关键。如果反过来（默认公开、需要保护的才标记），
  // 那么以后每加一个新接口，只要忘了标记，它就自动变成"任何人可访问"。
  // 默认拒绝（deny by default）才是安全的默认值 ——
  // 忘了标记最多是"该公开的接口打不开"，能被立刻发现；
  // 而反过来忘了标记是"该保护的接口敞开了"，可能很久都没人发现。
  if (!matched.route.isPublic && !user) {
    return json({ error: '请先登录' }, 401);
  }

  try {
    const body =
      method === 'GET' || method === 'DELETE'
        ? {}
        : await readJsonBody(req as unknown as import('node:http').IncomingMessage | Request);

    // handler 可以直接返回一个 Response（认证接口需要设置 cookie），
    // 也可以返回普通对象（会被包成 200 JSON）。两种都支持。
    const result = await matched.route.handler({
      user,
      params: matched.params,
      query: url.searchParams,
      body,
      req,
    });

    if (result instanceof Response) return result;
    return json(result ?? { ok: true }, 200);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    // 把数据库约束错误翻译成人话
    const translated = translateSqliteError(err);
    if (translated) {
      console.error('[api]', translated.message, '←', err instanceof Error ? err.message : err);
      return json({ error: translated.message }, translated.status);
    }
    console.error('[api] 未预期的错误：', err);
    return json({ error: '服务器内部错误' }, 500);
  }
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * 给 node:http 用的适配器。
 *
 * handler 内部统一用 Web 标准的 Request / Response 写（因为 Vite 的中间件
 * 也是这套标准），但 node:http 是 Node 的老风格。两种环境共用同一份
 * handleApiRequest，只在最外层做一次转换。
 */
export async function handleApiRequestNode(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);

  const response = await handleApiRequest(req as unknown as Request, url);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** 给调试用：当前注册了哪些接口 */
export function listRoutes() {
  return routes.map((r) => `${r.method} /${r.segments.join('/')}${r.isPublic ? '  (公开)' : ''}`);
}

export type { ApiError };
