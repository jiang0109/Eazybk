/**
 * 分组柱状图（纯 SVG，手写）。
 *
 * 和 DonutChart 一样，为了避开图表库在 React 19 下的兼容问题而手写。
 * 需求很简单：每个月两根柱子（收入 / 支出），带月份标签和纵向刻度。
 *
 * 坐标计算全部基于 SVG 的 viewBox（逻辑坐标系），外层用 CSS 缩放到容器宽度。
 * 好处是不需要测量 DOM，也不需要 ResizeObserver —— 渲染结果完全确定。
 */

import { useEffect, useState } from 'react';

export interface BarGroup {
  /** 月份 'YYYY-MM' */
  month: string;
  income: number;
  expense: number;
}

interface Props {
  data: BarGroup[];
  /** 逻辑宽度，外层会缩放 */
  width?: number;
  height?: number;
  /** 月份标签的显示方式 */
  formatMonth: (month: string) => string;
}

export function BarChart({ data, width = 420, height = 176, formatMonth }: Props) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const duration = 620;

    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      setProgress(1 - Math.pow(1 - t, 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [data]);

  // 边距：左边留给刻度文字，下边留给月份文字
  const padding = { top: 8, right: 4, bottom: 20, left: 38 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  // 纵轴上限：取所有数据的最大值，再向上取整到一个"整"刻度
  const maxValue = Math.max(...data.flatMap((d) => [d.income, d.expense]), 1);
  const step = niceStep(maxValue);
  const axisMax = Math.ceil(maxValue / step) * step;

  const groupW = data.length === 0 ? plotW : plotW / data.length;
  const barW = Math.min(groupW * 0.28, 16);
  const gap = 3;

  const y = (v: number) => padding.top + plotH - (v / axisMax) * plotH;

  // 刻度线（4 段）
  const ticks = Array.from({ length: 5 }, (_, i) => (axisMax / 4) * i);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="h-full w-full"
      role="img"
      aria-label="近几个月收入与支出对比"
    >
      {/* 横向刻度线与纵轴文字 */}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--color-line)"
            strokeWidth="1"
            strokeDasharray={t === 0 ? undefined : '3 4'}
          />
          <text
            x={padding.left - 6}
            y={y(t) + 3.5}
            textAnchor="end"
            fill="var(--color-ink-3)"
            fontSize="9"
          >
            {formatAxis(t)}
          </text>
        </g>
      ))}

      {data.map((d, i) => {
        const centerX = padding.left + groupW * i + groupW / 2;
        const incomeH = (d.income / axisMax) * plotH * progress;
        const expenseH = (d.expense / axisMax) * plotH * progress;

        return (
          <g key={d.month}>
            {/* 收入柱（靠左） */}
            <rect
              x={centerX - barW - gap / 2}
              y={padding.top + plotH - incomeH}
              width={barW}
              height={Math.max(incomeH, 0)}
              rx="2"
              fill="var(--color-income)"
            />
            {/* 支出柱（靠右） */}
            <rect
              x={centerX + gap / 2}
              y={padding.top + plotH - expenseH}
              width={barW}
              height={Math.max(expenseH, 0)}
              rx="2"
              fill="var(--color-expense)"
            />
            {/* 月份标签 */}
            <text
              x={centerX}
              y={height - 6}
              textAnchor="middle"
              fill="var(--color-ink-3)"
              fontSize="10"
            >
              {formatMonth(d.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 把最大值向上归整到一个好看的刻度（1/2/5/10 × 10^n）。
 * 不然纵轴会出现 "8347" 这种刻度，读数很累。
 */
function niceStep(maxValue: number): number {
  const rough = maxValue / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  const normalized = rough / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** 纵轴刻度文字：上万就折成"万"，省空间 */
function formatAxis(v: number): string {
  if (v >= 10000) return `${(v / 10000).toFixed(v % 10000 === 0 ? 0 : 1)}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(v));
}
