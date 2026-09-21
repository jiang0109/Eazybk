/**
 * 极简的数据拉取 Hook。
 *
 * 只做三件事，但每一件都是新手容易漏掉的：
 *   1. 管理 loading / error 状态（否则界面无处显示失败原因）
 *   2. 处理**竞态**：快速切换月份时，先发的请求可能后回来，
 *      如果不判断就 setState，界面会显示成上一次月份的数据。
 *   3. 自动重新拉取：任何写操作之后 store.version +1，相关组件重新查询。
 */

import { useCallback, useEffect, useState } from 'react';
import { useUi } from '../store/ui';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** 手动重新拉取（比如用户点了"重试"） */
  reload: () => void;
}

export function useFetch<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const version = useUi((s) => s.version);

  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // 这个标记是解决竞态的关键：
    // 每次 effect 重新执行（依赖变化）时，把上一次的请求标记为"过期"，
    // 过期请求回来时直接丢弃，不写入状态。
    let stale = false;

    setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        if (stale) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setError(err instanceof ApiError ? err.message : '加载失败，请重试');
      })
      .finally(() => {
        if (stale) return;
        setLoading(false);
      });

    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, nonce]);

  return { data, loading, error, reload };
}
