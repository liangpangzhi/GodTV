/**
 * 飞牛影视 (fnOS video) 客户端
 *
 * 依据 FlyNarwhal (https://github.com/FNOSP/FlyNarwhal) 逆向的官方 API 实现。
 * 飞牛影视使用自有 REST API (/v/api/v1/*)，不兼容 Emby/Jellyfin。
 *
 * 认证要点：
 * - 登录 POST /v/api/v1/login 获取 token（非 Bearer，直接放 Authorization 头）
 * - 每个请求需带 Authx 签名头（MD5）
 * - 必须带 x-trim-client: web 与 x-trim-client-version: 616，否则直播库不可见
 * - POST/DELETE 的参数必须放 body（服务端按 body 计算 Authx），GET 放 query
 */

import crypto from 'crypto';

import type { PrivateLibraryConnector } from './admin.types';

/**
 * 飞牛影视 Web 客户端内置的应用级签名密钥。
 *
 * 这不是用户凭据，而是官方 trimemedia-web 客户端随包分发的静态 Key/Secret
 * （公开逆向实现见 https://github.com/FNOSP/FlyNarwhal ），所有客户端一致。
 * 仍可通过环境变量覆盖，以便对接私有部署或未来官方更换密钥。
 */
const API_KEY = process.env.FNOS_API_KEY || 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const API_SECRET =
  process.env.FNOS_API_SECRET || '16CCEB3D-AB42-077D-36A1-F355324E4237';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const CONTROL_TIMEOUT_MS = 12000;
/**
 * 转码分辨率。
 * 飞牛在 resolution 为空时会按「原画」转码，MKV/HEVC 软转码耗时可能超过片长（实测 5s 分片需 5.2s），
 * 导致播放缓冲不断累积、延迟越来越大；显式指定分辨率后实测 5s 分片仅需 ~2.4s，可稳定实时播放。
 */
const DEFAULT_TRANSCODE_RESOLUTION = '1080p';

function md5(input: string): string {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

function randomDigits(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}

/** 计算 Authx 签名头 */
function genAuthx(
  urlPath: string,
  params?: Record<string, unknown>,
  data?: unknown,
): string {
  const nonce = randomDigits();
  const timestamp = String(Date.now());
  let dataJsonMd5: string;
  if (data !== undefined && data !== null) {
    dataJsonMd5 = md5(JSON.stringify(data));
  } else if (params && Object.keys(params).length > 0) {
    const sorted = Object.keys(params)
      .filter((k) => params[k] !== null && params[k] !== undefined)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    dataJsonMd5 = md5(sorted);
  } else {
    dataJsonMd5 = md5('');
  }
  const sign = md5(
    [API_KEY, urlPath, nonce, timestamp, dataJsonMd5, API_SECRET].join('_'),
  );
  return `nonce=${nonce}&timestamp=${timestamp}&sign=${sign}`;
}

interface FnBaseResponse<T> {
  code?: number;
  msg?: string;
  error?: string;
  data?: T;
}

interface FnAuth {
  token: string;
  cookie?: string;
}

/** 登录态缓存：避免每次请求都重新登录（对齐 FlyNarwhal 的 6h 缓存） */
const authCache = new Map<string, { token: string; expires: number }>();
const AUTH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function authCacheKey(connector: PrivateLibraryConnector): string {
  return `${connector.id}:${connector.updatedAt}:${connector.serverUrl}`;
}

/** 从连接器配置解析鉴权信息（token 直接使用，或用户名密码登录） */
export async function resolveAuth(
  connector: PrivateLibraryConnector,
  forceRefresh = false,
): Promise<FnAuth> {
  if (!forceRefresh && connector.token) {
    return { token: connector.token };
  }
  if (!connector.username || !connector.password) {
    throw new Error('飞牛影视需要填写访问令牌，或用户名与密码。');
  }

  const key = authCacheKey(connector);
  if (!forceRefresh) {
    const cached = authCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return { token: cached.token, cookie: `Trim-MC-token=${cached.token}` };
    }
  }

  const login = await fnLogin(
    connector.serverUrl.replace(/\/+$/, ''),
    connector.username,
    connector.password,
  );
  authCache.set(key, {
    token: login.token,
    expires: Date.now() + AUTH_CACHE_TTL_MS,
  });
  return { token: login.token, cookie: `Trim-MC-token=${login.token}` };
}

