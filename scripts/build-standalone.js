#!/usr/bin/env node

/* eslint-disable no-console */

/**
 * 以 standalone 模式构建 Next.js 服务端产物，供桌面版（Electron）打包使用。
 *
 * 为什么需要单独脚本：
 * - next.config.js 依据 DOCKER_BUILD 环境变量决定是否输出 standalone；
 * - 桌面版需要的是「服务端产物 + 静态资源」，而不是静态站点导出。
 *
 * 用法：node scripts/build-standalone.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function run(command, args, env) {
  console.log(`\n> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`\n✗ 构建失败（退出码 ${result.status}）`);
    process.exit(result.status || 1);
  }
}

run('npx', ['next', 'build'], { DOCKER_BUILD: '1' });

console.log('\n✓ standalone 产物构建完成：.next/standalone');
console.log(
  '  下一步：pnpm desktop:dist（或 cd .electron-build && npx electron-builder --win --x64）',
);
