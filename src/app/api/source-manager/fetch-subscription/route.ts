/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface ParsedSource {
  key: string;
  name: string;
  api: string;
  detail?: string;
  is_adult?: boolean;
}
interface ParsedLive {
  key: string;
  name: string;
  url: string;
  ua?: string;
  epg?: string;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** 去掉 API 末尾已有的 query（God TV 会自行拼接 ?ac=videolist&wd=） */
function cleanApi(api: string): string {
  try {
    const u = new URL(api);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return api.split('?')[0].replace(/\/+$/, '');
  }
}

function uniqueKey(prefix: string, name: string, index: number): string {
  const clean = name
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[｜|┃\s]/g, '')
    .trim()
    .slice(0, 24);
  return `${prefix}_${clean || index}_${Date.now().toString(36)}`;
}

/**
 * 解析配置文件内容，支持三种格式：
 *  1) God TV 配置：{ api_site: {...}, lives: {...} }
 *  2) TVBox 配置：{ sites: [...], lives: [...] }
 *  3) 源数组：[{ key, name, api }]  （点播）
 */
function parseConfigContent(raw: string): {
  sources: ParsedSource[];
  lives: ParsedLive[];
  format: string;
} {
  let text = raw.trim();
  const b64Match = text.match(/^base64\s*[,:]\s*([\s\S]+)$/i);
  if (b64Match) {
    text = Buffer.from(b64Match[1].trim(), 'base64').toString('utf-8');
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { sources: [], lives: [], format: 'unknown' };
  }

  const sources: ParsedSource[] = [];
  const lives: ParsedLive[] = [];
  let format = 'unknown';

  if (!data || typeof data !== 'object') {
    return { sources, lives, format };
  }

  // 数组：点播源列表
  if (Array.isArray(data)) {
    format = 'array';
    data.forEach((item: Record<string, string>, i: number) => {
      if (!item || typeof item !== 'object' || !item.api) return;
      if (!isHttpUrl(item.api)) return; // 跳过 csp_ 等自定义爬虫
      sources.push({
        key: item.key || uniqueKey('vod', item.name || '', i),
        name: item.name || item.key || `点播源${i + 1}`,
        api: cleanApi(item.api),
        detail: item.detail,
        is_adult: !!item.is_adult,
      });
    });
    return { sources, lives, format };
  }

  const obj = data as Record<string, unknown>;

  // God TV 配置格式：api_site / lives 为对象字典
  if (obj.api_site && typeof obj.api_site === 'object') {
    format = 'decotv';
    Object.entries(
      obj.api_site as Record<string, Record<string, string>>,
    ).forEach(([key, site], i) => {
      if (!site || !site.api || !isHttpUrl(site.api)) return;
      sources.push({
        key: key || uniqueKey('vod', site.name || '', i),
        name: site.name || key,
        api: cleanApi(site.api),
        detail: site.detail,
        is_adult: !!site.is_adult,
      });
    });
  }

  // TVBox 格式：sites / lives 为数组
  if (obj.sites && Array.isArray(obj.sites)) {
    format = 'tvbox';
    (obj.sites as Record<string, unknown>[]).forEach((site, i) => {
      const api = String(site.api || '');
      if (!isHttpUrl(api)) return; // 跳过 csp_ 等爬虫源
      // 只保留苹果 CMS 采集接口
      const low = api.toLowerCase();
      if (
        !low.includes('api.php') &&
        !low.includes('provide/vod') &&
        !low.includes('api_mac10') &&
        !low.includes('mc/vod')
      ) {
        return;
      }
      const key = String(
        site.key || uniqueKey('vod', String(site.name || ''), i),
      );
      sources.push({
        key,
        name: String(site.name || key),
        api: cleanApi(api),
        detail: site.ext ? String(site.ext) : undefined,
      });
    });
  }

  // 直播源：God TV 字典格式 或 TVBox 数组格式
  const livesRaw = obj.lives;
  if (livesRaw && typeof livesRaw === 'object') {
    if (!format || format === 'array') format = 'decotv';
    const entries: [string, Record<string, string>][] = Array.isArray(livesRaw)
      ? livesRaw.map((l: Record<string, string>, i: number) => [
          l.key || String(i),
          l,
        ])
      : Object.entries(livesRaw as Record<string, Record<string, string>>);
    entries.forEach(([key, live], i) => {
      if (!live || !live.url || !isHttpUrl(live.url)) return;
      lives.push({
        key: key || uniqueKey('live', live.name || '', i),
        name: live.name || key,
        url: live.url,
        ua: live.ua,
        epg: live.epg,
      });
    });
  }

  return { sources, lives, format };
}

/**
 * POST /api/source-manager/fetch-subscription
 * 请求体：{ url?: string, content?: string }
 * - url：服务端代为抓取（绕 CORS），支持 base58 / base64 / 原始 JSON
 * - content：直接解析粘贴的文本
 * 返回：{ success, sources, lives, format, rawPreview }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, content } = body as { url?: string; content?: string };

    let raw = '';
    if (url) {
      if (!isHttpUrl(url)) {
        return NextResponse.json({ error: '订阅地址无效' }, { status: 400 });
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA },
          signal: ctrl.signal,
          redirect: 'follow',
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        raw = await res.text();
      } finally {
        clearTimeout(timer);
      }
    } else if (content) {
      raw = content;
    } else {
      return NextResponse.json(
        { error: '请提供订阅地址或配置内容' },
        { status: 400 },
      );
    }

    // 尝试 base58 解码（God TV 订阅常见格式）
    let decoded = raw.trim();
    try {
      const bs58 = (await import('bs58')).default;
      const bytes = bs58.decode(decoded);
      const candidate = new TextDecoder().decode(bytes);
      if (
        candidate.trim().startsWith('{') ||
        candidate.trim().startsWith('[')
      ) {
        decoded = candidate;
      }
    } catch {
      // 非 base58，保持原文
    }

    let result = parseConfigContent(decoded);

    // 纯文本直播列表（TVBox txt：#genre# 分组 或 "名称,URL" 行）作为单个直播源导入
    if (result.format === 'unknown' && url) {
      const looksLikeLiveList =
        /#genre#/i.test(decoded) ||
        /^[^,\n]+,\s*https?:\/\//im.test(decoded) ||
        /^#EXTM3U/im.test(decoded);
      if (looksLikeLiveList) {
        let name = '导入的直播源';
        const m = url.match(/\/([^/]+)$/);
        if (m && m[1])
          name = decodeURIComponent(m[1]).replace(/\.(txt|m3u8?)$/i, '');
        result = {
          sources: [],
          lives: [
            {
              key: uniqueKey('live', name, 0),
              name,
              url,
            },
          ],
          format: 'live-list',
        };
      }
    }

    return NextResponse.json({
      success: true,
      ...result,
      rawPreview: decoded.slice(0, 500),
    });
  } catch (error) {
    console.error('[SourceManager] 解析订阅失败:', error);
    return NextResponse.json(
      {
        error: `解析失败：${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}
