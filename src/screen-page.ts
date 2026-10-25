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
  main { display: flex; justify-content: center; align-items: center; min-height: 0; }
  img, canvas { max-height: calc(100vh - 110px); max-width: 100%; border: 1px solid var(--line); border-radius: 18px; background: #000; touch-action: none; user-select: none; -webkit-user-drag: none; ${drives ? 'cursor: pointer;' : ''} }
  button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); } button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style></head>
<body>
<header><span><span class="dot" id="state"></span><b>${esc(o.run)}</b></span><span class="muted">${esc(o.platform)} ${esc(o.device)}</span><span class="muted" id="fps"></span></header>
<main><canvas id="video" hidden aria-label="the device's screen"></canvas><img id="screen" alt="the device's screen"></main>
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
  if (KEYMAP[e.key]) { flush(); send({ type: 'key', key: KEYMAP[e.key] }); e.preventDefault(); return }
  if (e.key.length === 1) { typed += e.key; clearTimeout(timer); timer = setTimeout(flush, 150); e.preventDefault() }
})` : ''}
</script>
</body></html>`
}
