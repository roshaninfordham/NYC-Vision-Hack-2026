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
  pickView: 'map',     // 'map' | 'list'
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
  lastReport: null,    // last /api/report payload (report may be human-edited)
  lockedTrackId: null, // target-locked detection trackId
  lockedClass: null,
  lockedMissing: 0,    // consecutive frames the locked target was absent
};

/* ---------------------------------------------------------- views */

/* swap a button's label for a spinner while an async action runs */
function btnSpinner(btn, label) {
  btn.disabled = true;
  btn.textContent = '';
  const s = document.createElement('span');
  s.className = 'spin';
  s.setAttribute('aria-hidden', 'true');
  btn.append(s, label);
}

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
  $('#mapWrap').hidden = true;
  $('#camLoading').hidden = false;
  $('#camCount').textContent = '';
  try {
    const res = await fetch('/api/cameras');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.cameras = (data.cameras || []).slice().sort((a, b) =>
      (isOnline(b) ? 1 : 0) - (isOnline(a) ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
    $('#camLoading').hidden = true;
    initMap();
    buildMarkers();
    loadBikeLanes();
    if (!map) state.pickView = 'list';
    setPickView(state.pickView);
    renderCameras();
  } catch (err) {
    $('#camLoading').hidden = true;
    $('#camError').hidden = false;
  }
}

function filteredCameras() {
  const text = state.filterText.trim().toLowerCase();
  return state.cameras.filter((c) => {
    if (state.borough !== 'All' &&
        !String(c.area || '').toLowerCase().includes(state.borough.toLowerCase())) return false;
    if (text && !String(c.name).toLowerCase().includes(text)) return false;
    return true;
  });
}

function renderCameras() {
  const text = state.filterText.trim();
  const list = filteredCameras();
  applyMapFilter(list);

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
  ul.hidden = state.pickView !== 'list';
  $('#camCount').textContent =
    `${list.length} camera${list.length === 1 ? '' : 's'}` +
    (state.borough !== 'All' ? ` · ${state.borough.toUpperCase()}` : '') +
    (text ? ` · “${text}”` : '');
}

/* --- map picker (Leaflet, vendored) --- */

let map = null;
let tilesLoaded = 0;
let mapMarkers = [];   // [{marker, cam}]

const BOROUGH_VIEWS = {
  'All':           { center: [40.72, -73.98],     zoom: 11 },
  'Manhattan':     { center: [40.7781, -73.9665], zoom: 12 },
  'Brooklyn':      { center: [40.6526, -73.9497], zoom: 12 },
  'Queens':        { center: [40.7282, -73.8158], zoom: 11 },
  'Bronx':         { center: [40.8448, -73.8648], zoom: 12 },
  'Staten Island': { center: [40.5795, -74.1502], zoom: 12 },
};

const DOT_STYLE_BASE    = { radius: 4.5, fillColor: '#ffb612', fillOpacity: 0.9, color: '#141518', weight: 1 };
const DOT_STYLE_OFFLINE = { radius: 3.5, fillColor: '#5a5f66', fillOpacity: 0.7, color: '#141518', weight: 1 };
const DOT_STYLE_HOVER   = { radius: 7, fillColor: '#2fa34f', fillOpacity: 1 };

function initMap() {
  if (map || typeof L === 'undefined') return;
  $('#mapWrap').hidden = false;   // Leaflet needs a visible container to size itself
  map = L.map('map', { preferCanvas: true }).setView(BOROUGH_VIEWS.All.center, BOROUGH_VIEWS.All.zoom);
  let tileErrors = 0;
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  tiles.on('tileload', () => { tilesLoaded += 1; });
  tiles.on('tileerror', () => {
    tileErrors += 1;
    if (tilesLoaded === 0 && tileErrors >= 6 && state.pickView === 'map') {
      setPickView('list', { notice: 'Map tiles unavailable (offline?) — showing the list instead.' });
    }
  });
}

function markerPopup(cam) {
  const div = document.createElement('div');
  const name = document.createElement('p');
  name.className = 'cam-pop-name';
  name.textContent = cam.name;
  const borough = document.createElement('p');
  borough.className = 'cam-pop-borough';
  borough.textContent = (cam.area || '—') + (isOnline(cam) ? '' : ' · OFFLINE');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-green btn-sm cam-pop-btn';
  btn.textContent = 'Watch this camera';
  btn.addEventListener('click', () => { map.closePopup(); selectCamera(cam); });
  div.append(name, borough, btn);
  return div;
}

function buildMarkers() {
  if (!map) return;
  for (const { marker } of mapMarkers) marker.remove();
  mapMarkers = [];
  for (const cam of state.cameras) {
    const lat = Number(cam.latitude), lng = Number(cam.longitude);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
    const base = isOnline(cam) ? DOT_STYLE_BASE : DOT_STYLE_OFFLINE;
    const marker = L.circleMarker([lat, lng], base);
    marker.on('mouseover', () => marker.setStyle(DOT_STYLE_HOVER));
    marker.on('mouseout', () => marker.setStyle(base));
    marker.bindPopup(() => markerPopup(cam));
    marker.addTo(map);
    mapMarkers.push({ marker, cam });
  }
}

/* --- bike-lane network overlay (NYC DOT bicycle routes) --- */

let bikeLayer = null;
let bikeLanesOn = true;
let bikeLanesLoading = false;

// facilitycl "I" = protected lane / greenway → drawn heavier
function bikeLaneStyle(feature) {
  const isProtected = feature && feature.properties && feature.properties.c === 'I';
  return {
    color: '#2fa34f',
    weight: isProtected ? 3 : 2,
    opacity: isProtected ? 0.9 : 0.75,
  };
}

async function loadBikeLanes() {
  if (!map || bikeLayer || bikeLanesLoading) return;
  bikeLanesLoading = true;
  try {
    const res = await fetch('/data/bike-routes.geojson');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geo = await res.json();
    bikeLayer = L.geoJSON(geo, { style: bikeLaneStyle, interactive: false });
    $('#bikeLanesBtn').hidden = false;
    if (bikeLanesOn) {
      bikeLayer.addTo(map);
      bikeLayer.bringToBack();   // lanes glow under the camera dots
    }
  } catch { /* no lane data — skip silently */ }
  finally {
    bikeLanesLoading = false;
    updateBikeLegend();
  }
}

function setBikeLanes(on) {
  bikeLanesOn = on;
  $('#bikeLanesBtn').setAttribute('aria-pressed', String(on));
  if (bikeLayer && map) {
    if (on) {
      bikeLayer.addTo(map);
      bikeLayer.bringToBack();
    } else {
      bikeLayer.remove();
    }
  }
  updateBikeLegend();
}

function updateBikeLegend() {
  $('#bikeLegend').hidden = !(bikeLayer && bikeLanesOn && state.pickView === 'map');
}

function applyMapFilter(list) {
  if (!map) return;
  const keep = new Set(list.map((c) => c.id));
  for (const { marker, cam } of mapMarkers) {
    const shown = map.hasLayer(marker);
    if (keep.has(cam.id) && !shown) marker.addTo(map);
    else if (!keep.has(cam.id) && shown) marker.remove();
  }
}

function setPickView(view, { notice } = {}) {
  state.pickView = map ? view : 'list';
  const isMap = state.pickView === 'map';
  $('#mapWrap').hidden = !isMap;
  $('#camList').hidden = isMap;
  $('#mapViewBtn').setAttribute('aria-pressed', String(isMap));
  $('#listViewBtn').setAttribute('aria-pressed', String(!isMap));
  if (!map) document.querySelector('.view-toggle').hidden = true;
  const n = $('#pickNotice');
  n.textContent = notice || '';
  n.hidden = !notice;
  updateBikeLegend();
  if (isMap) setTimeout(() => map.invalidateSize(), 60);
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
  $('#startWatchBtn').textContent = 'Start watching';
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
  btnSpinner($('#startWatchBtn'), 'Starting…');
  state.sessionId = crypto.randomUUID();
  state.watching = true;
  state.paused = false;
  state.framesAnalyzed = 0;
  state.lastResult = null;
  state.frameImg = null;
  state.prevZone = {};
  state.events = [];
  clearLock();
  renderEvents();
  $('#reportCard').hidden = true;
  $('#reportErr').hidden = true;
  $('#reportBtn').disabled = false;
  $('#reportBtn').textContent = 'Get agent verdict';
  state.lastReport = null;
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
  const slowTimer = setTimeout(() => {   // frame proxy stalling — say so in the HUD
    $('#hudTime').textContent = 'SLOW FEED…';
  }, 4000);
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
  } finally {
    clearTimeout(slowTimer);
  }
  state.pollTimer = setTimeout(poll, POLL_MS);
}

