/**
 * ---------------------------------------------------------------------------
 * 权限校验（authorization）—— PostgreSQL 版
 * ---------------------------------------------------------------------------
 * 认证（authentication）= 你是谁；授权（authorization）= 你能动什么。
 * 这个文件管的是后者。
 *
 * 多用户系统里最危险的漏洞叫 **IDOR**（Insecure Direct Object Reference）：
 * 接口只检查"你登录了吗"，不检查"这条数据是你的吗"。
 * 于是攻击者把 URL 里的 id 从 5 改成 6，就能读改删别人的数据。
 *
 * 防御的核心思路：**每一次按 id 操作数据，都要把 user_id 带进 WHERE 条件。**
 * 而不是"先查出来，再用 if 判断是不是自己的"—— 后者容易漏、也容易写错。
 *
 *     ✓ 正确：UPDATE ... WHERE id = $1 AND user_id = $2
 *     ✗ 危险：if (row.user_id === me) { UPDATE ... WHERE id = $1 }
 *
 * 迁移差异：所有函数变成 async（PG 是网络数据库）。
 * 另外这里顺便让函数**返回需要的属性**，省掉"校验一次、再查一次"的往返 ——
 * 在本地文件数据库上往返成本可以忽略，但经过网络访问托管数据库时，
 * 每一次多余往返都是实打实的延迟。
 */

import { get } from '../db/pg.ts';
import { HttpError } from '../http.ts';

/**
 * 断言账户属于该用户，返回账户信息（名称、余额等）。
 *
 * 不存在和"不属于你"返回**同样**的错误信息 —— 否则攻击者能通过
 * 报错差异探测出"哪些 id 是存在的"（这叫枚举攻击）。
 */
export async function requireOwnedAccount(
  userId: number,
  accountId: number,
): Promise<{ id: number; name: string; balanceCents: number }> {
  const row = await get<{ id: number; name: string; balance_cents: number }>(
    `SELECT id::int, name, balance_cents FROM accounts WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
  if (!row) throw new HttpError(400, '选择的账户不存在');
  return { id: row.id, name: row.name, balanceCents: row.balance_cents };
}

/** 断言分类属于该用户，返回它的类型（用于校验收入/支出是否匹配） */
export async function requireOwnedCategory(
  userId: number,
  categoryId: number,
): Promise<{ id: number; kind: string }> {
  const row = await get<{ id: number; kind: string }>(
    `SELECT id::int, kind FROM categories WHERE id = $1 AND user_id = $2`,
    [categoryId, userId],
  );
  if (!row) throw new HttpError(400, '选择的分类不存在');
  return { id: row.id, kind: row.kind };
}

/** 断言分类属于该用户，并返回它是不是二级分类（用于"最多两级"的校验） */
export async function requireOwnedCategoryWithParent(
  userId: number,
  categoryId: number,
): Promise<{ id: number; kind: string; parentId: number | null }> {
  const row = await get<{ id: number; kind: string; parent_id: number | null }>(
    `SELECT id::int, kind, parent_id::int FROM categories WHERE id = $1 AND user_id = $2`,
    [categoryId, userId],
  );
  if (!row) throw new HttpError(400, '选择的分类不存在');
  return { id: row.id, kind: row.kind, parentId: row.parent_id };
}

/** 断言某笔流水属于该用户（修改 / 删除前必须调用） */
export async function requireOwnedTransaction(userId: number, txId: number): Promise<void> {
  const row = await get<{ id: number }>(
    `SELECT id::int FROM transactions WHERE id = $1 AND user_id = $2`,
    [txId, userId],
  );
  if (!row) throw new HttpError(404, '这笔记录不存在');
}
