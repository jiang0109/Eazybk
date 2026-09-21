/**
 * ---------------------------------------------------------------------------
 * 应用外壳：顶部栏 + 内容区 + 底部导航 + 悬浮记账按钮
 * ---------------------------------------------------------------------------
 * 布局策略是"移动优先"：
 *   - 内容最大宽度限制在 2xl（672px）并居中，桌面端不会拉成一条长横线
 *   - 底部导航固定，适配 iPhone 安全区
 *   - 悬浮按钮用"fixed 容器 + absolute 定位"对齐到内容区右边缘
 *
 * 页签切换用 AnimatePresence 的 mode="wait"：等旧页面淡出再让新页面淡入，
 * 避免两个页面重叠导致布局跳动。
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useUi, type TabKey } from '../../store/ui';
import { useAuth } from '../../store/auth';
import { LedgerPage } from '../ledger/LedgerPage';
import { TransactionEditor } from '../ledger/TransactionEditor';
import { StatsPage } from '../stats/StatsPage';
import { ManagePage } from '../manage/ManagePage';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';

const TABS: { key: TabKey; label: string; icon: (active: boolean) => ReactNode }[] = [
  {
    key: 'ledger',
    label: '明细',
    icon: (active) => (
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5v-13Z" strokeLinejoin="round" />
        <path d="M8 8h7M8 12h7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'stats',
    label: '统计',
    icon: (active) => (
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <path d="M12 3a9 9 0 1 0 9 9h-9V3Z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'manage',
    label: '管理',
    icon: (active) => (
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function AppShell() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const openEditor = useUi((s) => s.openEditor);
  const resetForNewUser = useUi((s) => s.resetForNewUser);

  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      // 关键：把所有的 UI 状态（当前页签、选中月份、数据版本号）清掉。
      // 否则换一个账号登录后，界面可能还停在"上一个人的月份"，
      // 甚至出现"先闪过一丝上一个人的数据"这种很难查的问题。
      resetForNewUser();
      setAccountOpen(false);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col">
      {/* ---------- 顶部栏 ---------- */}
      <header className="sticky top-0 z-30 border-b border-line/70 bg-base/85 pt-safe backdrop-blur-xl">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-base font-semibold tracking-tight">
            记账
            <span className="ml-2 text-xs font-normal text-ink-3">Ledger · SQLite</span>
          </h1>

          <button
            onClick={() => setAccountOpen(true)}
            className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:text-ink"
            title="账号"
          >
            {user?.isDemo && (
              <span className="font-medium" style={{ color: 'var(--color-accent)' }}>
                演示
              </span>
            )}
            <span className="max-w-[7rem] truncate">{user?.name ?? ''}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* 演示账号的提示条：说明数据是公开的，避免访客误以为这是私人账本 */}
        {user?.isDemo && (
          <p
            className="px-4 py-1.5 text-center text-[11px]"
            style={{ backgroundColor: 'var(--color-accent-soft)', color: 'var(--color-accent)' }}
          >
            演示账号：数据公开，可随意增删改 · 在「管理」页可一键恢复
          </p>
        )}
      </header>

      {/* ---------- 内容区 ---------- */}
      <main className="flex-1 px-4 pt-4 pb-28">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            /* 同样只动 y 不动 opacity：内容可见性不能依赖动画跑完（见 FadeIn.tsx） */
            initial={{ y: 8 }}
            animate={{ y: 0 }}
            exit={{ y: -6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {tab === 'ledger' && <LedgerPage />}
            {tab === 'stats' && <StatsPage />}
            {tab === 'manage' && <ManagePage />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ---------- 悬浮记账按钮 ----------
          按钮要对齐到"内容区（max-w-2xl 居中）"的右边缘，而不是视口右边缘。
          一开始我用了 right-[max(1rem,calc(50%-21rem))] 这种任意值类名，
          但 Tailwind 不认含空格的 calc 表达式，这条类没被生成 ——
          按钮于是跑到屏幕外，把整个页面撑出横向滚动，右侧内容全被切掉。
          换成 fixed 容器 + absolute 定位后就不依赖脆弱的任意值了。 */}
      <div className="pointer-events-none fixed inset-0 z-30">
        <div className="relative mx-auto h-full max-w-2xl">
          <motion.button
            onClick={() => openEditor(null)}
            aria-label="记一笔"
            className="pointer-events-auto absolute bottom-24 right-4 grid size-14 place-items-center rounded-full shadow-xl shadow-black/40"
            style={{ backgroundColor: 'var(--color-accent)' }}
            /* 刻意不给入场动画：一开始写成 initial={{ scale: 0 }} + spring，
               结果在渲染时序稍有不同时（比如首屏首帧就被截图/快照），
               按钮会停在 scale 0 的初始状态，等于「记账入口消失」。
               这是个功能按钮，可见性不能依赖动画是否跑完。 */
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.93 }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a1205" strokeWidth="2.6">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </motion.button>
        </div>
      </div>

      {/* ---------- 底部导航 ---------- */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-line/70 bg-base/90 backdrop-blur-xl">
        <div
          className="mx-auto flex max-w-2xl items-stretch justify-around px-2 pt-1.5"
          style={{ paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="relative flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 transition-colors"
                style={{ color: active ? 'var(--color-accent)' : 'var(--color-ink-3)' }}
              >
                {t.icon(active)}
                <span className="text-[10px] font-medium">{t.label}</span>

                {/* 选中指示条：layoutId 让它平滑地在页签之间滑动 */}
                {active && (
                  <motion.span
                    layoutId="tab-indicator"
                    className="absolute -top-[7px] h-[2px] w-8 rounded-full"
                    style={{ backgroundColor: 'var(--color-accent)' }}
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* ---------- 记账弹层（全局唯一实例，新增/编辑共用）---------- */}
      <TransactionEditor />

      {/* ---------- 账号弹层 ---------- */}
      <Sheet open={accountOpen} title="账号" onClose={() => setAccountOpen(false)}>
        <div className="space-y-4">
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-sm font-medium">{user?.name}</p>
            <p className="mt-0.5 text-xs text-ink-3">
              @{user?.username}
              {user?.isDemo && ' · 演示账号'}
            </p>
          </div>

          {user?.isDemo && (
            <p className="text-xs leading-relaxed text-ink-3">
              你现在用的是公开的演示账号，任何人打开这个网址看到的都是同一份数据。
              想记录自己的账目，请退出后注册一个账号。
            </p>
          )}

          <Button className="w-full" variant="ghost" loading={loggingOut} onClick={doLogout}>
            退出登录
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
