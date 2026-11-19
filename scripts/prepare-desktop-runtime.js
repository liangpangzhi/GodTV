#!/usr/bin/env node

/* eslint-disable no-console */

/**
 * 准备桌面版打包所需的运行时二进制。
 *
 * 桌面版（Electron）打包需要两个二进制文件，它们体积较大（合计约 145MB），
 * 因此没有提交进仓库，由本脚本按需下载：
 *
 *   .electron-build/runtime/node.exe          —— 独立 Node.js 运行时（用于跑 Next.js standalone 服务端）
 *   .electron-build/runtime/ffmpeg/ffmpeg.exe —— 飞牛影视本地解码所用的转封装工具
 *
 * 用法：
 *   node scripts/prepare-desktop-runtime.js
 *
 * 可选环境变量：
 *   GODTV_NODE_VERSION  指定 Node.js 版本（默认 22.14.0）
 *   GODTV_FFMPEG_URL    自定义 ffmpeg 下载地址（默认使用 ffmpeg-static npm 包）
 *   GODTV_SKIP_NODE=1   跳过 Node.js 下载
 *   GODTV_SKIP_FFMPEG=1 跳过 ffmpeg 下载
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.electron-build', 'runtime');
const ffmpegDir = path.join(runtimeDir, 'ffmpeg');

const NODE_VERSION = process.env.GODTV_NODE_VERSION || '22.14.0';
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;

/** 下载文件到指定路径（跟随重定向） */
function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = (target, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('重定向次数过多'));
        return;
      }
      https
        .get(
          target,
          { headers: { 'User-Agent': 'GodTV-Prepare-Runtime' } },
          (response) => {
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
              response.resume();
              request(
                new URL(response.headers.location, target).toString(),
                redirects + 1,
              );
              return;
            }
            if (status !== 200) {
              response.resume();
              reject(new Error(`下载失败 ${status}: ${target}`));
              return;
            }
            const total = Number(response.headers['content-length'] || 0);
            let received = 0;
            let lastPrint = 0;
            const file = fs.createWriteStream(destination);
            response.on('data', (chunk) => {
              received += chunk.length;
              const now = Date.now();
              if (now - lastPrint > 2000) {
                lastPrint = now;
                const percent = total
                  ? ((received / total) * 100).toFixed(1)
                  : '?';
                console.log(
                  `  下载中 ${percent}% (${(received / 1024 / 1024).toFixed(1)} MB)`,
                );
              }
            });
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
            file.on('error', reject);
          },
        )
        .on('error', reject);
    };
    request(url);
  });
}

/** 从 zip 中提取单个文件（用系统 tar，Windows 10+ 自带） */
function extractFromZip(zipPath, entryName, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync(
    'tar',
    ['-xf', zipPath, '-C', path.dirname(destination), entryName],
    {
      stdio: 'inherit',
    },
  );
  const extracted = path.join(path.dirname(destination), entryName);
  if (!fs.existsSync(extracted)) {
    throw new Error(`解压失败，未找到 ${entryName}`);
  }
  fs.renameSync(extracted, destination);
}

async function prepareNode() {
  const destination = path.join(runtimeDir, 'node.exe');
  if (fs.existsSync(destination)) {
    console.log('✓ node.exe 已存在，跳过');
    return;
  }
  console.log('→ 准备 Node.js 运行时…');
  const zipPath = path.join(os.tmpdir(), `node-${NODE_VERSION}.zip`);
  await download(NODE_URL, zipPath);
  extractFromZip(
    zipPath,
    `node-v${NODE_VERSION}-win-x64/node.exe`,
    destination,
  );
  fs.rmSync(zipPath, { force: true });
  console.log('✓ node.exe 就绪');
}

async function prepareFfmpeg() {
  const destination = path.join(ffmpegDir, 'ffmpeg.exe');
  if (fs.existsSync(destination)) {
    console.log('✓ ffmpeg.exe 已存在，跳过');
    return;
  }
  console.log('→ 准备 ffmpeg（用于飞牛本地解码）…');
  fs.mkdirSync(ffmpegDir, { recursive: true });

  // 优先使用 ffmpeg-static（自动挑选镜像，含 Windows 版本）
  if (!process.env.GODTV_FFMPEG_URL) {
    try {
      require.resolve('ffmpeg-static');
      const staticPath = require('ffmpeg-static');
      fs.copyFileSync(staticPath, destination);
      console.log('✓ ffmpeg.exe 就绪（来自 ffmpeg-static）');
      return;
    } catch {
      console.log('  未安装 ffmpeg-static，改用直接下载');
    }
  }

  const url =
    process.env.GODTV_FFMPEG_URL ||
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
  const zipPath = path.join(os.tmpdir(), 'ffmpeg-win64.zip');
  await download(url, zipPath);
  extractFromZip(
    zipPath,
    'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe',
    destination,
  );
  fs.rmSync(zipPath, { force: true });
  console.log('✓ ffmpeg.exe 就绪');
}

async function main() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!process.env.GODTV_SKIP_NODE) {
    await prepareNode();
  }
  if (!process.env.GODTV_SKIP_FFMPEG) {
    await prepareFfmpeg();
  }
  console.log('\n运行时准备完成，可以执行：pnpm desktop:dist');
}

main().catch((error) => {
  console.error('\n✗ 准备失败：', error.message);
  console.error(
    '\n可手动下载后放置到对应位置：\n' +
      `  Node.js : ${path.join(runtimeDir, 'node.exe')}\n` +
      `  ffmpeg  : ${path.join(ffmpegDir, 'ffmpeg.exe')}`,
  );
  process.exit(1);
});
