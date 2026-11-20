/**
 * 飞牛影视「本地解码」服务
 *
 * 目标：绕开 NAS 端（尤其是硬件转码性能不足的真机）转码，
 * 由客户端直接拉取 NAS 上的原片，在本机完成解码播放。
 *
 * 播放路径分三级，自动降级：
 *  1) 直连原片：容器本身浏览器可解（mp4 / webm），直接 Range 代理，零转码、零延迟；
 *  2) 本地转封装：MKV / TS 等浏览器不解的容器，用本机 ffmpeg 以 -c:v copy 转封装为
 *     分片 MP4（不重新编码，几乎不占 CPU），再由本机解码；
 *  3) 本地转码：若原片编码浏览器也不支持（少见），由本机 ffmpeg 转 H.264。
 *
 * 转封装/转码的同时把结果写入本地缓存文件，完成后即可支持任意拖动（Range）。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PrivateLibraryConnector } from './admin.types';
import {
  type FnContainerType,
  fnGetOriginalMediaRequest,
  fnHeadersToFfmpegArg,
  fnProbeContainer,
} from './fnos-client';

export type LocalPlaybackMode = 'auto' | 'direct' | 'remux' | 'transcode';

/**
 * Content-Range 中表示「本段数据一直延续到文件末尾」的结束偏移。
 * 转封装期间文件仍在增长，无法给出真实末字节，用 JS 可精确表示的最大整数占位。
 */
const UNBOUNDED_LAST_BYTE = Number.MAX_SAFE_INTEGER;

export interface LocalMediaSource {
  url: string;
  headers: Record<string, string>;
  mediaGuid: string;
  container: FnContainerType;
  size?: number;
}

/** 找到随程序内置的 ffmpeg（打包后位于 resources/runtime/ffmpeg/ffmpeg.exe） */
export function resolveFfmpegPath(): string | null {
  const candidates: string[] = [];

  // Android TV 版：ffmpeg 作为 native library 安装，路径由外壳通过环境变量传入
  const androidFfmpeg = process.env.GODTV_ANDROID_FFMPEG;
  if (androidFfmpeg) {
    candidates.push(androidFfmpeg);
  }

  const execName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // 打包后：<resources>/server/server.js → <resources>/runtime/ffmpeg/ffmpeg.exe
  candidates.push(
    path.join(__dirname, '..', 'runtime', 'ffmpeg', execName),
    path.join(process.cwd(), 'runtime', 'ffmpeg', execName),
    path.join(process.cwd(), '.electron-build', 'runtime', 'ffmpeg', execName),
  );

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, execName))
    .find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });

  return fromPath || null;
}

export function hasLocalFfmpeg(): boolean {
  return Boolean(resolveFfmpegPath());
}

