const HOST = 'jp.inha.cast_volume';
const SCAN_INTERVAL = 2500;
const REDISCOVER_INTERVAL = 12000;
const RETRY_INTERVAL = 850;

const ui = {
  status: document.getElementById('status'),
  retry: document.getElementById('retry'),
  receivers: document.getElementById('receivers'),
  receiverTemplate: document.getElementById('receiver-template'),
};

const rows = new Map();
const pendingVolumes = new Map();
let port;
let inFlight;
let pendingScan = null;
let scanTimer;
let lastDiscovery = 0;

function sameSession(a, b) {
  return a && b && a.id === b.id && a.session === b.session;
}

function currentLevel(receiver) {
  return receiver.muted ? 0 : receiver.level;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function showStatus(element, text) {
  setText(element, text);
  element.hidden = !text;
}

function createRow(receiver) {
  const element = ui.receiverTemplate.content.firstElementChild.cloneNode(true);
  const row = {
    receiver,
    element,
    name: element.querySelector('.device-name'),
    slider: element.querySelector('input'),
    value: element.querySelector('.volume-value'),
    detail: element.querySelector('.detail'),
    drag: null,
    error: '',
  };
  rows.set(receiver.id, row);
  ui.receivers.append(element);

  row.slider.addEventListener('pointerdown', event => {
    if (row.slider.disabled || event.button !== 0) return;
    row.drag = {
      pointerId: event.pointerId,
      session: row.receiver.session,
      level: row.slider.valueAsNumber,
    };
  });
  row.slider.addEventListener('input', () => changeVolume(row));
  return row;
}

function renderRow(row) {
  const {receiver, slider} = row;
  const pending = pendingVolumes.get(receiver.id);
  let level = currentLevel(receiver);
  if (receiver.adjustable) {
    if (inFlight?.op === 'volume' && sameSession(receiver, inFlight)) level = inFlight.level;
    if (sameSession(receiver, pending)) level = pending.level;
    if (row.drag?.session === receiver.session) level = row.drag.level;
  }

  setText(row.name, receiver.name);
  slider.setAttribute('aria-label', `Volume for ${receiver.name}`);
  slider.disabled = !receiver.adjustable;
  if (slider.valueAsNumber !== (level ?? 0)) slider.value = level ?? 0;
  slider.style.setProperty('--fill', `${level ?? 0}%`);
  slider.setAttribute('aria-valuetext', level == null ? 'Unavailable' : `${level}%`);
  setText(row.value, level == null ? '—' : `${level}%`);

  let detail = row.error;
  if (!detail && receiver.fixed) detail = 'This receiver reports fixed volume.';
  if (!detail && !receiver.adjustable) detail = 'Volume is unavailable on this receiver.';
  if (!detail && receiver.muted) detail = 'Receiver is muted.';
  showStatus(row.detail, detail);
}

function syncRows(receivers) {
  const active = new Set(receivers.map(receiver => receiver.id));
  for (const [id, row] of rows) {
    if (active.has(id)) continue;
    row.element.remove();
    rows.delete(id);
    pendingVolumes.delete(id);
  }
  for (const receiver of receivers) {
    const row = rows.get(receiver.id) ?? createRow(receiver);
    if (!sameSession(row.receiver, receiver)) {
      pendingVolumes.delete(receiver.id);
      row.error = '';
    }
    row.receiver = receiver;
    renderRow(row);
  }
  ui.receivers.hidden = !rows.size;
}

function changeVolume(row) {
  const {receiver, drag, slider} = row;
  if (!receiver.adjustable || (drag && drag.session !== receiver.session)) {
    renderRow(row);
    return;
  }
  const level = slider.valueAsNumber;
  if (drag) drag.level = level;
  row.error = '';
  pendingVolumes.set(receiver.id, {op: 'volume', id: receiver.id, session: receiver.session, level});
  renderRow(row);
  sendNext();
}

function finishDrag(pointerId) {
  for (const row of rows.values()) {
    if (!row.drag || (pointerId != null && row.drag.pointerId !== pointerId)) continue;
    row.drag = null;
    renderRow(row);
  }
}

function send(message) {
  inFlight = message;
  ui.retry.disabled = true;
  try {
    port.postMessage(message);
  } catch (error) {
    disconnect(error.message);
  }
}

function sendNext() {
  if (inFlight || !port) return;
  if (pendingScan != null) {
    const discover = pendingScan || Date.now() - lastDiscovery >= REDISCOVER_INTERVAL;
    pendingScan = null;
    if (discover) lastDiscovery = Date.now();
    window.clearTimeout(scanTimer);
    if (discover && !rows.size) showStatus(ui.status, 'Looking for active casts…');
    send({op: 'scan', discover});
    return;
  }
  for (const [id, volume] of pendingVolumes) {
    pendingVolumes.delete(id);
    const receiver = rows.get(id)?.receiver;
    if (!sameSession(receiver, volume) || !receiver.adjustable || volume.level === currentLevel(receiver)) continue;
    send(volume);
    return;
  }
}

function requestScan(discover = false) {
  pendingScan = discover || pendingScan === true;
  if (!port) connect();
  sendNext();
}

function scheduleScan(delay) {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(requestScan, delay);
}

function receive(message) {
  const request = inFlight;
  inFlight = null;
  ui.retry.disabled = false;
  if (!request) return;

  if (request.op === 'scan') {
    syncRows(message.ok ? message.receivers : []);
    if (!message.ok) showStatus(ui.status, message.error || 'Could not refresh Cast receivers.');
    else if (rows.size) showStatus(ui.status, '');
    else showStatus(ui.status, message.found ? 'No active cast found.' : 'No Cast receivers found on this network.');
    scheduleScan(message.ok ? SCAN_INTERVAL : RETRY_INTERVAL);
  } else {
    const row = rows.get(request.id);
    if (row && message.ok && sameSession(request, message.receiver)) {
      row.receiver = message.receiver;
      row.error = '';
      renderRow(row);
    } else {
      pendingVolumes.delete(request.id);
      const error = message.error || 'Could not change the volume. The Cast session may have changed.';
      if (row) {
        row.error = error;
        renderRow(row);
      } else showStatus(ui.status, error);
      scheduleScan(RETRY_INTERVAL);
    }
  }
  sendNext();
}

function disconnect(error) {
  port = null;
  inFlight = null;
  pendingScan = null;
  pendingVolumes.clear();
  window.clearTimeout(scanTimer);
  ui.retry.disabled = false;
  syncRows([]);
  showStatus(ui.status, error.includes('not found') || error.includes('forbidden')
    ? 'Install the Cast Volume helper, then refresh.'
    : 'The Cast Volume helper disconnected. Try refreshing.');
}

function connect() {
  try {
    const connection = chrome.runtime.connectNative(HOST);
    port = connection;
    connection.onMessage.addListener(receive);
    connection.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message ?? '';
      if (port === connection) disconnect(error);
    });
  } catch (error) {
    disconnect(error.message);
  }
}

ui.retry.addEventListener('click', () => requestScan(true));
window.addEventListener('pointerup', event => finishDrag(event.pointerId));
window.addEventListener('pointercancel', event => finishDrag(event.pointerId));
window.addEventListener('blur', () => finishDrag());
requestScan(true);
