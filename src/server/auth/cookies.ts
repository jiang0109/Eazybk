/**
 * ---------------------------------------------------------------------------
 * Cookie 读写
 * ---------------------------------------------------------------------------
 * 自己解析，不引第三方库 —— 格式很简单（分号分隔的 key=value），
 * 而且这样你能看清 Cookie 的每个安全属性到底在防什么。
 */

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
 * 是否启用 Secure 标记。
 * 本地开发（http）不能加 Secure，否则浏览器根本不会保存这个 Cookie —— 这是新手常踩的坑。
 */
export function shouldUseSecureCookie(): boolean {
  return process.env.NODE_ENV === 'production';
}
