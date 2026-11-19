import { NextRequest, NextResponse } from 'next/server';

import { verifyApiAuth } from '@/lib/auth';
import {
  cleanupLocalCache,
  hasLocalFfmpeg,
  isLocalCacheReady,
  localCacheFreeSpace,
  localCacheInfo,
  type LocalPlaybackMode,
  resolveLocalMediaSource,
  serveLocalFile,
  startLocalTranscode,
  streamLocalGrowingFile,
  waitForMoovDurationPatch,
} from '@/lib/fnos-local-player';
import {
  getPrivateLibraryConfig,
  toPrivateLibraryErrorMessage,
} from '@/lib/private-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cacheCleaned = false;

/**
 * GET /api/private-library/local-stream
 * 参数：connectorId、sourceItemId、mode(auto|direct|remux|transcode)、start(秒)
 *
 * 飞牛影视本地解码播放：
 *  - direct：原片容器浏览器可解时直接 Range 代理原片；
 *  - remux / transcode：由本机 ffmpeg 转封装或转码为分片 MP4 后流式返回；
 *  - auto：按 mp4/webm → 直连，其余 → 本地转封装（无 ffmpeg 时返回提示）。
 */
export async function GET(request: NextRequest) {
  const authResult = verifyApiAuth(request);
  if (!authResult.isValid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (!cacheCleaned) {
      cacheCleaned = true;
      cleanupLocalCache();
    }
    const { searchParams } = new URL(request.url);
    const connectorId = (searchParams.get('connectorId') || '').trim();
    const sourceItemId = (searchParams.get('sourceItemId') || '').trim();
    const mode = ((searchParams.get('mode') || 'auto').trim() ||
      'auto') as LocalPlaybackMode;
    const startRaw = (searchParams.get('start') || '').trim();
    const startSeconds =
      startRaw && /^\d+(\.\d+)?$/.test(startRaw) ? Number(startRaw) : undefined;
    // 调用方（详情接口）可带上飞牛元数据里的精确时长，用于回填 moov
    const durationRaw = (searchParams.get('duration') || '').trim();
    const durationSeconds =
      durationRaw && /^\d+(\.\d+)?$/.test(durationRaw)
        ? Number(durationRaw)
        : undefined;

    if (!connectorId || !sourceItemId) {
      return NextResponse.json(
        { error: 'connectorId 和 sourceItemId 不能为空' },
        { status: 400 },
      );
    }

    const cfg = await getPrivateLibraryConfig();
    const connector = cfg.connectors.find(
      (item) => item.id === connectorId && item.enabled,
    );
    if (!connector) {
      return NextResponse.json(
        { error: '未找到对应的飞牛影视连接器' },
        { status: 404 },
      );
    }
    if (connector.type !== 'fnos') {
      return NextResponse.json(
        { error: '该连接器不支持本地解码' },
        { status: 400 },
      );
    }

    const source = await resolveLocalMediaSource(connector, sourceItemId);
    const range = request.headers.get('range') || '';

    // 1) 直连原片：仅当容器确认浏览器可解（mp4/webm）时才直连，
    //    否则（mkv/ts/未知）一律走本地转封装，避免把浏览器解不了的容器直接喂给播放器。
    const browserReady =
      source.container === 'mp4' || source.container === 'webm';
    const wantDirect = (mode === 'direct' || mode === 'auto') && browserReady;
    if (wantDirect) {
      const upstream = await fetch(source.url, {
        headers: {
          ...source.headers,
          ...(range ? { Range: range } : {}),
        },
      });
      if (upstream.ok || upstream.status === 206) {
        const headers = new Headers();
        [
          'content-type',
          'content-length',
          'accept-ranges',
          'content-range',
        ].forEach((name) => {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        });
        headers.set(
          'Content-Type',
          source.container === 'webm' ? 'video/webm' : 'video/mp4',
        );
        headers.set('Accept-Ranges', 'bytes');
        return new Response(upstream.body, {
          status: upstream.status === 206 ? 206 : 200,
          headers,
        });
      }
    }

    // 2) 本地缓存已完成 → 直接按字节 Range 返回（可任意拖动）
    const transcodeMode = mode === 'transcode' ? 'transcode' : 'remux';
    if (!startSeconds) {
      const cached = isLocalCacheReady(
        connectorId,
        sourceItemId,
        transcodeMode,
      );
      if (cached?.ready) {
        const served = serveLocalFile(cached.file, range || null, {
          alignToFragment: true,
        });
        if (served) return served;
      }
    }

    // 2b) 转码进行中 + 带 Range 的续传请求 → 以「增长文件」持续推流。
    // 注意不能返回固定长度的快照：文件尾部的分片尚未写完，浏览器会一直等缺失字节，
    // 导致首帧解不出来、播放永远卡住。
    // 续传必须返回 206 + Content-Range，浏览器才知道新数据从哪个偏移开始，
    // 否则重叠部分会被重复拼接，导致解码错误而中断播放。
    if (!startSeconds && range) {
      const match = range.match(/bytes=(\d+)-/);
      const requested = match ? Number(match[1]) : 0;
      const entry = localCacheInfo(connectorId, sourceItemId, transcodeMode);
      if (entry.running) {
        const growing = streamLocalGrowingFile(
          connectorId,
          sourceItemId,
          transcodeMode,
          requested,
        );
        if (growing) return growing;
      }
    }

    // 3) 本机 ffmpeg 转封装 / 转码（ffmpeg 只负责写文件，客户端从文件读）
    if (!hasLocalFfmpeg()) {
      return NextResponse.json(
        {
          error:
            '未找到 ffmpeg，无法本地解码。请把 ffmpeg.exe 放到 resources\\runtime\\ffmpeg\\ 目录，或改用 NAS 转码模式。',
        },
        { status: 501 },
      );
    }

    // 转码需要把整部影片落到本地磁盘，先确认空间够用，避免转一半失败
    const freeSpace = localCacheFreeSpace();
    const expectedSize = (source.size || 0) * 1.1;
    if (freeSpace > 0 && expectedSize > 0 && freeSpace < expectedSize) {
      return NextResponse.json(
        {
          error: `磁盘空间不足：本地解码需要约 ${Math.ceil(
            expectedSize / 1024 / 1024 / 1024,
          )} GB 可用空间，当前仅剩 ${Math.floor(
            freeSpace / 1024 / 1024 / 1024,
          )} GB。请清理磁盘或改用 NAS 转码模式。`,
        },
        { status: 507 },
      );
    }

    startLocalTranscode(source, transcodeMode, {
      connectorId,
      sourceItemId,
      startSeconds,
      durationSeconds,
    });

    // 等待 moov 时长回填完成：否则播放器拿到的片长只有几十毫秒，
    // 进度条与拖动都会失真（最多等待 8 秒，不阻塞播放）
    await waitForMoovDurationPatch(
      connectorId,
      sourceItemId,
      transcodeMode,
      8000,
    );

    // 以「文件为缓冲」推流：ffmpeg 首批数据产出前会等待，
    // 避免浏览器收到 503 后直接放弃加载。
    const growing = streamLocalGrowingFile(
      connectorId,
      sourceItemId,
      transcodeMode,
      0,
    );
    if (growing) return growing;

    const headers = new Headers();
    headers.set('Content-Type', 'video/mp4');
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Retry-After', '2');
    return new Response(null, { status: 503, headers });
  } catch (error) {
    return NextResponse.json(
      {
        error: '本地解码失败',
        details: toPrivateLibraryErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
