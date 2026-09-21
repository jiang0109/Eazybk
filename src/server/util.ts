/**
 * 通用小工具
 */

/**
 * 转义 LIKE 的通配符。
 *
 * 为什么需要：用户搜"50%"时，% 在 LIKE 里是通配符，会匹配到所有记录。
 * 用 ESCAPE 子句指定转义符，把用户输入里的 % 和 _ 转义掉。
 * 这类"用户输入进入 LIKE"的场景是 SQL 注入之外最容易被忽略的坑。
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 把本地时间格式化成 YYYY-MM-DD（不能用 toISOString，它会按 UTC 算，东八区会差一天） */
export function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地时间的当前月份 'YYYY-MM' */
export function currentMonth(): string {
  return toLocalDate(new Date()).slice(0, 7);
}

/** 校验 'YYYY-MM' 或 'YYYY-MM-DD' 格式 */
export function isMonthString(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
}

export function isDateString(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
