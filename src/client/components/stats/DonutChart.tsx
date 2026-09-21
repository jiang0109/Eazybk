/**
 * 环形图（纯 SVG，手写）。
 *
 * 为什么不用图表库？
 * 一开始用的是 Recharts，但在 React 19 下它的扇形容器
 * （<g class="recharts-shape">）是空的 —— 根本没生成扇形的 path，
 * 界面上只剩一个环心文字，图是白板。这是库的兼容性问题，不是配置问题。
 * 判断之后决定自己画：
 *   1. 少一个 300 kB 量级的依赖（这个项目一共就两种图）
 *   2. 行为完全可控，不会有版本兼容的意外
 *   3. 代码很短，看懂之后还能自己改
 *
 * 实现思路：不用 svg 的弧线路径（需要算三角函数，容易错），
 * 而是画同心圆 + stroke-dasharray 只显示一段。半径 R 的周长是 2πR，
 * 把"这一段占多少比例"换算成线段长度，再用 dashoffset 决定它从哪里开始。
 */

import { useEffect, useState } from 'react';

export interface DonutSlice {
  id: number | string;
  name: string;
  /** 数值（正数）。占比由组件自己按总和算 */
  value: number;
  color: string;
}

interface Props {
  data: DonutSlice[];
  /** 环的外半径与粗细（都是 SVG 逻辑坐标，外层用 CSS 缩放） */
  radius?: number;
  thickness?: number;
  /** 环心显示的主标题与副标题 */
  centerLabel?: string;
  centerValue?: string;
}

export function DonutChart({ data, radius = 74, thickness = 26, centerLabel, centerValue }: Props) {
  // 进场动画：让每一段从 0 长到目标长度。
  // 用一个 0→1 的进度值驱动所有段的长度，动画结束就停掉定时器。
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const duration = 560;

    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // easeOutCubic：一开始快、结束慢，视觉上更自然
      setProgress(1 - Math.pow(1 - t, 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [data]);

  const total = data.reduce((s, d) => s + d.value, 0);
  const size = radius * 2 + thickness + 4;
  const center = size / 2;
  const r = radius;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const slices = data.map((d) => {
    const ratio = total === 0 ? 0 : d.value / total;
    const length = ratio * circumference;
    const slice = { ...d, ratio, length, offset };
    offset += length;
    return slice;
  });

  return (
    <div className="flex flex-col items-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="max-w-full"
        role="img"
        aria-label={`分类占比：${data.map((d) => `${d.name} ${(total === 0 ? 0 : (d.value / total) * 100).toFixed(1)}%`).join('，')}`}
      >
        {/* 底环：数据为空时也能看出这是个环形图 */}
        <circle cx={center} cy={center} r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth={thickness} />

        {slices.map((s) => (
          <circle
            key={s.id}
            cx={center}
            cy={center}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            // 留 1.5% 的缝隙让相邻两段分开，视觉上更清楚
            strokeDasharray={`${Math.max(s.length * progress - 1.5, 0)} ${circumference}`}
            strokeDashoffset={-s.offset}
            // 从 12 点方向开始，符合看饼图的习惯
            transform={`rotate(-90 ${center} ${center})`}
            strokeLinecap="butt"
          />
        ))}

        {/* 环心文字：给这一圈一个"锚点"，让人知道代表多少钱 */}
        {centerValue && (
          <>
            <text
              x={center}
              y={center - 4}
              textAnchor="middle"
              fill="var(--color-ink-3)"
              fontSize="11"
            >
              {centerLabel}
            </text>
            <text
              x={center}
              y={center + 16}
              textAnchor="middle"
              fill="var(--color-ink)"
              fontSize="18"
              fontWeight="700"
              fontFamily="var(--font-mono)"
            >
              {centerValue}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
