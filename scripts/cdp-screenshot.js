// 真实时间下通过 CDP 截取播放页画面
const { spawn } = require('child_process');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_TO_OPEN = process.argv[2];
const OUT = process.argv[3] || 'C:\\Users\\54743\\WorkBuddy\\2026-11-19-13-03-28\\DecoTV\\.tmp-cdp-shot.png';
const PORT = 9334;

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=C:\\Users\\54743\\WorkBuddy\\2026-11-19-13-03-28\\DecoTV\\.tmp-edgeprofile-cdp10',
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
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));

  for (const wait of [20000, 20000]) {
    await sleep(wait);
    const expr = `(() => { const v=document.querySelector('video'); if(!v) return 'no video';
      let buf='-'; try{ if(v.buffered.length) buf=v.buffered.end(v.buffered.length-1).toFixed(1);}catch(e){}
      return 'ct='+v.currentTime.toFixed(2)+' dur='+(isFinite(v.duration)?v.duration.toFixed(1):'Inf')+
        ' err='+(v.error?v.error.code:'none')+' buf='+buf+' size='+v.videoWidth+'x'+v.videoHeight+' paused='+v.paused; })()`;
    const st = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(st?.result?.value);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('截图已保存:', OUT);
  }
  ws.close();
  process.exit(0);
})();
