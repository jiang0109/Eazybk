/**
 * ---------------------------------------------------------------------------
 * Cookie 读写
 * ---------------------------------------------------------------------------
 * 自己解析，不引第三方库 —— 格式很简单（分号分隔的 key=value），
 * 而且这样你能看清 Cookie 的每个安全属性到底在防什么。
 */

import { getHeader } from '../http.ts';

/** 会话 Cookie 的名字 */
export const SESSION_COOKIE = 'ledger_session';

/** 会话有效期（天） */
export const SESSION_DAYS = 30;

/** 从请求头里解析出所有 Cookie */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 生成 Set-Cookie 的值。
 *
 * 四个属性各自防什么：
 *   HttpOnly  —— JavaScript 读不到这个 Cookie（document.cookie）。
 *                这是防 XSS 的核心：即使页面被注入了恶意脚本，
 *                它也偷不走会话令牌。
 *   SameSite=Lax —— 跨站请求默认不带这个 Cookie，大幅降低 CSRF 风险。
 *                用 Lax 而不是 Strict：Strict 会导致"从别的网站点链接进来
 *                变成未登录状态"，体验很怪。Lax 允许顶级导航携带，日常够用。
 *   Path=/    —— 全站有效
 *   Max-Age   —— 过期时间，让浏览器自己清理
 *   Secure    —— 只在 HTTPS 下发送。本地开发是 http，所以生产才加。
 */
export function serializeSessionCookie(token: string, opts: { secure: boolean }): string {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 生成"删除 Cookie"的 Set-Cookie（退出登录用） */
export function serializeClearCookie(opts: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 是否启用 Secure 标记（只允许 HTTPS 传输会话 Cookie）。
 *
 * ⚠️ 这里**不能**用 NODE_ENV 来判断，原因很实际：
 *   Vite 在构建时会读取 .env，如果 .env 里写了 NODE_ENV=development，
 *   前端就会被打包成**开发版 React**（体积从 211 kB 涨到 396 kB，
 *   还带一堆开发期警告）。我正是这样踩了一次 —— 部署前才发现。
 *   所以 NODE_ENV 留给工具链用，应用自己的开关另起名字。
 *
 * 判断顺序：
 *   1. 显式开关 SECURE_COOKIES=1/0（最高优先级，便于本地强制测试）
 *   2. 反向代理头 x-forwarded-proto（Render / Railway / Fly 都会设置）
 *      —— 线上是 "https"，所以这一条就能自动生效，不需要额外配置
 *   3. 请求自身的协议（直连且有 TLS 时）
 *
 * 为什么不硬编码 "生产就加 Secure"？
 *   因为"是不是生产"是个模糊概念，而"这个请求是不是 HTTPS"是确定的。
 *   直接看事实比看一个需要人工维护的标志可靠。
 */
export function shouldUseSecureCookie(req?: Request): boolean {
  const explicit = process.env.SECURE_COOKIES;
  if (explicit === '1') return true;
  if (explicit === '0') return false;

  if (req) {
    // 代理终止 TLS 时，真实协议在这个头里
    const forwarded = getHeader(req, 'x-forwarded-proto');
    if (forwarded) return forwarded.split(',')[0].trim() === 'https';

    try {
      if (new URL(req.url, 'http://localhost').protocol === 'https:') return true;
    } catch {
      /* url 不合法就当作 http */
    }
  }

  return false;
}