/** 本地缓存目录（转封装/转码结果） */
function resolveCacheDir(): string {
  const base = process.env.LOCALAPPDATA || process.env.HOME || os.tmpdir();
  const dir = path.join(base, 'GodTV', 'media-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

interface CacheEntry {
  /** 完整文件（分片 MP4，转码完成后才存在） */
  file: string;
  /** 进行中的文件 */
  partFile: string;
  /** 完成标记：存在才代表 file 内容完整 */
  doneMarker: string;
  /** faststart 普通 MP4（由分片文件转换而来，可秒开与任意拖动） */
  fastFile: string;
  /** faststart 版本的完成标记 */
  fastMarker: string;
  ready: boolean;
  running: boolean;
  bytes: number;
  /** 原片总时长（秒），来自 ffmpeg 读取输入时的输出 */
  durationSeconds?: number;
  /** moov 时长是否已回填 */
  moovPatched: boolean;
  /** 当前正在读取该缓存的流数量，用于安全地替换文件 */
  activeStreams: number;
}

const localCache = new Map<string, CacheEntry>();

function cacheKey(
  connectorId: string,
  sourceItemId: string,
  mode: string,
): string {
  return `${connectorId}::${sourceItemId}::${mode}`;
}

/** 获取（并按需初始化）缓存条目信息 */
export function localCacheInfo(
  connectorId: string,
  sourceItemId: string,
  mode: string,
): CacheEntry {
  const key = cacheKey(connectorId, sourceItemId, mode);
  let entry = localCache.get(key);
  if (!entry) {
    const file = localCacheFilePath(connectorId, sourceItemId, mode);
    const fastFile = file.replace(/\.mp4$/i, '.fast.mp4');
    entry = {
      file,
      partFile: `${file}.part`,
      doneMarker: `${file}.done`,
      fastFile,
      fastMarker: `${fastFile}.done`,
      ready: false,
      running: false,
      bytes: 0,
      moovPatched: false,
      activeStreams: 0,
    };
    // 进程重启后磁盘上可能已有完整缓存（以 .done 标记为准，避免用到中断的残缺文件）
    try {
      if (
        fs.existsSync(fastFile) &&
        fs.existsSync(entry.fastMarker) &&
        fs.statSync(fastFile).size > 0
      ) {
        entry.ready = true;
        entry.bytes = fs.statSync(fastFile).size;
      } else if (
        fs.existsSync(file) &&
        fs.existsSync(entry.doneMarker) &&
        fs.statSync(file).size > 0
      ) {
        entry.ready = true;
        entry.bytes = fs.statSync(file).size;
      }
    } catch {
      // ignore
    }
    localCache.set(key, entry);
  }
  return entry;
}

/**
 * 取得当前应当对外提供的缓存文件。
 * 优先使用 faststart 普通 MP4（可秒开、可任意拖动）。
 */
export function localCacheServeFile(
  connectorId: string,
  sourceItemId: string,
  mode: string,
): { file: string; ready: boolean } | null {
  const entry = localCacheInfo(connectorId, sourceItemId, mode);
  try {
    if (
      fs.existsSync(entry.fastFile) &&
      fs.existsSync(entry.fastMarker) &&
      fs.statSync(entry.fastFile).size > 0
    ) {
      return { file: entry.fastFile, ready: true };
    }
  } catch {
    // ignore
  }
  if (!entry.ready) return null;
  return { file: entry.file, ready: true };
}

/** 该条目是否正在转码中 */
export function isLocalTranscodeRunning(
  connectorId: string,
  sourceItemId: string,
  mode: string,
): boolean {
  return localCacheInfo(connectorId, sourceItemId, mode).running;
}

/** 读取原片信息（含容器类型） */
export async function resolveLocalMediaSource(
  connector: PrivateLibraryConnector,
  sourceItemId: string,
): Promise<LocalMediaSource> {
  const request = await fnGetOriginalMediaRequest(connector, sourceItemId);
  let container: FnContainerType = 'unknown';
  let size: number | undefined;
  try {
    const probe = await fnProbeContainer(connector, request.mediaGuid);
    container = probe.container;
    size = probe.size;
  } catch {
    // 探测失败不影响后续流程，按未知容器走本地转封装
  }
  return {
    url: request.url,
    headers: request.headers,
    mediaGuid: request.mediaGuid,
    container,
    size,
  };
}

function buildFfmpegArgs(
  source: LocalMediaSource,
  mode: 'remux' | 'transcode',
  startSeconds?: number,
): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-headers',
    fnHeadersToFfmpegArg(source.headers),
  ];

  if (startSeconds && startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }

  args.push('-i', source.url);

  if (mode === 'remux') {
    // 不重新编码视频，仅转封装；音频统一转 AAC 立体声——
    // 原片常为 AC3/DTS 5.1，浏览器无法解码；且 Chromium 的 AAC 解码器
    // 对多声道 AAC 会出现 "Failed to send audio packet for decoding" 导致播放中断。
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
    );
  }

  args.push(
    '-f',
    'mp4',
    '-movflags',
    // 注意：不能用 empty_moov——那会写出不含轨道信息的空 moov，
    // 浏览器解析后直接报 "Format error"。这里保留完整 moov + 分片，
    // 保证 Chromium 能识别编码并边下边播。
    'frag_keyframe+default_base_moof',
    'pipe:1',
  );

  return args;
}

