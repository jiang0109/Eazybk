/**
 * 统计页：分类占比 + 趋势 + 账户分布。
 *
 * 三种图各有分工，不要混用：
 *   环形图 —— 看**构成**（这个月的钱花在哪几项上）
 *   柱状图 —— 看**趋势**（每个月的变化）
 *   进度条 —— 看**排行**（谁花得最多，能精确到百分比）
 *
 * 数据全部来自 SQL：
 *   /api/stats/categories  → GROUP BY + 窗口函数算占比
 *   /api/stats/trend       → 递归 CTE 补齐空缺月份 + 条件聚合
 *   /api/stats/compare     → LAG 窗口函数拿上个月的值
 *   /api/balance           → 账户余额
 */

import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { categoryColor, centsToYuan, formatAmount, formatCompact, formatMonthLabel } from '../../lib/format';
import { useUi } from '../../store/ui';
import { EmptyState, SkeletonRows } from '../ui/Button';
import { FadeIn } from '../ui/FadeIn';
import { MonthPicker } from '../ledger/MonthPicker';
import { DonutChart } from './DonutChart';
import { BarChart } from './BarChart';
import type { CategoryKind } from '@shared/types';

export function StatsPage() {
  const { month, setMonth } = useUi();
  const [kind, setKind] = useState<CategoryKind>('expense');
  // 是否把子分类合并到父分类（饼图看大项更清楚，明细看列表）
  const [rollup, setRollup] = useState(true);

  const monthsState = useFetch(() => api.months(), []);
  const summaryState = useFetch(() => api.summary(month), [month]);
  const statsState = useFetch(() => api.categoryStats(month, kind, rollup), [month, kind, rollup]);
  const compareState = useFetch(() => api.compare(month), [month]);
  const trendState = useFetch(() => api.trend(6), []);
  const balanceState = useFetch(() => api.balance(), []);

  const availableMonths = useMemo(() => monthsState.data?.map((m) => m.month) ?? [], [monthsState.data]);

  // 环形图数据：把"分"转成"元"，并带上每个分类的固定配色
  const pieData = useMemo(
    () =>
      (statsState.data?.items ?? []).map((item) => ({
        id: item.categoryId,
        name: item.name,
        value: Math.abs(centsToYuan(item.totalCents)),
        ratio: item.ratio,
        color: categoryColor(item.categoryId),
      })),
    [statsState.data],
  );

  // 柱状图数据：支出取绝对值，两根柱子都朝上更好比较
  const trendData = useMemo(
    () =>
      (trendState.data ?? []).map((m) => ({
        month: m.month,
        income: centsToYuan(m.incomeCents),
        expense: Math.abs(centsToYuan(m.expenseCents)),
      })),
    [trendState.data],
  );

  const stats = statsState.data;
  const compare = compareState.data;
  const summary = summaryState.data;

  return (
    <div className="space-y-4">
      {/* ---------- 月份 + 收/支切换 ---------- */}
      <FadeIn>
        <section className="card flex items-center justify-between px-3 py-2.5">
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {(['expense', 'income'] as CategoryKind[]).map((k) => {
              const active = k === kind;
              const color = k === 'expense' ? 'var(--color-expense)' : 'var(--color-income)';
              return (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--color-surface)' : 'transparent',
                    color: active ? color : 'var(--color-ink-3)',
                  }}
                >
                  {k === 'expense' ? '支出' : '收入'}
                </button>
              );
            })}
          </div>

          <MonthPicker month={month} availableMonths={availableMonths} onChange={setMonth} />
        </section>
      </FadeIn>

      {/* ---------- 总额 + 环比 ---------- */}
      <FadeIn index={1}>
        <section className="card px-5 py-4">
          <p className="text-xs text-ink-2">
            {formatMonthLabel(month)}总{kind === 'expense' ? '支出' : '收入'}
          </p>
          {stats ? (
            <>
              <p className="mt-1 font-mono text-3xl font-bold tabular-nums">
                <span className="mr-1 text-lg font-normal text-ink-2">¥</span>
                {formatAmount(stats.totalCents)}
              </p>
              <p className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                <span>
                  {stats.txCount} 笔 · {stats.items.length} 个分类
                </span>
                {/* 环比：用 LAG 窗口函数算出来的 */}
                {kind === 'expense' && compare && compare.diffRatio !== null && (
                  <span
                    className="rounded-md px-1.5 py-0.5 font-mono tabular-nums"
                    style={{
                      color: compare.diffCents > 0 ? 'var(--color-expense)' : 'var(--color-income)',
                      backgroundColor:
                        compare.diffCents > 0
                          ? 'color-mix(in srgb, var(--color-expense) 15%, transparent)'
                          : 'color-mix(in srgb, var(--color-income) 15%, transparent)',
                    }}
                    title="和上个月相比"
                  >
                    较上月 {compare.diffCents > 0 ? '↑' : '↓'}
                    {Math.abs(compare.diffRatio * 100).toFixed(0)}%
                  </span>
                )}
              </p>
            </>
          ) : (
            <div className="skeleton mt-2 h-9 w-40" />
          )}
        </section>
      </FadeIn>

      {/* ---------- 分类占比 ---------- */}
      <FadeIn index={2}>
        <section className="card p-5">
          <header className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">分类占比</h3>
            {/* 汇总开关：演示"子分类汇总到父分类"的 SQL 写法 */}
            {kind === 'expense' && (
              <button
                onClick={() => setRollup((v) => !v)}
                className="rounded-lg border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:text-ink"
                title="是否把子分类（如早餐/午餐）合并到父分类（餐饮）"
              >
                {rollup ? '合并子分类' : '展开子分类'}
              </button>
            )}
          </header>

          {statsState.loading && <SkeletonRows rows={3} />}

          {!statsState.loading && pieData.length === 0 && (
            <EmptyState icon="📊" title={`这个月还没有${kind === 'expense' ? '支出' : '收入'}记录`} />
          )}

          {pieData.length > 0 && (
            <>
              {/* 环形图：手写 SVG，环心直接显示合计金额 */}
              <DonutChart
                data={pieData}
                centerLabel="合计"
                centerValue={`¥${formatCompact(stats?.totalCents ?? 0)}`}
              />

              {/* 排行列表：比饼图更精确，所以两个都给 */}
              <ul className="mt-3 space-y-2.5">
                {[...stats!.items]
                  .sort((a, b) => b.ratio - a.ratio)
                  .map((item, i) => (
                    <FadeIn key={item.categoryId} index={i}>
                      <li>
                        <div className="flex items-baseline justify-between text-sm">
                          <span className="truncate">
                            <span className="mr-1.5">{item.icon}</span>
                            {item.name}
                            <span className="ml-1.5 text-[11px] text-ink-3">{item.txCount} 笔</span>
                          </span>
                          <span className="ml-2 shrink-0 font-mono tabular-nums">
                            {formatAmount(item.totalCents)}
                            <span className="ml-1.5 text-xs text-ink-3">{(item.ratio * 100).toFixed(1)}%</span>
                          </span>
                        </div>
                        {/* 进度条：宽度就是占比 */}
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.max(item.ratio * 100, 1.5)}%`,
                              backgroundColor: categoryColor(item.categoryId),
                            }}
                          />
                        </div>
                      </li>
                    </FadeIn>
                  ))}
              </ul>
            </>
          )}
        </section>
      </FadeIn>

      {/* ---------- 近 6 个月趋势 ---------- */}
      <FadeIn index={3}>
        <section className="card p-5">
          <header className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">近 6 个月趋势</h3>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1 text-ink-2">
                <i className="size-2 rounded-sm" style={{ backgroundColor: 'var(--color-income)' }} />
                收入
              </span>
              <span className="flex items-center gap-1 text-ink-2">
                <i className="size-2 rounded-sm" style={{ backgroundColor: 'var(--color-expense)' }} />
                支出
              </span>
            </div>
          </header>

          {trendState.loading ? (
            <div className="skeleton h-44 w-full" />
          ) : (
            // 手写 SVG 柱状图：纵轴刻度、月份标签、进出场动画都在组件里
            <BarChart
              data={trendData}
              formatMonth={(m) => formatMonthLabel(m, true)}
            />
          )}
        </section>
      </FadeIn>

      {/* ---------- 账户余额分布 ---------- */}
      <FadeIn index={4}>
        <section className="card p-5">
          <h3 className="mb-3 text-sm font-semibold">账户余额</h3>
          {!balanceState.data ? (
            <SkeletonRows rows={3} />
          ) : (
            <ul className="space-y-3">
              {balanceState.data.accounts.map((a) => {
                // 用绝对值画宽度：负数余额（比如信用卡欠款）不该出现负宽度，改用颜色区分
                const total = Math.max(Math.abs(balanceState.data!.totalBalanceCents), 1);
                const width = Math.min(Math.abs(a.balanceCents / total) * 100, 100);
                return (
                  <li key={a.id}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span>{a.name}</span>
                      <span
                        className="font-mono tabular-nums"
                        style={{ color: a.balanceCents < 0 ? 'var(--color-expense)' : undefined }}
                      >
                        {a.balanceCents < 0 && '-'}
                        {formatAmount(a.balanceCents)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.max(width, 1)}%`,
                          backgroundColor: a.balanceCents < 0 ? 'var(--color-expense)' : 'var(--color-accent)',
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
            余额 = 初始余额 + 该账户所有流水之和。它由数据库触发器在每次增删改流水时自动维护，
            可以用 <code className="text-ink-2">/api/health/balance</code> 对账验证有没有漂移。
          </p>
        </section>
      </FadeIn>

      {/* 本月收支对比（补充趋势图看不出的当月细节） */}
      {summary && (
        <FadeIn index={5}>
          <section className="card grid grid-cols-3 divide-x divide-line">
            {[
              { label: '收入', value: summary.incomeCents, color: 'var(--color-income)' },
              { label: '支出', value: summary.expenseCents, color: 'var(--color-expense)' },
              { label: '结余', value: summary.netCents, color: 'var(--color-ink)' },
            ].map((it) => (
              <div key={it.label} className="px-3 py-3 text-center">
                <p className="text-[11px] text-ink-3">{it.label}</p>
                <p className="mt-1 font-mono text-sm font-semibold tabular-nums" style={{ color: it.color }}>
                  {formatAmount(it.value)}
                </p>
              </div>
            ))}
          </section>
        </FadeIn>
      )}
    </div>
  );
}

