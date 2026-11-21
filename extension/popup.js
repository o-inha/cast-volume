const HOST = 'jp.inha.cast_volume';
const SCAN_INTERVAL = 2500;
const REDISCOVER_INTERVAL = 12000;
const RETRY_INTERVAL = 850;
const DEMO_MODE = new URLSearchParams(location.search).get('demo') === '1';
const ORDER_KEY = DEMO_MODE ? 'demoReceiverOrder' : 'receiverOrder';

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
let receiverOrder = [];
let reorderDrag = null;
let deferredOrder = null;
let orderWrite = Promise.resolve();

function cleanOrder(value) {
  return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : [];
}

function visibleOrder() {
  return Array.from(ui.receivers.children, element => element.dataset.receiverId);
}

function moveRow(element, before) {
  // moveBefore preserves focus and pointer state on current Chrome versions.
  if (ui.receivers.moveBefore) ui.receivers.moveBefore(element, before);
  else {
    const focused = document.activeElement;
    ui.receivers.insertBefore(element, before);
    if (element.contains(focused)) focused.focus({preventScroll: true});
  }
}

function applyOrder() {
  if (reorderDrag) return;
  const positions = new Map(receiverOrder.map((id, index) => [id, index]));
  const ordered = [...rows.values()].sort((a, b) =>
    (positions.get(a.receiver.id) ?? Infinity) - (positions.get(b.receiver.id) ?? Infinity));
  ordered.forEach((row, index) => {
    if (ui.receivers.children[index] !== row.element) {
      moveRow(row.element, ui.receivers.children[index] ?? null);
    }
  });
}

function saveOrder() {
  const visible = visibleOrder();
  const active = new Set(visible);
  let index = 0;
  // Keep inactive receivers in their saved slots until they return.
  receiverOrder = receiverOrder.map(id => active.has(id) ? visible[index++] : id)
    .concat(visible.slice(index));
  const saved = receiverOrder.slice();
  orderWrite = orderWrite.then(() => chrome.storage.local.set({[ORDER_KEY]: saved})).catch(error => {
    console.warn('Could not save receiver order.', error);
    showStatus(ui.status, 'Could not save the receiver order. Try moving an item again.');
  });
}

function beginReorder(row, event) {
  if (event.button !== 0 || reorderDrag) return;
  event.preventDefault();
  reorderDrag = {
    row, pointerId: event.pointerId, startY: event.clientY, moved: false, order: visibleOrder(),
  };
  // Capture on the list so moving a receiver row keeps the pointer captured.
  ui.receivers.setPointerCapture(event.pointerId);
}

function moveReorder(event) {
  const drag = reorderDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return;
  drag.moved = true;
  event.preventDefault();
  ui.receivers.classList.add('is-reordering');
  drag.row.element.classList.add('is-dragging');
  const before = Array.from(ui.receivers.children).find(element => {
    if (element === drag.row.element) return false;
    const bounds = element.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2;
  }) ?? null;
  if (drag.row.element.nextElementSibling !== before) moveRow(drag.row.element, before);
  // Keep the last items reachable when the receiver list scrolls.
  if (event.clientY < 28) window.scrollBy(0, -12);
  else if (event.clientY > window.innerHeight - 28) window.scrollBy(0, 12);
}

function finishReorder(cancelled = false, pointerId) {
  const drag = reorderDrag;
  if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return;
  reorderDrag = null;
  ui.receivers.classList.remove('is-reordering');
  drag.row.element.classList.remove('is-dragging');
  if (ui.receivers.hasPointerCapture(drag.pointerId)) ui.receivers.releasePointerCapture(drag.pointerId);
  if (deferredOrder) {
    receiverOrder = deferredOrder;
    deferredOrder = null;
  }
  const changed = !cancelled && drag.moved && visibleOrder().join('\n') !== drag.order.join('\n');
  if (changed) saveOrder();
  applyOrder();
}