export interface LocalTranscodeResult {
  process: ReturnType<typeof spawn>;
  cacheFile: string;
}

/** 缓存文件路径（不依赖是否已缓存） */
export function localCacheFilePath(
  connectorId: string,
  sourceItemId: string,
  mode: string,
): string {
  const cacheDir = resolveCacheDir();
  return path.join(cacheDir, `${connectorId}_${sourceItemId}_${mode}.mp4`);
}

/**
 * 探测原片总时长（秒）。
 * ffmpeg 以 `-loglevel error` 运行时不会打印 Duration 行，
 * 因此单独跑一次「只读输入、不输出」的探测命令。
 */
export async function probeSourceDuration(
  source: LocalMediaSource,
): Promise<number> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return 0;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-headers',
        fnHeadersToFfmpegArg(source.headers),
        '-i',
        source.url,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(
        match
          ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
          : 0,
      );
    });
    child.on('error', () => finish(0));
    setTimeout(() => finish(0), 20000);
  });
}

/**
 * 等 moov 写盘后回填时长。
 * ffmpeg 先写 moov 再写分片数据，因此稍等片刻即可定位并覆写。
 */
async function scheduleMoovDurationPatch(
  entry: CacheEntry,
  partFile: string,
  durationSeconds: number,
): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(partFile).size > 4096) {
        if (patchMoovDuration(partFile, durationSeconds)) {
          entry.moovPatched = true;
          return;
        }
      }
    } catch {
      // 文件尚未创建，继续等待
    }
    if (!entry.running) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 转码完成后把分片 MP4 转成 faststart 普通 MP4。
 *
 * 分片 MP4 的索引分布在整个文件里，Chromium 解析前必须把整个文件读一遍
 * （GB 级影片会等上近一分钟才起播）。普通 MP4 的 moov 在文件头且带完整
 * 采样表，浏览器读头部即可起播，并支持任意拖动。
 */
function scheduleFastStartConversion(entry: CacheEntry): void {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return;
  const source = entry.file;
  const target = entry.fastFile;

  let needBytes = 0;
  try {
    needBytes = fs.statSync(source).size;
  } catch {
    return;
  }
  // 磁盘空间不足时跳过转换，避免把用户磁盘撑满
  try {
    const stat = fs.statfsSync(path.dirname(source));
    const free = stat.bavail * stat.bsize;
    if (free < needBytes * 1.15) return;
  } catch {
    // 取不到磁盘信息时按正常流程继续
  }

  try {
    fs.rmSync(target, { force: true });
    fs.rmSync(entry.fastMarker, { force: true });
  } catch {
    // ignore
  }

  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      source,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      target,
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8').trim();
    if (text) {
      // eslint-disable-next-line no-console
      console.error('[fnOS 本地解码] faststart:', text);
    }
  });

  child.on('close', (code) => {
    if (code !== 0) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // ignore
      }
      return;
    }
    try {
      fs.writeFileSync(entry.fastMarker, String(code));
      entry.bytes = fs.statSync(target).size;
    } catch {
      // ignore
    }
    // 分片文件已无用途，等没有流在读取时再删除，避免影响正在播放的任务
    scheduleFragmentCleanup(entry);
  });

  child.on('error', () => {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // ignore
    }
  });
}

