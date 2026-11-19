/* eslint-disable */
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.DECOTV_PORT) || 3000;
const PORT_SCAN_LIMIT = 60;

let PORT = DEFAULT_PORT;
let BASE_URL = `http://${HOST}:${PORT}`;

let serverProcess = null;
let mainWindow = null;

/**
 * 判断端口是否已被占用。
 * 采用「连接探测」而非「绑定探测」：Windows 下 0.0.0.0 已被监听时，
 * 另一个进程仍可能成功绑定 127.0.0.1，导致误判为空闲。
 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port });
    let done = false;
    const finish = (busy) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(700);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(true)); // 无响应同样视为不可用
    sock.once('error', (err) => finish(err.code !== 'ECONNREFUSED'));
  });
}

/**
 * 从起始端口向后探测可用端口。
 * 避开用户机器上已被占用的 3000（如其它开发服务、虚拟机转发端口）。
 */
async function findFreePort(start, limit = PORT_SCAN_LIMIT) {
  for (let port = start; port < start + limit; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const busy = await isPortBusy(port);
    if (!busy) return port;
  }
  throw new Error(`端口 ${start}-${start + limit - 1} 均被占用`);
}

/**
 * 读取或生成持久化的鉴权密钥。
 * 服务端在 production 下缺少 AUTH_SECRET 时：
 *  - 每次启动都会打印缺失告警；
 *  - m3u8 分片/过滤代理的签名校验会因无密钥而全部失败（403），直播与采集站播放会中断。
 * 因此桌面端在用户数据目录保存一份随机密钥，重启后保持不变。
 */
function resolveAuthSecret() {
  try {
    const dir = app.getPath('userData');
    const file = path.join(dir, 'auth-secret');
    if (fs.existsSync(file)) {
      const cached = fs.readFileSync(file, 'utf8').trim();
      if (cached) return cached;
    }
    const secret = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, secret, { encoding: 'utf8' });
    return secret;
  } catch (error) {
    return crypto.randomBytes(32).toString('base64');
  }
}

/**
 * 解析服务端运行目录。
 * 打包后 standalone 位于 resources/server，node.exe 位于 resources/runtime。
 */
function resolvePaths() {
  const isPackaged = app.isPackaged;
  const resourcesDir = isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '.electron-build');
  const serverDir = path.join(resourcesDir, 'server');
  const nodeExe = path.join(resourcesDir, 'runtime', 'node.exe');
  return { serverDir, nodeExe, isPackaged };
}

function startServer() {
  const { serverDir, nodeExe } = resolvePaths();
  const serverScript = path.join(serverDir, 'server.js');

  if (!fs.existsSync(serverScript)) {
    throw new Error(`找不到服务端入口: ${serverScript}`);
  }

  const nodeBin = fs.existsSync(nodeExe) ? nodeExe : process.execPath;

  // 关键：使用干净的环境变量启动服务。
  // 继承宿主机全部环境变量（如 ELECTRON_RUN_AS_NODE、各类代理变量）会干扰初始化。
  const cleanEnv = {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || 'C:\\Windows',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
    USERPROFILE: process.env.USERPROFILE || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    NODE_ENV: 'production',
    HOSTNAME: HOST,
    PORT: String(PORT),
    // 持久化密钥：避免 m3u8 代理签名失效（403）与缺失告警
    AUTH_SECRET: resolveAuthSecret(),
    NEXTAUTH_SECRET: resolveAuthSecret(),
    // 免登录家庭模式 + 本地存储；预置源已编译进 standalone
    NEXT_PUBLIC_AUTH_MODE: 'public',
    NEXT_PUBLIC_STORAGE_TYPE: 'localstorage',
  };

  console.log('[God TV] 启动服务:', nodeBin, serverScript);
  serverProcess = spawn(nodeBin, [serverScript], {
    cwd: serverDir,
    env: cleanEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(`[God TV Server] ${data}`);
  });
  serverProcess.stderr.on('data', (data) => {
    process.stderr.write(`[God TV Server ERR] ${data}`);
  });
  serverProcess.on('exit', (code) => {
    console.log('[God TV] 服务进程退出, code =', code);
  });
}

function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (msg) => {
      if (!settled) {
        settled = true;
        reject(new Error(msg));
      }
    };
    const probe = () => {
      if (settled) return;
      if (serverProcess && serverProcess.exitCode !== null) {
        fail(
          `服务进程已退出 (code=${serverProcess.exitCode})，请检查端口或运行环境`,
        );
        return;
      }
      const req = http.get(`${BASE_URL}/version.json`, (res) => {
        res.resume();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      req.on('error', retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() - start > timeoutMs) {
        fail('服务启动超时');
        return;
      }
      setTimeout(probe, 500);
    };
    probe();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'God TV',
    backgroundColor: '#0b0b0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const iconPath = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(iconPath)) {
    try {
      mainWindow.setIcon(iconPath);
    } catch (e) {}
  }

  mainWindow.loadURL(BASE_URL);

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(BASE_URL)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  try {
    PORT = await findFreePort(DEFAULT_PORT);
    BASE_URL = `http://${HOST}:${PORT}`;
    console.log('[God TV] 使用端口', PORT);
    startServer();
    await waitForServer();
    createWindow();
  } catch (error) {
    console.error(error);
    dialog.showErrorBox(
      'God TV 启动失败',
      String((error && error.message) || error),
    );
    app.quit();
  }
}

// 单实例：重复启动时聚焦已有窗口，避免占用多个端口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(bootstrap);

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill('SIGTERM');
    } catch (e) {
      try {
        serverProcess.kill();
      } catch (_) {}
    }
  }
}

app.on('before-quit', stopServer);
app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
