/* CurbWatch frontend — plain JS, no deps.
   Three states: pick camera → trace lane → watch.
   API contract:
     GET  /api/cameras            → {cameras:[{id,name,latitude,longitude,area,isOnline}]}
     POST /api/analyze            ← {sessionId, cameraId, zone:[{x,y}…] (normalized 0-1), replay}
                                  → {frame, ts, imageSize:{width,height},
                                     detections:[{class,confidence,box:{x,y,width,height},inZone,blocking,dwellFrames}],
                                     status:"clear"|"warning"|"blocked", personCount, budget:{used,max}}
                                     (box x/y = CENTER pixels in imageSize space)
     POST /api/report             ← {sessionId} → {report, source, generatedAt}
*/
'use strict';

const $ = (sel) => document.querySelector(sel);

const POLL_MS = 3000;
const SECONDS_PER_FRAME = 3;
const BOROUGHS = ['All', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
const FRAME_URL = (id) => `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${Date.now()}`;
// DOT upstream sends isOnline as the string "true"/"false"; tolerate both.
const isOnline = (cam) => !(cam.isOnline === false || cam.isOnline === 'false');

const state = {
  cameras: [],
  filterText: '',
  borough: 'All',
  camera: null,
  zone: [],            // normalized {x,y}, 0–1 relative to displayed frame
  zoneClosed: false,
  sessionId: null,
  replay: false,
  watching: false,
  paused: false,
  framesAnalyzed: 0,
  lastResult: null,    // last /api/analyze payload
  frameImg: null,      // decoded Image for lastResult.frame
  prevZone: {},        // per-class summary of previous frame, for the event log
  events: [],          // newest first: {time, text, kind, cls, live}
  pollTimer: null,
  rafId: null,
  traceEntries: [],
};

/* ---------------------------------------------------------- views */

function show(view) {
  for (const v of ['pick', 'draw', 'watch']) $('#view-' + v).hidden = v !== view;
  document.body.dataset.view = view;
  const onCam = view !== 'pick' && state.camera;
  $('#topbarCam').hidden = !onCam;
  if (onCam) {
    $('#topbarCamName').textContent = state.camera.name;
    $('#topbarCamBorough').textContent = state.camera.area || '';
  }
}

/* ---------------------------------------------------------- state 1: pick */

async function loadCameras() {
  $('#camError').hidden = true;
  $('#camList').hidden = true;
  $('#camLoading').hidden = false;
  $('#camCount').textContent = '';
  try {
    const res = await fetch('/api/cameras');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.cameras = (data.cameras || []).slice().sort((a, b) =>
      (isOnline(b) ? 1 : 0) - (isOnline(a) ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
    $('#camLoading').hidden = true;
    renderCameras();
  } catch (err) {
    $('#camLoading').hidden = true;
    $('#camError').hidden = false;
  }
}

function renderCameras() {
  const text = state.filterText.trim().toLowerCase();
  const list = state.cameras.filter((c) => {
    if (state.borough !== 'All' &&
        !String(c.area || '').toLowerCase().includes(state.borough.toLowerCase())) return false;
    if (text && !String(c.name).toLowerCase().includes(text)) return false;
    return true;
  });

  const ul = $('#camList');
  ul.textContent = '';
  const frag = document.createDocumentFragment();
  for (const cam of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cam-row' + (isOnline(cam) ? '' : ' is-offline');
    const name = document.createElement('span');
    name.className = 'cam-row-name';
    name.textContent = cam.name;
    btn.appendChild(name);
    if (!isOnline(cam)) {
      const off = document.createElement('span');
      off.className = 'plate plate-off';
      off.textContent = 'offline';
      btn.appendChild(off);
    }
    const plate = document.createElement('span');
    plate.className = 'plate';
    plate.textContent = cam.area || '—';
    btn.appendChild(plate);
    btn.addEventListener('click', () => selectCamera(cam));
    li.appendChild(btn);
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  ul.hidden = false;
  $('#camCount').textContent =
    `${list.length} camera${list.length === 1 ? '' : 's'}` +
    (state.borough !== 'All' ? ` · ${state.borough.toUpperCase()}` : '') +
    (text ? ` · “${state.filterText.trim()}”` : '');
}

function selectCamera(cam) {
  state.camera = cam;
  enterDraw();
}

/* ---------------------------------------------------------- state 2: draw */

const previewImg = $('#previewImg');
const drawCanvas = $('#drawCanvas');

function enterDraw({ keepZone = false } = {}) {
  stopWatching();
  if (!keepZone) {
    state.zone = [];
    state.zoneClosed = false;
  }
  show('draw');
  $('#drawHudCam').textContent = `CAM ${state.camera.id} · ${state.camera.name.toUpperCase()}`;
  refreshPreview();
  updateZoneUI();
}

function refreshPreview() {
  $('#previewError').hidden = true;
  previewImg.src = FRAME_URL(state.camera.id);
}
previewImg.addEventListener('load', sizeDrawCanvas);
previewImg.addEventListener('error', () => { $('#previewError').hidden = false; });
window.addEventListener('resize', () => {
  if (!$('#view-draw').hidden) sizeDrawCanvas();
  if (!$('#view-watch').hidden) fitWatchFrame();
});

/* Cap a frame wrapper's width so the frame (at its aspect ratio) plus the
   surrounding chrome fits the viewport height — no scrolling on a projector. */
function fitFrame(wrapEl, ratio, reservedPx) {
  if (!ratio) return;
  const maxH = Math.max(320, window.innerHeight - reservedPx);
  wrapEl.style.setProperty('--frame-max', Math.round(maxH * ratio) + 'px');
}

function fitDrawFrame() {
  if (previewImg.naturalWidth) {
    fitFrame($('#drawFrameWrap'), previewImg.naturalWidth / previewImg.naturalHeight, 170);
  }
}

function fitWatchFrame() {
  const size = state.lastResult && state.lastResult.imageSize;
  if (size && size.height) fitFrame($('#watchFrameWrap'), size.width / size.height, 290);
}

function sizeDrawCanvas() {
  fitDrawFrame();
  const w = previewImg.clientWidth, h = previewImg.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  drawCanvas.width = Math.round(w * dpr);
  drawCanvas.height = Math.round(h * dpr);
  drawCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawZone();
}

drawCanvas.addEventListener('click', (e) => {
  if (state.zoneClosed) return;
  const w = drawCanvas.clientWidth, h = drawCanvas.clientHeight;
  if (!w || !h) return;
  state.zone.push({ x: e.offsetX / w, y: e.offsetY / h });
  updateZoneUI();
});

drawCanvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  // a dblclick already delivered two near-identical click points; drop one
  if (!state.zoneClosed && state.zone.length > 3) state.zone.pop();
  closeZone();
});

function closeZone() {
  if (state.zoneClosed || state.zone.length < 3) return;
  state.zoneClosed = true;
  updateZoneUI();
}

function clearZone() {
  state.zone = [];
  state.zoneClosed = false;
  updateZoneUI();
}

function updateZoneUI() {
  const n = state.zone.length;
  const status = $('#zoneStatus');
  status.classList.toggle('zone-ready', state.zoneClosed);
  status.textContent = state.zoneClosed
    ? `Zone locked — ${n} points. Ready to watch.`
    : n === 0 ? '0 points — click the frame to start'
    : n < 3 ? `${n} point${n === 1 ? '' : 's'} — need at least 3`
    : `${n} points — double-click or press Done to close`;
  $('#doneZoneBtn').disabled = state.zoneClosed || n < 3;
  $('#startWatchBtn').disabled = !state.zoneClosed;
  redrawZone();
}

function drawZonePath(ctx, w, h, closed) {
  ctx.beginPath();
  state.zone.forEach((p, i) => {
    const x = p.x * w, y = p.y * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  if (closed) ctx.closePath();
}

function redrawZone() {
  const ctx = drawCanvas.getContext('2d');
  const w = drawCanvas.clientWidth, h = drawCanvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (state.zone.length === 0) return;

  drawZonePath(ctx, w, h, state.zoneClosed);
  if (state.zoneClosed) {
    ctx.fillStyle = 'rgba(47, 163, 79, 0.28)';
    ctx.fill();
  }
  ctx.strokeStyle = state.zoneClosed ? '#2fa34f' : '#ffb612';
  ctx.lineWidth = 2.5;
  ctx.setLineDash(state.zoneClosed ? [] : [8, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  state.zone.forEach((p, i) => {
    const x = p.x * w, y = p.y * h;
    ctx.fillStyle = i === 0 ? '#ffb612' : '#f1efe7';
    ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.strokeStyle = '#141518';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 4, y - 4, 8, 8);
  });
}

/* ---------------------------------------------------------- state 3: watch */

const watchCanvas = $('#watchCanvas');

function enterWatch() {
  state.sessionId = crypto.randomUUID();
  state.watching = true;
  state.paused = false;
  state.framesAnalyzed = 0;
  state.lastResult = null;
  state.frameImg = null;
  state.prevZone = {};
  state.events = [];
  renderEvents();
  $('#reportCard').hidden = true;
  $('#reportErr').hidden = true;
  $('#reportBtn').disabled = false;
  $('#reportBtn').textContent = 'Get agent verdict';
  resetReportDecision();
  resetChat();
  closeTrace();
  $('#traceList').textContent = '';
  state.traceEntries = [];
  $('#watchWaiting').hidden = false;
  $('#watchNotice').hidden = true;
  $('#sbFrames').textContent = '0';
  setBanner('clear');
  setLiveIndicator();
  show('watch');
  $('#hudCam').textContent = `CAM ${state.camera.id} · ${state.camera.name.toUpperCase()}`;
  $('#hudTime').textContent = '';
  $('#bannerCam').textContent = state.camera.name;
  poll();
  if (state.rafId == null) state.rafId = requestAnimationFrame(renderWatchFrame);
}

function stopWatching() {
  state.watching = false;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (state.rafId != null) { cancelAnimationFrame(state.rafId); state.rafId = null; }
}

async function poll() {
  if (!state.watching || state.paused) return;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        cameraId: state.camera.id,
        zone: state.zone.map((p) => [p.x, p.y]),
        replay: state.replay,
      }),
    });
    if (res.status === 429) { onBudgetExhausted(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    onAnalysis(data);
    hideNotice();
  } catch (err) {
    showNotice('Connection lost — retrying every 3 s…');
  }
  state.pollTimer = setTimeout(poll, POLL_MS);
}

function onAnalysis(data) {
  state.framesAnalyzed += 1;
  state.lastResult = data;
  fitWatchFrame();
  $('#watchWaiting').hidden = true;
  $('#sbFrames').textContent = String(state.framesAnalyzed);
  $('#hudTime').textContent = fmtTime(data.ts) + ' · NYC DOT';

  if (data.frame) {
    const img = new Image();
    img.onload = () => { state.frameImg = img; };
    img.src = data.frame;
  }
  setBanner(data.status || 'clear');
  updateStats(data);
  updateBudget(data.budget);
  deriveEvents(data);
}

function setBanner(status) {
  const banner = $('#statusBanner');
  banner.className = 'banner banner-' + status;
  $('#bannerWord').textContent =
    status === 'blocked' ? '⚠ LANE BLOCKED' :
    status === 'warning' ? 'VEHICLE IN LANE' : 'CLEAR';
}

function updateStats(data) {
  const dets = data.detections || [];
  $('#statInZone').textContent = String(dets.filter((d) => d.inZone).length);
  $('#statBlocking').textContent = String(dets.filter((d) => d.blocking).length);
  $('#statPeople').textContent = String(data.personCount ?? 0);
}

function updateBudget(budget) {
  if (!budget || !budget.max) return;
  const pct = Math.min(100, (budget.used / budget.max) * 100);
  const fill = $('#budgetFill');
  fill.style.width = pct + '%';
  fill.className = 'budget-fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
  $('#budgetText').textContent = `${budget.used}/${budget.max}`;
}

/* --- event log: diff per-class in-zone summaries between frames --- */

function deriveEvents(data) {
  const t = fmtTime(data.ts);
  const cur = {};
  for (const d of data.detections || []) {
    if (!d.inZone) continue;
    const c = (cur[d.class] ??= { count: 0, blocking: false, dwell: 0 });
    c.count += 1;
    if (d.blocking) {
      c.blocking = true;
      c.dwell = Math.max(c.dwell, (d.dwellFrames || 0) * SECONDS_PER_FRAME);
    }
  }
  const prev = state.prevZone;
  for (const cls of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
    const c = cur[cls], p = prev[cls];
    if (c && !p) addEvent(t, `${cls} entered zone`, 'enter', cls);
    if (!c && p) addEvent(t, `${cls} left zone`, 'leave', cls);
    if (c && c.blocking) {
      const live = state.events.find((e) => e.cls === cls && e.kind === 'block' && e.live);
      if (live) { live.text = `${cls} BLOCKING ${c.dwell}s`; live.time = t; }
      else addEvent(t, `${cls} BLOCKING ${c.dwell}s`, 'block', cls, true);
    }
    if ((!c || !c.blocking) && p && p.blocking) {
      for (const e of state.events) if (e.cls === cls && e.kind === 'block') e.live = false;
    }
  }
  state.prevZone = cur;
  renderEvents();
}

function addEvent(time, text, kind, cls, live = false) {
  state.events.unshift({ time, text, kind, cls, live });
  state.events.length = Math.min(state.events.length, 8);
}

function renderEvents() {
  const ol = $('#eventLog');
  ol.textContent = '';
  if (state.events.length === 0) {
    const li = document.createElement('li');
    li.className = 'event event-idle';
    li.textContent = 'No events yet — watching…';
    ol.appendChild(li);
    return;
  }
  for (const ev of state.events) {
    const li = document.createElement('li');
    li.className = 'event event-' + ev.kind;
    const time = document.createElement('time');
    time.textContent = ev.time;
    const span = document.createElement('span');
    span.textContent = ev.text;
    li.append(time, span);
    ol.appendChild(li);
  }
}

/* --- canvas render loop: frame + zone + detection boxes --- */

const DET_STYLE = {
  out:      { stroke: 'rgba(154,160,168,0.55)', width: 1.5 },
  inZone:   { stroke: '#ffb612', width: 2.5 },
  blocking: { stroke: '#e33d2a', width: 4.5 },
};

function renderWatchFrame(now) {
  state.rafId = $('#view-watch').hidden ? null : requestAnimationFrame(renderWatchFrame);
  if (state.rafId == null) return;
  const data = state.lastResult;
  if (!data || !state.frameImg || !data.imageSize) return;

  const { width: W, height: H } = data.imageSize;
  if (watchCanvas.width !== W || watchCanvas.height !== H) {
    watchCanvas.width = W;
    watchCanvas.height = H;
  }
  const ctx = watchCanvas.getContext('2d');
  ctx.drawImage(state.frameImg, 0, 0, W, H);

  // lane zone
  if (state.zone.length >= 3) {
    drawZonePath(ctx, W, H, true);
    ctx.fillStyle = 'rgba(47, 163, 79, 0.25)';
    ctx.fill();
    ctx.strokeStyle = '#2fa34f';
    ctx.lineWidth = Math.max(2, W / 400);
    ctx.stroke();
  }

  // detections (box x/y are CENTER pixels in imageSize space)
  const pulse = 0.55 + 0.45 * Math.sin(now / 170);
  const fontPx = Math.max(11, Math.round(W / 42));
  ctx.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'top';

  for (const d of data.detections || []) {
    const b = d.box;
    if (!b) continue;
    const x = b.x - b.width / 2, y = b.y - b.height / 2;
    const style = d.blocking ? DET_STYLE.blocking : d.inZone ? DET_STYLE.inZone : DET_STYLE.out;

    if (d.blocking) {
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.shadowColor = '#e33d2a';
      ctx.shadowBlur = 18;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.width;
      ctx.strokeRect(x, y, b.width, b.height);
      ctx.restore();
    } else {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.width;
      ctx.strokeRect(x, y, b.width, b.height);
    }

    // footprint tick: bottom-center is what the zone test uses
    if (d.inZone || d.blocking) {
      ctx.fillStyle = style.stroke;
      ctx.beginPath();
      ctx.arc(b.x, y + b.height, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // label: class + dwell seconds
    if (d.inZone || d.blocking) {
      const dwell = (d.dwellFrames || 0) * SECONDS_PER_FRAME;
      const label = `${d.class}${dwell > 0 ? ' ' + dwell + 's' : ''}`;
      const pad = 3;
      const tw = ctx.measureText(label).width;
      const ly = Math.max(0, y - fontPx - pad * 2);
      ctx.fillStyle = d.blocking ? '#e33d2a' : '#ffb612';
      ctx.fillRect(x, ly, tw + pad * 2, fontPx + pad * 2);
      ctx.fillStyle = '#141518';
      ctx.fillText(label, x + pad, ly + pad);
    }
  }
}

/* --- notices, budget exhaustion, pause/resume --- */

function showNotice(text, withReplayCta = false) {
  const el = $('#watchNotice');
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (withReplayCta && !state.replay) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-yellow btn-sm';
    btn.textContent = 'Switch to replay mode';
    btn.addEventListener('click', () => {
      $('#replayToggle').checked = true;
      setReplay(true);
      resumeWatching();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
}

function hideNotice() { $('#watchNotice').hidden = true; }

function onBudgetExhausted() {
  state.paused = true;
  setLiveIndicator();
  showNotice('Inference budget exhausted for this session. Replay mode runs the demo on cached frames — zero credits.', true);
}

function resumeWatching() {
  hideNotice();
  state.paused = false;
  setLiveIndicator();
  clearTimeout(state.pollTimer);
  poll();
}

function setLiveIndicator() {
  const el = $('#sbLive');
  el.classList.toggle('is-paused', state.paused);
  el.innerHTML = `<span class="dot-pulse" aria-hidden="true">&#9679;</span> ${state.paused ? 'paused' : 'watching'}`;
}

function setReplay(on) {
  state.replay = on;
  $('#replayBadge').hidden = !on;
}

/* --- agent report --- */

async function getReport() {
  const btn = $('#reportBtn');
  btn.disabled = true;
  btn.textContent = 'Agent is writing…';
  $('#reportErr').hidden = true;
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    $('#reportTime').textContent = fmtDateTime(data.generatedAt);
    $('#reportCam').textContent = `${state.camera.name} (id ${state.camera.id})`;
    $('#reportSource').textContent = data.source || 'agent';
    $('#reportBody').textContent = data.report || '(empty report)';
    $('#reportCard').hidden = false;
    resetReportDecision();
    $('#reportActions').hidden = false;
    btn.textContent = 'Refresh verdict';
  } catch (err) {
    const errEl = $('#reportErr');
    errEl.textContent = 'Report unavailable — the agent didn’t answer. Try again in a few seconds.';
    errEl.hidden = false;
    btn.textContent = 'Get agent verdict';
  } finally {
    btn.disabled = false;
  }
}

/* --- human-in-the-loop: approve / edit / discard the report --- */

function resetReportDecision() {
  $('#reportActions').hidden = true;
  $('#approvedStamp').hidden = true;
  $('#reportEdit').hidden = true;
  $('#reportBody').hidden = false;
}

async function postDecision(payload) {
  const res = await fetch('/api/report/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, ...payload }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

function decisionError() {
  const errEl = $('#reportErr');
  errEl.textContent = 'Couldn’t record the decision — backend didn’t answer. Try again.';
  errEl.hidden = false;
}

async function approveReport() {
  $('#reportErr').hidden = true;
  try {
    await postDecision({ action: 'approved' });
    $('#reportActions').hidden = true;
    $('#approvedStamp').hidden = false;
  } catch { decisionError(); }
}

function startEditReport() {
  $('#reportErr').hidden = true;
  $('#reportEditText').value = $('#reportBody').textContent;
  $('#reportBody').hidden = true;
  $('#reportActions').hidden = true;
  $('#reportEdit').hidden = false;
  $('#reportEditText').focus();
}

function cancelEditReport() {
  $('#reportEdit').hidden = true;
  $('#reportBody').hidden = false;
  $('#reportActions').hidden = false;
}

async function saveEditReport() {
  const text = $('#reportEditText').value.trim();
  if (!text) return;
  try {
    await postDecision({ action: 'edited', editedText: text });
    $('#reportBody').textContent = text;
    cancelEditReport();
  } catch { decisionError(); }
}

async function discardReport() {
  $('#reportErr').hidden = true;
  try {
    await postDecision({ action: 'discarded' });
    $('#reportCard').hidden = true;
    $('#reportBtn').textContent = 'Get agent verdict';
  } catch { decisionError(); }
}

/* --- Ask CurbWatch chat --- */

function resetChat() {
  $('#chatMsgs').textContent = '';
  $('#chatNotice').hidden = true;
  $('#chatInput').value = '';
  $('#chatSend').disabled = false;
  $('#chatSec').open = false;
}

function chatBubble(cls, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + cls;
  div.textContent = text;
  const msgs = $('#chatMsgs');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function chatToolChips(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return;
  const ICONS = { search: '🔍', analyze: '📷', report: '📝', camera: '📷', zone: '📐' };
  const row = document.createElement('div');
  row.className = 'chat-tools';
  for (const t of tools) {
    const name = typeof t === 'string' ? t : (t.name || t.tool || 'tool');
    const icon = Object.keys(ICONS).find((k) => name.toLowerCase().includes(k));
    const chip = document.createElement('span');
    chip.className = 'tool-chip';
    chip.textContent = (icon ? ICONS[icon] + ' ' : '⚙ ') + name;
    row.appendChild(chip);
  }
  const msgs = $('#chatMsgs');
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

async function sendChat(message) {
  chatBubble('chat-user', message);
  $('#chatNotice').hidden = true;
  const thinking = chatBubble('chat-agent chat-thinking', '');
  const dot = document.createElement('span');
  dot.className = 'dot-pulse';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = '●';
  thinking.append(dot, ' agent thinking…');
  $('#chatSend').disabled = true;
  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message,
        cameraId: state.camera.id,
        zone: state.zone.map((p) => [p.x, p.y]),
      }),
    });
    thinking.remove();
    if (res.status === 503) {
      const n = $('#chatNotice');
      n.textContent = 'The agent needs Gemini credentials on this deploy — chat is offline, but watching and reports still work.';
      n.hidden = false;
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    chatBubble('chat-agent', data.reply || '(no reply)');
    chatToolChips(data.toolsUsed);
  } catch {
    thinking.remove();
    const n = $('#chatNotice');
    n.textContent = 'No answer from the agent — check the connection and try again.';
    n.hidden = false;
  } finally {
    $('#chatSend').disabled = false;
  }
}

/* --- agent trace drawer --- */

function openTrace() {
  $('#traceDrawer').classList.add('open');
  $('#traceBtn').setAttribute('aria-expanded', 'true');
  $('#traceSession').textContent = state.sessionId || 'no session';
  refreshTrace();
}

function closeTrace() {
  $('#traceDrawer').classList.remove('open');
  $('#traceBtn').setAttribute('aria-expanded', 'false');
}

function traceType(e) {
  const t = String(e.type || e.kind || '').toLowerCase();
  if (t.includes('llm') || t.includes('gemini') || t.includes('model')) return 'llm';
  if (t.includes('tool')) return 'tool';
  if (t.includes('verdict') || t.includes('analyze') || t.includes('detect')) return 'verdict';
  if (t.includes('human') || t.includes('decision') || t.includes('approv')) return 'human';
  return 'other';
}

function traceSummary(e) {
  if (e.summary) return String(e.summary);
  if (e.message) return String(e.message);
  const rest = { ...e };
  for (const k of ['ts', 'time', 'timestamp', 'type', 'kind', 'sessionId']) delete rest[k];
  const s = JSON.stringify(rest);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

async function refreshTrace() {
  const empty = $('#traceEmpty');
  empty.hidden = true;
  try {
    const res = await fetch(`/api/trace?sessionId=${encodeURIComponent(state.sessionId || '')}&limit=40`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const entries = Array.isArray(data) ? data : (data.entries || data.trace || []);
    state.traceEntries = entries;
    const ol = $('#traceList');
    ol.textContent = '';
    if (entries.length === 0) {
      empty.textContent = 'No trace entries yet for this session.';
      empty.hidden = false;
      return;
    }
    for (const e of entries) {   // newest last, as received
      const li = document.createElement('li');
      li.className = 'trace-row';
      const time = document.createElement('span');
      time.className = 'trace-time';
      time.textContent = fmtTime(e.ts ?? e.time ?? e.timestamp);
      const badge = document.createElement('span');
      const t = traceType(e);
      badge.className = 'trace-badge t-' + t;
      badge.textContent = t === 'other' ? String(e.type || 'event').slice(0, 8) : t;
      const sum = document.createElement('span');
      sum.className = 'trace-sum';
      sum.textContent = traceSummary(e);
      li.append(time, badge, sum);
      ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;
  } catch {
    $('#traceList').textContent = '';
    empty.textContent = 'Trace unavailable — the backend didn’t answer.';
    empty.hidden = false;
  }
}

function downloadTrace() {
  const entries = state.traceEntries || [];
  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
  const blob = new Blob([jsonl + '\n'], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `curbwatch-trace-${(state.sessionId || 'session').slice(0, 8)}.jsonl`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------------------------------------- utils */

function fmtTime(ts) {
  const d = ts != null ? new Date(ts) : new Date();
  return (isNaN(d) ? new Date() : d).toLocaleTimeString('en-US', { hour12: false });
}

function fmtDateTime(ts) {
  const d = ts != null ? new Date(ts) : new Date();
  return (isNaN(d) ? new Date() : d).toLocaleString('en-US', { hour12: false });
}

/* ---------------------------------------------------------- wiring */

$('#camSearch').addEventListener('input', (e) => { state.filterText = e.target.value; renderCameras(); });
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.borough = chip.dataset.borough;
    for (const c of document.querySelectorAll('.chip')) {
      c.setAttribute('aria-pressed', String(c === chip));
    }
    renderCameras();
  });
}
$('#camRetry').addEventListener('click', loadCameras);
$('#homeLink').addEventListener('click', (e) => { e.preventDefault(); stopWatching(); show('pick'); });

$('#doneZoneBtn').addEventListener('click', closeZone);
$('#clearZoneBtn').addEventListener('click', clearZone);
$('#refreshFrameBtn').addEventListener('click', refreshPreview);
$('#previewRetry').addEventListener('click', refreshPreview);
$('#backToPickBtn').addEventListener('click', () => { stopWatching(); show('pick'); });
$('#startWatchBtn').addEventListener('click', enterWatch);

$('#stopBtn').addEventListener('click', () => enterDraw({ keepZone: true }));
$('#replayToggle').addEventListener('change', (e) => setReplay(e.target.checked));
$('#reportBtn').addEventListener('click', getReport);

$('#approveBtn').addEventListener('click', approveReport);
$('#editBtn').addEventListener('click', startEditReport);
$('#cancelEditBtn').addEventListener('click', cancelEditReport);
$('#saveEditBtn').addEventListener('click', saveEditReport);
$('#discardBtn').addEventListener('click', discardReport);

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const msg = input.value.trim();
  if (!msg || $('#chatSend').disabled) return;
  input.value = '';
  sendChat(msg);
});

$('#traceBtn').addEventListener('click', () => {
  $('#traceDrawer').classList.contains('open') ? closeTrace() : openTrace();
});
$('#traceClose').addEventListener('click', closeTrace);
$('#traceRefresh').addEventListener('click', refreshTrace);
$('#traceDownload').addEventListener('click', downloadTrace);

loadCameras();

/* small hook for demos & debugging from the console */
window.CurbWatch = { state, selectCamera, enterWatch, onAnalysis, show };
