/**
 * 管理页：账户 + 分类。
 *
 * 这个页面的价值不只是"能增删分类"，更重要的是它演示了**删除时的引用保护**：
 *   transactions.category_id 外键是 ON DELETE RESTRICT，
 *   所以被流水用过的分类删不掉。界面上直接给出"该分类下还有 N 笔记录"，
 *   而不是把一句 SQLite 的英文报错丢给用户。
 *
 * 这体现了一个设计原则：数据库负责"不许删"，应用负责"说清楚为什么"。
 */

import { useState } from 'react';
import { api, ApiError, type CategoryNode } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { formatAmount } from '../../lib/format';
import { useUi } from '../../store/ui';
import { useAuth } from '../../store/auth';
import { Button, EmptyState, SkeletonRows, TextInput } from '../ui/Button';
import { FadeIn } from '../ui/FadeIn';
import { Sheet } from '../ui/Sheet';
import {
  ACCOUNT_TYPE_ICON,
  ACCOUNT_TYPE_LABEL,
  type Account,
  type AccountType,
  type Category,
  type CategoryKind,
} from '@shared/types';

export function ManagePage() {
  const [tab, setTab] = useState<'account' | 'category'>('account');
  // 本地版本号：账户/分类变更后强制重新查询
  const [localVersion, setLocalVersion] = useState(0);
  const refreshGlobal = useUi((s) => s.refresh);
  const isDemo = useAuth((s) => s.user?.isDemo ?? false);

  const accountsState = useFetch(() => api.accounts(), [localVersion]);
  const categoriesState = useFetch(() => api.categories(), [localVersion]);

  const bump = () => {
    setLocalVersion((v) => v + 1);
    refreshGlobal(); // 同时让记账页 / 统计页重新查询
  };

  return (
    <div className="space-y-4">
      {/* ---------- 分段控件 ---------- */}
      <FadeIn>
        <div className="flex rounded-xl border border-line bg-surface-2 p-1">
          {(
            [
              { key: 'account', label: '账户' },
              { key: 'category', label: '分类' },
            ] as const
          ).map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
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
      </FadeIn>

      {tab === 'account' ? (
        <AccountSection accounts={accountsState.data} loading={accountsState.loading} onChanged={bump} />
      ) : (
        <CategorySection categories={categoriesState.data} loading={categoriesState.loading} onChanged={bump} />
      )}

      {/* 演示账号专属：一键恢复演示数据 */}
      {isDemo && <DemoResetSection onReset={bump} />}
    </div>
  );
}

/**
 * 演示数据重置。
 *
 * 为什么这个功能是必要的？
 *   演示账号允许访客随便增删改（这才是真的演示），
 *   但被玩坏之后，下一个访客打开看到的就是一个空壳界面。
 *   所以必须给一个"恢复出厂设置"的按钮。
 *
 * 服务端做了两道限制：只有 is_demo 用户能调用，且整个重置在一个事务里完成。
 */
function DemoResetSection({ onReset }: { onReset: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const doReset = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.resetDemo();
      setConfirmOpen(false);
      setMessage(`已恢复到 ${result.transactions} 笔示例流水`);
      onReset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FadeIn index={4}>
        <section className="card p-5">
          <h3 className="text-sm font-semibold">演示数据</h3>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            这个演示账号的数据是所有访客共享的，可以被随意增删改。
            如果数据被改乱了，可以恢复到初始的示例状态。
            重置只影响这个演示账号，不会动到别人的真实账目。
          </p>

          <button
            onClick={() => {
              setConfirmOpen(true);
              setMessage(null);
            }}
            className="mt-3 rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-sm text-ink-2 transition-colors hover:text-ink"
          >
            恢复演示数据
          </button>

          {message && <p className="mt-2 text-xs" style={{ color: 'var(--color-income)' }}>{message}</p>}
        </section>
      </FadeIn>

      <Sheet open={confirmOpen} title="恢复演示数据？" onClose={() => setConfirmOpen(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed">
            会用初始示例数据（约 640 笔流水、4 个账户、16 个分类）替换当前的演示数据。
          </p>
          <p className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
            当前演示账号里所有被改动过的数据都会丢失，无法撤销。
          </p>

          {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button className="flex-1" loading={busy} onClick={doReset}>
              确认恢复
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

// ===========================================================================
//  账户
// ===========================================================================

function AccountSection({
  accounts,
  loading,
  onChanged,
}: {
  accounts: Account[] | undefined;
  loading: boolean;
  onChanged: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <FadeIn index={1}>
      <section className="card">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">账户</h3>
            <p className="text-[11px] text-ink-3">余额由数据库触发器自动维护</p>
          </div>
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setAddOpen(true)}>
            + 新增
          </Button>
        </header>

        <div className="p-2">
          {loading && <SkeletonRows rows={3} />}
          {!loading && (accounts?.length ?? 0) === 0 && (
            <EmptyState icon="🏦" title="还没有账户" hint="先建一个账户，才能开始记账" />
          )}
          <ul className="divide-y divide-line/60">
            {accounts?.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-2 py-3">
                <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-lg">
                  {ACCOUNT_TYPE_ICON[a.type]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="text-[11px] text-ink-3">
                    {ACCOUNT_TYPE_LABEL[a.type]} · 初始 {formatAmount(a.initialBalanceCents)}
                  </p>
                </div>
                <span
                  className="font-mono text-sm font-semibold tabular-nums"
                  style={{ color: a.balanceCents < 0 ? 'var(--color-expense)' : undefined }}
                >
                  {a.balanceCents < 0 && '-'}
                  {formatAmount(a.balanceCents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 只在打开时挂载：组件卸载时状态自然清空，不需要写一堆 reset 逻辑。
          这比"用 useEffect 监听 open 然后清空表单"更不容易出 bug。 */}
      {addOpen && (
        <AddAccountSheet
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            onChanged();
          }}
        />
      )}
    </FadeIn>
  );
}

function AddAccountSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('ewallet');
  const [initial, setInitial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('请输入账户名');
      return;
    }
    setSubmitting(true);
    try {
      await api.createAccount({ name: name.trim(), type, initialBalance: initial || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open title="新增账户" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs text-ink-2">账户名</p>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="比如：招商银行卡"
            maxLength={30}
          />
        </div>

        <div>
          <p className="mb-2 text-xs text-ink-2">类型</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(ACCOUNT_TYPE_LABEL) as AccountType[]).map((t) => {
              const active = t === type;
              return (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className="rounded-lg border px-3 py-2 text-sm transition-colors"
                  style={{
                    borderColor: active ? 'var(--color-accent)' : 'var(--color-line)',
                    backgroundColor: active ? 'var(--color-accent-soft)' : 'var(--color-surface-2)',
                    color: active ? 'var(--color-accent)' : 'var(--color-ink-2)',
                  }}
                >
                  {ACCOUNT_TYPE_ICON[t]} {ACCOUNT_TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs text-ink-2">初始余额（可选）</p>
          <TextInput
            inputMode="decimal"
            value={initial}
            onChange={(e) => setInitial(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
          />
          <p className="mt-1.5 text-[11px] text-ink-3">
            把账户里现有的钱记进来。它会成为余额的起点，但不计入收支统计。
          </p>
        </div>

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <Button className="w-full" loading={submitting} onClick={submit}>
          创建账户
        </Button>
      </div>
    </Sheet>
  );
}

// ===========================================================================
//  分类
// ===========================================================================

function CategorySection({
  categories,
  loading,
  onChanged,
}: {
  categories: CategoryNode[] | undefined;
  loading: boolean;
  onChanged: () => void;
}) {
  // 新增分类弹层的默认类型（点哪个分组的"+ 新增"就带上哪个类型）
  const [addFor, setAddFor] = useState<CategoryKind | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CategoryNode | null>(null);

  const expense = (categories ?? []).filter((c) => c.kind === 'expense');
  const income = (categories ?? []).filter((c) => c.kind === 'income');
  const allNodes = expense.concat(income);

  return (
    <>
      {loading && (
        <section className="card p-4">
          <SkeletonRows rows={4} />
        </section>
      )}

      {!loading && (
        <>
          <CategoryGroup
            title="支出分类"
            kind="expense"
            nodes={expense}
            index={2}
            onAdd={setAddFor}
            onEdit={setEditing}
            onDelete={setPendingDelete}
          />
          <CategoryGroup
            title="收入分类"
            kind="income"
            nodes={income}
            index={3}
            onAdd={setAddFor}
            onEdit={setEditing}
            onDelete={setPendingDelete}
          />

          <FadeIn index={4}>
            <p className="px-1 text-[11px] leading-relaxed text-ink-3">
              被流水引用过的分类删不掉 —— 这是数据库外键{' '}
              <code className="text-ink-2">ON DELETE RESTRICT</code> 在起作用。如果改成{' '}
              <code className="text-ink-2">CASCADE</code>，删分类会连流水一起删掉，
              在记账 App 里这是灾难性的（账会莫名其妙消失）。所以这里选择"拒绝删除"。
            </p>
          </FadeIn>
        </>
      )}

      {addFor && (
        <AddCategorySheet
          defaultKind={addFor}
          parents={allNodes}
          onClose={() => setAddFor(null)}
          onSaved={() => {
            setAddFor(null);
            onChanged();
          }}
        />
      )}

      {/* key 用分类 id：换一个分类编辑时强制重新挂载，表单自然取到新值 */}
      {editing && (
        <RenameCategorySheet
          key={editing.id}
          category={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      {pendingDelete && (
        <DeleteCategorySheet
          key={pendingDelete.id}
          category={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDeleted={() => {
            setPendingDelete(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** 一组分类（支出或收入） */
function CategoryGroup({
  title,
  kind,
  nodes,
  index,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  kind: CategoryKind;
  nodes: CategoryNode[];
  index: number;
  onAdd: (kind: CategoryKind) => void;
  onEdit: (c: Category) => void;
  onDelete: (c: CategoryNode) => void;
}) {
  const color = kind === 'expense' ? 'var(--color-expense)' : 'var(--color-income)';

  return (
    <FadeIn index={index}>
      <section className="card">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold" style={{ color }}>
            {title}
          </h3>
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => onAdd(kind)}>
            + 新增
          </Button>
        </header>

        <div className="p-2">
          {nodes.length === 0 && <EmptyState icon="🏷️" title={`还没有${title}`} />}

          <ul className="divide-y divide-line/60">
            {nodes.map((parent) => (
              <li key={parent.id} className="px-2 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-base">{parent.icon}</span>
                  <span className="flex-1 text-sm font-medium">{parent.name}</span>
                  <span className="text-[11px] text-ink-3">{parent.usageCount} 笔</span>
                  <RowActions onEdit={() => onEdit(parent)} onDelete={() => onDelete(parent)} />
                </div>

                {/* 二级分类：缩进 + 左侧竖线，形成层级感 */}
                {parent.children.length > 0 && (
                  <ul className="mt-1.5 ml-6 space-y-1.5 border-l border-line pl-3">
                    {parent.children.map((child) => (
                      <li key={child.id} className="flex items-center gap-2">
                        <span className="text-sm">{child.icon}</span>
                        <span className="flex-1 text-xs text-ink-2">{child.name}</span>
                        <span className="text-[11px] text-ink-3">{child.usageCount} 笔</span>
                        <RowActions
                          onEdit={() => onEdit(child)}
                          onDelete={() =>
                            onDelete({
                              ...child,
                              // 子分类没有 children，构造一个空数组让类型对上
                              children: [],
                            })
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </FadeIn>
  );
}

/** 行内操作按钮（重命名 / 删除） */
function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <span className="flex items-center gap-0.5">
      <button
        onClick={onEdit}
        aria-label="重命名"
        className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        onClick={onDelete}
        aria-label="删除"
        className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-danger/15 hover:text-danger"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </span>
  );
}

/** 新增分类 */
function AddCategorySheet({
  defaultKind,
  parents,
  onClose,
  onSaved,
}: {
  defaultKind: CategoryKind;
  parents: CategoryNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [kind, setKind] = useState<CategoryKind>(defaultKind);
  const [parentId, setParentId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('请输入分类名');
      return;
    }
    setBusy(true);
    try {
      await api.createCategory({ name: name.trim(), kind, parentId, icon: icon.trim() || null });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  // 父分类候选：只能是同类型的一级分类（这条规则数据库触发器也会强制校验）
  const parentOptions = parents.filter((p) => p.kind === kind);

  return (
    <Sheet open title="新增分类" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs text-ink-2">类型</p>
          <div className="flex gap-2">
            {(['expense', 'income'] as CategoryKind[]).map((k) => {
              const active = k === kind;
              const color = k === 'expense' ? 'var(--color-expense)' : 'var(--color-income)';
              return (
                <button
                  key={k}
                  onClick={() => {
                    setKind(k);
                    setParentId(null); // 换类型后原来的父分类不再合法
                  }}
                  className="flex-1 rounded-lg border py-2 text-sm transition-colors"
                  style={{
                    borderColor: active ? color : 'var(--color-line)',
                    backgroundColor: active ? `${color}1f` : 'var(--color-surface-2)',
                    color: active ? color : 'var(--color-ink-2)',
                  }}
                >
                  {k === 'expense' ? '支出' : '收入'}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs text-ink-2">分类名</p>
          <div className="flex gap-2">
            <TextInput
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="🏷️"
              maxLength={4}
              className="w-16 text-center"
              aria-label="图标"
            />
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="比如：餐饮"
              maxLength={20}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs text-ink-2">
            上级分类 <span className="text-ink-3">（可选，最多两级）</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setParentId(null)}
              className="rounded-lg border px-3 py-2 text-sm transition-colors"
              style={{
                borderColor: parentId === null ? 'var(--color-accent)' : 'var(--color-line)',
                backgroundColor: parentId === null ? 'var(--color-accent-soft)' : 'var(--color-surface-2)',
                color: parentId === null ? 'var(--color-accent)' : 'var(--color-ink-2)',
              }}
            >
              无（一级分类）
            </button>
            {parentOptions.map((p) => {
              const active = parentId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setParentId(p.id)}
                  className="rounded-lg border px-3 py-2 text-sm transition-colors"
                  style={{
                    borderColor: active ? 'var(--color-accent)' : 'var(--color-line)',
                    backgroundColor: active ? 'var(--color-accent-soft)' : 'var(--color-surface-2)',
                    color: active ? 'var(--color-accent)' : 'var(--color-ink-2)',
                  }}
                >
                  {p.icon} {p.name}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-ink-3">
            选了上级分类，它就变成二级分类（比如 餐饮 → 外卖）。
          </p>
        </div>

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <Button className="w-full" loading={busy} onClick={submit}>
          创建分类
        </Button>
      </div>
    </Sheet>
  );
}

/** 重命名分类 */
function RenameCategorySheet({
  category,
  onClose,
  onSaved,
}: {
  category: Category;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [icon, setIcon] = useState(category.icon ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('请输入分类名');
      return;
    }
    setBusy(true);
    try {
      await api.renameCategory(category.id, { name: name.trim(), icon: icon.trim() || null });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title="修改分类" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <TextInput
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={4}
            className="w-16 text-center"
            aria-label="图标"
          />
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
        </div>
        <p className="text-[11px] leading-relaxed text-ink-3">
          改名不影响已有流水 —— 流水引用的是分类的 id，不是名字。这正是关系型数据库的基本做法：
          <span className="text-ink-2">用 id 建立关系，名字只是展示属性</span>。
        </p>
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <Button className="w-full" loading={busy} onClick={submit}>
          保存
        </Button>
      </div>
    </Sheet>
  );
}

/** 删除分类（会被外键挡住的情况在这里提前给出人话提示） */
function DeleteCategorySheet({
  category,
  onClose,
  onDeleted,
}: {
  category: CategoryNode;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCategory(category.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  // 自己 + 子分类被引用的总笔数
  const used = (category.usageCount ?? 0) + category.children.reduce((s, c) => s + (c.usageCount ?? 0), 0);

  return (
    <Sheet open title="删除分类？" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">
          确定要删除分类「{category.icon} {category.name}」吗？
        </p>

        {category.children.length > 0 && (
          <p className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
            它下面还有 {category.children.length} 个子分类，会被一起删除。
          </p>
        )}

        {used > 0 && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
            它（含子分类）已经被 {used} 笔流水使用，删除会被数据库拒绝。请先修改那些流水的分类。
          </p>
        )}

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="flex gap-3">
          <Button variant="ghost" className="flex-1" onClick={onClose}>
            取消
          </Button>
          <Button
            className="flex-1"
            loading={busy}
            onClick={submit}
            style={{ backgroundColor: 'var(--color-danger)', color: 'white' }}
          >
            删除
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
