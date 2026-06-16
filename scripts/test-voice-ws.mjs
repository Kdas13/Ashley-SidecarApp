import { WebSocket } from '/home/runner/workspace/node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs';

const API_AUTH_KEY = process.env['API_AUTH_KEY'] ?? '';
const DEVICE_ID = 'test-device-11223344';

async function testRejectBadAuth() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8080/api/voice/call', {
      headers: {
        'Authorization': 'Bearer definitely-wrong-key-xyz',
        'X-Device-Id': DEVICE_ID,
      },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ test: 'reject_bad_auth', result: 'TIMEOUT', ok: false });
    }, 4000);
    ws.on('error', (err) => {
      clearTimeout(timer);
      const ok = err.message.includes('401') || err.message.toLowerCase().includes('unauthorized');
      resolve({ test: 'reject_bad_auth', result: err.message, ok });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve({ test: 'reject_bad_auth', result: 'OPENED — should have been rejected', ok: false });
    });
  });
}

async function testRejectBadDeviceId() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8080/api/voice/call', {
      headers: {
        'Authorization': `Bearer ${API_AUTH_KEY}`,
        'X-Device-Id': 'bad!id',
      },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ test: 'reject_bad_device_id', result: 'TIMEOUT', ok: false });
    }, 4000);
    ws.on('error', (err) => {
      clearTimeout(timer);
      const ok = err.message.includes('400') || err.message.toLowerCase().includes('bad');
      resolve({ test: 'reject_bad_device_id', result: err.message, ok });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve({ test: 'reject_bad_device_id', result: 'OPENED — should have been rejected', ok: false });
    });
  });
}

async function testEchoIfKeyAvailable() {
  if (!API_AUTH_KEY) {
    return { test: 'echo', result: 'SKIPPED — API_AUTH_KEY not in env', ok: 'skip' };
  }
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8080/api/voice/call', {
      headers: {
        'Authorization': `Bearer ${API_AUTH_KEY}`,
        'X-Device-Id': DEVICE_ID,
      },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ test: 'echo', result: 'TIMEOUT', ok: false });
    }, 5000);
    let gotConnected = false;
    let gotEcho = false;
    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ test: 'echo', result: `error: ${err.message}`, ok: false });
    });
    ws.on('message', (data) => {
      const text = data.toString();
      if (!gotConnected) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'connected') {
            gotConnected = true;
            ws.send('hello from test');
            return;
          }
        } catch {}
      }
      if (text === '[echo] hello from test') {
        gotEcho = true;
        clearTimeout(timer);
        ws.close();
        resolve({ test: 'echo', result: 'connected + echo OK', ok: true });
      }
    });
  });
}

const results = await Promise.all([
  testRejectBadAuth(),
  testRejectBadDeviceId(),
  testEchoIfKeyAvailable(),
]);

let allOk = true;
for (const r of results) {
  const icon = r.ok === true ? '✓' : r.ok === 'skip' ? '~' : '✗';
  console.log(`${icon}  [${r.test}] ${r.result}`);
  if (r.ok === false) allOk = false;
}

process.exit(allOk ? 0 : 1);
