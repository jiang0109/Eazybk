/**
 * ---------------------------------------------------------------------------
 * 密码哈希
 * ---------------------------------------------------------------------------
 * 三条铁律，一条都不能破：
 *
 *   1. **永远不存明文密码。** 数据库泄露时，明文等于把所有用户的密码（以及他们
 *      在别的网站复用的同一密码）直接送出去。
 *
 *   2. **不用 SHA-256/MD5 这类"快"哈希。** 它们为速度设计，GPU 每秒能算几十亿次，
 *      弱密码瞬间被彩虹表或暴力破解攻破。密码必须用**慢哈希**：
 *      scrypt / bcrypt / argon2 故意让每次计算耗时几十到几百毫秒，
 *      把暴力破解的成本抬高几个数量级。
 *
 *   3. **每个密码用独立的随机 salt。** 否则两个用户设了同样的密码，
 *      哈希值会一模一样：攻击者一眼看出"这两个人密码相同"，
 *      而且可以用一张预先算好的表同时破解所有相同密码的账号。
 *
 * 这里用 Node 内置的 `crypto.scrypt`，不需要任何第三方依赖。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 派生密钥长度 */
const KEY_LEN = 64;

/**
 * scrypt 参数。
 *
 * ⚠️ 这里有个真实的坑：Node 的 scrypt 默认 `maxmem` 是 **32 MB**，
 * 而 N=16384、r=8 需要的实际内存约为 `128 * N * r` = **128 MB**，
 * 远超默认上限 —— 不显式放宽 maxmem 的话，哈希函数会直接抛错
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。
 *
 * （我第一次写就踩了这个，而且因为第一版代码在别处先抛了错，
 *  这个错被掩盖过去了。这类"默认值不够用"的问题，光看 API 名字是发现不了的。）
 */
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  // 给足内存上限，并留一点余量
  maxmem: 64 * 1024 * 1024,
} as const;

/**
 * 生成密码哈希。
 *
 * 存储格式（自己定，够用就好）：
 *   scrypt$<salt的hex>$<派生密钥的hex>
 *
 * 为什么把 salt 和参数一起存进字符串里？
 *   因为以后你可能调高 N 让哈希变慢，那时老用户的哈希是用老参数算的，
 *   必须知道当初用的是哪套参数才能验证。写进存储格式就自带了这个信息。
 *   （真实系统通常还会存一个算法版本号，方便将来整体升级。）
 *
 * 关于"为什么用同步版本"：
 *   scrypt 本身是 CPU 密集的，无论同步还是异步都会占住线程。
 *   Node 的异步 scrypt 会把它丢到线程池，但校验密码时我们本来就要
 *   等这个结果才能继续，对单个请求来说没有差别。
 *   用同步版本让代码更直白（不用 async/await 传染到所有调用链）。
 *   真正高并发的系统会考虑用独立的认证服务来隔离这种 CPU 开销。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * 校验密码。
 *
 * 关键点：比较时必须用 **timingSafeEqual**（恒定时间比较），不能用 `===`。
 *
 * 为什么？普通字符串比较是"发现第一个不同的字符就返回 false"，
 * 所以比较耗时和前多少个字符匹配相关。攻击者可以通过精确测量响应时间，
 * 逐个字符把哈希值试出来（时序攻击 / timing attack）。
 * timingSafeEqual 无论内容如何都花同样的时间。
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  // 没有密码的用户（演示账号、迁移前的旧用户）不允许用密码登录
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, saltHex, expectedHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');

  const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);

  // 长度不等时 timingSafeEqual 会抛错，所以先挡一下
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 生成随机会话令牌（和密码不是一回事）。
 *
 * 会话令牌需要的是**不可预测性**，不是"慢" —— 它每个请求都要验证，
 * 用慢哈希会让每个请求都卡 100ms。所以用 CSPRNG 生成足够长的随机串即可。
 * 32 字节 = 256 bit，暴力猜中的概率可以忽略。
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
