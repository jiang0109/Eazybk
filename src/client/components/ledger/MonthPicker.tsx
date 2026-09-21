/**
 * 月份选择器：左右箭头 + 当前月份。
 *
 * 只在"有数据的月份"之间切换，所以不会有翻到空白页的挫败感。
 * 数据来源是 GET /api/months（一条 GROUP BY 查询）。
 */

import { formatMonthLabel } from '../../lib/format';

interface Props {
  month: string;
  availableMonths: string[];
  onChange: (month: string) => void;
}

export function MonthPicker({ month, availableMonths, onChange }: Props) {
  const idx = availableMonths.indexOf(month);
  // idx === 0 表示已经是最新的一个月，不能再往后翻
  const canPrev = idx === -1 ? true : idx < availableMonths.length - 1;
  const canNext = idx > 0;

  // 月份之间有间隔时（比如中间那个月没记账），提示一下用户
  const gapHint = idx > 0 ? `${availableMonths.length - idx} / ${availableMonths.length}` : null;

  const arrow = (dir: -1 | 1, disabled: boolean) => (
    <button
      disabled={disabled}
      onClick={() => {
        const next = availableMonths[idx + dir];
        if (next) onChange(next);
      }}
      aria-label={dir === -1 ? '上一个月' : '下一个月'}
      className="grid size-9 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path
          d={dir === -1 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  return (
    <div className="flex items-center gap-1">
      {arrow(-1, !canPrev)}
      <div className="flex min-w-[5.5rem] flex-col items-center">
        <span className="text-sm font-semibold">{formatMonthLabel(month)}</span>
        {gapHint && <span className="text-[10px] leading-none text-ink-3">{gapHint}</span>}
      </div>
      {arrow(1, !canNext)}
    </div>
  );
}
