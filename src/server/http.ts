/**
 * 统一的响应格式与错误处理。
 *
 * 为什么要统一？
 *   前端需要一套**可预测**的约定来判断成功与失败。
 *   如果错误信息散落在各个 handler 里，前端就要写一堆 if 判断。
 */

export interface ApiError {
  error: string;
}

/**
 * 读取一个请求头，兼容两种请求对象。
 *
 * 为什么不直接用 `req.headers.get(...)`？
 *   因为本项目有两类请求对象：
 *     - 开发/生产：node:http 的 IncomingMessage，`headers` 是普通对象，
 *       取值用 `req.headers['cookie']`（值可能是 string 或 string[]）
 *     - 冒烟测试/未来可能的 edge 运行时：Web 标准的 Request，
 *       `headers` 是 Headers 实例，取值用 `req.headers.get('cookie')`
 *
 * 这个差异非常隐蔽：测试全绿、开发也正常，只有生产环境用 node 服务器时会崩。
 * （我就踩了这个 —— 一开始只写了 Web 版本，生产服务器收到第一个请求就退出了。
 *  更糟的是请求处理器当时没有 try/catch，一个 500 直接把整个进程带走。）
 *
 * 教训：**测试用的请求对象要和真实运行环境一致**，否则测了个寂寞。
 */
export function getHeader(req: unknown, name: string): string | null {
  const headers = (req as { headers?: unknown }).headers;
  if (!headers) return null;

  // Web 标准 Headers
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }

  // node:http 的普通对象
  const value = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * 带状态码的业务异常。
 * handler 里 throw new HttpError(400, '金额格式不对')，路由层会统一转成 JSON。
 *
 * 注意：这里没有用 TypeScript 的"参数属性"写法
 * （constructor(public status: number)）。
 * 因为 Node 直接运行 .ts 文件时是"只剥离类型不做转换"（strip-only），
 * 参数属性需要生成额外的赋值代码，所以不被支持。
 * 这类语法限制是"零构建"方案的代价，知道就好。
 */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 把数据库的英文报错翻译成人能看懂的话。
 *
 * 这一步很有价值：数据库约束报错（CHECK / FOREIGN KEY / UNIQUE）是
 * **我们故意设计出来的保护**，不应该以 "violates check constraint ..."
 * 这种形式丢给用户。数据库负责拦住错误数据，应用负责把原因说清楚。
 *
 * 迁移提示：PostgreSQL 的错误格式和 SQLite 完全不同。
 *   SQLite: "CHECK constraint failed: transactions"
 *   PG    : "new row for relation \"transactions\" violates check constraint \"transactions_check\""
 * 而且 PG 还有一个**错误码**（err.code）比匹配文本可靠得多：
 *   23514 check_violation
 *   23503 foreign_key_violation
 *   23505 unique_violation
 *   23502 not_null_violation
 *   42P01 undefined_table
 *   42703 undefined_column
 *   57P03 cannot_connect_now（服务正在启动/挂起中）
 * 所以下面优先按 code 判断，文本匹配只作为兜底。
 */
export function translateSqliteError(err: unknown): { status: number; message: string } | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  const code = (err as { code?: string }).code;

  // --- 优先按 PG 的 SQLSTATE 错误码判断（可靠）---
  if (code === '23514') {
    // check_violation：具体是哪张表的哪条约束，从 message 里看
    if (/transactions/i.test(msg)) {
      return {
        status: 400,
        message: '这笔账的数据不符合规则：收入/支出必须选分类，转账不能有分类，金额不能为 0',
      };
    }
    if (/categories/i.test(msg)) {
      return { status: 400, message: '分类数据不符合规则（类型只能是收入或支出）' };
    }
    return { status: 400, message: '数据不符合业务规则，请检查后重试' };
  }

  if (code === '23503') {
    return { status: 400, message: '引用了不存在的账户或分类，请刷新后重试' };
  }

  if (code === '23505') {
    if (/users_username|ux_users_username/i.test(msg)) {
      return { status: 409, message: '这个用户名已经被注册了' };
    }
    if (/categories/i.test(msg)) {
      return { status: 409, message: '已经有同名的分类了' };
    }
    if (/accounts/i.test(msg)) {
      return { status: 409, message: '已经有同名的账户了' };
    }
    return { status: 409, message: '这条数据已经存在了' };
  }

  if (code === '23502') {
    return { status: 400, message: '有必填字段没有填写' };
  }

  // 22007/22008：日期格式或范围错误。PG 的 date 类型会直接拒绝非法日期，
  // 而 SQLite 要靠 GLOB 约束 —— 这里给出统一的友好提示。
  if (code === '22007' || code === '22008') {
    return { status: 400, message: '日期格式不正确或不是真实存在的日期' };
  }

  if (code === '42P01') {
    return { status: 500, message: '数据库表不存在，请执行 npm run db:init 初始化' };
  }
  if (code === '42703') {
    return { status: 500, message: '数据库结构与代码不一致，请执行迁移（npm run db:migrate）' };
  }

  // Neon 的计算在闲置后会挂起，唤醒过程中可能出现连接类错误。
  // 这类问题通常重试一次就好，所以给一个"稍后重试"的提示而不是通用 500。
  if (code === '57P03' || /ECONNREFUSED|ETIMEDOUT|Connection terminated|timeout expired/i.test(msg)) {
    return { status: 503, message: '数据库暂时不可用（可能正在从闲置状态唤醒），请稍后重试' };
  }

  // --- 兜底：按文本匹配（跨数据库兼容，也应对没有 code 的情况）---
  if (/violates check constraint/i.test(msg)) {
    return { status: 400, message: '数据不符合业务规则，请检查后重试' };
  }
  if (/foreign key constraint/i.test(msg)) {
    return { status: 400, message: '引用了不存在的账户或分类，请刷新后重试' };
  }
  if (/duplicate key value/i.test(msg)) {
    return { status: 409, message: '这条数据已经存在了' };
  }
  if (/子分类的类型必须和父分类一致/.test(msg)) {
    return { status: 400, message: '子分类的类型必须和父分类一致' };
  }
  if (/no such (table|column)/i.test(msg)) {
    return { status: 500, message: '数据库结构与代码不一致，请执行迁移（npm run db:migrate）' };
  }
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return { status: 503, message: '数据库正忙（可能有并发写入），请稍后重试' };
  }

  return null;
}
