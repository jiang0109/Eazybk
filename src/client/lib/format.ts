/**
 * 格式化工具：金额、日期。
 *
 * 关于金额有一条铁律：**内部一律用"分"（整数），只在显示时才转成"元"。**
 * 这里的 centsToYuan 是全项目唯一允许出现小数的地方，
 * 而且除法只发生在渲染的最后一步。
 */

/** 分 → 元（数值）。用于图表数据点。 */
export function centsToYuan(cents: number): number {
  return cents / 100;
}

/** 分 → 元（两位小数字符串），例如 1234567 → "12,345.67" */
export function formatAmount(cents: number): string {
  return (Math.abs(cents) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 带符号的金额，用于流水列表。
 * 支出显示 "-35.00"，收入显示 "+15,000.00"。
 */
export function formatSigned(cents: number): string {
  return `${cents < 0 ? '-' : '+'}${formatAmount(cents)}`;
}

/** 图表轴标签用的紧凑写法：12345678 分 → "12.3万" */
export function formatCompact(cents: number): string {
  const yuan = Math.abs(cents) / 100;
  if (yuan >= 10000) return `${(yuan / 10000).toFixed(1)}万`;
  if (yuan >= 1000) return `${(yuan / 1000).toFixed(1)}千`;
  return String(Math.round(yuan));
}

/**
 * 把用户输入的"元"字符串规范化成两位小数，显示在输入框里。
 * 不做数学运算，纯粹是字符串处理 —— 避免浮点误差。
 */
export function normalizeYuanInput(input: string): string {
  const s = input.replace(/[^\d.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot === -1) return s;

  const intPart = s.slice(0, firstDot);
  const decPart = s.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
  return `${intPart}.${decPart}`;
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/** 本地日期 YYYY-MM-DD（不能用 toISOString：它按 UTC 算，东八区会差一天） */
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today(): string {
  return toDateStr(new Date());
}

/** 当前月份 YYYY-MM */
export function thisMonth(): string {
  return today().slice(0, 7);
}

/** 月份加减，用于月份选择器的左右切换 */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 月份显示：跨年时带上年份。
 * 比如当前是 2026 年，那 "2026-03" 显示成 "3月"，
 * "2025-11" 显示成 "2025年11月" —— 避免用户分不清是哪一年的 3 月。
 */
export function formatMonthLabel(month: string, compact = false): string {
  const [y, m] = month.split('-');
  const sameYear = y === today().slice(0, 4);
  if (sameYear) return `${Number(m)}月`;
  // compact 用于图表坐标轴（横轴空间紧张，年份去掉前两位）
  return compact ? `${y.slice(2)}年${Number(m)}月` : `${y}年${Number(m)}月`;
}

/** 日期显示：今天/昨天/前天，其余显示 M月D日，跨年补年份 */
export function formatDateLabel(dateStr: string): string {
  const t = today();
  if (dateStr === t) return '今天';

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === toDateStr(yesterday)) return '昨天';

  const [y, m, d] = dateStr.split('-');
  return y === t.slice(0, 4) ? `${Number(m)}月${Number(d)}日` : `${y}年${Number(m)}月${Number(d)}日`;
}

/** 星期几 */
export function weekdayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}

// ---------------------------------------------------------------------------
// 分类配色（饼图需要一组固定颜色，保证同一分类每次颜色一致）
// ---------------------------------------------------------------------------

const PALETTE = [
  '#f5a524', // 主色（琥珀）
  '#38bdf8', // 天蓝
  '#a78bfa', // 紫
  '#fb7185', // 玫红
  '#34d399', // 翠绿
  '#fbbf24', // 金黄
  '#60a5fa', // 蓝
  '#f472b6', // 粉
  '#2dd4bf', // 青
  '#c084fc', // 淡紫
  '#fdba74', // 橙
  '#4ade80', // 绿
];

/** 用分类 id 取色，这样同一分类的颜色永远不变 */
export function categoryColor(id: number): string {
  return PALETTE[id % PALETTE.length];
}