/** 没有流读取缓存时，删除已转换完成的分片文件以释放空间 */
function scheduleFragmentCleanup(entry: CacheEntry): void {
  const timer = setInterval(() => {
    if (entry.activeStreams > 0) return;
    clearInterval(timer);
    try {
      fs.rmSync(entry.file, { force: true });
      fs.rmSync(entry.doneMarker, { force: true });
    } catch {
      // ignore
    }
  }, 5000);
  // 最多等待 10 分钟
  setTimeout(() => clearInterval(timer), 10 * 60 * 1000).unref?.();
}

/**
 * 启动本地 ffmpeg 转封装/转码，输出以分片 MP4 的形式流式返回。
 * 同时把输出落盘到缓存文件，完成后即可支持拖动定位。
 */
export function startLocalTranscode(
  source: LocalMediaSource,
  mode: 'remux' | 'transcode',
  options: {
    connectorId: string;
    sourceItemId: string;
    startSeconds?: number;
    /** 已知的原片时长（秒），用于回填 moov，省去一次探测 */
    durationSeconds?: number;
  } = {
    connectorId: '',
    sourceItemId: '',
  },
): LocalTranscodeResult | null {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return null;

  const entry = localCacheInfo(options.connectorId, options.sourceItemId, mode);
  if (entry.running) {
    // 已有转码在进行中，避免重复启动
    return null;
  }
  entry.running = true;

  const args = buildFfmpegArgs(source, mode, options.startSeconds);
  const child = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 先写 .part，完成后再重命名为正式文件并写完成标记：
  // 正式文件 + .done 同时存在才代表内容完整
  const partFile = entry.partFile;
  try {
    fs.rmSync(partFile, { force: true });
    fs.rmSync(entry.file, { force: true });
    fs.rmSync(entry.doneMarker, { force: true });
  } catch {
    // ignore
  }
  const writeStream = fs.createWriteStream(partFile);
  child.stdout.pipe(writeStream);

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8').trim();
    if (text) {
      // eslint-disable-next-line no-console
      console.error('[fnOS 本地解码] ffmpeg:', text);
    }
  });

  // 回填 moov 时长：优先使用调用方给的时长，否则探测一次原片
  if (options.durationSeconds && options.durationSeconds > 0) {
    entry.durationSeconds = options.durationSeconds;
    void scheduleMoovDurationPatch(entry, partFile, options.durationSeconds);
  } else {
    void probeSourceDuration(source).then((seconds) => {
      if (!seconds || entry.durationSeconds) return;
      entry.durationSeconds = seconds;
      void scheduleMoovDurationPatch(entry, partFile, seconds);
    });
  }

  child.on('close', (code) => {
    entry.running = false;
    writeStream.end(() => {
      try {
        fs.renameSync(partFile, entry.file);
        fs.writeFileSync(entry.doneMarker, String(code ?? 0));
        entry.ready = true;
        entry.bytes = fs.statSync(entry.file).size;
        // 后台转成 faststart 普通 MP4，让下次播放可以秒开
        scheduleFastStartConversion(entry);
      } catch {
        // ignore
      }
    });
  });

  child.on('error', (error) => {
    entry.running = false;
    // eslint-disable-next-line no-console
    console.error('[fnOS 本地解码] ffmpeg 启动失败:', error.message);
  });

  return { process: child, cacheFile: entry.file };
}

/** 缓存是否已完成（完成后可直接按字节 Range 提供，任意拖动） */
export function isLocalCacheReady(
  connectorId: string,
  sourceItemId: string,
  mode: string,
): { file: string; ready: boolean } | null {
  return localCacheServeFile(connectorId, sourceItemId, mode);
}

/**
 * 转码进行中时，可服务「已写入部分」的文件内容（尽力而为）
 */
export function serveLocalPartial(
  connectorId: string,
  sourceItemId: string,
  mode: string,
  rangeHeader: string | null,
): Response | null {
  const entry = localCacheInfo(connectorId, sourceItemId, mode);
  if (!entry.running) return null;
  return serveLocalFile(entry.partFile, rangeHeader, {
    alignToFragment: true,
  });
}

