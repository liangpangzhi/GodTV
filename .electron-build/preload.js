/* eslint-disable */
const { contextBridge } = require('electron');

// 暴露最小化信息给渲染进程（不开放 node 能力，保证安全）
contextBridge.exposeInMainWorld('GodTVDesktop', {
  isElectron: true,
  platform: process.platform,
});
