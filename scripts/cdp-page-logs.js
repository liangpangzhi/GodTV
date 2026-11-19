// 收集播放页的控制台输出与失败请求
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_TO_OPEN = process.argv[2];
const PORT = 9336;

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=C:\\Users\\54743\\WorkBuddy\\2026-11-19-13-03-28\\DecoTV\\.tmp-edgeprofile-cdp11',
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
    } catch (e) { /* ignore */ }
  }
  if (!target) { console.log('未找到页面'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const logs = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push(`[console.${msg.params.type}] ${text}`.slice(0, 300));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params.exceptionDetails?.text} ${msg.params.exceptionDetails?.exception?.description || ''}`.slice(0, 300));
    }
    if (msg.method === 'Network.loadingFailed') {
      logs.push(`[netfail] ${msg.params.errorText} ${msg.params.type}`);
    }
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.status >= 400 || r.url.includes('/api/')) {
        logs.push(`[net] ${r.status} ${r.url.slice(0, 140)}`);
      }
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Network.enable');
  await sleep(12000);

  const expr = `(async () => {
    try {
      const q = new URLSearchParams({source:'private_library', id: new URL(location.href).searchParams.get('id') || ''});
      const r = await fetch('/api/detail?' + q.toString());
      const t = await r.text();
      return 'detail HTTP ' + r.status + ' :: ' + t.slice(0, 200);
    } catch (e) { return 'fetch err ' + e.message; }
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('页面内 fetch:', res?.result?.value);
  console.log('--- 日志 ---');
  logs.slice(0, 40).forEach((l) => console.log(l));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    require('fs').writeFileSync('C:////Users////54743////WorkBuddy////2026-11-19-13-03-28////DecoTV////.tmp-cdp-shot.png', Buffer.from(shot.data, 'base64'));
    console.log('截图已保存');
  }
  ws.close();
  process.exit(0);
})();
