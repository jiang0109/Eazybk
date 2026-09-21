/**
 * 流水行。
 *
 * 显示：分类图标 + 分类名 + 备注/账户 + 金额。
 * 点击整行进入编辑，右侧垃圾桶删除（删除前二次确认）。
 */

import type { Transaction } from '@shared/types';
import { categoryColor, formatAmount, formatSigned } from '../../lib/format';

interface Props {
  tx: Transaction;
  onEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
}

export function TransactionRow({ tx, onEdit, onDelete }: Props) {
  const isTransfer = tx.type === 'transfer';
  const isIncome = tx.amountCents > 0;

  // 金额颜色：收入绿、支出白、转账用弱化色（它既不是收入也不是支出，
  // 用红绿去标它反而会误导用户）
  const amountColor = isTransfer ? 'var(--color-ink-2)' : isIncome ? 'var(--color-income)' : 'var(--color-ink)';

  const title = isTransfer ? '转账' : (tx.categoryName ?? '未分类');
  const icon = isTransfer ? '🔄' : (tx.categoryIcon ?? '📝');

  return (
    <div className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
      {/* 点左边进入编辑 */}
      <button onClick={() => onEdit(tx)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-full text-lg"
          style={{
            backgroundColor: isTransfer ? 'var(--color-surface-2)' : `${categoryColor(tx.categoryId ?? 0)}22`,
          }}
        >
          {icon}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-ink-3">
            {/* 备注为空时用账户名兜底，避免出现一行空白 */}
            {tx.description || tx.accountName}
            {tx.description && <span className="text-ink-3/70"> · {tx.accountName}</span>}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: amountColor }}>
          {isTransfer ? formatAmount(tx.amountCents) : formatSigned(tx.amountCents)}
        </span>

        {/* 删除按钮：移动端没有 hover，所以默认给它一点透明度，保证可见 */}
        <button
          onClick={() => onDelete(tx)}
          aria-label="删除这笔账"
          className="ml-1 rounded-lg p-1.5 text-ink-3 opacity-0 transition-all hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-60"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
