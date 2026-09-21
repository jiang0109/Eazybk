/**
 * ---------------------------------------------------------------------------
 * 认证状态的客户端管理
 * ---------------------------------------------------------------------------
 * 只有三件事：查当前登录状态、登录、退出。
 *
 * 一个刻意的设计：**前端不缓存"我是谁"的判断**。
 *   user 只是"界面上要显示什么"的依据，真正的授权永远在服务端 ——
 *   每个请求都会重新按 cookie 里的会话查一遍。
 *   所以即使有人改了前端状态把界面"显示成已登录"，他也读不到任何数据，
 *   只会看到一堆 401。
 *   这一点很重要：**前端的状态只是 UI 状态，不是安全边界。**
 */

import { create } from 'zustand';
import type { AuthUser } from '@shared/types';

interface AuthState {
  user: AuthUser | null;
  /** 是否已经问过服务端"我登录了吗"。没问过之前不能急着跳登录页 */
  checked: boolean;
  /** 正在提交登录/注册表单 */
  busy: boolean;

  /** 启动时调用一次 */
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (input: { username: string; password: string; name?: string }) => Promise<void>;
  loginAsDemo: () => Promise<void>;
  logout: () => Promise<void>;
  /** 被服务端告知会话失效时调用（比如 token 过期） */
  clear: () => void;
}

/** 统一的请求封装：自动带 cookie，出错时抛出可读的消息 */
async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = (data as { error?: string })?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new Error(message);
  }
  return data as T;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  checked: false,
  busy: false,

  bootstrap: async () => {
    try {
      const data = await authRequest<{ user: AuthUser | null }>('/api/auth/me');
      set({ user: data.user, checked: true });
    } catch {
      // 查不通（比如服务器刚起来还没就绪）就当作未登录，
      // 但仍然标记 checked —— 否则界面会永远卡在加载态。
      set({ user: null, checked: true });
    }
  },

  login: async (username, password) => {
    set({ busy: true });
    try {
      const data = await authRequest<{ user: AuthUser }>('/api/auth/login', { username, password });
      set({ user: data.user });
    } finally {
      set({ busy: false });
    }
  },

  register: async (input) => {
    set({ busy: true });
    try {
      const data = await authRequest<{ user: AuthUser }>('/api/auth/register', input);
      set({ user: data.user });
    } finally {
      set({ busy: false });
    }
  },

  loginAsDemo: async () => {
    set({ busy: true });
    try {
      const data = await authRequest<{ user: AuthUser }>('/api/auth/demo', {});
      set({ user: data.user });
    } finally {
      set({ busy: false });
    }
  },

  logout: async () => {
    try {
      await authRequest('/api/auth/logout', {});
    } finally {
      // 无论服务端是否成功，本地都要清干净
      set({ user: null });
    }
  },

  clear: () => set({ user: null }),
}));