/** 缓存占用上限（超出后按修改时间清理旧文件） */
const LOCAL_CACHE_MAX_BYTES = 24 * 1024 * 1024 * 1024;

/** 陈旧临时文件的最大保留时间（超过则视为上次异常中断的残留） */
const STALE_PART_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** 取当前缓存目录所在磁盘的可用空间（字节），取不到时返回 0 */
export function localCacheFreeSpace(): number {
  try {
    const stat = fs.statfsSync(resolveCacheDir());
    return stat.bavail * stat.bsize;
  } catch {
    return 0;
  }
}

/**
 * 清理本地缓存：删除残留的 .part 与超限的旧文件。
 * 正在转码中的条目（存在最新鲜的 .part）不会被误删。
 */
export function cleanupLocalCache(): void {
  const dir = resolveCacheDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // 残留的临时文件直接清理（正在写入的新鲜 .part 保留）
  const now = Date.now();
  for (const item of entries) {
    if (!item.isFile() || !item.name.endsWith('.part')) continue;
    const full = path.join(dir, item.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < STALE_PART_MAX_AGE_MS) continue;
      fs.rmSync(full, { force: true });
      // eslint-disable-next-line no-console
      console.log('[fnOS 本地解码] 清理残留临时文件:', item.name);
    } catch {
      // ignore
    }
  }

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const files = entries
    .filter((item) => item.isFile() && item.name.endsWith('.mp4'))
    .map((item) => {
      const full = path.join(dir, item.name);
      let size = 0;
      let mtime = 0;
      try {
        const stat = fs.statSync(full);
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        // ignore
      }
      return { full, size, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);

  let total = files.reduce((sum, item) => sum + item.size, 0);
  for (const item of files) {
    if (total <= LOCAL_CACHE_MAX_BYTES) break;
    try {
      fs.rmSync(item.full, { force: true });
      fs.rmSync(`${item.full}.done`, { force: true });
      total -= item.size;
      // eslint-disable-next-line no-console
      console.log('[fnOS 本地解码] 清理旧缓存:', path.basename(item.full));
    } catch {
      // ignore
    }
  }
}

/** 读取文件指定区间（同步） */
function readFileRange(file: string, start: number, length: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 把 moov 中 mvhd / tkhd / mdhd 的时长字段定位出来。
 * 仅做定长覆写，不会改变文件任何 box 的偏移量。
 */
interface DurationField {
  /** 文件内绝对偏移 */
  offset: number;
  /** 字段字节数（4 或 8） */
  width: 4 | 8;
  /** 该字段使用的 timescale；tkhd 使用影片级 timescale */
  kind: 'movie' | 'track';
  trackTimescale: number;
}

function collectDurationFields(
  buf: Buffer,
  base: number,
  fields: DurationField[],
  movieTimescale: number,
): void {
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('latin1');
    if (size < 8 || p + size > buf.length) break;
    const body = p + 8;
    const end = p + size;

    if (type === 'mvhd') {
      const version = buf[body];
      const timescale =
        version === 1
          ? buf.readUInt32BE(body + 16)
          : buf.readUInt32BE(body + 12);
      const offset = version === 1 ? body + 24 : body + 16;
      fields.push({
        offset: base + offset,
        width: version === 1 ? 8 : 4,
        kind: 'movie',
        trackTimescale: timescale,
      });
      movieTimescale = timescale;
    } else if (type === 'tkhd') {
      const version = buf[body];
      const offset = version === 1 ? body + 28 : body + 20;
      fields.push({
        offset: base + offset,
        width: version === 1 ? 8 : 4,
        kind: 'movie',
        trackTimescale: movieTimescale,
      });
    } else if (type === 'mdhd') {
      const version = buf[body];
      const timescale =
        version === 1
          ? buf.readUInt32BE(body + 16)
          : buf.readUInt32BE(body + 12);
      const offset = version === 1 ? body + 24 : body + 16;
      fields.push({
        offset: base + offset,
        width: version === 1 ? 8 : 4,
        kind: 'track',
        trackTimescale: timescale,
      });
    }

    if (type === 'moov' || type === 'trak' || type === 'mdia') {
      collectDurationFields(
        buf.slice(body, end),
        base + body,
        fields,
        movieTimescale,
      );
    }
    p = end;
  }
}

/**
 * 回填 moov 中的总时长。
 *
 * ffmpeg 以管道方式输出分片 MP4 时无法回写 moov，导致 mvhd/mdhd 只记录了
 * 首批数据的时长（几十毫秒）。播放器据此认为影片只有几十毫秒，进度条与
 * 拖动都会失真。这里在转码开始后把真实时长写回 moov（定长覆写，偏移不变）。
 *
 * @returns 是否已成功回填（文件尚未写出 moov 时返回 false）
 */
export function patchMoovDuration(
  file: string,
  durationSeconds: number,
): boolean {
  if (!durationSeconds || durationSeconds <= 0) return false;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(1024 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read < 16) return false;

    const fields: DurationField[] = [];
    collectDurationFields(head.subarray(0, read), 0, fields, 0);
    if (!fields.length) return false;

    const maxValue = fields.some((f) => f.width === 8)
      ? Number.MAX_SAFE_INTEGER
      : 0xffffffff;

    for (const field of fields) {
      const ticks = Math.round(durationSeconds * field.trackTimescale);
      const value = Math.max(0, Math.min(ticks, maxValue));
      const buf = field.width === 8 ? Buffer.alloc(8) : Buffer.alloc(4);
      if (field.width === 8) buf.writeBigUInt64BE(BigInt(value));
      else buf.writeUInt32BE(value);
      fs.writeSync(fd, buf, 0, buf.length, field.offset);
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 等待 moov 时长回填完成（转码刚启动时 moov 尚未写完，需要稍等）。
 * 超时则放弃，不阻塞播放。
 */
export async function waitForMoovDurationPatch(
  connectorId: string,
  sourceItemId: string,
  mode: string,
  timeoutMs = 8000,
): Promise<void> {
  const entry = localCacheInfo(connectorId, sourceItemId, mode);
  if (entry.moovPatched) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.moovPatched) return;
    if (!entry.running) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 以「文件为缓冲」的方式提供正在转码的内容。
 *
 * 关键点 1：ffmpeg 的 stdout 不能直接给播放器——应用的播放探测会先发一个
 * 小 Range 请求把管道读空，导致真正的播放请求拿不到数据。
 * 因此这里让 ffmpeg 只负责写文件，客户端（探测 / 播放器）都从文件读。
 *
 * 关键点 2：Chromium 播放「不可 seek 的渐进式 MP4」时，解封装器会按需向数据源
 * 申请指定偏移的数据，并据此发起 `Range: bytes=N-` 续传请求。若响应是 200
 * （没有 Content-Range），浏览器不知道新数据从哪个偏移开始，重叠部分会被
 * 丢弃或重复拼接，导致音视频数据错乱、出现
 * "Failed to send audio packet for decoding" 而在首个分片边界中断播放。
 * 因此凡是带 Range 的请求都必须返回 206 + Content-Range。
 *
 * 关键点 3：总长度必须写成 `*`（未知）。转封装期间文件仍在增长，一旦报出
 * 具体的总长度，Chromium 会认为资源大小已确定，转而先把整个资源读完再解析
 * 分片索引（GB 级文件会长时间黑屏）。
 *
 * @param startOffset 本次响应数据的起始字节偏移
 */
export function streamLocalGrowingFile(
  connectorId: string,
  sourceItemId: string,
  mode: string,
  startOffset = 0,
): Response | null {
  const entry = localCacheInfo(connectorId, sourceItemId, mode);

  const offset = Math.max(0, startOffset);

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Accept-Ranges', 'bytes');
  // 起始偏移必须明确告知浏览器；总长度未知，用 `*` 表示仍在增长
  headers.set('Content-Range', `bytes ${offset}-${UNBOUNDED_LAST_BYTE}/*`);

  let cursor = offset;
  entry.activeStreams += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.activeStreams = Math.max(0, entry.activeStreams - 1);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 循环读取，直到转码结束
      for (;;) {
        // ffmpeg 刚启动时文件可能还不存在，先等待
        const file = entry.ready ? entry.file : entry.partFile;
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }

        if (cursor < size) {
          // 单次最多取 1MB，避免一次性分配几百 MB 缓冲导致响应卡死
          const length = Math.min(size - cursor, 1024 * 1024);
          const chunk = readFileRange(file, cursor, length);
          if (chunk.length > 0) {
            cursor += chunk.length;
            controller.enqueue(new Uint8Array(chunk));
            return;
          }
        }

        if (!entry.running) {
          // 转码已结束：把剩余数据读完再关闭
          release();
          controller.close();
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    cancel() {
      release();
    },
  });

  return new Response(stream, { status: 206, headers });
}

/**
 * 把拖动位置对齐到最近的 moof（分片）边界。
 * fMP4 必须从 moof 开始才能被浏览器解析，否则会解析失败。
 */
export function alignToFragmentBoundary(file: string, offset: number): number {
  if (offset <= 0) return 0;
  const window = 4 * 1024 * 1024;
  const start = Math.max(0, offset - window);
  let length = 0;
  let fileSize = 0;
  try {
    fileSize = fs.statSync(file).size;
    length = Math.min(fileSize - start, window);
  } catch {
    return offset;
  }
  if (length <= 0) return offset;

  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let idx = buffer.lastIndexOf(Buffer.from('moof'));
      while (idx >= 0) {
        const abs = start + idx;
        // 校验命中的是真实的 box 起点：moof 前 4 字节应是该 box 的长度
        if (idx >= 4) {
          const boxSize = buffer.readUInt32BE(idx - 4);
          if (boxSize >= 8 && abs + boxSize <= fileSize) {
            return abs;
          }
        }
        idx = buffer.lastIndexOf(Buffer.from('moof'), idx - 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return offset;
}

/**
 * 判断缓存文件是否为分片 MP4（含 mvex 扩展盒）。
 * faststart 普通 MP4 没有 moof，按分片对齐会定位到错误位置。
 */
export function isFragmentedMp4File(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(512 * 1024);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      if (read < 16) return false;
      let p = 0;
      while (p + 8 <= read) {
        const size = head.readUInt32BE(p);
        const type = head.slice(p + 4, p + 8).toString('latin1');
        if (size < 8) break;
        if (type === 'moov') {
          const end = Math.min(p + size, read);
          return head.subarray(p, end).includes(Buffer.from('mvex'));
        }
        if (type === 'mdat') break;
        p += size;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 直接从缓存文件按 Range 返回内容（转码完成后使用，支持拖动）。
 */
export function serveLocalFile(
  file: string,
  rangeHeader: string | null,
  options: { alignToFragment?: boolean } = {},
): Response | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');

  if (!rangeHeader) {
    headers.set('Content-Length', String(stat.size));
    const stream = fs.createReadStream(file);
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers,
    });
  }

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    headers.set('Content-Length', String(stat.size));
    const stream = fs.createReadStream(file);
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers,
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  const end = match[2]
    ? Math.min(Number(match[2]), stat.size - 1)
    : stat.size - 1;
  if (start > end || start >= stat.size) {
    headers.set('Content-Range', `bytes */${stat.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (options.alignToFragment && start > 0 && isFragmentedMp4File(file)) {
    start = alignToFragmentBoundary(file, start);
  }

  headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  headers.set('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(file, { start, end });
  return new Response(stream as unknown as ReadableStream, {
    status: 206,
    headers,
  });
}
