/**
 * Zustand 状态管理。
 *
 * 这里只放**跨组件共享的 UI 状态**：当前页签、选中的月份、弹窗开关，
 * 以及一个用于触发重新拉取数据的版本号。
 *
 * 为什么不用 Zustand 存业务数据？
 * 因为业务数据的唯一真相在数据库里。把流水列表也放进 store 就多了一份副本，
 * 你得手动保证副本和数据库同步 —— 这正是大量前端 bug 的来源。
 * 所以这里的规矩是：**store 存 UI 状态，数据库存数据；改完数据就让 version +1，
 * 订阅了它的组件会自动重新查询。**
 */

import { create } from 'zustand';
import type { Transaction } from '@shared/types';
import { thisMonth } from '../lib/format';

/** 底部导航的三个页签 */
export type TabKey = 'ledger' | 'stats' | 'manage';

const TAB_KEYS: TabKey[] = ['ledger', 'stats', 'manage'];

/**
 * 从 URL 里读初始页签，支持 ?tab=stats 这种直达链接。
 * 好处是可以把某一页的地址直接发出去，也方便自动化验证某个页面。
 * 值不合法时回退到"明细"。
 */
function initialTab(): TabKey {
  if (typeof window === 'undefined') return 'ledger';
  const value = new URLSearchParams(window.location.search).get('tab');
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : 'ledger';
}

interface UiState {
  // --- 导航 ---
  tab: TabKey;
  setTab: (tab: TabKey) => void;

  // --- 月份筛选（记账页和统计页共用同一个月份）---
  month: string;
  setMonth: (month: string) => void;

  // --- 记一笔 / 改一笔 弹窗 ---
  editorOpen: boolean;
  /** 正在编辑的流水；null 表示"新增" */
  editing: Transaction | null;
  openEditor: (tx?: Transaction | null) => void;
  closeEditor: () => void;

  // --- 数据版本号 ---
  // 任何写操作（增 / 删 / 改）之后 +1，订阅它的组件会重新查询数据库。
  // 这是最简单可靠的"数据失效"机制：不需要手写缓存更新逻辑。
  version: number;
  refresh: () => void;

  /** 换账号时把界面状态清干净，避免看到上一个用户残留的月份 / 数据 */
  resetForNewUser: () => void;
}

export const useUi = create<UiState>((set) => ({
  tab: initialTab(),
  setTab: (tab) => {
    set({ tab });
    // 同步到 URL，刷新后仍停在同一页（用 replaceState 不污染历史记录）
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (tab === 'ledger') url.searchParams.delete('tab');
      else url.searchParams.set('tab', tab);
      window.history.replaceState(null, '', url);
    }
  },

  month: thisMonth(),
  setMonth: (month) => set({ month }),

  editorOpen: false,
  editing: null,
  openEditor: (tx = null) => set({ editorOpen: true, editing: tx }),
  closeEditor: () => set({ editorOpen: false, editing: null }),

  version: 0,
  refresh: () => set((s) => ({ version: s.version + 1 })),

  /**
   * 重置界面状态。
   *
   * 为什么退出登录时必须调用它？
   *   因为 store 是模块级的单例，不会随组件卸载而清空。
   *   如果不清，A 用户退出、B 用户登录后，界面可能还停在 A 选中的那个月份，
   *   甚至因为 version 没有变化而继续显示 A 的缓存数据。
   *   这属于"看起来是 UI bug、实质是状态生命周期没管好"的问题。
   *
   * 注意 version 也是要重置的：它的作用是让 useFetch 重新拉数据，
   * 归零同样会触发一次变化（从 5 变 0 也是变化），效果一样。
   * 但为了让语义更清楚，这里显式 +1 一次。
   */
  resetForNewUser: () =>
    set((s) => ({
      tab: 'ledger',
      month: thisMonth(),
      editorOpen: false,
      editing: null,
      version: s.version + 1,
    })),
}));
