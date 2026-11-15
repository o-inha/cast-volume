const HOST = 'jp.inha.cast_volume';
const SCAN_INTERVAL = 2500;
const REDISCOVER_INTERVAL = 12000;

const ui = Object.fromEntries(
  ['status', 'retry', 'receiver', 'device-name', 'devices', 'volume', 'value', 'detail']
    .map(id => [id, document.getElementById(id)])
);

let port;
let inFlight;
let pendingVolume;
let scanTimer;
let lastDiscovery = 0;
let receivers = [];
let selectedId = '';
let errorMessage = '';
let errorUntil = 0;

function selectedReceiver() {
  return receivers.find(receiver => receiver.id === selectedId);
}

function sameSession(a, b) {
  return a && b && a.id === b.id && a.session === b.session;
}

function showLevel(level) {
  ui.volume.value = level ?? 0;
  ui.volume.style.setProperty('--fill', `${level ?? 0}%`);
  ui.value.textContent = level == null ? '—' : `${level}%`;
}

function render() {
  const receiver = selectedReceiver();
  const choosing = receivers.length > 1;
  ui.receiver.hidden = !receivers.length;
  ui['device-name'].hidden = choosing;
  ui.devices.hidden = !choosing;
  if (choosing) {
    const options = [['', 'Choose a receiver'], ...receivers.map(({id, name}) => [id, name])];
    const currentOptions = Array.from(ui.devices.options, option => [option.value, option.text]);
    if (JSON.stringify(options) !== JSON.stringify(currentOptions)) {
      ui.devices.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
      ui.devices.options[0].disabled = true;
    }
    ui.devices.value = selectedId;
  } else {
    ui['device-name'].textContent = receiver?.name ?? '';
  }

  const level = sameSession(receiver, pendingVolume) ? pendingVolume.level
    : sameSession(receiver, inFlight?.volume) ? inFlight.volume.level
    : receiver?.muted ? 0 : receiver?.level;
  showLevel(level);
  ui.volume.disabled = !receiver?.adjustable;
  const detail = Date.now() < errorUntil ? errorMessage
    : receiver?.fixed ? 'This receiver reports fixed volume.'
    : receiver && !receiver.adjustable ? 'Volume is unavailable on this receiver.'
    : receiver?.muted ? 'Receiver is muted.' : '';
  ui.detail.textContent = detail;
  ui.detail.hidden = !detail;
}

function setStatus(message) {
  ui.status.textContent = message;
  ui.status.hidden = !message;
}

function send(message, volume) {
  window.clearTimeout(scanTimer);
  inFlight = {message, volume};
  ui.retry.disabled = true;
  port.postMessage(message);
}

function requestScan(discover = false) {
  if (inFlight) return;
  if (!port) connect();
  if (!port) return;
  discover ||= Date.now() - lastDiscovery >= REDISCOVER_INTERVAL;
  if (discover) lastDiscovery = Date.now();
  if (discover && !receivers.length) setStatus('Looking for active casts…');
  send({op: 'scan', discover});
}

function sendPendingVolume() {
  if (!port || inFlight || !pendingVolume) return false;
  const volume = pendingVolume;
  pendingVolume = null;
  const receiver = selectedReceiver();
  if (!sameSession(receiver, volume) || !receiver.adjustable) return false;
  const current = receiver.muted ? 0 : receiver.level;
  if (volume.level === current) return false;
  send({op: 'volume', id: volume.id, session: volume.session, level: volume.level}, volume);
  return true;
}

function receive(message) {
  const request = inFlight;
  inFlight = null;
  ui.retry.disabled = false;
  if (!request) return;

  if (message.ok && request.message.op === 'scan') {
    receivers = message.receivers;
    if (receivers.length === 1) selectedId = receivers[0].id;
    else if (!selectedReceiver()) selectedId = '';
    setStatus(receivers.length ? '' : message.found
      ? 'No active cast found.' : 'No Cast receivers found on this network.');
  } else if (message.ok) {
    receivers = receivers.map(receiver => sameSession(receiver, request.volume)
      ? message.receiver : receiver);
    errorMessage = '';
    errorUntil = 0;
  } else if (request.message.op === 'scan') {
    receivers = [];
    selectedId = '';
    setStatus(message.error);
  } else {
    pendingVolume = null;
    errorMessage = message.error;
    errorUntil = Date.now() + 4200;
  }

  render();
  if (sendPendingVolume()) return;
  scanTimer = window.setTimeout(requestScan, message.ok ? SCAN_INTERVAL : 850);
}

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? '';
    port = null;
    inFlight = null;
    pendingVolume = null;
    receivers = [];
    selectedId = '';
    errorUntil = 0;
    window.clearTimeout(scanTimer);
    ui.retry.disabled = false;
    setStatus(error.includes('not found') || error.includes('forbidden')
      ? 'Install the Cast Volume helper, then refresh.'
      : 'The Cast Volume helper disconnected. Try refreshing.');
    render();
  });
}

ui.retry.addEventListener('click', () => requestScan(true));
ui.devices.addEventListener('change', () => {
  selectedId = ui.devices.value;
  pendingVolume = null;
  errorUntil = 0;
  render();
});
ui.volume.addEventListener('input', () => {
  const receiver = selectedReceiver();
  if (!receiver?.adjustable) return;
  pendingVolume = {id: receiver.id, session: receiver.session, level: ui.volume.valueAsNumber};
  errorUntil = 0;
  render();
  sendPendingVolume();
});

requestScan(true);
