/**
 * ---------------------------------------------------------------------------
 * 登录闸门
 * ---------------------------------------------------------------------------
 * 启动流程：
 *   1. 先问服务端"我登录了吗"（GET /api/auth/me）
 *   2. 问的过程显示一个骨架屏 —— **不能直接跳登录页**
 *      否则已登录的用户每次刷新都会看到登录页闪一下，体验很差
 *   3. 未登录 → 登录页；已登录 → 主应用
 *
 * 再强调一次：这个组件只负责"显示什么"，不是安全边界。
 * 真正拦住未登录请求的是服务端的认证闸门（api.ts 里默认拒绝的那个判断）。
 */

import { useEffect } from 'react';
import { useAuth } from '../../store/auth';
import { AppShell } from '../layout/AppShell';
import { LoginPage } from './LoginPage';

export function AuthGate() {
  const checked = useAuth((s) => s.checked);
  const user = useAuth((s) => s.user);
  const bootstrap = useAuth((s) => s.bootstrap);

  // 只在挂载时问一次
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!checked) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span
            className="size-6 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: 'var(--color-line)', borderTopColor: 'var(--color-accent)' }}
          />
          <p className="text-xs text-ink-3">正在检查登录状态…</p>
        </div>
      </div>
    );
  }

  return user ? <AppShell /> : <LoginPage />;
}
