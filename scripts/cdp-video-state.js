// 通过 CDP 读取应用播放页 video 元素的实时状态
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_TO_OPEN = process.argv[2];
const PORT = 9333;

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=C:\\Users\\54743\\WorkBuddy\\2026-11-19-13-03-28\\DecoTV\\.tmp-edgeprofile-cdp',
  '--window-size=1600,1400',
  URL_TO_OPEN,
], { detached: true, stdio: 'ignore' });
child.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page' && t.url.includes('/play'));
      if (target) break;
    } catch (e) {
      // ignore
    }
  }
  if (!target) {
    console.log('未找到页面目标');
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve));

  for (const wait of [8000, 8000, 8000]) {
    await sleep(wait);
    const expr = `(() => {
      const v = document.querySelector('video');
      if (!v) return 'no video element';
      let buf = '-';
      try { if (v.buffered.length) buf = v.buffered.end(v.buffered.length-1).toFixed(1); } catch(e){}
      return ['rt=' + v.readyState, 'ns=' + v.networkState, 'ct=' + v.currentTime.toFixed(2),
        'dur=' + (isFinite(v.duration) ? v.duration.toFixed(1) : 'Inf'),
        'err=' + (v.error ? v.error.code + ':' + v.error.message : 'none'),
        'buf=' + buf, 'size=' + v.videoWidth + 'x' + v.videoHeight,
        'paused=' + v.paused, 'preload=' + v.preload,
        'src=' + (v.currentSrc || v.src).slice(-60)].join(' ');
    })()`;
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(res?.result?.value);
  }

  ws.close();
  process.exit(0);
})();
