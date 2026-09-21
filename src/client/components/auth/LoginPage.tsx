/**
 * ---------------------------------------------------------------------------
 * 登录页
 * ---------------------------------------------------------------------------
 * 这个页面的首要任务不是"功能齐全"，而是**让面试官/访客在 3 秒内看到东西**。
 *
 * 所以有两条路径：
 *   1. 「一键体验演示账号」—— 一个大按钮，不用注册、不用记密码、不用等邮件。
 *      这是给访客准备的，也是这个页面最重要的元素。
 *   2. 注册 / 登录 —— 完整流程，给人真的想用的时候用。
 *
 * 为什么演示账号不用密码？
 *   因为要在前端硬编码一个演示密码的话，它等于公开写在仓库里。
 *   走"一键体验"接口，服务端直接以 is_demo 用户建会话，
 *   既不需要密码，也把"这是演示身份"这件事明确记录在会话里。
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../../store/auth';
import { Button, TextInput } from '../ui/Button';

type Mode = 'login' | 'register';

export function LoginPage() {
  const { login, register, loginAsDemo, busy } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!username.trim()) {
      setError('请输入用户名');
      return;
    }
    if (password.length < 8) {
      // 前端也校验一遍，但服务端才是权威（前端可以被绕过）
      setError('密码至少 8 位');
      return;
    }

    try {
      if (mode === 'login') {
        await login(username.trim(), password);
      } else {
        await register({ username: username.trim(), password, name: name.trim() || undefined });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    }
  };

  const enterDemo = async () => {
    setError(null);
    try {
      await loginAsDemo();
    } catch (err) {
      setError(err instanceof Error ? err.message : '演示账号暂时不可用');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <motion.div
        className="w-full max-w-sm"
        /* 只做位移，不用 opacity 入场 —— 见 FadeIn.tsx 里的详细说明：
           内容可见性不该依赖动画是否跑完。 */
        initial={{ y: 16 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* ---------- 标题 ---------- */}
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">记账 · Ledger</h1>
          <p className="mt-1.5 text-xs text-ink-3">
            一个用 SQLite 练手的记账应用
            <br />
            数据、约束、事务都在数据库里，不在 JavaScript 里
          </p>
        </div>

        {/* ---------- 一键体验（最重要的入口，放最上面） ---------- */}
        <section className="card overflow-hidden">
          <div className="border-b border-line px-5 py-4" style={{ backgroundColor: 'var(--color-accent-soft)' }}>
            <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--color-accent)' }}>
              <span>✨</span> 直接看效果？不用注册
            </h2>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
              进入预置的演示账号，里面有 14 个月的仿真记账数据
              （4 个账户、16 个分类、约 640 笔流水）。
              随便点、随便改，玩坏了可以一键恢复。
            </p>
          </div>
          <div className="p-4">
            <Button className="w-full" loading={busy} onClick={enterDemo}>
              一键体验演示账号
            </Button>
            <p className="mt-2.5 text-center text-[11px] leading-relaxed text-ink-3">
              注意：演示账号是公开的，任何人点进来看到的都是同一份数据。
              <br />
              所以<span className="text-ink-2">不要在里面记录真实账目</span>。
            </p>
          </div>
        </section>

        {/* ---------- 登录 / 注册 ---------- */}
        <section className="card mt-4 p-5">
          <div className="mb-4 flex rounded-xl border border-line bg-surface-2 p-1">
            {(
              [
                { key: 'login', label: '登录' },
                { key: 'register', label: '注册新账号' },
              ] as const
            ).map((t) => {
              const active = mode === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => {
                    setMode(t.key);
                    setError(null);
                  }}
                  className="flex-1 rounded-lg py-2 text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--color-surface)' : 'transparent',
                    color: active ? 'var(--color-ink)' : 'var(--color-ink-3)',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs text-ink-2" htmlFor="username">
                用户名
              </label>
              <TextInput
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={mode === 'register' ? '3-20 位字母、数字或下划线' : ''}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>

            {mode === 'register' && (
              <div>
                <label className="mb-1.5 block text-xs text-ink-2" htmlFor="name">
                  昵称（可选）
                </label>
                <TextInput
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="不填就用用户名"
                  maxLength={20}
                />
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-xs text-ink-2" htmlFor="password">
                密码
              </label>
              <TextInput
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 8 位' : ''}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                onKeyDown={(e) => {
                  // 回车直接提交，省得用鼠标找按钮
                  if (e.key === 'Enter') void submit();
                }}
              />
            </div>
          </div>

          {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <Button className="mt-4 w-full" loading={busy} onClick={submit}>
            {mode === 'login' ? '登录' : '注册并进入'}
          </Button>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-3">
            密码用 scrypt 加盐哈希后存进数据库，
            <br />
            服务端自己也读不出你的原始密码。
          </p>
        </section>

        {/* ---------- 技术说明（对面试官友好的部分） ---------- */}
        <section className="mt-4 space-y-2 px-1">
          <details className="group">
            <summary className="cursor-pointer list-none text-[11px] text-ink-3 transition-colors hover:text-ink-2">
              ▸ 这个项目里数据库做了什么
            </summary>
            <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-3">
              <li>· 金额一律用整数存"分"，避免浮点误差</li>
              <li>· CHECK 约束挡住非法数据（转账不能带分类、金额不能为 0）</li>
              <li>· 触发器自动维护账户余额，DELETE 时自动扣回</li>
              <li>· 一个 SQL 对账接口验证余额有没有漂移</li>
              <li>· 会话存数据库（可随时撤销），密码 scrypt 加盐哈希</li>
              <li>· 所有查询都把 user_id 写进 WHERE，防止越权访问</li>
            </ul>
          </details>
        </section>
      </motion.div>
    </div>
  );
}
