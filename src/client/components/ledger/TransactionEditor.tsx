/**
 * 记一笔 / 改一笔（同一个表单）。
 *
 * 包含三种类型：支出、收入、转账。
 *   - 支出 / 收入：金额 + 分类 + 账户 + 日期 + 备注
 *   - 转账：金额 + 转出账户 + 转入账户 + 日期（没有分类，因为转账不属于任何消费类别）
 *
 * 这个区分不是随便定的，它对应数据库里的一条 CHECK 约束：
 *   转账的 category_id 必须是 NULL；收支必须有 category_id。
 * 界面上把转账单独做成一个页签，就是为了不让你有机会造出违反约束的数据。
 */

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { centsToYuan, normalizeYuanInput, today } from '../../lib/format';
import { useUi } from '../../store/ui';
import { Button, Field, TextInput } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import type { TxType } from '@shared/types';

/** 表单内部统一用"支出 / 收入 / 转账"三种模式 */
const TYPE_TABS: { key: TxType; label: string; color: string }[] = [
  { key: 'expense', label: '支出', color: 'var(--color-expense)' },
  { key: 'income', label: '收入', color: 'var(--color-income)' },
  { key: 'transfer', label: '转账', color: 'var(--color-ink-2)' },
];

export function TransactionEditor() {
  const { editorOpen, editing, closeEditor, refresh } = useUi();

  const [type, setType] = useState<TxType>('expense');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [toAccountId, setToAccountId] = useState<number | null>(null);
  const [occurredOn, setOccurredOn] = useState(today());
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categoriesState = useFetch(() => api.categories(), []);
  const accountsState = useFetch(() => api.accounts(), []);

  /**
   * 打开弹层时初始化表单。
   *
   * 这里是新手最容易出 bug 的地方：编辑一笔已有的账，而分类列表是**异步**加载的。
   * 如果不等分类加载完就设 categoryId，界面上会看不到选中的分类。
   * 所以依赖里带上 categoriesState.data —— 数据到了会重新初始化一次。
   */
  useEffect(() => {
    if (!editorOpen) return;

    if (editing) {
      setType(editing.type);
      // 数据库存的是"分"，表单要显示"元"，并且显示成正数（符号由类型决定）
      setAmount(String(Math.abs(centsToYuan(editing.amountCents))));
      setCategoryId(editing.categoryId);
      setAccountId(editing.accountId);
      setToAccountId(null);
      setOccurredOn(editing.occurredOn);
      setDescription(editing.description);
    } else {
      setType('expense');
      setAmount('');
      setCategoryId(null);
      setAccountId(accountsState.data?.[0]?.id ?? null);
      setToAccountId(accountsState.data?.[1]?.id ?? null);
      setOccurredOn(today());
      setDescription('');
    }
    setError(null);
  }, [editorOpen, editing, accountsState.data]);

  /**
   * 切换类型时，已选的分类可能不属于新类型，必须清掉。
   *
   * 注意这里用 setState 的函数式更新（setCategoryId(current => ...)），
   * 而不是在依赖里读 categoryId。
   * 因为如果把 categoryId 加进依赖，这个 effect 会在每次选择分类后重跑，
   * 逻辑就变得难以预测。函数式更新只在"类型或分类列表变化"时才需要判断。
   */
  useEffect(() => {
    if (type === 'transfer') {
      setCategoryId(null);
      return;
    }
    setCategoryId((current) => {
      if (current === null) return null;
      const all = categoriesState.data?.flatMap((c) => [c, ...c.children]) ?? [];
      const selected = all.find((c) => c.id === current);
      return selected && selected.kind !== type ? null : current;
    });
  }, [type, categoriesState.data]);

  /** 当前类型下可选的分类（只在收支模式下有意义） */
  const visibleCategories = useMemo(() => {
    if (type === 'transfer') return [];
    return (categoriesState.data ?? []).filter((c) => c.kind === type);
  }, [categoriesState.data, type]);

  const accounts = accountsState.data ?? [];

  const submit = async () => {
    setError(null);

    // 前端校验只是体验优化，服务端会再校验一遍（防 curl 直接打接口）
    const trimmed = amount.trim();
    if (!trimmed || Number(trimmed) <= 0) {
      setError('请输入金额');
      return;
    }
    if (type !== 'transfer' && categoryId === null) {
      setError('请选择一个分类');
      return;
    }
    if (type === 'transfer') {
      if (accountId === null || toAccountId === null) {
        setError('请选择转出和转入账户');
        return;
      }
      if (accountId === toAccountId) {
        setError('转出和转入不能是同一个账户');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (type === 'transfer') {
        await api.createTransfer({
          fromAccountId: accountId!,
          toAccountId: toAccountId!,
          amount: trimmed,
          occurredOn,
          description,
        });
      } else {
        const payload = {
          accountId: accountId!,
          categoryId,
          type,
          amount: trimmed,
          description,
          occurredOn,
        };
        if (editing) await api.updateTransaction(editing.id, payload);
        else await api.createTransaction(payload);
      }

      closeEditor();
      refresh(); // 让所有订阅 version 的查询重新拉取
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const accentColor = TYPE_TABS.find((t) => t.key === type)?.color ?? 'var(--color-accent)';

  return (
    <Sheet open={editorOpen} title={editing ? '修改这笔账' : '记一笔'} onClose={closeEditor}>
      <div className="space-y-4">
        {/* ---------- 类型切换 ---------- */}
        <div className="flex rounded-xl border border-line bg-surface-2 p-1">
          {TYPE_TABS.map((tab) => {
            const active = tab.key === type;
            // 编辑已有流水时不允许改成转账：转账是成对的两行，改单行会破坏配对
            const disabled = editing !== null && tab.key === 'transfer';
            return (
              <button
                key={tab.key}
                disabled={disabled}
                onClick={() => setType(tab.key)}
                className="relative flex-1 rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-40"
                style={{ color: active ? tab.color : 'var(--color-ink-3)' }}
              >
                {active && (
                  // 高亮块用绝对定位铺满，颜色跟随类型（支出红 / 收入绿 / 转账灰）
                  <span className="absolute inset-0 rounded-lg" style={{ backgroundColor: 'var(--color-surface)' }} />
                )}
                <span className="relative">{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* ---------- 金额 ---------- */}
        <div className="py-2 text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="text-2xl font-medium" style={{ color: accentColor }}>
              ¥
            </span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(normalizeYuanInput(e.target.value))}
              placeholder="0.00"
              aria-label="金额"
              className="w-[9ch] bg-transparent text-center font-mono text-4xl font-bold tabular-nums outline-none placeholder:text-ink-3/50"
              style={{ color: amount ? accentColor : undefined }}
            />
          </div>
          <p className="mt-1 text-xs text-ink-3">
            {type === 'expense' ? '花掉的钱' : type === 'income' ? '赚到的钱' : '账户之间搬钱，不计入收支'}
          </p>
        </div>

        {/* ---------- 分类（转账模式不显示）---------- */}
        {type !== 'transfer' && (
          <div>
            <p className="mb-2 text-xs text-ink-2">分类</p>
            {categoriesState.loading ? (
              <div className="skeleton h-9 w-full" />
            ) : visibleCategories.length === 0 ? (
              <p className="text-xs text-ink-3">
                还没有{type === 'expense' ? '支出' : '收入'}分类，去"管理"页添加一个
              </p>
            ) : (
              <div className="space-y-3">
                {visibleCategories.map((parent) => (
                  <div key={parent.id}>
                    {/* 有子分类的父分类只作为分组标题，本身不可选 */}
                    {parent.children.length > 0 && (
                      <p className="mb-1.5 text-[11px] text-ink-3">
                        {parent.icon} {parent.name}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {(parent.children.length > 0 ? parent.children : [parent]).map((c) => {
                        const active = categoryId === c.id;
                        return (
                          <button
                            key={c.id}
                            onClick={() => setCategoryId(c.id)}
                            className="rounded-lg border px-3 py-2 text-sm transition-colors"
                            style={{
                              borderColor: active ? accentColor : 'var(--color-line)',
                              backgroundColor: active ? `${accentColor}1f` : 'var(--color-surface-2)',
                              color: active ? accentColor : 'var(--color-ink-2)',
                              fontWeight: active ? 600 : 400,
                            }}
                          >
                            {c.icon} {c.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---------- 账户 ---------- */}
        {type === 'transfer' ? (
          <>
            <div>
              <p className="mb-2 text-xs text-ink-2">从</p>
              <AccountChips accounts={accounts} value={accountId} onChange={setAccountId} />
            </div>
            <div>
              <p className="mb-2 text-xs text-ink-2">到</p>
              <AccountChips
                accounts={accounts.filter((a) => a.id !== accountId)}
                value={toAccountId}
                onChange={setToAccountId}
              />
            </div>
          </>
        ) : (
          <div>
            <p className="mb-2 text-xs text-ink-2">账户</p>
            <AccountChips accounts={accounts} value={accountId} onChange={setAccountId} />
          </div>
        )}

        {/* ---------- 日期 / 备注 ---------- */}
        <div className="divide-y divide-line/60 border-t border-line pt-1">
          <Field label="日期">
            <TextInput
              type="date"
              value={occurredOn}
              max={today()}
              onChange={(e) => setOccurredOn(e.target.value)}
              className="[color-scheme:dark]"
            />
          </Field>
          <Field label="备注">
            <TextInput
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选，比如：和朋友吃饭"
            />
          </Field>
        </div>

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <Button loading={submitting} onClick={submit} className="w-full">
          {editing ? '保存修改' : '记账'}
        </Button>

        <p className="pb-1 text-center text-[11px] leading-relaxed text-ink-3">
          金额会以"分"为单位存进数据库（整数），
          <br />
          这样加减不会出现浮点误差，余额永远能和流水对上。
        </p>
      </div>
    </Sheet>
  );
}

/** 账户选择芯片 */
function AccountChips({
  accounts,
  value,
  onChange,
}: {
  accounts: { id: number; name: string }[];
  value: number | null;
  onChange: (id: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {accounts.map((a) => {
        const active = value === a.id;
        return (
          <button
            key={a.id}
            onClick={() => onChange(a.id)}
            className="rounded-lg border px-3 py-2 text-sm transition-colors"
            style={{
              borderColor: active ? 'var(--color-accent)' : 'var(--color-line)',
              backgroundColor: active ? 'var(--color-accent-soft)' : 'var(--color-surface-2)',
              color: active ? 'var(--color-accent)' : 'var(--color-ink-2)',
              fontWeight: active ? 600 : 400,
            }}
          >
            {a.name}
          </button>
        );
      })}
    </div>
  );
}