function reorderWithKeys(row, event) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  if (reorderDrag) return;
  const element = row.element;
  if (event.key === 'ArrowUp') {
    if (!element.previousElementSibling) return;
    moveRow(element, element.previousElementSibling);
  } else {
    const next = element.nextElementSibling;
    if (!next) return;
    moveRow(element, next.nextElementSibling);
  }
  saveOrder();
}

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
    deviceIcon: element.querySelector('.device-icon'),
    groupIcon: element.querySelector('.group-icon'),
    handle: element.querySelector('.drag-handle'),
    slider: element.querySelector('input'),
    value: element.querySelector('.volume-value'),
    detail: element.querySelector('.detail'),
    drag: null,
    error: '',
  };
  rows.set(receiver.id, row);
  element.dataset.receiverId = receiver.id;
  ui.receivers.append(element);
  row.handle.addEventListener('pointerdown', event => beginReorder(row, event));
  row.handle.addEventListener('keydown', event => reorderWithKeys(row, event));

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
  row.deviceIcon.toggleAttribute('hidden', receiver.isGroup === true);
  row.groupIcon.toggleAttribute('hidden', receiver.isGroup !== true);
  row.name.title = receiver.isGroup ? 'Speaker group' : 'Cast device';
  row.handle.setAttribute('aria-label', `Reorder ${receiver.name}`);
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
  if (reorderDrag && !active.has(reorderDrag.row.receiver.id)) finishReorder(true);
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
  applyOrder();
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
  if (DEMO_MODE) {
    port = createDemoPort();
    return;
  }
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

function createDemoPort() {
  const receivers = [
    {id: 'demo-tv', name: 'Living Room TV', level: 38},
    {id: 'demo-kitchen', name: 'Kitchen Speaker', level: 24},
    {id: 'demo-bedroom', name: 'Bedroom Speaker', level: 45},
    {id: 'demo-downstairs', name: 'Downstairs Speakers', level: 52, isGroup: true},
    {id: 'demo-home', name: 'Whole Home', level: 30, isGroup: true},
  ].map(receiver => ({
    session: receiver.id, muted: false, fixed: false, adjustable: true, isGroup: false, ...receiver,
  }));
  return {
    postMessage(message) {
      window.setTimeout(() => {
        if (message.op === 'scan') {
          receive({ok: true, found: receivers.length, receivers: receivers.map(receiver => ({...receiver}))});
          return;
        }
        const receiver = receivers.find(item => item.id === message.id && item.session === message.session);
        if (!receiver) {
          receive({ok: false, error: 'Demo receiver unavailable.'});
          return;
        }
        receiver.level = message.level;
        receive({ok: true, receiver: {...receiver}});
      }, 80);
    },
  };
}

if (DEMO_MODE) {
  document.querySelector('h1').textContent = 'Cast volume demo';
  ui.retry.setAttribute('aria-label', 'Refresh demo devices');
}
ui.retry.title = DEMO_MODE
  ? 'Refresh demo devices. Shift-click to return to real casts.'
  : 'Refresh receivers. Shift-click to try demo devices.';
ui.retry.addEventListener('click', event => {
  if (event.shiftKey) {
    const url = new URL(location.href);
    if (DEMO_MODE) url.searchParams.delete('demo');
    else url.searchParams.set('demo', '1');
    location.href = url.href;
    return;
  }
  requestScan(true);
});
window.addEventListener('pointerup', event => finishDrag(event.pointerId));
window.addEventListener('pointercancel', event => finishDrag(event.pointerId));
window.addEventListener('blur', () => finishDrag());
window.addEventListener('pointermove', moveReorder);
window.addEventListener('pointerup', event => finishReorder(false, event.pointerId));
window.addEventListener('pointercancel', event => finishReorder(true, event.pointerId));
window.addEventListener('blur', () => finishReorder(true));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') finishReorder(true);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[ORDER_KEY]) return;
  const nextOrder = cleanOrder(changes[ORDER_KEY].newValue);
  if (reorderDrag) deferredOrder = nextOrder;
  else {
    receiverOrder = nextOrder;
    applyOrder();
  }
});
chrome.storage.local.get(ORDER_KEY).then(saved => {
  receiverOrder = cleanOrder(saved[ORDER_KEY]);
}).catch(error => {
  console.warn('Could not read receiver order.', error);
}).finally(() => requestScan(true));
