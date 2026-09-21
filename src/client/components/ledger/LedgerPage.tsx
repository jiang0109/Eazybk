/**
 * 记账主页：余额 + 本月汇总 + 流水列表。
 *
 * 数据来源（全部是 SQL 算出来的，前端不做任何业务计算）：
 *   GET /api/balance      → 账户余额合计、历史收入/支出
 *   GET /api/summary      → 本月收入、支出、结余（一条条件聚合 SQL）
 *   GET /api/transactions → 本月流水（带分页）
 *   GET /api/months       → 有数据的月份，供月份选择器用
 */

import { useCallback, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { formatAmount, formatDateLabel, formatMonthLabel, weekdayLabel } from '../../lib/format';
import { useUi } from '../../store/ui';
import { Button, EmptyState, SkeletonRows } from '../ui/Button';
import { FadeIn } from '../ui/FadeIn';
import { Sheet } from '../ui/Sheet';
import { MonthPicker } from './MonthPicker';
import { TransactionRow } from './TransactionRow';
import type { Transaction } from '@shared/types';

export function LedgerPage() {
  const { month, setMonth, openEditor, refresh } = useUi();
  const [monthSheetOpen, setMonthSheetOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const monthsState = useFetch(() => api.months(), []);
  const summaryState = useFetch(() => api.summary(month), [month]);
  const balanceState = useFetch(() => api.balance(), []);
  const listState = useFetch(() => api.transactions({ month, limit: 200 }), [month]);

  const availableMonths = useMemo(() => monthsState.data?.map((m) => m.month) ?? [], [monthsState.data]);
  const balance = balanceState.data;
  const summary = summaryState.data;
  const transactions = listState.data?.items ?? [];

  /**
   * 按日期分组。
   *
   * 分组逻辑放在前端是合理的 —— 它只是展示层的组织方式，不涉及数据计算。
   * 但注意"本月花了多少"这类**计算**必须来自 SQL，不能在这里 reduce。
   */
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of transactions) {
      const list = map.get(tx.occurredOn);
      if (list) list.push(tx);
      else map.set(tx.occurredOn, [tx]);
    }
    return [...map.entries()];
  }, [transactions]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteTransaction(pendingDelete.id);
      setPendingDelete(null);
      // 让所有订阅 version 的查询重新拉取（余额和汇总会自动变化，
      // 因为 DELETE 触发器已经改过数据库里的余额了）
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refresh]);

  return (
    <div className="space-y-4">
      {/* ---------- 概览卡片 ---------- */}
      <FadeIn>
        <section className="card overflow-hidden">
          {/* 总余额 */}
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-center gap-1.5 text-xs text-ink-2">
              <span>总余额</span>
              {/* 说明这个数字来自 accounts.balance_cents，由触发器维护 */}
              <span className="text-ink-3" title="所有账户余额之和，由数据库触发器自动维护">
                ⓘ
              </span>
            </div>

            {balance ? (
              <>
                <p className="mt-1 font-mono text-3xl font-bold tabular-nums">
                  <span className="mr-1 text-lg font-normal text-ink-2">¥</span>
                  {formatAmount(balance.totalBalanceCents)}
                </p>
                <p className="mt-1 text-xs text-ink-3">
                  共 {balance.accounts.length} 个账户 · 记账以来结余{' '}
                  <span
                    className="font-mono tabular-nums"
                    style={{ color: balance.netCents >= 0 ? 'var(--color-income)' : 'var(--color-expense)' }}
                  >
                    {balance.netCents >= 0 ? '+' : '-'}
                    {formatAmount(balance.netCents)}
                  </span>
                </p>
              </>
            ) : (
              <div className="skeleton mt-2 h-9 w-40" />
            )}
          </div>

          {/* 本月收入 / 支出 / 结余 —— 来自一条条件聚合 SQL */}
          <div className="grid grid-cols-3 divide-x divide-line border-t border-line">
            {[
              { label: '本月收入', value: summary?.incomeCents, color: 'var(--color-income)', sign: '+' },
              { label: '本月支出', value: summary?.expenseCents, color: 'var(--color-expense)', sign: '-' },
              { label: '本月结余', value: summary?.netCents, color: 'var(--color-ink)', sign: '' },
            ].map((item) => (
              <div key={item.label} className="px-3 py-3 text-center">
                <p className="text-[11px] text-ink-3">{item.label}</p>
                {item.value === undefined ? (
                  <div className="skeleton mx-auto mt-1.5 h-4 w-16" />
                ) : (
                  <p className="mt-1 font-mono text-sm font-semibold tabular-nums" style={{ color: item.color }}>
                    {item.sign}
                    {formatAmount(item.value)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      </FadeIn>

      {/* ---------- 月份 + 流水列表 ---------- */}
      <section className="card">
        <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <button
            onClick={() => setMonthSheetOpen(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold transition-colors hover:bg-surface-2"
            title="选择月份"
          >
            {formatMonthLabel(month)}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              className="text-ink-3"
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <div className="flex items-center gap-2">
            {listState.data && <span className="text-xs text-ink-3">共 {listState.data.total} 笔</span>}
            <MonthPicker month={month} availableMonths={availableMonths} onChange={setMonth} />
          </div>
        </header>

        <div className="px-2 py-2">
          {listState.loading && <SkeletonRows rows={6} />}

          {listState.error && (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-danger">{listState.error}</p>
              <Button variant="ghost" className="mt-3" onClick={listState.reload}>
                重试
              </Button>
            </div>
          )}

          {!listState.loading && !listState.error && groups.length === 0 && (
            <EmptyState icon="🗒️" title="这个月还没有记账" hint="点右下角的 + 按钮记第一笔" />
          )}

          {groups.map(([date, items], groupIndex) => (
            <div key={date}>
              <div className="flex items-baseline justify-between px-3 pt-3 pb-1">
                <span className="text-xs font-medium text-ink-2">
                  {formatDateLabel(date)}
                  <span className="ml-1.5 text-ink-3">周{weekdayLabel(date)}</span>
                </span>
                {/* 当日小计：这里的求和只是展示层的聚合（同一批已取回的数据），
                    跨表、跨月份的计算才必须交给 SQL */}
                <span className="font-mono text-[11px] text-ink-3 tabular-nums">
                  {formatAmount(items.reduce((s, t) => s + t.amountCents, 0))}
                </span>
              </div>

              <FadeIn index={groupIndex}>
                <div className="divide-y divide-line/60">
                  {items.map((tx) => (
                    <TransactionRow key={tx.id} tx={tx} onEdit={openEditor} onDelete={setPendingDelete} />
                  ))}
                </div>
              </FadeIn>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 月份选择弹层 ---------- */}
      <Sheet open={monthSheetOpen} title="选择月份" onClose={() => setMonthSheetOpen(false)}>
        <div className="grid grid-cols-3 gap-2">
          {availableMonths.map((m) => {
            const active = m === month;
            return (
              <button
                key={m}
                onClick={() => {
                  setMonth(m);
                  setMonthSheetOpen(false);
                }}
                className="rounded-xl border px-3 py-3 text-sm transition-colors"
                style={{
                  borderColor: active ? 'var(--color-accent)' : 'var(--color-line)',
                  backgroundColor: active ? 'var(--color-accent-soft)' : 'var(--color-surface-2)',
                  color: active ? 'var(--color-accent)' : 'var(--color-ink-2)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {formatMonthLabel(m)}
              </button>
            );
          })}
        </div>
      </Sheet>

      {/* ---------- 删除确认 ---------- */}
      <Sheet
        open={pendingDelete !== null}
        title="删除这笔账？"
        onClose={() => {
          setPendingDelete(null);
          setActionError(null);
        }}
      >
        {pendingDelete && (
          <div className="space-y-4">
            <div className="rounded-xl bg-surface-2 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">
                  {pendingDelete.categoryIcon ?? '🔄'} {pendingDelete.categoryName ?? '转账'}
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {formatAmount(pendingDelete.amountCents)}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-3">
                {pendingDelete.occurredOn} · {pendingDelete.accountName}
                {pendingDelete.description && ` · ${pendingDelete.description}`}
              </p>
            </div>

            <p className="text-xs text-ink-3">
              删除后这笔金额会从账户余额中扣回 —— 这是数据库的 DELETE 触发器自动完成的，
              不需要应用代码去改余额。
            </p>

            {actionError && <p className="text-sm text-danger">{actionError}</p>}

            <div className="flex gap-3">
              <Button variant="ghost" className="flex-1" onClick={() => setPendingDelete(null)}>
                取消
              </Button>
              <Button
                className="flex-1"
                loading={deleting}
                onClick={handleDelete}
                style={{ backgroundColor: 'var(--color-danger)', color: 'white' }}
              >
                删除
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
