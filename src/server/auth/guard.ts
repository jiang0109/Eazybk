/**
 * ---------------------------------------------------------------------------
 * 权限校验（authorization）
 * ---------------------------------------------------------------------------
 * 认证（authentication）= 你是谁；授权（authorization）= 你能动什么。
 * 这个文件管的是后者。
 *
 * 多用户系统里最危险的漏洞叫 **IDOR**（Insecure Direct Object Reference，
 * 不安全的直接对象引用）：接口只检查"你登录了吗"，不检查"这条数据是你的吗"。
 * 于是攻击者把 URL 里的 id 从 5 改成 6，就能读改删别人的数据。
 *
 * 防御的核心思路：**每一次按 id 操作数据，都要把 user_id 带进 WHERE 条件。**
 * 而不是"先查出来，再用 if 判断是不是自己的"—— 后者容易漏、也容易写错。
 *
 *     ✓ 正确：UPDATE ... WHERE id = ? AND user_id = ?
 *     ✗ 危险：if (row.user_id === me) { UPDATE ... WHERE id = ? }
 *
 * 第一种写法即使你忘了判断也不会泄露；第二种只要漏一个 if 就出事。
 * 所以本文件里的函数都返回"带 user_id 校验的查询结果"，而不是布尔值。
 */

import { get } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http.ts';

/**
 * 断言某个账户属于该用户，返回账户信息。
 * 不存在和"不属于你"返回**同样**的错误信息 —— 否则攻击者能通过
 * 报错差异探测出"哪些 id 是存在的"（这叫枚举攻击）。
 */
export function requireOwnedAccount(db: Db, userId: number, accountId: number): { id: number; name: string } {
  const row = get<{ id: number; name: string }>(
    db,
    `SELECT id, name FROM accounts WHERE id = ? AND user_id = ?`,
    accountId,
    userId,
  );
  if (!row) throw new HttpError(400, '选择的账户不存在');
  return row;
}

/** 断言某个分类属于该用户。转账场景下 categoryId 为 null，直接放行 */
export function requireOwnedCategory(
  db: Db,
  userId: number,
  categoryId: number,
): { id: number; kind: string } {
  const row = get<{ id: number; kind: string }>(
    db,
    `SELECT id, kind FROM categories WHERE id = ? AND user_id = ?`,
    categoryId,
    userId,
  );
  if (!row) throw new HttpError(400, '选择的分类不存在');
  return row;
}

/** 断言某笔流水属于该用户（修改 / 删除前必须调用） */
export function requireOwnedTransaction(db: Db, userId: number, txId: number): void {
  const row = get<{ id: number }>(
    db,
    `SELECT id FROM transactions WHERE id = ? AND user_id = ?`,
    txId,
    userId,
  );
  if (!row) throw new HttpError(404, '这笔记录不存在');
}
