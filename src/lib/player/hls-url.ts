const HLS_EXTENSION_PATTERN = /\.m3u8(?:$|[?#])/i;
const HLS_ENDPOINT_PATTERN = /\/m3u8(?:$|[/?#])/i;
const HLS_PROXY_PATH_PATTERN = /\/api\/proxy\/m3u8(?:-filter)?\/?$/i;
const PRIVATE_STREAM_PATH_PATTERN = /\/api\/private-library\/stream\/?$/i;
const MAX_PROXY_UNWRAP_DEPTH = 3;

export function isLikelyHlsUrl(url: string, depth = 0): boolean {
  if (!url) {
    return false;
  }

  if (HLS_EXTENSION_PATTERN.test(url) || HLS_ENDPOINT_PATTERN.test(url)) {
    return true;
  }

  if (depth >= MAX_PROXY_UNWRAP_DEPTH) {
    return false;
  }

  try {
    const parsed = new URL(url, 'http://localhost');

    // 私有影库流：飞牛影视返回 HLS 播放列表，由后端以 type=hls 显式标记
    if (PRIVATE_STREAM_PATH_PATTERN.test(parsed.pathname)) {
      return parsed.searchParams.get('type') === 'hls';
    }

    if (!HLS_PROXY_PATH_PATTERN.test(parsed.pathname)) {
      return false;
    }

    const upstreamUrl = parsed.searchParams.get('url');
    return upstreamUrl ? isLikelyHlsUrl(upstreamUrl, depth + 1) : false;
  } catch {
    return false;
  }
}
