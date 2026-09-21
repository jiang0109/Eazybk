/**
 * 请求体解析与字段校验。
 *
 * 新手最容易忽略的一点：**前端的校验只是体验优化，不是安全措施。**
 * 任何人都能用 curl 直接打你的接口，绕过所有前端校验。
 * 所以每一个进入数据库的值都必须在服务端校验。
 */

import type { IncomingMessage } from 'node:http';
import { HttpError } from './http.ts';
import type { AccountType, CategoryKind, TxType } from '../shared/types.ts';

/**
 * 读取请求体。
 *
 * 这个函数要同时支持两种请求对象，因为开发环境和生产环境的入口不同：
 *   - 开发：Vite 中间件把 node:http 的 IncomingMessage 交给我们（异步可迭代）
 *   - 生产：同一份代码，但形式上是 Web 标准的 Request
 * 而且写了冒烟测试之后，测试里直接用 Request 构造请求，
 * 如果不支持这一种，测试就会在"读 body"这一步失败。
 *
 * 统一在这里做一次适配，比在每个 handler 里判断要干净得多。
 */
export async function readJsonBody(req: IncomingMessage | Request, maxBytes = 64 * 1024): Promise<unknown> {
  let text: string;

  if (typeof (req as Request).json === 'function') {
    // Web 标准的 Request
    text = await (req as Request).text();
    if (text.length > maxBytes) throw new HttpError(413, '请求体过大');
  } else {
    // node:http 的 IncomingMessage：异步可迭代
    const nodeReq = req as IncomingMessage;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of nodeReq) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBytes) throw new HttpError(413, '请求体过大');
      chunks.push(buf);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }

  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
}

export function asObject(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象');
  }
  return v as Record<string, unknown>;
}

export function asString(v: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string {
  const { max = 200, required = true } = opts;
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `缺少字段：${field}`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const trimmed = v.trim();
  if (required && trimmed === '') throw new HttpError(400, `${field} 不能为空`);
  if (trimmed.length > max) throw new HttpError(400, `${field} 太长了（最多 ${max} 个字符）`);
  return trimmed;
}

export function asInt(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new HttpError(400, `${field} 必须是整数`);
  }
  if (n < min || n > max) throw new HttpError(400, `${field} 超出允许范围`);
  return n;
}

export function asEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new HttpError(400, `${field} 只能是：${allowed.join(' / ')}`);
  }
  return v as T;
}

export const TX_TYPES = ['expense', 'income', 'transfer'] as const satisfies readonly TxType[];
export const CATEGORY_KINDS = ['expense', 'income'] as const satisfies readonly CategoryKind[];
export const ACCOUNT_TYPES = ['cash', 'bank', 'credit', 'ewallet', 'investment'] as const satisfies readonly AccountType[];

/**
 * 金额解析：把用户输入的"元"转成数据库里的"分"。
 *
 * 这是全项目最容易出精度问题的一处。绝对不能用 `parseFloat(x) * 100`：
 *   parseFloat('19.99') * 100 = 1998.9999999999998  → Math.round 才是 1999，
 *   但 parseFloat('1.005') * 100 = 100.49999999999999 → 会错成 100 分。
 * 所以直接把字符串拆成"整数部分 + 小数部分"来处理：
 *   '19.99' → 19 * 100 + 99 = 1999
 * 全程整数运算，没有浮点数参与。
 */
export function parseYuanToCents(input: unknown, field = '金额'): number {
  const raw = typeof input === 'number' ? String(input) : input;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpError(400, `${field}不能为空`);
  }

  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new HttpError(400, `${field}格式不正确，最多两位小数（例如 19.99）`);
  }

  const [intPart, decPart = ''] = s.split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));

  if (cents <= 0) throw new HttpError(400, `${field}必须大于 0`);
  if (cents > 100_000_000_00) throw new HttpError(400, `${field}太大了`);
  return cents;
}

/** 校验日期格式，并拒绝明显不合理的日期（比如 2030 年） */
export function asDate(v: unknown, field = '日期'): string {
  const s = asString(v, field, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new HttpError(400, `${field}格式必须是 YYYY-MM-DD`);
  }
  // 用 Date 反过来验证：2026-02-31 会被规范化成 3 月 3 日，说明原值非法
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new HttpError(400, `${field}不是一个真实存在的日期`);
  }
  if (y < 2000 || y > 2100) throw new HttpError(400, `${field}的年份超出合理范围`);
  return s;
}

/** 校验月份 'YYYY-MM' */
export function asMonth(v: unknown, field = '月份'): string {
  const s = asString(v, field, { max: 7 });
  if (!/^\d{4}-\d{2}$/.test(s)) throw new HttpError(400, `${field}格式必须是 YYYY-MM`);
  const m = Number(s.slice(5));
  if (m < 1 || m > 12) throw new HttpError(400, `${field}不是一个真实存在的月份`);
  return s;
}

/** 可选的月份参数（不传时返回 undefined，表示"全部"） */
export function optionalMonth(v: string | null, field = '月份'): string | undefined {
  if (v === null || v === '') return undefined;
  return asMonth(v, field);
}
