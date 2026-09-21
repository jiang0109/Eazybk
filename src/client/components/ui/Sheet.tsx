/**
 * 底部弹层（移动端的标准交互）。
 *
 * 为什么不用 <dialog> 或第三方库？
 * 因为需求是"简洁、不过度设计"，而这个弹层只需要三层：
 * 遮罩 + 面板 + 下滑关闭。自己写反而更短，也更好控制动画。
 *
 * 用 framer-motion 的 AnimatePresence 实现进出场动画：
 * 组件被移除时动画还能播完，这是纯 CSS 做不到的。
 */

import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Sheet({ open, title, onClose, children }: SheetProps) {
  // 打开时锁定 body 滚动，避免背景跟着滑（移动端很容易忽略的细节）
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  // 按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          {/* 遮罩：点击关闭 */}
          <motion.div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />

          {/* 面板：移动端从底部升起，桌面端居中 */}
          <motion.div
            className="card relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-b-none sm:max-w-lg sm:rounded-2xl"
            style={{ backgroundColor: 'var(--color-surface)' }}
            initial={{ y: '100%', opacity: 0.6, scale: 1 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            <header className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold">{title}</h2>
              <button
                onClick={onClose}
                aria-label="关闭"
                className="rounded-full p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </header>

            <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-safe">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
