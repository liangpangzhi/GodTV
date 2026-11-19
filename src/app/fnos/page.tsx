'use client';

import {
  Check,
  Film,
  FolderOpen,
  Link2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Tv,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import PageLayout from '@/components/PageLayout';

const LOCAL_CONFIG_KEY = 'decotv_admin_config';
const PAGE_SIZE = 24;

interface FnOSConnector {
  id: string;
  name: string;
  displayName?: string;
  type: 'fnos';
  enabled: boolean;
  serverUrl: string;
  token: string;
  username: string;
  password: string;
  /** 本地解码：取原片在客户端解码，避开 NAS 转码 */
  localDecode?: boolean;
  localDecodeMode?: 'auto' | 'direct' | 'remux' | 'transcode';
  createdAt: number;
  updatedAt: number;
}

const LOCAL_DECODE_MODE_LABEL: Record<string, string> = {
  auto: '自动（优先直连原片）',
  direct: '直连原片',
  remux: '本地转封装',
  transcode: '本地转码',
};

interface LibraryItem {
  id: string;
  title: string;
  year?: number;
  mediaType: 'movie' | 'tv';
  poster?: string;
  connectorId: string;
  connectorType: string;
  sourceItemId: string;
  overview?: string;
  libraryName?: string;
  tmdbRating?: number;
  episodeCount?: number;
}

export default function FnOSPage() {
  const [connectors, setConnectors] = useState<FnOSConnector[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [activeConnector, setActiveConnector] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<FnOSConnector>({
    id: '',
    name: '我的飞牛影视',
    type: 'fnos',
    enabled: true,
    serverUrl: '',
    token: '',
    username: '',
    password: '',
    createdAt: 0,
    updatedAt: 0,
  });

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // 读取配置中的 fnOS 连接器
  const loadConnectors = useCallback(async () => {
    try {
      let cfg: {
        PrivateLibraryConfig?: { connectors?: FnOSConnector[] };
      } | null = null;
      const stored = localStorage.getItem(LOCAL_CONFIG_KEY);
      if (stored) cfg = JSON.parse(stored);

      // 始终拉取服务端配置：本地模式下服务端内存配置在重启后会重置，
      // 若本地(localStorage)保留了飞牛连接器而服务端没有，需要补一次同步，否则影库接口查不到连接器。
      const res = await fetch('/api/source-manager/config', {
        cache: 'no-store',
      });
      const data = await res.json();
      const serverCfg = data?.config as
        | { PrivateLibraryConfig?: { connectors?: FnOSConnector[] } }
        | undefined;

      if (!cfg) {
        cfg = serverCfg || null;
      } else {
        const localFnOS = (cfg.PrivateLibraryConfig?.connectors || []).filter(
          (c) => c.type === 'fnos',
        );
        const serverFnOS = (
          serverCfg?.PrivateLibraryConfig?.connectors || []
        ).filter((c) => c.type === 'fnos');
        const missing = localFnOS.filter(
          (c) => !serverFnOS.some((s) => s.id === c.id),
        );
        if (missing.length > 0) {
          const others = (
            serverCfg?.PrivateLibraryConfig?.connectors || []
          ).filter((c) => c.type !== 'fnos');
          const merged = {
            ...(serverCfg || {}),
            PrivateLibraryConfig: { connectors: [...others, ...localFnOS] },
          };
          await fetch('/api/source-manager/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: merged }),
          });
          cfg = merged;
        }
      }

      const all = cfg?.PrivateLibraryConfig?.connectors || [];
      setConnectors(all.filter((c) => c.type === 'fnos'));
    } catch {
      showToast('读取配置失败');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadConnectors();
  }, [loadConnectors]);

  // 保存连接器到配置（localStorage + 后端）
  const persistConnectors = async (nextAll: FnOSConnector[]) => {
    try {
      const res = await fetch('/api/source-manager/config', {
        cache: 'no-store',
      });
      const data = await res.json();
      const cfg = data.config || {};
      // 保留非 fnOS 的其他连接器
      const others = (cfg.PrivateLibraryConfig?.connectors || []).filter(
        (c: FnOSConnector) => c.type !== 'fnos',
      );
      cfg.PrivateLibraryConfig = { connectors: [...others, ...nextAll] };

      localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(cfg));
      const save = await fetch('/api/source-manager/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const saveData = await save.json();
      if (!saveData.success) throw new Error(saveData.error || '保存失败');
      setConnectors(nextAll);
      showToast('已保存');
      return true;
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const handleSave = async () => {
    if (!draft.serverUrl.trim()) {
      showToast('请填写服务地址');
      return;
    }
    const now = Date.now();
    const item: FnOSConnector = {
      ...draft,
      id: draft.id || `fnos_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name: draft.name.trim() || '我的飞牛影视',
      createdAt: draft.createdAt || now,
      updatedAt: now,
    };
    const next = connectors.some((c) => c.id === item.id)
      ? connectors.map((c) => (c.id === item.id ? item : c))
      : [...connectors, item];
    if (await persistConnectors(next)) setShowAdd(false);
  };

  const handleDelete = async (id: string) => {
    await persistConnectors(connectors.filter((c) => c.id !== id));
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await persistConnectors(
      connectors.map((c) =>
        c.id === id ? { ...c, enabled, updatedAt: Date.now() } : c,
      ),
    );
  };

  const handleToggleLocalDecode = async (id: string, localDecode: boolean) => {
    await persistConnectors(
      connectors.map((c) =>
        c.id === id ? { ...c, localDecode, updatedAt: Date.now() } : c,
      ),
    );
  };

  const handleLocalDecodeMode = async (
    id: string,
    mode: 'auto' | 'direct' | 'remux' | 'transcode',
  ) => {
    await persistConnectors(
      connectors.map((c) =>
        c.id === id
          ? { ...c, localDecodeMode: mode, updatedAt: Date.now() }
          : c,
      ),
    );
  };

  const handleTest = async (connector: FnOSConnector) => {
    setTesting(connector.id);
    try {
      const res = await fetch('/api/source-manager/fnos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector, action: 'test' }),
      });
      const data = await res.json();
      showToast(
        data.ok
          ? '连接成功'
          : `连接失败：${data.detail || data.error || '未知错误'}`,
      );
    } catch (e) {
      showToast(`测试失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
    }
  };

  // 加载飞牛影库内容
  const loadItems = useCallback(
    async (refresh = false) => {
      const enabled = connectors.filter((c) => c.enabled);
      if (enabled.length === 0) {
        setItems([]);
        return;
      }
      setLoadingItems(true);
      try {
        const connectorId =
          activeConnector === 'all' ? enabled[0].id : activeConnector;
        const url = `/api/private-library/items?connectorId=${encodeURIComponent(connectorId)}&limit=${PAGE_SIZE}${refresh ? '&refresh=1' : ''}`;
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json();
        setItems(
          (data.items || []).filter(
            (i: LibraryItem) => i.connectorType === 'fnos',
          ),
        );
      } catch {
        showToast('加载影库失败');
      } finally {
        setLoadingItems(false);
      }
    },
    [connectors, activeConnector, showToast],
  );

  const enabledConnectors = connectors.filter((c) => c.enabled);
  const enabledConnectorCount = enabledConnectors.length;
  useEffect(() => {
    if (!loading && enabledConnectorCount > 0) loadItems();
    else setItems([]);
  }, [loading, activeConnector, connectors, enabledConnectorCount, loadItems]);

  return (
    <PageLayout activePath='/fnos'>
      <div className='max-w-6xl mx-auto px-4 py-6'>
        {/* 标题 */}
        <div className='flex items-center justify-between flex-wrap gap-3 mb-6'>
          <div className='flex items-center gap-3'>
            <div className='p-2.5 rounded-xl bg-orange-500/15 text-orange-600 dark:text-orange-400'>
              <Server className='w-6 h-6' />
            </div>
            <div>
              <h1 className='text-2xl font-bold text-gray-900 dark:text-gray-100'>
                飞牛影音
              </h1>
              <p className='text-sm text-gray-500 dark:text-gray-400 mt-0.5'>
                连接你的飞牛 NAS 影视库，直接观看本地影片
              </p>
            </div>
          </div>
          <div className='flex gap-2'>
            {enabledConnectors.length > 0 && (
              <button
                onClick={() => loadItems(true)}
                disabled={loadingItems}
                className='flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-gray-200'
              >
                <RefreshCw
                  className={`w-4 h-4 ${loadingItems ? 'animate-spin' : ''}`}
                />
                刷新
              </button>
            )}
            <button
              onClick={() => {
                setDraft({
                  id: '',
                  name: '我的飞牛影视',
                  type: 'fnos',
                  enabled: true,
                  serverUrl: '',
                  token: '',
                  username: '',
                  password: '',
                  createdAt: 0,
                  updatedAt: 0,
                });
                setShowAdd(true);
              }}
              className='flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700'
            >
              <Plus className='w-4 h-4' /> 添加 NAS
            </button>
          </div>
        </div>

        {/* 连接器列表 */}
        {connectors.length > 0 && (
          <div className='mb-6 space-y-2'>
            {connectors.map((c) => (
              <div
                key={c.id}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  c.enabled
                    ? 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-zinc-700'
                    : 'bg-gray-100 dark:bg-zinc-900 border-gray-200 dark:border-zinc-700 opacity-60'
                }`}
              >
                <Server className='w-5 h-5 text-orange-500 shrink-0' />
                <div className='flex-1 min-w-0'>
                  <div className='font-medium text-sm text-gray-900 dark:text-gray-100'>
                    {c.displayName || c.name}
                  </div>
                  <div className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                    {c.serverUrl} ·{' '}
                    {c.token
                      ? '令牌认证'
                      : c.username
                        ? `账号 ${c.username}`
                        : '未填写凭证'}
                  </div>
                  <div className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                    播放方式：
                    {c.localDecode === false
                      ? 'NAS 转码（云端转码）'
                      : `本地解码 · ${LOCAL_DECODE_MODE_LABEL[c.localDecodeMode || 'auto']}`}
                  </div>
                </div>
                <select
                  value={c.localDecodeMode || 'auto'}
                  disabled={c.localDecode === false}
                  onChange={(e) =>
                    handleLocalDecodeMode(
                      c.id,
                      e.target.value as
                        | 'auto'
                        | 'direct'
                        | 'remux'
                        | 'transcode',
                    )
                  }
                  className='px-2 py-1.5 rounded text-xs bg-gray-100 dark:bg-zinc-700 text-gray-700 dark:text-gray-200 disabled:opacity-40'
                >
                  {Object.entries(LOCAL_DECODE_MODE_LABEL).map(
                    ([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
                <button
                  onClick={() =>
                    handleToggleLocalDecode(c.id, c.localDecode === false)
                  }
                  className={`px-2.5 py-1.5 rounded text-xs ${
                    c.localDecode === false
                      ? 'bg-gray-300 dark:bg-zinc-600 text-gray-700 dark:text-gray-200'
                      : 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                  }`}
                  title='本地解码：取原片在本机解码播放，避开 NAS 硬件转码'
                >
                  {c.localDecode === false ? 'NAS 转码' : '本地解码'}
                </button>
                <button
                  onClick={() => handleTest(c)}
                  disabled={testing === c.id}
                  className='flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                >
                  {testing === c.id ? (
                    <Loader2 className='w-3.5 h-3.5 animate-spin' />
                  ) : (
                    <Check className='w-3.5 h-3.5' />
                  )}
                  测试
                </button>
                <button
                  onClick={() => handleToggle(c.id, !c.enabled)}
                  className={`px-2.5 py-1.5 rounded text-xs ${
                    c.enabled
                      ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                      : 'bg-gray-300 dark:bg-zinc-600 text-gray-700 dark:text-gray-200'
                  }`}
                >
                  {c.enabled ? '已启用' : '已禁用'}
                </button>
                <button
                  onClick={() => {
                    setDraft({ ...c });
                    setShowAdd(true);
                  }}
                  className='px-2.5 py-1.5 rounded text-xs bg-gray-100 dark:bg-zinc-700 text-gray-700 dark:text-gray-200'
                >
                  编辑
                </button>
                <button
                  onClick={() => handleDelete(c.id)}
                  className='p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded'
                >
                  <Trash2 className='w-4 h-4' />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 未配置引导 */}
        {connectors.length === 0 && !loading && (
          <div className='text-center py-14 rounded-2xl border border-dashed border-gray-300 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/30'>
            <FolderOpen className='w-12 h-12 mx-auto text-gray-300 dark:text-zinc-600 mb-3' />
            <p className='text-gray-600 dark:text-gray-300 font-medium'>
              尚未添加飞牛影视
            </p>
            <p className='text-sm text-gray-400 dark:text-gray-500 mt-1 mb-4'>
              点击右上角「添加 NAS」，填写地址与账号即可连接
            </p>
            <button
              onClick={() => setShowAdd(true)}
              className='px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700'
            >
              立即添加
            </button>
          </div>
        )}

        {/* 影库内容 */}
        {enabledConnectors.length > 0 && (
          <div>
            {enabledConnectors.length > 1 && (
              <div className='flex gap-2 mb-4 flex-wrap'>
                <button
                  onClick={() => setActiveConnector('all')}
                  className={`px-3 py-1.5 rounded-full text-xs ${
                    activeConnector === 'all'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-200 dark:bg-zinc-700 text-gray-700 dark:text-gray-200'
                  }`}
                >
                  全部
                </button>
                {enabledConnectors.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setActiveConnector(c.id)}
                    className={`px-3 py-1.5 rounded-full text-xs ${
                      activeConnector === c.id
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-200 dark:bg-zinc-700 text-gray-700 dark:text-gray-200'
                    }`}
                  >
                    {c.displayName || c.name}
                  </button>
                ))}
              </div>
            )}

            {loadingItems ? (
              <div className='flex justify-center py-12'>
                <Loader2 className='w-8 h-8 animate-spin text-purple-500' />
              </div>
            ) : items.length === 0 ? (
              <div className='text-center py-12 text-gray-400 dark:text-zinc-500 text-sm'>
                暂无影片。首次连接后系统会自动扫描媒体库，请稍后刷新。
              </div>
            ) : (
              <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4'>
                {items.map((item) => {
                  const params = new URLSearchParams({
                    source: 'private_library',
                    id: item.id,
                    title: item.title,
                    stype: item.mediaType,
                    connectorId: item.connectorId,
                    sourceItemId: item.sourceItemId,
                  });
                  return (
                    <Link
                      key={item.id}
                      href={`/play?${params.toString()}`}
                      className='group block'
                    >
                      <div className='aspect-[2/3] rounded-lg overflow-hidden bg-gray-200 dark:bg-zinc-800 relative'>
                        {item.poster ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.poster}
                            alt={item.title}
                            className='w-full h-full object-cover group-hover:scale-105 transition-transform'
                            loading='lazy'
                          />
                        ) : (
                          <div className='w-full h-full flex items-center justify-center'>
                            {item.mediaType === 'tv' ? (
                              <Tv className='w-10 h-10 text-gray-400' />
                            ) : (
                              <Film className='w-10 h-10 text-gray-400' />
                            )}
                          </div>
                        )}
                        <div className='absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center'>
                          <Play className='w-10 h-10 text-white opacity-0 group-hover:opacity-100 transition-opacity' />
                        </div>
                      </div>
                      <div className='mt-2 text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                        {item.title}
                      </div>
                      <div className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                        {item.year ||
                          item.libraryName ||
                          (item.mediaType === 'tv' ? '剧集' : '电影')}
                        {item.episodeCount ? ` · ${item.episodeCount}集` : ''}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 添加/编辑弹窗 */}
      {showAdd && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'>
          <div className='w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-5 shadow-xl'>
            <h2 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
              {draft.id ? '编辑飞牛影视' : '添加飞牛影视'}
            </h2>
            <div className='space-y-3'>
              <div>
                <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
                  名称
                </label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className='w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm text-gray-900 dark:text-gray-100'
                />
              </div>
              <div>
                <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
                  服务地址
                </label>
                <input
                  value={draft.serverUrl}
                  onChange={(e) =>
                    setDraft({ ...draft, serverUrl: e.target.value })
                  }
                  placeholder='http://192.168.1.10:5666'
                  className='w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm text-gray-900 dark:text-gray-100'
                />
              </div>
              <div>
                <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
                  访问令牌（与账号密码二选一）
                </label>
                <input
                  value={draft.token}
                  onChange={(e) =>
                    setDraft({ ...draft, token: e.target.value })
                  }
                  className='w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm text-gray-900 dark:text-gray-100'
                />
              </div>
              <div className='grid grid-cols-2 gap-3'>
                <div>
                  <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
                    用户名
                  </label>
                  <input
                    value={draft.username}
                    onChange={(e) =>
                      setDraft({ ...draft, username: e.target.value })
                    }
                    className='w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm text-gray-900 dark:text-gray-100'
                  />
                </div>
                <div>
                  <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
                    密码
                  </label>
                  <input
                    type='password'
                    value={draft.password}
                    onChange={(e) =>
                      setDraft({ ...draft, password: e.target.value })
                    }
                    className='w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm text-gray-900 dark:text-gray-100'
                  />
                </div>
              </div>
              <p className='text-xs text-gray-500 dark:text-gray-400 flex items-start gap-1'>
                <Link2 className='w-3.5 h-3.5 mt-0.5 shrink-0' />
                FN Connect 用户可填
                https://&lt;FN_ID&gt;.5ddd.com。保存后建议点「测试」验证。
              </p>
            </div>
            <div className='flex justify-end gap-2 mt-5'>
              <button
                onClick={() => setShowAdd(false)}
                className='px-4 py-2 rounded-lg text-sm bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-gray-200'
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className='px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700'
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className='fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-lg bg-gray-900 text-white text-sm shadow-lg'>
          {toast}
        </div>
      )}
    </PageLayout>
  );
}
