/**
 * 通用按钮与输入框。
 *
 * 保持极简：只有两种按钮（主按钮 / 次级按钮）和一种输入框。
 * 需求里说"不要过度设计"，所以不做 variant 系统，直接是明确的几个组件。
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'ghost';
  loading?: boolean;
}

export function Button({ children, variant = 'primary', loading = false, className = '', style, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50';

  const styles =
    variant === 'primary'
      ? 'text-[#1a1205] hover:brightness-110'
      : 'bg-surface-2 text-ink-2 hover:text-ink border border-line';

  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`${base} ${styles} ${className}`}
      // 主按钮的背景色用 CSS 变量（来自 @theme 的 --color-accent），
      // 调用方可以用 style 覆盖它（比如删除按钮要变成红色）
      style={variant === 'primary' ? { backgroundColor: 'var(--color-accent)', ...style } : style}
    >
      {loading && (
        // 加载指示器：按钮内的小转圈
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

/** 文本输入框。注意深色主题下要给 placeholder 单独的弱化颜色。 */
export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`w-full rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent ${className}`}
    />
  );
}

/** 表单里的一行：左侧标签 + 右侧控件 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2">
      <span className="w-16 shrink-0 text-sm text-ink-2">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 空状态：没有数据时给一句人话，而不是留一片空白 */
export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <span className="text-3xl opacity-70">{icon}</span>
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="max-w-[16rem] text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/** 加载骨架：比一个转圈更不容易让布局跳动 */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-1 py-3">
          <div className="skeleton size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-24" />
            <div className="skeleton h-3 w-16" />
          </div>
          <div className="skeleton h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
