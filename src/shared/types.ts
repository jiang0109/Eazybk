/**
 * ---------------------------------------------------------------------------
 * 领域类型（前后端共用）
 * ---------------------------------------------------------------------------
 * 所有金额在数据库里都是"分"（INTEGER）。只在界面显示时才转成"元"。
 * 这条规则贯穿整个项目，是避免浮点误差的关键。
 */

export type TxType = 'expense' | 'income' | 'transfer';
export type CategoryKind = 'expense' | 'income';
export type AccountType = 'cash' | 'bank' | 'credit' | 'ewallet' | 'investment';

/**
 * 当前登录用户（服务端返回给前端的最小信息）。
 *
 * 注意这里**没有**密码哈希之类的字段 —— 服务端永远不会把它们发出来，
 * 前端类型里也就没有。类型定义和接口契约保持一致，是一种便宜的防错手段。
 */
export interface AuthUser {
  id: number;
  name: string;
  username: string;
  /** 演示账号：界面上会多显示"重置演示数据"，并且提示数据是公共的 */
  isDemo: boolean;
}

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  /** 初始余额（分） */
  initialBalanceCents: number;
  /** 当前余额（分），由数据库触发器维护 */
  balanceCents: number;
  sortOrder: number;
}

export interface Category {
  id: number;
  name: string;
  kind: CategoryKind;
  parentId: number | null;
  icon: string | null;
  sortOrder: number;
  /** 该分类下有多少笔流水 —— 用于删除前的检查与界面提示 */
  usageCount?: number;
}

export interface Transaction {
  id: number;
  accountId: number;
  accountName: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryIcon: string | null;
  type: TxType;
  /** 带符号金额（分）：收入为正，支出为负 */
  amountCents: number;
  description: string;
  occurredOn: string;
  createdAt: string;
}

export interface MonthlySummary {
  /** 'YYYY-MM' */
  month: string;
  /** 收入合计（分，正数） */
  incomeCents: number;
  /** 支出合计（分，负数） */
  expenseCents: number;
  /** 结余 = 收入 + 支出（支出是负的，所以这里是加） */
  netCents: number;
  /** 本月笔数 */
  txCount: number;
}

export interface CategoryStat {
  categoryId: number;
  name: string;
  icon: string | null;
  kind: CategoryKind;
  /** 合计金额（分） */
  totalCents: number;
  txCount: number;
  /** 占同类合计的比例，0~1 */
  ratio: number;
}

export interface BalanceOverview {
  /** 所有账户合计余额（分） */
  totalBalanceCents: number;
  /** 历史收入合计（分） */
  totalIncomeCents: number;
  /** 历史支出合计（分，负数） */
  totalExpenseCents: number;
  /** 结余 = 收入总额 − 支出总额 */
  netCents: number;
  accounts: Account[];
}

/** 创建/更新流水时的输入 */
export interface TransactionInput {
  accountId: number;
  categoryId: number | null;
  type: TxType;
  /** 带符号金额（分） */
  amountCents: number;
  description: string;
  occurredOn: string;
}

/** 账户类型的中文名与图标，供界面展示 */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: '现金',
  bank: '银行卡',
  credit: '信用卡',
  ewallet: '电子钱包',
  investment: '投资',
};

export const ACCOUNT_TYPE_ICON: Record<AccountType, string> = {
  cash: '💵',
  bank: '🏦',
  credit: '💳',
  ewallet: '📱',
  investment: '📈',
};