function onAnalysis(data) {
  state.framesAnalyzed += 1;
  if (state.framesAnalyzed === 1) {   // first frame landed — Start button can settle
    $('#startWatchBtn').textContent = 'Start watching';
    $('#startWatchBtn').disabled = !state.zoneClosed;
  }
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
  updateLock(data);
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

/* --- target lock: click a detection box to track one vehicle across frames --- */

const LOCK_COLOR = '#39d0ff';
const LOCK_LOST_FRAMES = 3;

function lockSeconds(d) {
  return (d.seenFrames ?? d.dwellFrames ?? 0) * SECONDS_PER_FRAME;
}

function setLock(d) {
  state.lockedTrackId = d.trackId;
  state.lockedClass = d.class;
  state.lockedMissing = 0;
  renderTargetLine(d);
}

function clearLock() {
  state.lockedTrackId = null;
  state.lockedClass = null;
  state.lockedMissing = 0;
  $('#targetRow').hidden = true;
}

function renderTargetLine(d) {
  $('#targetRow').hidden = false;
  $('#targetLine').textContent =
    `TARGET: ${d.class} #${d.trackId} · ${d.blocking ? 'BLOCKING' : d.inZone ? 'in zone' : 'off zone'} · ${lockSeconds(d)}s`;
}

function updateLock(data) {
  if (state.lockedTrackId == null) return;
  const d = (data.detections || []).find((x) => x.trackId === state.lockedTrackId);
  if (d) {
    state.lockedMissing = 0;
    renderTargetLine(d);
  } else {
    state.lockedMissing += 1;
    if (state.lockedMissing > LOCK_LOST_FRAMES) {
      addEvent(fmtTime(data.ts), `target ${state.lockedClass} #${state.lockedTrackId} lost`, 'leave', state.lockedClass);
      renderEvents();
      clearLock();
    }
  }
}

watchCanvas.addEventListener('click', (e) => {
  const data = state.lastResult;
  if (!data || !data.imageSize || !watchCanvas.clientWidth) return;
  const px = e.offsetX * (data.imageSize.width / watchCanvas.clientWidth);
  const py = e.offsetY * (data.imageSize.height / watchCanvas.clientHeight);
  const dets = data.detections || [];
  for (let i = dets.length - 1; i >= 0; i--) {   // last drawn = topmost
    const d = dets[i], b = d.box;
    if (!b || d.trackId == null) continue;
    if (Math.abs(px - b.x) <= b.width / 2 && Math.abs(py - b.y) <= b.height / 2) {
      state.lockedTrackId === d.trackId ? clearLock() : setLock(d);
      return;
    }
  }
});

function drawLock(ctx, d, W, fontPx) {
  const b = d.box;
  const x = b.x - b.width / 2, y = b.y - b.height / 2;
  ctx.save();
  ctx.strokeStyle = LOCK_COLOR;
  ctx.lineWidth = Math.max(3.5, W / 300);
  ctx.strokeRect(x, y, b.width, b.height);

  // corner crosshair ticks, extending outward
  const t = Math.max(8, Math.min(b.width, b.height) * 0.22);
  const g = Math.max(4, W / 250);            // gap outside the box
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [
    [x, y, 1, 1], [x + b.width, y, -1, 1],
    [x, y + b.height, 1, -1], [x + b.width, y + b.height, -1, -1],
  ]) {
    ctx.moveTo(cx - sx * g, cy - sy * g);
    ctx.lineTo(cx - sx * g + sx * t, cy - sy * g);
    ctx.moveTo(cx - sx * g, cy - sy * g);
    ctx.lineTo(cx - sx * g, cy - sy * g + sy * t);
  }
  ctx.stroke();

  const label = `LOCKED · ${d.class} #${d.trackId} · ${lockSeconds(d)}s`;
  const pad = 3;
  const tw = ctx.measureText(label).width;
  const ly = Math.max(0, y - fontPx - pad * 2 - g);
  const lx = Math.max(0, Math.min(x, W - tw - pad * 2));   // keep the label on-frame
  ctx.fillStyle = LOCK_COLOR;
  ctx.fillRect(lx, ly, tw + pad * 2, fontPx + pad * 2);
  ctx.fillStyle = '#062733';
  ctx.fillText(label, lx + pad, ly + pad);
  ctx.restore();
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

    // label: class + dwell seconds (the lock overlay draws its own label)
    if ((d.inZone || d.blocking) && d.trackId !== state.lockedTrackId) {
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

  // target-locked vehicle rides on top of everything
  if (state.lockedTrackId != null) {
    const locked = (data.detections || []).find((d) => d.trackId === state.lockedTrackId && d.box);
    if (locked) drawLock(ctx, locked, W, fontPx);
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
  btnSpinner(btn, 'Agent is writing…');
  $('#reportErr').hidden = true;
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.lastReport = data;
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
  $('#evidenceSec').hidden = true;
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
    $('#evidenceSec').hidden = false;
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
    if (state.lastReport) state.lastReport.report = text;
    cancelEditReport();
  } catch { decisionError(); }
}

/* --- evidence bundle: approved report + trace + frame, one download --- */

async function downloadEvidence() {
  const btn = $('#evidenceBtn');
  btn.disabled = true;
  btn.textContent = 'Bundling…';
  try {
    let trace = state.traceEntries || [];
    try {
      const res = await fetch(`/api/trace?sessionId=${encodeURIComponent(state.sessionId || '')}&limit=200`);
      if (res.ok) {
        const data = await res.json();
        trace = Array.isArray(data) ? data : (data.entries || data.trace || []);
      }
    } catch { /* trace is best-effort — bundle ships without it */ }

    const cam = state.camera || {};
    const rep = state.lastReport || {};
    const bundle = {
      camera: {
        id: cam.id,
        name: cam.name,
        latitude: cam.latitude,
        longitude: cam.longitude,
        area: cam.area,
      },
      report: $('#reportBody').textContent,
      reportSource: rep.source || null,
      decision: 'approved',
      generatedAt: new Date().toISOString(),
      trace,
      frameJpegDataUrl: (state.lastResult && state.lastResult.frame) || null,
    };
    if (rep.grounded !== undefined) bundle.grounded = rep.grounded;

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `curbwatch-evidence-${cam.id || 'camera'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Evidence bundle';
  }
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
  stopListening();
  stopSpeech();
  $('#chatMsgs').textContent = '';
  $('#chatNotice').hidden = true;
  $('#chatInput').value = '';
  $('#chatSend').disabled = false;
  $('#chatSec').open = true;   // discoverable by default in watch view
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
    if (data.reply) speakReply(data.reply);
  } catch {
    thinking.remove();
    const n = $('#chatNotice');
    n.textContent = 'No answer from the agent — check the connection and try again.';
    n.hidden = false;
  } finally {
    $('#chatSend').disabled = false;
  }
}

/* --- voice: mic input + spoken replies (demo flourish, degrades to text) --- */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let listening = false;

const CHAT_HINTS = [
  'Ask about this camera… (any language)',
  'Pregúntame en español…',
  '用中文问我…',
  'Poze m kesyon an kreyòl…',
  'Спросите меня по-русски…',
  'اسألني بالعربية…',
  'Posez-moi la question en français…',
];
let hintIdx = 0;
setInterval(() => {
  const input = $('#chatInput');
  if (listening || document.activeElement === input) return;
  hintIdx = (hintIdx + 1) % CHAT_HINTS.length;
  input.placeholder = CHAT_HINTS[hintIdx];
}, 4000);

function startListening() {
  if (!SpeechRec) return;
  recog = new SpeechRec();
  recog.lang = navigator.language || '';
  recog.interimResults = true;
  recog.continuous = false;
  listening = true;
  const btn = $('#micBtn');
  btn.classList.add('listening');
  btn.setAttribute('aria-pressed', 'true');
  $('#chatInput').placeholder = 'Listening…';
  recog.onresult = (e) => {
    let interim = '', final = '';
    for (const r of e.results) (r.isFinal ? final += r[0].transcript : interim += r[0].transcript);
    $('#chatInput').value = final || interim;
    if (final.trim()) {
      stopListening();
      $('#chatInput').value = '';
      sendChat(final.trim());
    }
  };
  recog.onerror = () => stopListening();
  recog.onend = () => { if (listening) stopListening(); };
  try { recog.start(); } catch { stopListening(); }
}

function stopListening() {
  listening = false;
  const btn = $('#micBtn');
  btn.classList.remove('listening');
  btn.setAttribute('aria-pressed', 'false');
  $('#chatInput').placeholder = CHAT_HINTS[hintIdx];
  if (recog) { try { recog.stop(); } catch { /* already stopped */ } recog = null; }
}

/* pick a spoken language from the reply's script (rough, on purpose) */
function detectLangCode(text) {
  if (/[一-鿿]/.test(text)) return 'zh-CN';
  if (/[぀-ヿ]/.test(text)) return 'ja-JP';
  if (/[가-힯]/.test(text)) return 'ko-KR';
  if (/[؀-ۿ]/.test(text)) return 'ar';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru-RU';
  if (/[֐-׿]/.test(text)) return 'he-IL';
  if (/[ऀ-ॿ]/.test(text)) return 'hi-IN';
  if (/[¿¡]|\b(el|la|los|las|está|es|una|para|qué|carril)\b/i.test(text)) return 'es';
  if (/\b(le|les|est|une|vous|pour|voie|caméra)\b/i.test(text)) return 'fr';
  return '';
}

function speakReply(text) {
  if (!('speechSynthesis' in window) || !$('#ttsToggle').checked) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const lang = detectLangCode(text);
  if (lang) {
    u.lang = lang;
    const voice = speechSynthesis.getVoices()
      .find((v) => v.lang && v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    if (voice) u.voice = voice;
  }
  speechSynthesis.speak(u);
}

function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
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
for (const chip of document.querySelectorAll('.chip[data-borough]')) {
  chip.addEventListener('click', () => {
    state.borough = chip.dataset.borough;
    for (const c of document.querySelectorAll('.chip[data-borough]')) {
      c.setAttribute('aria-pressed', String(c === chip));
    }
    renderCameras();
    const view = BOROUGH_VIEWS[state.borough];
    if (map && view && state.pickView === 'map') {
      map.flyTo(view.center, view.zoom, { duration: 0.9 });
    }
  });
}
$('#mapViewBtn').addEventListener('click', () => setPickView('map'));
$('#listViewBtn').addEventListener('click', () => setPickView('list'));
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
$('#evidenceBtn').addEventListener('click', downloadEvidence);
$('#bikeLanesBtn').addEventListener('click', () => setBikeLanes(!bikeLanesOn));
$('#unlockBtn').addEventListener('click', clearLock);
for (const chip of document.querySelectorAll('.chip-suggest')) {
  chip.addEventListener('click', () => {
    if ($('#chatSend').disabled) return;
    sendChat(chip.textContent);
  });
}

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const msg = input.value.trim();
  if (!msg || $('#chatSend').disabled) return;
  input.value = '';
  sendChat(msg);
});

if (!SpeechRec) $('#micBtn').hidden = true;
if (!('speechSynthesis' in window)) $('#ttsWrap').hidden = true;
$('#micBtn').addEventListener('click', () => (listening ? stopListening() : startListening()));
$('#ttsToggle').addEventListener('change', (e) => { if (!e.target.checked) stopSpeech(); });

$('#traceBtn').addEventListener('click', () => {
  $('#traceDrawer').classList.contains('open') ? closeTrace() : openTrace();
});
$('#traceClose').addEventListener('click', closeTrace);
$('#traceRefresh').addEventListener('click', refreshTrace);
$('#traceDownload').addEventListener('click', downloadTrace);

loadCameras();

/* small hook for demos & debugging from the console */
window.CurbWatch = {
  state, selectCamera, enterWatch, onAnalysis, show,
  map: () => map, markers: () => mapMarkers,
};