/** 登录获取 token */
export async function fnLogin(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ token: string }> {
  const path = '/v/api/v1/login';
  const body = { username, password, app_name: 'trimemedia-web' };
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'x-trim-client': 'web',
      'x-trim-client-version': '616',
      Authx: genAuthx(path, undefined, body),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  const json = (await res.json()) as FnBaseResponse<{ token: string }>;
  if (json.code !== 0 || !json.data?.token) {
    throw new Error(
      `飞牛影视登录失败：${json.msg || json.error || res.status}`,
    );
  }
  return { token: json.data.token };
}

/** 通用请求（自动注入鉴权与签名） */
async function fnRequest<T>(
  connector: PrivateLibraryConnector,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    params?: Record<string, unknown>;
    body?: unknown;
    auth?: FnAuth;
  } = {},
): Promise<T> {
  const auth = options.auth || (await resolveAuth(connector));
  const method = options.method || 'GET';
  const baseUrl = connector.serverUrl.replace(/\/+$/, '');

  let url = `${baseUrl}${path}`;
  if (
    method === 'GET' &&
    options.params &&
    Object.keys(options.params).length
  ) {
    const qs = new URLSearchParams();
    Object.entries(options.params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    });
    url += `?${qs.toString()}`;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    Authorization: auth.token,
    'x-trim-client': 'web',
    'x-trim-client-version': '616',
    Authx: genAuthx(
      path,
      method === 'GET' ? options.params : undefined,
      options.body,
    ),
  };
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });

  const text = await res.text();
  let json: FnBaseResponse<T>;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, '')) as FnBaseResponse<T>;
  } catch {
    throw new Error(`飞牛影视返回异常 (${res.status})：${text.slice(0, 120)}`);
  }
  if (json.code !== 0) {
    const msg = json.msg || json.error || `HTTP ${res.status}`;
    const err = new Error(`飞牛影视接口错误：${msg}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return json.data as T;
}

/** 测试连接：登录 + 拉取媒体库列表 */
export async function fnTestConnector(
  connector: PrivateLibraryConnector,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const auth = await resolveAuth(connector, true);
    await fnRequest<unknown[]>(connector, '/v/api/v1/mediadb/list', { auth });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------- 数据模型 ----------------

export interface FnMediaDb {
  guid?: string;
  title?: string;
  category?: string;
  view_type?: string;
  posters?: string[];
}

export interface FnMediaStream {
  resolutions?: string[];
  audio_type?: string;
  color_range_type?: string;
}

export interface FnMediaItem {
  guid?: string;
  title?: string;
  type?: string;
  poster?: string;
  poster_list?: string[];
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genres?: string[];
  media_stream?: FnMediaStream;
  ancestor_guid?: string;
  ancestor_name?: string;
  ancestor_category?: string;
  season_number?: number;
  episode_number?: number;
  number_of_seasons?: number;
  number_of_episodes?: number;
  local_number_of_seasons?: number;
  local_number_of_episodes?: number;
  duration?: number;
  imdb_id?: string;
  douban_id?: string;
  is_favorite?: boolean;
  watched?: boolean;
}

interface FnItemListResponse {
  list?: FnMediaItem[];
  total?: number;
  mdb_name?: string;
}

export interface FnSeason {
  guid?: string;
  season_number?: number;
  title?: string;
  tv_title?: string;
  parent_guid?: string;
}

export interface FnEpisode {
  guid?: string;
  parent_guid?: string;
  season_number?: number;
  episode_number?: number;
  title?: string;
  tv_title?: string;
  duration?: number;
  single_child_guid?: string;
  video_guid?: string;
  media_guid?: string;
}

export interface FnPlayInfo {
  guid?: string;
  media_guid?: string;
  video_guid?: string;
  parent_guid?: string;
  grand_guid?: string;
  ts?: number;
  item?: FnMediaItem;
  play_config?: { guid?: string; skip_opening?: number; skip_ending?: number };
}

export interface FnStreamInfo {
  video_stream?: {
    media_guid?: string;
    guid?: string;
    width?: number;
    height?: number;
  }[];
  audio_streams?: { media_guid?: string; guid?: string; language?: string }[];
  subtitle_streams?: { guid?: string }[];
  qualities?: { quality?: string; url?: string }[];
  direct_link_qualities?: { quality?: string; url?: string }[];
  direct_link_audio_streams?: unknown[];
  header?: Record<string, string>;
}

// ---------------- API 封装 ----------------

export async function fnListMediaDbs(
  connector: PrivateLibraryConnector,
  auth?: FnAuth,
): Promise<FnMediaDb[]> {
  return fnRequest<FnMediaDb[]>(connector, '/v/api/v1/mediadb/list', { auth });
}

export async function fnListItemList(
  connector: PrivateLibraryConnector,
  ancestorGuid: string,
  page: number,
  pageSize: number,
  auth?: FnAuth,
): Promise<FnItemListResponse> {
  const body = {
    ancestor_guid: ancestorGuid,
    parent_guid: '',
    exclude_grouped_video: 1,
    sort_type: 'DESC',
    sort_column: 'create_time',
    page_size: pageSize,
    page,
    tags: { type: [] },
  };
  return fnRequest<FnItemListResponse>(connector, '/v/api/v1/item/list', {
    method: 'POST',
    body,
    auth,
  });
}

export async function fnSearch(
  connector: PrivateLibraryConnector,
  query: string,
  auth?: FnAuth,
): Promise<FnMediaItem[]> {
  return fnRequest<FnMediaItem[]>(connector, '/v/api/v1/search/list', {
    params: { q: query },
    auth,
  });
}

export async function fnGetSeasons(
  connector: PrivateLibraryConnector,
  guid: string,
  auth?: FnAuth,
): Promise<FnSeason[]> {
  return fnRequest<FnSeason[]>(
    connector,
    `/v/api/v1/season/list/${encodeURIComponent(guid)}`,
    { auth },
  );
}

export async function fnGetEpisodes(
  connector: PrivateLibraryConnector,
  guid: string,
  auth?: FnAuth,
): Promise<FnEpisode[]> {
  return fnRequest<FnEpisode[]>(
    connector,
    `/v/api/v1/episode/list/${encodeURIComponent(guid)}`,
    { auth },
  );
}

export async function fnGetPlayInfo(
  connector: PrivateLibraryConnector,
  itemGuid: string,
  auth?: FnAuth,
): Promise<FnPlayInfo> {
  return fnRequest<FnPlayInfo>(connector, '/v/api/v1/play/info', {
    method: 'POST',
    body: { item_guid: itemGuid },
    auth,
  });
}

/**
 * 获取条目对应的 media_guid（原片地址用）。
 * 飞牛原片通过 /v/api/v1/media/range/{media_guid} 提供，支持 Range 请求。
 */
export async function fnGetMediaGuid(
  connector: PrivateLibraryConnector,
  itemGuid: string,
  auth?: FnAuth,
): Promise<string> {
  const playInfo = await fnGetPlayInfo(connector, itemGuid, auth);
  const mediaGuid = playInfo.media_guid;
  if (!mediaGuid) {
    throw new Error('飞牛影视未返回 media_guid，无法获取原片');
  }
  return mediaGuid;
}

/** 构造原片地址（支持 Range） */
export function fnBuildOriginalMediaUrl(
  connector: PrivateLibraryConnector,
  mediaGuid: string,
): string {
  const baseUrl = connector.serverUrl.replace(/\/+$/, '');
  return `${baseUrl}/v/api/v1/media/range/${encodeURIComponent(mediaGuid)}`;
}

export type FnContainerType = 'mp4' | 'webm' | 'mkv' | 'ts' | 'flv' | 'unknown';

/** 依据文件头判断容器类型 */
export function detectContainerType(head: Uint8Array): FnContainerType {
  if (head.length >= 8) {
    // ISO BMFF: [size][ftyp]
    const ftyp = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (ftyp === 'ftyp') return 'mp4';

    // Matroska / WebM (EBML)
    if (
      head[0] === 0x1a &&
      head[1] === 0x45 &&
      head[2] === 0xdf &&
      head[3] === 0xa3
    ) {
      const text = Buffer.from(head).toString('latin1');
      if (text.includes('webm')) return 'webm';
      return 'mkv';
    }

    // MPEG-TS
    if (head[0] === 0x47 && head.length > 188 && head[188] === 0x47)
      return 'ts';

    // FLV
    if (head[0] === 0x46 && head[1] === 0x4c && head[2] === 0x56) return 'flv';
  }
  return 'unknown';
}

/**
 * 探测原片容器类型（读取文件头，不下载整个文件）。
 */
export async function fnProbeContainer(
  connector: PrivateLibraryConnector,
  mediaGuid: string,
  auth?: FnAuth,
): Promise<{ container: FnContainerType; size?: number }> {
  const resolvedAuth = auth || (await resolveAuth(connector));
  const url = fnBuildOriginalMediaUrl(connector, mediaGuid);
  const res = await fetch(url, {
    headers: {
      ...buildFnHeaders(resolvedAuth),
      Range: 'bytes=0-65535',
    },
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`飞牛原片探测失败：HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const range = res.headers.get('content-range') || '';
  const sizeMatch = range.match(/\/(\d+)$/);
  return {
    container: detectContainerType(buf),
    size: sizeMatch ? Number(sizeMatch[1]) : undefined,
  };
}

/**
 * 获取原片请求信息（地址 + 鉴权头），供本地直连/转封装使用。
 */
export async function fnGetOriginalMediaRequest(
  connector: PrivateLibraryConnector,
  itemGuid: string,
  auth?: FnAuth,
): Promise<{
  url: string;
  mediaGuid: string;
  headers: Record<string, string>;
}> {
  const resolvedAuth = auth || (await resolveAuth(connector));
  const mediaGuid = await fnGetMediaGuid(connector, itemGuid, resolvedAuth);
  return {
    url: fnBuildOriginalMediaUrl(connector, mediaGuid),
    mediaGuid,
    headers: buildFnHeaders(resolvedAuth),
  };
}

/** 把请求头转换为 ffmpeg -headers 参数格式 */
export function fnHeadersToFfmpegArg(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('');
}

export async function fnGetStreamInfo(
  connector: PrivateLibraryConnector,
  mediaGuid: string,
  auth?: FnAuth,
): Promise<FnStreamInfo> {
  return fnRequest<FnStreamInfo>(connector, '/v/api/v1/stream', {
    method: 'POST',
    body: { media_guid: mediaGuid, level: 1 },
    auth,
  });
}

/** 构造播放地址：优先原生直链，转码回退 /play/play */
export async function fnResolvePlayback(
  connector: PrivateLibraryConnector,
  sourceItemId: string,
  auth?: FnAuth,
): Promise<{ url: string; headers?: Record<string, string> }> {
  const resolvedAuth = auth || (await resolveAuth(connector));
  const baseUrl = connector.serverUrl.replace(/\/+$/, '');

  try {
    // sourceItemId 形如 <itemGuid>::<mediaGuid> 或 <itemGuid>::<mediaGuid>::<videoGuid>
    const parts = sourceItemId.split('::');
    const itemGuid = parts[0];
    const mediaGuidFromId = parts[1];
    const videoGuidFromId = parts[2];

    let mediaGuid: string | undefined = mediaGuidFromId || undefined;
    let videoGuid: string | undefined = videoGuidFromId || undefined;
    if (!mediaGuid || !videoGuid) {
      try {
        const playInfo = await fnGetPlayInfo(connector, itemGuid, resolvedAuth);
        mediaGuid = mediaGuid || playInfo.media_guid || undefined;
        videoGuid = videoGuid || playInfo.video_guid || undefined;
      } catch {
        // 忽略，下面用已有 mediaGuid 尝试
      }
    }

    if (mediaGuid) {
      // 尝试 stream 接口获取直链画质
      try {
        const stream = await fnGetStreamInfo(
          connector,
          mediaGuid,
          resolvedAuth,
        );
        const direct =
          stream.direct_link_qualities?.find((q) => q?.url)?.url ||
          stream.qualities?.find((q) => q?.url)?.url;
        if (direct && /^https?:\/\//i.test(direct)) {
          return { url: direct, headers: stream.header };
        }
        // 媒体源直链：/media/range/{mediaGuid}
        return {
          url: `${baseUrl}/v/api/v1/media/range/${encodeURIComponent(mediaGuid)}`,
          headers: buildFnHeaders(resolvedAuth),
        };
      } catch {
        // 落到转码
      }
    }

    // 转码 HLS
    const path = '/v/api/v1/play/play';
    const body = {
      media_guid: mediaGuid || '',
      video_guid: videoGuid || '',
      video_encoder: 'h264',
      resolution: DEFAULT_TRANSCODE_RESOLUTION,
      bitrate: 0,
      startTimestamp: 0,
      audio_encoder: 'aac',
      audio_guid: '',
      subtitle_guid: '',
      channels: 2,
      forced_sdr: 0,
    };
    const headers: Record<string, string> = {
      ...buildFnHeaders(resolvedAuth),
      'Content-Type': 'application/json',
      Authx: genAuthx(path, undefined, body),
    };
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const json = (await res.json()) as FnBaseResponse<{ play_link?: string }>;
    if (json.code !== 0 || !json.data?.play_link) {
      throw new Error(
        `飞牛影视播放失败：${json.msg || json.error || res.status}`,
      );
    }
    const playLink = json.data.play_link;
    const url = /^https?:\/\//i.test(playLink)
      ? playLink
      : `${baseUrl}${playLink.startsWith('/') ? '' : '/'}${playLink}`;
    return { url, headers: buildFnHeaders(resolvedAuth) };
  } catch (error) {
    throw new Error(
      `飞牛影视播放地址解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildFnHeaders(auth: FnAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    Authorization: auth.token,
    'x-trim-client': 'web',
    'x-trim-client-version': '616',
  };
  if (auth.cookie) headers.Cookie = auth.cookie;
  return headers;
}

/** 构造海报地址（由 poster 路由代理，带鉴权） */
export function fnBuildPosterUrl(
  connector: PrivateLibraryConnector,
  posterPath: string,
): { url: string; headers?: Record<string, string> } | null {
  if (!posterPath) return null;
  const baseUrl = connector.serverUrl.replace(/\/+$/, '');
  let url: string;
  if (/^https?:\/\//i.test(posterPath)) {
    url = posterPath;
  } else {
    const path = posterPath.startsWith('/') ? posterPath : `/${posterPath}`;
    url = `${baseUrl}/v/api/v1/sys/img${path}?w=500`;
  }
  return { url, headers: buildFnHeaders({ token: connector.token }) };
}

/**
 * 根据 sourceItemId 构造带鉴权的海报请求（供 poster 路由代理使用）。
 * 飞牛海报路径为 /v/api/v1/sys/img{path}，需要 token 鉴权。
 */
export async function fnResolvePosterUrl(
  connector: PrivateLibraryConnector,
  posterPath: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (!posterPath) return null;
  const auth = await resolveAuth(connector);
  const baseUrl = connector.serverUrl.replace(/\/+$/, '');
  const path = posterPath.startsWith('/') ? posterPath : `/${posterPath}`;
  const url = /^https?:\/\//i.test(posterPath)
    ? posterPath
    : `${baseUrl}/v/api/v1/sys/img${path}?w=500`;
  return { url, headers: buildFnHeaders(auth) };
}

/** 上报播放进度 */
export async function fnReportProgress(
  connector: PrivateLibraryConnector,
  sourceItemId: string,
  positionSeconds: number,
  auth?: FnAuth,
): Promise<void> {
  const parts = sourceItemId.split('::');
  const body = {
    item_guid: parts[0],
    media_guid: parts[1] || '',
    ts: Math.max(0, Math.floor(positionSeconds)),
    lan: 'zh-CN',
    device_name: 'God TV',
  };
  await fnRequest<unknown>(connector, '/v/api/v1/play/record', {
    method: 'POST',
    body,
    auth,
  });
}
