// Runs inside the Codespace: connects OUT to the relay, runs Claude Code headless, streams events back.
console.log("agent boot", process.env.RELAY_URL, process.env.GITHUB_USER, !!process.env.GITHUB_TOKEN, !!process.env.CODESPACE_NAME);
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELAY = process.env.RELAY_URL || 'wss://claude-code-cloud.mhamra148.workers.dev/agent';
const WORK = path.resolve('projects');
fs.mkdirSync(WORK, { recursive: true });
let sessionId = null, proc = null, reported = false;

const clip = (v) => String(v ?? '').slice(0, 300);
function describe(b) {
  const i = b.input || {};
  switch (b.name) {
    case 'Bash': return { kind: 'cmd', k: 'Ran', v: clip(i.command) };
    case 'Read': return { kind: 'read', k: 'Read', v: clip(i.file_path) };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return { kind: 'edit', k: 'Edited', v: clip(i.file_path || i.notebook_path) };
    case 'Glob': case 'Grep': return { kind: 'read', k: 'Searched', v: clip(i.pattern) };
    default: return { kind: 'browser', k: b.name, v: clip(i.url || i.query) };
  }
}

function onLine(line, send) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.session_id) sessionId = m.session_id;
  if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (b.type === 'thinking') send({ t: 'think' });
      else if (b.type === 'text' && b.text) send({ t: 'text', s: b.text });
      else if (b.type === 'tool_use') send({ t: 'tool', ...describe(b) });
    }
  } else if (m.type === 'result' && m.is_error) {
    reported = true;
    send({ t: 'error', s: clip(m.result || 'Claude Code error') });
  }
}

function run(text, send) {
  if (proc) return;
  reported = false;
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep'];
  if (sessionId) args.push('--resume', sessionId);
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
    ANTHROPIC_AUTH_TOKEN: 'local',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  delete env.GITHUB_TOKEN; delete env.GH_TOKEN; // keep the user's token away from the model
  proc = spawn('claude', args, { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  proc.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l, send); }
  });
  proc.stderr.on('data', (c) => { err += c; });
  proc.on('close', (code) => {
    if (code && !reported && !proc?.killed) send({ t: 'error', s: clip(err.trim().slice(-400) || 'exit ' + code) });
    proc = null; send({ t: 'end' });
  });
}

function connect() {
  const ws = new WebSocket(`${RELAY}?user=${encodeURIComponent(process.env.GITHUB_USER || '')}`);
  const ka = setInterval(() => ws.readyState === 1 && ws.send('ping'), 30000);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('open', () => send({ t: 'hello', token: process.env.GITHUB_TOKEN, name: process.env.CODESPACE_NAME }));
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'msg' && typeof m.text === 'string') run(m.text, send);
    else if (m.t === 'stop' && proc) proc.kill();
  });
  ws.on('close', (c, r) => { console.log('closed', c, String(r)); clearInterval(ka); setTimeout(connect, 3000); });
  ws.on('error', (e) => console.log('ws error:', e.message));
}
connect();
