'use client';

import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Edit3,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminConfig } from '@/lib/admin.types';

import PageLayout from '@/components/PageLayout';

const LOCAL_CONFIG_KEY = 'decotv_admin_config';

interface SourceItem {
  key: string;
  name: string;
  api: string;
  detail?: string;
  from: 'config' | 'custom';
  disabled?: boolean;
  is_adult?: boolean;
  disable_ad_filter?: boolean;
}

interface LiveItem {
  key: string;
  name: string;
  url: string;
  ua?: string;
  epg?: string;
  from: 'config' | 'custom';
  channelNumber?: number;
  disabled?: boolean;
}

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
  libraryFilter?: string[];
  createdAt: number;
  updatedAt: number;
}

type Tab = 'vod' | 'live' | 'import' | 'fnos';

function genKey(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export default function SourceManagerPage() {
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [tab, setTab] = useState<Tab>('vod');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // 编辑弹窗
  const [editingVod, setEditingVod] = useState<SourceItem | null>(null);
  const [editingLive, setEditingLive] = useState<LiveItem | null>(null);
  const [editingFnOS, setEditingFnOS] = useState<FnOSConnector | null>(null);
  const [testingFnOS, setTestingFnOS] = useState<string | null>(null);

  // 导入表单
  const [importUrl, setImportUrl] = useState('');
  const [importContent, setImportContent] = useState('');
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    sources: SourceItem[];
    lives: LiveItem[];
    format: string;
  } | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // 加载配置：优先 localStorage（本地模式权威），否则从服务端读取
  useEffect(() => {
    (async () => {
      try {
        let cfg: AdminConfig | null = null;
        if (typeof window !== 'undefined') {
          const stored = localStorage.getItem(LOCAL_CONFIG_KEY);
          if (stored) {
            try {
              cfg = JSON.parse(stored) as AdminConfig;
            } catch {
              cfg = null;
            }
          }
        }
        if (!cfg) {
          const res = await fetch('/api/source-manager/config', {
            cache: 'no-store',
          });
          const data = await res.json();
          if (data.success && data.config) cfg = data.config as AdminConfig;
        }
        if (cfg) {
          cfg.SourceConfig = cfg.SourceConfig || [];
          cfg.LiveConfig = cfg.LiveConfig || [];
          setConfig(cfg);
        } else {
          showToast('配置加载失败');
        }
      } catch {
        showToast('配置加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [showToast]);

  // 保存：写 localStorage + 同步服务端内存
  const persist = useCallback(
    async (next: AdminConfig) => {
      setConfig(next);
      try {
        localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(next));
      } catch {
        /* 存储配额或隐私模式限制，忽略 */
      }
      setSaving(true);
      try {
        const res = await fetch('/api/source-manager/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: next }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '保存失败');
        showToast('已保存并生效');
      } catch (e) {
        showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [showToast],
  );

  const vodSources = useMemo<SourceItem[]>(
    () => config?.SourceConfig || [],
    [config],
  );
  const liveSources = useMemo<LiveItem[]>(
    () => config?.LiveConfig || [],
    [config],
  );

  // ---------- 点播源操作 ----------
  const updateVod = (key: string, patch: Partial<SourceItem>) => {
    if (!config) return;
    const next = {
      ...config,
      SourceConfig: (config.SourceConfig || []).map((s) =>
        s.key === key ? { ...s, ...patch } : s,
      ),
    };
    persist(next);
  };

  const deleteVod = (key: string) => {
    if (!config) return;
    const next = {
      ...config,
      SourceConfig: (config.SourceConfig || []).filter((s) => s.key !== key),
    };
    // 同步清理用户的 enabledApis
    if (next.UserConfig?.Users) {
      next.UserConfig.Users = next.UserConfig.Users.map((u) => ({
        ...u,
        enabledApis: u.enabledApis?.filter((k) => k !== key),
      }));
    }
    persist(next);
  };

  const moveVod = (key: string, dir: -1 | 1) => {
    if (!config) return;
    const list = [...(config.SourceConfig || [])];
    const i = list.findIndex((s) => s.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    persist({ ...config, SourceConfig: list });
  };

  // ---------- 直播源操作 ----------
  const updateLive = (key: string, patch: Partial<LiveItem>) => {
    if (!config) return;
    const next = {
      ...config,
      LiveConfig: (config.LiveConfig || []).map((l) =>
        l.key === key ? { ...l, ...patch } : l,
      ),
    };
    persist(next);
  };

  const deleteLive = (key: string) => {
    if (!config) return;
    const next = {
      ...config,
      LiveConfig: (config.LiveConfig || []).filter((l) => l.key !== key),
    };
    persist(next);
  };

  const moveLive = (key: string, dir: -1 | 1) => {
    if (!config) return;
    const list = [...(config.LiveConfig || [])];
    const i = list.findIndex((l) => l.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    persist({ ...config, LiveConfig: list });
  };

  // ---------- 飞牛影视连接器操作 ----------
  const fnosConnectors = useMemo<FnOSConnector[]>(() => {
    const all = config?.PrivateLibraryConfig?.connectors || [];
    return all.filter((c) => c.type === 'fnos') as unknown as FnOSConnector[];
  }, [config]);

  const saveFnOSConnector = (connector: FnOSConnector) => {
    if (!config) return;
    const all = [...(config.PrivateLibraryConfig?.connectors || [])];
    const idx = all.findIndex((c) => c.id === connector.id);
    const withTs = { ...connector, updatedAt: Date.now() };
    if (idx >= 0) all[idx] = withTs;
    else all.push(withTs);
    persist({
      ...config,
      PrivateLibraryConfig: { connectors: all as never },
    });
    setEditingFnOS(null);
  };

  const deleteFnOSConnector = (id: string) => {
    if (!config) return;
    const all = (config.PrivateLibraryConfig?.connectors || []).filter(
      (c) => c.id !== id,
    );
    persist({ ...config, PrivateLibraryConfig: { connectors: all } });
  };

  const toggleFnOSConnector = (id: string, enabled: boolean) => {
    if (!config) return;
    const all = (config.PrivateLibraryConfig?.connectors || []).map((c) =>
      c.id === id ? { ...c, enabled, updatedAt: Date.now() } : c,
    );
    persist({ ...config, PrivateLibraryConfig: { connectors: all } });
  };

  const testFnOSConnector = async (connector: FnOSConnector) => {
    setTestingFnOS(connector.id);
    try {
      const res = await fetch('/api/source-manager/fnos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector, action: 'test' }),
      });
      const data = await res.json();
      if (data.ok) showToast('飞牛影视连接成功');
      else showToast(`连接失败：${data.detail || data.error || '未知错误'}`);
    } catch (e) {
      showToast(`测试失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestingFnOS(null);
    }
  };

  // ---------- 新增/编辑保存 ----------
  const saveVodEdit = (item: SourceItem) => {
    if (!config) return;
    const exists = (config.SourceConfig || []).some((s) => s.key === item.key);
    const next = {
      ...config,
      SourceConfig: exists
        ? (config.SourceConfig || []).map((s) =>
            s.key === item.key ? item : s,
          )
        : [...(config.SourceConfig || []), item],
    };
    persist(next);
    setEditingVod(null);
  };

  const saveLiveEdit = (item: LiveItem) => {
    if (!config) return;
    const exists = (config.LiveConfig || []).some((l) => l.key === item.key);
    const next = {
      ...config,
      LiveConfig: exists
        ? (config.LiveConfig || []).map((l) => (l.key === item.key ? item : l))
        : [...(config.LiveConfig || []), item],
    };
    persist(next);
    setEditingLive(null);
  };

  // ---------- 导入 ----------
  const doImport = async () => {
    if (!importUrl.trim() && !importContent.trim()) {
      showToast('请输入订阅地址或粘贴配置内容');
      return;
    }
    setImporting(true);
    setImportPreview(null);
    try {
      const res = await fetch('/api/source-manager/fetch-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: importUrl.trim() || undefined,
          content: importContent.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '解析失败');
      setImportPreview({
        sources: data.sources || [],
        lives: data.lives || [],
        format: data.format || 'unknown',
      });
      if ((data.sources?.length || 0) + (data.lives?.length || 0) === 0) {
        showToast('未识别到可导入的源');
      }
    } catch (e) {
      showToast(`解析失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = () => {
    if (!config || !importPreview) return;
    const existingVodKeys = new Set(
      (config.SourceConfig || []).map((s) => s.key),
    );
    const existingLiveKeys = new Set(
      (config.LiveConfig || []).map((l) => l.key),
    );

    const newSources: SourceItem[] = [];
    for (const s of importPreview.sources) {
      if (!existingVodKeys.has(s.key) && s.api) {
        newSources.push({ ...s, from: 'custom', disabled: false });
        existingVodKeys.add(s.key);
      }
    }
    const newLives: LiveItem[] = [];
    for (const l of importPreview.lives) {
      if (!existingLiveKeys.has(l.key) && l.url) {
        newLives.push({ ...l, from: 'custom', disabled: false });
        existingLiveKeys.add(l.key);
      }
    }

    if (newSources.length + newLives.length === 0) {
      showToast('没有新增的源（可能已存在）');
      return;
    }
    const next = {
      ...config,
      SourceConfig: [...(config.SourceConfig || []), ...newSources],
      LiveConfig: [...(config.LiveConfig || []), ...newLives],
    };
    persist(next);
    setImportPreview(null);
    setImportUrl('');
    setImportContent('');
  };

  // 恢复内置预置源（追加缺失的 config 源）
  const restorePreset = async () => {
    if (!config) return;
    try {
      const res = await fetch('/api/source-manager/preset', {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!data.success) throw new Error('无法读取预置源');
      const presetSources: SourceItem[] = data.sources || [];
      const presetLives: LiveItem[] = data.lives || [];
      const vkeys = new Set((config.SourceConfig || []).map((s) => s.key));
      const lkeys = new Set((config.LiveConfig || []).map((l) => l.key));
      const next = {
        ...config,
        SourceConfig: [
          ...(config.SourceConfig || []),
          ...presetSources.filter((s) => !vkeys.has(s.key)),
        ],
        LiveConfig: [
          ...(config.LiveConfig || []),
          ...presetLives.filter((l) => !lkeys.has(l.key)),
        ],
      };
      persist(next);
      setConfirmReset(false);
    } catch (e) {
      showToast(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (loading || !config) {
    return (
      <PageLayout activePath='/source-manager'>
        <div className='flex items-center justify-center min-h-[60vh]'>
          <Loader2 className='w-8 h-8 animate-spin text-purple-500' />
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/source-manager'>
      <div className='max-w-5xl mx-auto px-4 py-6'>
        {/* 头部 */}
        <div className='flex items-center justify-between mb-6 flex-wrap gap-3'>
          <div>
            <h1 className='text-2xl font-bold text-gray-900 dark:text-gray-100'>
              源管理
            </h1>
            <p className='text-sm text-gray-500 dark:text-gray-400 mt-1'>
              管理点播源与直播源，支持订阅导入。共 {vodSources.length}{' '}
              个点播源、
              {liveSources.length} 个直播源。
            </p>
          </div>
          <div className='flex items-center gap-2'>
            {saving && (
              <span className='flex items-center gap-1 text-xs text-gray-500'>
                <Loader2 className='w-3 h-3 animate-spin' /> 保存中
              </span>
            )}
            <button
              onClick={() => setConfirmReset(true)}
              className='flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-gray-200 hover:opacity-80'
            >
              <RotateCcw className='w-4 h-4' /> 恢复预置源
            </button>
          </div>
        </div>

        {/* Tab */}
        <div className='flex gap-2 mb-5 border-b border-gray-200 dark:border-zinc-700'>
          {(
            [
              ['vod', `点播源 (${vodSources.length})`],
              ['live', `直播源 (${liveSources.length})`],
              ['import', '导入订阅'],
              ['fnos', `飞牛影视 (${fnosConnectors.length})`],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
                tab === key
                  ? 'border-purple-600 text-purple-600 dark:text-purple-400 dark:border-purple-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 点播源列表 */}
        {tab === 'vod' && (
          <div className='space-y-2'>
            <button
              onClick={() =>
                setEditingVod({
                  key: genKey('vod'),
                  name: '',
                  api: '',
                  from: 'custom',
                  disabled: false,
                })
              }
              className='flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700 mb-4'
            >
              <Plus className='w-4 h-4' /> 添加点播源
            </button>
            {vodSources.map((s, i) => (
              <div
                key={s.key}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  s.disabled
                    ? 'bg-gray-100 dark:bg-zinc-900 opacity-60'
                    : 'bg-white dark:bg-zinc-800'
                } border-gray-200 dark:border-zinc-700`}
              >
                <div className='flex flex-col gap-0.5'>
                  <button
                    onClick={() => moveVod(s.key, -1)}
                    disabled={i === 0}
                    className='text-gray-400 hover:text-gray-700 disabled:opacity-30'
                  >
                    <ChevronUp className='w-4 h-4' />
                  </button>
                  <button
                    onClick={() => moveVod(s.key, 1)}
                    disabled={i === vodSources.length - 1}
                    className='text-gray-400 hover:text-gray-700 disabled:opacity-30'
                  >
                    <ChevronDown className='w-4 h-4' />
                  </button>
                </div>
                <div className='flex-1 min-w-0'>
                  <div className='flex items-center gap-2'>
                    <span className='font-medium text-sm text-gray-900 dark:text-gray-100 truncate'>
                      {s.name}
                    </span>
                    <span className='text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-gray-300'>
                      {s.from === 'config' ? '预置' : '自定义'}
                    </span>
                  </div>
                  <div className='text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5'>
                    {s.api}
                  </div>
                </div>
                <button
                  onClick={() => updateVod(s.key, { disabled: !s.disabled })}
                  title={s.disabled ? '启用' : '禁用'}
                  className={`px-2 py-1 rounded text-xs ${
                    s.disabled
                      ? 'bg-gray-300 dark:bg-zinc-600 text-gray-700 dark:text-gray-200'
                      : 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                  }`}
                >
                  {s.disabled ? '已禁用' : '启用中'}
                </button>
                <button
                  onClick={() => setEditingVod({ ...s })}
                  title='编辑'
                  className='p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded'
                >
                  <Edit3 className='w-4 h-4' />
                </button>
                <button
                  onClick={() => deleteVod(s.key)}
                  title='删除'
                  className='p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded'
                >
                  <Trash2 className='w-4 h-4' />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 直播源列表 */}
        {tab === 'live' && (
          <div className='space-y-2'>
            <button
              onClick={() =>
                setEditingLive({
                  key: genKey('live'),
                  name: '',
                  url: '',
                  from: 'custom',
                  disabled: false,
                })
              }
              className='flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700 mb-4'
            >
              <Plus className='w-4 h-4' /> 添加直播源
            </button>
            {liveSources.map((l, i) => (
              <div
                key={l.key}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  l.disabled
                    ? 'bg-gray-100 dark:bg-zinc-900 opacity-60'
                    : 'bg-white dark:bg-zinc-800'
                } border-gray-200 dark:border-zinc-700`}
              >
                <div className='flex flex-col gap-0.5'>
                  <button
                    onClick={() => moveLive(l.key, -1)}
                    disabled={i === 0}
                    className='text-gray-400 hover:text-gray-700 disabled:opacity-30'
                  >
                    <ChevronUp className='w-4 h-4' />
                  </button>
                  <button
                    onClick={() => moveLive(l.key, 1)}
                    disabled={i === liveSources.length - 1}
                    className='text-gray-400 hover:text-gray-700 disabled:opacity-30'
                  >
                    <ChevronDown className='w-4 h-4' />
                  </button>
                </div>
                <div className='flex-1 min-w-0'>
                  <div className='flex items-center gap-2'>
                    <span className='font-medium text-sm text-gray-900 dark:text-gray-100 truncate'>
                      {l.name}
                    </span>
                    <span className='text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-gray-300'>
                      {l.from === 'config' ? '预置' : '自定义'}
                    </span>
                    <span className='text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'>
                      {l.channelNumber ? `${l.channelNumber} 频道` : '未刷新'}
                    </span>
                  </div>
                  <div className='text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5'>
                    {l.url}
                  </div>
                </div>
                <button
                  onClick={() => updateLive(l.key, { disabled: !l.disabled })}
                  className={`px-2 py-1 rounded text-xs ${
                    l.disabled
                      ? 'bg-gray-300 dark:bg-zinc-600 text-gray-700 dark:text-gray-200'
                      : 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                  }`}
                >
                  {l.disabled ? '已禁用' : '启用中'}
                </button>
                <button
                  onClick={() => setEditingLive({ ...l })}
                  className='p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded'
                >
                  <Edit3 className='w-4 h-4' />
                </button>
                <button
                  onClick={() => deleteLive(l.key)}
                  className='p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded'
                >
                  <Trash2 className='w-4 h-4' />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 导入订阅 */}
        {tab === 'import' && (
          <div className='space-y-4'>
            <div className='p-4 rounded-lg bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700'>
              <h2 className='text-base font-semibold text-gray-900 dark:text-gray-100 mb-1'>
                导入订阅地址
              </h2>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-4'>
                支持 God TV 配置 JSON、Base58 订阅、TVBox sites/lives
                配置，以及直播 txt 列表地址。 导入采用<b>追加合并</b>
                ，不会删除现有源。
              </p>
              <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
                订阅 / 直播列表地址
              </label>
              <div className='flex gap-2'>
                <div className='flex-1 relative'>
                  <Link2 className='w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400' />
                  <input
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder='https://example.com/config.json 或 live.txt'
                    className='w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm text-gray-900 dark:text-gray-100'
                  />
                </div>
              </div>
              <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1 mt-4'>
                或直接粘贴配置内容（JSON / Base58）
              </label>
              <textarea
                value={importContent}
                onChange={(e) => setImportContent(e.target.value)}
                rows={5}
                placeholder='粘贴配置 JSON 文本…'
                className='w-full p-3 rounded-lg border border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900 text-sm font-mono text-gray-900 dark:text-gray-100'
              />
              <button
                onClick={doImport}
                disabled={importing}
                className='mt-4 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-60'
              >
                {importing ? (
                  <Loader2 className='w-4 h-4 animate-spin' />
                ) : (
                  <Download className='w-4 h-4' />
                )}
                {importing ? '解析中…' : '解析订阅'}
              </button>
            </div>

            {importPreview && (
              <div className='p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'>
                <h3 className='font-semibold text-green-800 dark:text-green-300 mb-2'>
                  解析结果（格式：{importPreview.format}）
                </h3>
                <p className='text-sm text-green-700 dark:text-green-300 mb-3'>
                  将新增 {importPreview.sources.length} 个点播源、
                  {importPreview.lives.length} 个直播源
                </p>
                <div className='max-h-52 overflow-auto space-y-1 mb-4'>
                  {importPreview.sources.map((s) => (
                    <div
                      key={s.key}
                      className='text-xs text-gray-700 dark:text-gray-300 truncate'
                    >
                      [点播] {s.name} — {s.api}
                    </div>
                  ))}
                  {importPreview.lives.map((l) => (
                    <div
                      key={l.key}
                      className='text-xs text-gray-700 dark:text-gray-300 truncate'
                    >
                      [直播] {l.name} — {l.url}
                    </div>
                  ))}
                </div>
                <div className='flex gap-2'>
                  <button
                    onClick={confirmImport}
                    className='flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-green-600 text-white hover:bg-green-700'
                  >
                    <Check className='w-4 h-4' /> 确认导入
                  </button>
                  <button
                    onClick={() => setImportPreview(null)}
                    className='flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-gray-200'
                  >
                    <X className='w-4 h-4' /> 取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 飞牛影视连接器 */}
        {tab === 'fnos' && (
          <div className='space-y-3'>
            <div className='p-4 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800'>
              <h2 className='text-base font-semibold text-orange-800 dark:text-orange-300 mb-1'>
                飞牛影视 (fnOS) 媒体库
              </h2>
              <p className='text-xs text-orange-700 dark:text-orange-300/80'>
                连接你的飞牛 NAS 影视库。填写 NAS 地址（默认端口
                5666）与用户名密码， 或访问令牌
                Token。连接后影片会出现在「我的影库」中。
              </p>
            </div>

            <button
              onClick={() =>
                setEditingFnOS({
                  id: genKey('fnos'),
                  name: '我的飞牛影视',
                  type: 'fnos',
                  enabled: true,
                  serverUrl: '',
                  token: '',
                  username: '',
                  password: '',
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                })
              }
              className='flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700'
            >
              <Plus className='w-4 h-4' /> 添加飞牛影视
            </button>

            {fnosConnectors.length === 0 && (
              <div className='text-center py-10 text-gray-400 dark:text-zinc-500 text-sm'>
                尚未配置飞牛影视，点击上方按钮添加。
              </div>
            )}

            {fnosConnectors.map((c) => (
              <div
                key={c.id}
                className={`p-4 rounded-lg border ${
                  c.enabled
                    ? 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-zinc-700'
                    : 'bg-gray-100 dark:bg-zinc-900 border-gray-200 dark:border-zinc-700 opacity-60'
                }`}
              >
                <div className='flex items-start justify-between gap-3 flex-wrap'>
                  <div className='flex-1 min-w-0'>
                    <div className='flex items-center gap-2'>
                      <span className='font-medium text-sm text-gray-900 dark:text-gray-100'>
                        {c.displayName || c.name}
                      </span>
                      <span className='text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300'>
                        飞牛影视
                      </span>
                    </div>
                    <div className='text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5'>
                      {c.serverUrl}
                    </div>
                    <div className='text-xs text-gray-400 dark:text-gray-500 mt-0.5'>
                      {c.token
                        ? '认证方式：访问令牌'
                        : c.username
                          ? `认证方式：账号 ${c.username}`
                          : '未填写凭证'}
                    </div>
                  </div>
                  <div className='flex items-center gap-1.5'>
                    <button
                      onClick={() => testFnOSConnector(c)}
                      disabled={testingFnOS === c.id}
                      className='flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 disabled:opacity-60'
                    >
                      {testingFnOS === c.id ? (
                        <Loader2 className='w-3.5 h-3.5 animate-spin' />
                      ) : (
                        <Check className='w-3.5 h-3.5' />
                      )}
                      测试
                    </button>
                    <button
                      onClick={() => toggleFnOSConnector(c.id, !c.enabled)}
                      className={`px-2.5 py-1.5 rounded text-xs ${
                        c.enabled
                          ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                          : 'bg-gray-300 dark:bg-zinc-600 text-gray-700 dark:text-gray-200'
                      }`}
                    >
                      {c.enabled ? '已启用' : '已禁用'}
                    </button>
                    <button
                      onClick={() => setEditingFnOS({ ...c })}
                      className='p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded'
                    >
                      <Edit3 className='w-4 h-4' />
                    </button>
                    <button
                      onClick={() => deleteFnOSConnector(c.id)}
                      className='p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded'
                    >
                      <Trash2 className='w-4 h-4' />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 飞牛影视编辑弹窗 */}
      {editingFnOS && (
        <EditModal
          title={editingFnOS.name ? '编辑飞牛影视' : '添加飞牛影视'}
          onClose={() => setEditingFnOS(null)}
          onSave={() => saveFnOSConnector(editingFnOS)}
        >
          <Field label='名称'>
            <input
              value={editingFnOS.name}
              onChange={(e) =>
                setEditingFnOS({ ...editingFnOS, name: e.target.value })
              }
              className='input-cls'
              placeholder='我的飞牛影视'
            />
          </Field>
          <Field label='服务地址（含端口）'>
            <input
              value={editingFnOS.serverUrl}
              onChange={(e) =>
                setEditingFnOS({ ...editingFnOS, serverUrl: e.target.value })
              }
              className='input-cls'
              placeholder='http://192.168.1.10:5666'
            />
          </Field>
          <Field label='访问令牌 Token（与用户名密码二选一）'>
            <input
              value={editingFnOS.token}
              onChange={(e) =>
                setEditingFnOS({ ...editingFnOS, token: e.target.value })
              }
              className='input-cls'
              placeholder='留空则使用用户名密码登录'
            />
          </Field>
          <Field label='用户名'>
            <input
              value={editingFnOS.username}
              onChange={(e) =>
                setEditingFnOS({ ...editingFnOS, username: e.target.value })
              }
              className='input-cls'
              placeholder='飞牛 NAS 用户名'
            />
          </Field>
          <Field label='密码'>
            <input
              type='password'
              value={editingFnOS.password}
              onChange={(e) =>
                setEditingFnOS({ ...editingFnOS, password: e.target.value })
              }
              className='input-cls'
              placeholder='飞牛 NAS 密码'
            />
          </Field>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
            FN Connect 用户可填
            https://&lt;你的FN_ID&gt;.5ddd.com；保存后建议点「测试」验证连接。
          </p>
        </EditModal>
      )}

      {/* 点播源编辑弹窗 */}
      {editingVod && (
        <EditModal
          title={editingVod.name ? '编辑点播源' : '添加点播源'}
          onClose={() => setEditingVod(null)}
          onSave={() => saveVodEdit(editingVod)}
        >
          <Field label='名称'>
            <input
              value={editingVod.name}
              onChange={(e) =>
                setEditingVod({ ...editingVod, name: e.target.value })
              }
              className='input-cls'
              placeholder='源名称'
            />
          </Field>
          <Field label='API 地址'>
            <input
              value={editingVod.api}
              onChange={(e) =>
                setEditingVod({ ...editingVod, api: e.target.value })
              }
              className='input-cls'
              placeholder='https://example.com/api.php/provide/vod/'
            />
          </Field>
          <Field label='详情地址（可选）'>
            <input
              value={editingVod.detail || ''}
              onChange={(e) =>
                setEditingVod({ ...editingVod, detail: e.target.value })
              }
              className='input-cls'
              placeholder='留空即可'
            />
          </Field>
        </EditModal>
      )}

      {/* 直播源编辑弹窗 */}
      {editingLive && (
        <EditModal
          title={editingLive.name ? '编辑直播源' : '添加直播源'}
          onClose={() => setEditingLive(null)}
          onSave={() => saveLiveEdit(editingLive)}
        >
          <Field label='名称'>
            <input
              value={editingLive.name}
              onChange={(e) =>
                setEditingLive({ ...editingLive, name: e.target.value })
              }
              className='input-cls'
              placeholder='直播源名称'
            />
          </Field>
          <Field label='播放列表地址（m3u / txt）'>
            <input
              value={editingLive.url}
              onChange={(e) =>
                setEditingLive({ ...editingLive, url: e.target.value })
              }
              className='input-cls'
              placeholder='https://example.com/live.txt'
            />
          </Field>
          <Field label='UA（可选）'>
            <input
              value={editingLive.ua || ''}
              onChange={(e) =>
                setEditingLive({ ...editingLive, ua: e.target.value })
              }
              className='input-cls'
              placeholder='okhttp/3.15'
            />
          </Field>
          <Field label='EPG 节目单（可选）'>
            <input
              value={editingLive.epg || ''}
              onChange={(e) =>
                setEditingLive({ ...editingLive, epg: e.target.value })
              }
              className='input-cls'
              placeholder='http://epg.example.com/?ch={name}'
            />
          </Field>
        </EditModal>
      )}

      {/* 恢复预置确认 */}
      {confirmReset && (
        <EditModal
          title='恢复预置源'
          onClose={() => setConfirmReset(false)}
          onSave={restorePreset}
          saveLabel='确认恢复'
        >
          <p className='text-sm text-gray-700 dark:text-gray-300'>
            将追加编译内置的预置点播源与直播源（已存在的会跳过，不会删除你现有的源）。是否继续？
          </p>
        </EditModal>
      )}

      {/* Toast */}
      {toast && (
        <div className='fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-lg bg-gray-900 text-white text-sm shadow-lg flex items-center gap-2'>
          <Save className='w-4 h-4' /> {toast}
        </div>
      )}

      <style jsx global>{`
        .input-cls {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border-radius: 0.5rem;
          border: 1px solid #d1d5db;
          background: #f9fafb;
          color: #111827;
          font-size: 0.875rem;
        }
        .dark .input-cls {
          border-color: #52525b;
          background: #18181b;
          color: #f4f4f5;
        }
      `}</style>
    </PageLayout>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className='mb-3'>
      <label className='block text-sm text-gray-700 dark:text-gray-300 mb-1'>
        {label}
      </label>
      {children}
    </div>
  );
}

function EditModal({
  title,
  children,
  onClose,
  onSave,
  saveLabel = '保存',
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'>
      <div className='w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-5 shadow-xl'>
        <h2 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {title}
        </h2>
        {children}
        <div className='flex justify-end gap-2 mt-5'>
          <button
            onClick={onClose}
            className='px-4 py-2 rounded-lg text-sm bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-gray-200'
          >
            取消
          </button>
          <button
            onClick={onSave}
            className='px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700'
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
