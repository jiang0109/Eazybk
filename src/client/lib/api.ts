/**
 * 前端 API 客户端。
 *
 * 唯一的约定：所有请求都走相对路径 '/api/...'。
 * 开发时由 Vite 的中间件处理，生产时由 Node 服务器处理 —— 前端不需要知道区别。
 */

import type {
  Account,
  AccountType,
  BalanceOverview,
  Category,
  CategoryKind,
  CategoryStat,
  MonthlySummary,
  Transaction,
  TxType,
} from '@shared/types';

/** 后端返回的错误格式 */
interface ApiErrorBody {
  error?: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
    });
  } catch {
    // fetch 本身抛异常 = 网络层问题（比如开发服务器没起来）
    throw new ApiError(0, '连接不上服务器，请确认开发服务器还在运行');
  }

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = (data as ApiErrorBody)?.error ?? `请求失败（HTTP ${res.status}）`;

    // 401 说明会话已经失效（过期、被撤销、或者换了浏览器）。
    // 这里顺手把前端的登录状态清掉，界面就会自动回到登录页，
    // 而不是留在一个"看起来已登录、点什么都没反应"的死界面上。
    //
    // 用动态 import 是为了打破循环依赖：
    // api.ts 被 auth store 间接使用，顶层互相 import 会形成环。
    if (res.status === 401) {
      const { useAuth } = await import('../store/auth');
      useAuth.getState().clear();
    }

    throw new ApiError(res.status, message);
  }
  return data as T;
}

/** 分类树：一级分类带 children */
export interface CategoryNode extends Category {
  children: Category[];
}

/** 统计接口返回的结构 */
export interface CategoryStatsResponse {
  month: string;
  kind: CategoryKind;
  /** 是否已把子分类汇总到父分类 */
  rollup: boolean;
  totalCents: number;
  txCount: number;
  items: (CategoryStat & { totalYuan: number })[];
}

/** 流水列表响应 */
export interface TransactionListResponse {
  items: Transaction[];
  total: number;
}

/** 新增/修改流水时提交给后端的数据（金额是"元"的字符串，由服务端转成"分"） */
export interface TransactionPayload {
  accountId: number;
  categoryId: number | null;
  type: TxType;
  amount: string;
  description: string;
  occurredOn: string;
}

/** 环比接口返回结构 */
export interface CompareResponse {
  expenseCents: number;
  prevExpenseCents: number;
  diffCents: number;
  /** 上个月没有数据时为 null（避免除零出现 Infinity） */
  diffRatio: number | null;
}

export const api = {
  // --- 基础数据 ---
  accounts: () => request<Account[]>('/api/accounts'),
  categories: () => request<CategoryNode[]>('/api/categories'),
  months: () => request<{ month: string; txCount: number }[]>('/api/months'),

  // --- 流水 ---
  transactions: (
    params: {
      month?: string;
      type?: TxType;
      categoryId?: number;
      keyword?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const query = qs.toString();
    return request<TransactionListResponse>(`/api/transactions${query ? `?${query}` : ''}`);
  },

  createTransaction: (payload: TransactionPayload) =>
    request<{ id: number }>('/api/transactions', { method: 'POST', body: JSON.stringify(payload) }),

  updateTransaction: (id: number, payload: TransactionPayload) =>
    request<{ ok: true }>(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  deleteTransaction: (id: number) => request<{ ok: true }>(`/api/transactions/${id}`, { method: 'DELETE' }),

  // --- 分类管理 ---
  createCategory: (payload: { name: string; kind: CategoryKind; parentId: number | null; icon: string | null }) =>
    request<{ id: number }>('/api/categories', { method: 'POST', body: JSON.stringify(payload) }),

  renameCategory: (id: number, payload: { name: string; icon: string | null }) =>
    request<{ ok: true }>(`/api/categories/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  deleteCategory: (id: number) => request<{ ok: true }>(`/api/categories/${id}`, { method: 'DELETE' }),

  // --- 账户 ---
  createAccount: (payload: { name: string; type: AccountType; initialBalance?: string }) =>
    request<Account>('/api/accounts', { method: 'POST', body: JSON.stringify(payload) }),

  /** 转账：后端会在一个事务里写两行相反数的流水 */
  createTransfer: (payload: {
    fromAccountId: number;
    toAccountId: number;
    amount: string;
    occurredOn: string;
    description?: string;
  }) =>
    request<{ ok: true; amountCents: number }>('/api/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // --- 统计 ---
  balance: () => request<BalanceOverview & { totalBalanceYuan: number }>('/api/balance'),
  summary: (month: string) => request<MonthlySummary>(`/api/summary?month=${month}`),
  categoryStats: (month: string, kind: CategoryKind, rollup = false) =>
    request<CategoryStatsResponse>(
      `/api/stats/categories?month=${month}&kind=${kind}&rollup=${rollup ? 1 : 0}`,
    ),
  compare: (month: string) => request<CompareResponse>(`/api/stats/compare?month=${month}`),
  trend: (months: number) => request<MonthlySummary[]>(`/api/stats/trend?months=${months}`),

  // --- 演示账号专用 ---
  /** 把演示数据恢复成初始状态（只有演示账号能调用） */
  resetDemo: () =>
    request<{ ok: true; transactions: number }>('/api/auth/demo/reset', { method: 'POST' }),
};
