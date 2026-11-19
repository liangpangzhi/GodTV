import { NextRequest, NextResponse } from 'next/server';

import { verifyApiAuth } from '@/lib/auth';
import {
  resolveSegmentRequest,
  resolveStreamRequest,
  toPrivateLibraryErrorMessage,
} from '@/lib/private-library';

export const runtime = 'nodejs';

function mapStreamError(status: number): string {
  if (status === 401 || status === 403) {
    return '私人影库鉴权失败，请检查连接配置';
  }

  if (status === 404) {
    return '未找到对应的私有媒体文件';
  }

  if (status >= 500) {
    return '上游媒体服务暂时不可用';
  }

  return '私有媒体流请求失败';
}

/**
 * 重写 HLS 播放列表中的 URI。
 * 飞牛返回的 preset.m3u8 使用相对分片名（00000.ts）且分片需要 token 鉴权，
 * 因此改写为本服务的分片代理地址，由服务端补齐鉴权后再取回。
 */
function rewriteHlsPlaylist(
  playlist: string,
  baseUrl: string,
  buildSegmentUrl: (absoluteUrl: string) => string,
): string {
  const resolve = (uri: string): string => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
  };

  return playlist
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // #EXT-X-KEY / #EXT-X-MAP 等标签内的 URI="..." 同样需要代理
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          if (/^https?:\/\//i.test(uri)) return `URI="${uri}"`;
          return `URI="${buildSegmentUrl(resolve(uri))}"`;
        });
      }
      if (/^https?:\/\//i.test(trimmed)) {
        return buildSegmentUrl(trimmed);
      }
      return buildSegmentUrl(resolve(trimmed));
    })
    .join('\n');
}

export async function GET(request: NextRequest) {
  const authResult = verifyApiAuth(request);
  if (!authResult.isValid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const connectorId = (searchParams.get('connectorId') || '').trim();
    const sourceItemId = (searchParams.get('sourceItemId') || '').trim();
    const segmentUrl = (searchParams.get('seg') || '').trim();
    const rawAudioStreamIndex = (
      searchParams.get('audioStreamIndex') || ''
    ).trim();
    const audioStreamIndex =
      rawAudioStreamIndex && /^\d+$/.test(rawAudioStreamIndex)
        ? Number(rawAudioStreamIndex)
        : undefined;

    if (!connectorId) {
      return NextResponse.json(
        { error: 'connectorId 不能为空' },
        { status: 400 },
      );
    }

    // HLS 分片代理：seg 参数指向上游分片的绝对地址
    if (segmentUrl) {
      const segment = await resolveSegmentRequest(connectorId, segmentUrl);
      if (!segment) {
        return NextResponse.json({ error: '非法的分片地址' }, { status: 400 });
      }
      const range = request.headers.get('range') || '';
      const segmentResponse = await fetch(segment.url, {
        headers: {
          ...(segment.headers || {}),
          ...(range ? { Range: range } : {}),
        },
      });
      if (!segmentResponse.ok) {
        return NextResponse.json(
          { error: mapStreamError(segmentResponse.status) },
          { status: segmentResponse.status },
        );
      }
      const segmentHeaders = new Headers();
      [
        'content-type',
        'content-length',
        'accept-ranges',
        'content-range',
      ].forEach((name) => {
        const value = segmentResponse.headers.get(name);
        if (value) segmentHeaders.set(name, value);
      });
      segmentHeaders.set('Cache-Control', 'private, max-age=3600');
      return new Response(segmentResponse.body, {
        status: segmentResponse.status,
        headers: segmentHeaders,
      });
    }

    if (!sourceItemId) {
      return NextResponse.json(
        { error: 'sourceItemId 不能为空' },
        { status: 400 },
      );
    }

    let stream = await resolveStreamRequest(
      connectorId,
      sourceItemId,
      audioStreamIndex,
    );
    if (!stream) {
      return NextResponse.json(
        { error: '未找到可用的私有媒体流' },
        { status: 404 },
      );
    }

    const range = request.headers.get('range') || '';
    const fetchStream = (target: NonNullable<typeof stream>) =>
      fetch(target.url, {
        headers: {
          ...(target.headers || {}),
          ...(range ? { Range: range } : {}),
        },
      });
    let response = await fetchStream(stream);

    if (
      (response.status === 401 || response.status === 403) &&
      stream.canRefreshAuth
    ) {
      await response.body?.cancel().catch(() => undefined);
      const refreshedStream = await resolveStreamRequest(
        connectorId,
        sourceItemId,
        audioStreamIndex,
        { forceRefreshAuth: true },
      );
      if (refreshedStream) {
        stream = refreshedStream;
        response = await fetchStream(stream);
      }
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: mapStreamError(response.status) },
        { status: response.status },
      );
    }

    // 飞牛 HLS：播放列表内为相对分片名且分片需要 token，重写为本服务的分片代理地址
    const contentType = response.headers.get('content-type') || '';
    if (stream.rewriteHlsUris && /mpegurl|m3u8/i.test(contentType)) {
      const playlist = await response.text();
      const rewritten = rewriteHlsPlaylist(
        playlist,
        stream.url,
        (absoluteUrl) =>
          `/api/private-library/stream?connectorId=${encodeURIComponent(connectorId)}&seg=${encodeURIComponent(absoluteUrl)}`,
      );
      const playlistHeaders = new Headers();
      playlistHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
      playlistHeaders.set('Cache-Control', 'private, no-store');
      return new Response(rewritten, { status: 200, headers: playlistHeaders });
    }

    const headers = new Headers();
    const passthrough = [
      'content-type',
      'content-length',
      'accept-ranges',
      'content-range',
      'cache-control',
      'etag',
      'last-modified',
    ];

    passthrough.forEach((name) => {
      const value = response.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    });
    headers.set(
      'Cache-Control',
      headers.get('Cache-Control') || 'private, no-store',
    );

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '代理私有媒体流失败',
        details: toPrivateLibraryErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
