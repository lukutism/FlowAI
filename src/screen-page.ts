/** The web view of a run's device: its screen, refreshed as fast as frames come, and input sent back. */
export function screenPage(o: { run: string; device: string; platform: 'android' | 'ios' }): string {
  const drives = o.platform === 'android'
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.run)} · ${esc(o.device)}</title>
<style>
  :root { --bg: #0F1217; --panel: #161A20; --line: #262C35; --text: #DDE2E8; --muted: #6D7681; --accent: #78A6EC; --ok: #72C08A; --bad: #EC7A70; color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace; }
  body { display: grid; grid-template-rows: auto 1fr auto; padding-inline: max(16px, env(safe-area-inset-left, 0px)); }
  header, footer { display: flex; gap: 16px; align-items: center; padding-block: 10px; flex-wrap: wrap; }
  header b { color: var(--accent); font-weight: 600; }
  .muted { color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 6px; }
  .dot.live { background: var(--ok); } .dot.down { background: var(--bad); }
  main { display: flex; gap: 16px; justify-content: center; align-items: stretch; min-height: 0; }
  .screen { display: flex; justify-content: center; align-items: center; min-width: 0; }
  aside { flex: 1 1 0; max-width: 760px; min-width: 0; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  aside[hidden] { display: none; }
  aside .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  aside pre { flex: 1; margin: 0; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .e { color: var(--bad); } .w { color: #E2B35F; } .js { color: var(--text); } .o { color: var(--muted); }
  #console { flex: 1; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; font-size: 12px; line-height: 1.45; }
  #console[hidden] { display: none; }
  .row { display: flex; gap: 10px; padding: 3px 10px; border-bottom: 1px solid var(--line); align-items: baseline; }
  .row.warn { background: #2A2416; } .row.error { background: #2C1A19; }
  .row .t { color: var(--muted); flex: none; }
  .row .m { min-width: 0; white-space: pre-wrap; word-break: break-word; display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; }
  .row.warn .m { color: #E2B35F; } .row.error .m { color: var(--bad); }
  details { display: inline-block; vertical-align: top; } details[open] { display: block; }
  summary { cursor: pointer; color: var(--text); list-style: none; } summary::before { content: '▸ '; color: var(--muted); } details[open] > summary::before { content: '▾ '; }
  .kv { padding-left: 16px; } .k { color: #B39DDB; }
  .v-string { color: #E9A96E; } .v-number, .v-boolean { color: #8FB8F0; } .v-null, .v-undefined, .v-special { color: var(--muted); }
  input, select { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
  button.on { border-color: var(--accent); color: var(--accent); }
  @media (max-width: 900px) { main { flex-direction: column; } aside { max-width: none; min-height: 300px; } }
  img, canvas { max-height: calc(100vh - 110px); max-width: 100%; border: 1px solid var(--line); border-radius: 18px; background: #000; touch-action: none; user-select: none; -webkit-user-drag: none; ${drives ? 'cursor: pointer;' : ''} }
  button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); } button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style></head>
<body>
<header><span><span class="dot" id="state"></span><b>${esc(o.run)}</b></span><span class="muted">${esc(o.platform)} ${esc(o.device)}</span><span class="muted" id="fps"></span><label class="muted" for="devices">devices</label><select id="devices" aria-label="other devices"></select><button id="logsToggle">Logs</button></header>
<main><div class="screen"><canvas id="video" hidden aria-label="the device's screen"></canvas><img id="screen" alt="the device's screen"></div>
<aside id="logs" hidden><div class="bar"><button id="viewConsole" class="on">Console</button><button id="viewNative">Native</button><button id="allLines" hidden>Whole device</button><input id="filter" placeholder="filter" aria-label="filter the log"><button id="pause">Pause</button><button id="devtools" title="React Native DevTools: the browser's debugger for this app (it takes over an agent's debugger on it)">DevTools</button><span class="muted" id="count"></span></div><div id="console" aria-live="polite"></div><pre id="log" hidden aria-live="polite"></pre></aside></main>
<footer>${drives ? `
  <button data-key="back">◀ Back</button><button data-key="home">● Home</button><button data-key="apps">▢ Apps</button><button data-key="menu">Dev menu</button>
  <span class="muted">click to tap · drag to swipe · type to enter text</span>` : `<span class="muted">The simulator is shown here; drive it in Simulator.app (simctl has no input).</span>`}
</footer>
<script>
const token = new URLSearchParams(location.search).get('token') ?? ''
const base = location.pathname.replace(/\\/$/, '')
const img = document.getElementById('screen'), state = document.getElementById('state'), fps = document.getElementById('fps')
let frames = 0, last = performance.now(), url = '', live = false
const canvas = document.getElementById('video'), ctx = canvas.getContext('2d')
let size = null // the device's pixels, for taps on the video
const count = () => { frames++; const now = performance.now(); if (now - last > 2000) { fps.textContent = (frames * 1000 / (now - last)).toFixed(0) + ' fps'; frames = 0; last = now } }
// screenshots, while there is no video (an iOS simulator, a browser without WebCodecs, the stream down)
async function loop() {
  for (;;) {
    if (live || document.hidden) { await new Promise(r => setTimeout(r, 500)); continue }
    try {
      const r = await fetch(base + '/frame?token=' + encodeURIComponent(token), { cache: 'no-store' })
      if (!r.ok) throw new Error(await r.text())
      const next = URL.createObjectURL(await r.blob())
      await new Promise(res => { img.onload = res; img.onerror = res; img.src = next })
      if (url) URL.revokeObjectURL(url)
      url = next; count(); state.className = 'dot live'
    } catch (e) { state.className = 'dot down'; fps.textContent = String(e.message || e).slice(0, 120); await new Promise(r => setTimeout(r, 1500)) }
  }
}
loop()
// other devices: the runs' own and emulators no run holds
fetch('/devices?token=' + encodeURIComponent(token)).then(r => r.json()).then(list => {
  const sel = document.getElementById('devices'), here = base.split('/').pop()
  for (const d of list) { const o = document.createElement('option'); o.value = d.name; o.textContent = d.label; if (d.name === here) o.selected = true; sel.append(o) }
  sel.onchange = () => { location.href = '/device/' + encodeURIComponent(sel.value) + '?token=' + encodeURIComponent(token) }
}).catch(() => {})
// the app's log, every two seconds while shown: its JS console (objects open like the browser's) or the native rest
const logs = document.getElementById('logs'), pre = document.getElementById('log'), con = document.getElementById('console'), lineCount = document.getElementById('count'), filter = document.getElementById('filter')
let view = 'console', all = false, paused = false, timer2 = 0, shown = ''
const cls = l => /\\s[EF]\\/|Error|FATAL|Exception/.test(l) ? 'e' : /\\sW\\//.test(l) ? 'w' : /ReactNativeJS/.test(l) ? 'js' : 'o'
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
const short = v => v.kind === 'object' ? '{…}' : v.kind === 'array' ? 'Array(' + v.items.length + ')' : v.kind === 'string' ? '"' + v.text.slice(0, 40) + (v.text.length > 40 ? '…' : '') + '"' : v.text
const preview = v => v.kind === 'object' ? '{' + v.entries.slice(0, 4).map(([k, x]) => k + ': ' + short(x)).join(', ') + (v.entries.length > 4 ? ', …' : '') + '}'
  : '(' + v.items.length + ') [' + v.items.slice(0, 6).map(short).join(', ') + (v.items.length > 6 ? ', …' : '') + ']'
// a value: objects and arrays fold open, the rest coloured by kind
function node(v, top) {
  if (v.kind === 'object' || v.kind === 'array') {
    const d = el('details'), s = el('summary', '', preview(v)); d.append(s)
    for (const [k, x] of v.kind === 'object' ? v.entries : v.items.map((x, i) => [String(i), x])) { const row = el('div', 'kv'); row.append(el('span', 'k', k + ': '), node(x, false)); d.append(row) }
    return d
  }
  return el('span', 'v-' + v.kind, v.kind === 'string' && !top ? '"' + v.text + '"' : v.text)
}
async function pull() {
  if (logs.hidden || paused || document.hidden) return
  try {
    const q = filter.value.toLowerCase(), url = base + '/log?view=' + view + '&all=' + (all ? 1 : 0) + '&token=' + encodeURIComponent(token)
    if (view === 'console') {
      const entries = (await (await fetch(url, { cache: 'no-store' })).json()).filter(e => !q || e.text.toLowerCase().includes(q))
      const key = JSON.stringify(entries.map(e => e.time + e.text))
      if (key === shown) return // unchanged: the folds you opened stay open
      shown = key
      const atEnd = con.scrollHeight - con.scrollTop - con.clientHeight < 40
      con.replaceChildren(...entries.map(e => { const r = el('div', 'row ' + e.level); const m = el('div', 'm'); if (e.values) m.append(...e.values.map(v => node(v, true))); else m.textContent = (e.startCut ? '… (began earlier than the log kept) ' : '') + e.text; r.append(el('span', 't', e.time), m); return r }))
      lineCount.textContent = entries.length + ' entries'
      if (atEnd) con.scrollTop = con.scrollHeight
    } else {
      const lines = (await (await fetch(url, { cache: 'no-store' })).text()).split('\\n').filter(l => l && (!q || l.toLowerCase().includes(q)))
      const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
      pre.replaceChildren(...lines.map(l => el('div', cls(l), l)))
      lineCount.textContent = lines.length + ' lines'
      if (atEnd) pre.scrollTop = pre.scrollHeight
    }
  } catch {}
}
function show(v) {
  view = v; shown = ''
  document.getElementById('viewConsole').classList.toggle('on', v === 'console'); document.getElementById('viewNative').classList.toggle('on', v === 'native')
  con.hidden = v !== 'console'; pre.hidden = v !== 'native'; document.getElementById('allLines').hidden = v !== 'native'
  pull()
}
document.getElementById('logsToggle').onclick = e => { logs.hidden = !logs.hidden; e.target.classList.toggle('on', !logs.hidden); if (!logs.hidden) { pull(); clearInterval(timer2); timer2 = setInterval(pull, 2000) } else clearInterval(timer2) }
document.getElementById('viewConsole').onclick = () => show('console')
document.getElementById('viewNative').onclick = () => show('native')
document.getElementById('allLines').onclick = e => { all = !all; e.target.classList.toggle('on', all); pull() }
document.getElementById('devtools').onclick = async () => {
  const r = await fetch(base + '/devtools?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => null)
  lineCount.textContent = r && r.ok ? 'DevTools opened (an agent\\'s debugger on this app is disconnected meanwhile)' : 'DevTools: ' + (r ? await r.text() : 'the service did not answer')
}
document.getElementById('pause').onclick = e => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; if (!paused) pull() }
filter.oninput = () => pull()
// the device's own H.264 encoder over a WebSocket, decoded here: smooth, and cheap for the device
function videoStream() {
  if (!('VideoDecoder' in window) || ${drives ? 'false' : 'true'}) return
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + '/video?token=' + encodeURIComponent(token))
  ws.binaryType = 'arraybuffer'
  let buf = new Uint8Array(0), unit = [], key = false, ts = 0, decoder = null, quiet = 0
  const decoderFor = sps => {
    const d = new VideoDecoder({ output: f => { if (canvas.width !== f.displayWidth) { canvas.width = f.displayWidth; canvas.height = f.displayHeight } ctx.drawImage(f, 0, 0); f.close(); count() }, error: () => ws.close() })
    const hex = b => b.toString(16).padStart(2, '0')
    d.configure({ codec: 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]), optimizeForLatency: true })
    return d
  }
  const nal = n => {
    const type = n[0] & 31
    if (type === 7 && !decoder) decoder = decoderFor(n)
    unit.push(n)
    if (type === 5) key = true
    if (type === 1 || type === 5) { // a picture: the access unit is complete
      if (decoder && (key || ts)) {
        const len = unit.reduce((a, x) => a + 4 + x.length, 0), data = new Uint8Array(len)
        let o = 0
        for (const x of unit) { data.set([0, 0, 0, 1], o); data.set(x, o + 4); o += 4 + x.length }
        decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }))
        ts += 33333
        if (!live) { live = true; canvas.hidden = false; img.hidden = true; state.className = 'dot live' }
      }
      unit = []; key = false
    }
  }
  ws.onmessage = e => {
    if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.type === 'size') size = m; return }
    const next = new Uint8Array(buf.length + e.data.byteLength); next.set(buf); next.set(new Uint8Array(e.data), buf.length); buf = next
    // split on start codes; the last NAL unit waits for the next start code (it may not be whole yet)
    let at = -1, from = -1
    for (let i = 0; i + 3 <= buf.length; i++) {
      if (buf[i] !== 0 || buf[i + 1] !== 0) continue
      const sc = buf[i + 2] === 1 ? 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? 4 : 0
      if (!sc) continue
      if (from >= 0) nal(buf.slice(from, i))
      at = i; from = i + sc; i += sc - 1
    }
    if (at > 0) buf = buf.slice(at)
    // a still screen sends nothing more: the last unit is taken as whole once the stream is quiet
    clearTimeout(quiet)
    quiet = setTimeout(() => { const sc = buf[2] === 1 ? 3 : 4; if (buf.length > sc) { nal(buf.slice(sc)); buf = new Uint8Array(0) } }, 50)
  }
  ws.onclose = () => { live = false; decoder = null; canvas.hidden = true; img.hidden = false; setTimeout(videoStream, 2000) }
}
videoStream()
${drives ? `
const send = i => fetch(base + '/input?token=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(i) })
const at = e => {
  const el = live ? canvas : img, b = el.getBoundingClientRect()
  const w = live ? (size?.width ?? canvas.width) : img.naturalWidth, h = live ? (size?.height ?? canvas.height) : img.naturalHeight
  return { x: (e.clientX - b.left) * w / b.width, y: (e.clientY - b.top) * h / b.height }
}
let down = null
for (const el of [img, canvas]) el.addEventListener('pointerdown', e => { down = { ...at(e), t: performance.now() }; el.setPointerCapture(e.pointerId) })
for (const el of [img, canvas]) el.addEventListener('pointerup', e => {
  if (!down) return
  const up = at(e), ms = Math.round(performance.now() - down.t), moved = Math.hypot(up.x - down.x, up.y - down.y)
  send(moved < 12 && ms < 400 ? { type: 'tap', x: down.x, y: down.y } : { type: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Math.min(Math.max(ms, 80), 2000) })
  down = null
})
document.querySelectorAll('button[data-key]').forEach(b => b.addEventListener('click', () => send({ type: 'key', key: b.dataset.key })))
let typed = '', timer = 0
const flush = () => { if (typed) send({ type: 'text', text: typed }); typed = '' }
const KEYMAP = { Backspace: 'delete', Enter: 'enter', Escape: 'back', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  if (KEYMAP[e.key]) { flush(); send({ type: 'key', key: KEYMAP[e.key] }); e.preventDefault(); return }
  if (e.key.length === 1) { typed += e.key; clearTimeout(timer); timer = setTimeout(flush, 150); e.preventDefault() }
})` : ''}
</script>
</body></html>`
}
