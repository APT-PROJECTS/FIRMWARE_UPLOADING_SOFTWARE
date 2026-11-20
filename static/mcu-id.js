const $ = (id) => document.getElementById(id);
const fields = [...document.querySelectorAll('#mcu-id-form input')];
const form = $('mcu-id-form');
const statusText = $('mcu-id-status');
let latestLogId = 0;
let logGeneration = null;
let connectedPort = '';
let operationBusy = false;
let mcuIdLocked = false;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').textContent = theme === 'dark' ? '☼' : '◐';
}

function loadTheme() {
  const stored = localStorage.getItem('pic32mkUploaderTheme');
  applyTheme(stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function copyValue(sourceId, label) {
  const value = $(sourceId).textContent.trim();
  if (!value || value === '—') throw new Error(`No ${label} is available to copy`);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  } else {
    const temporary = document.createElement('textarea');
    temporary.value = value;
    document.body.append(temporary);
    temporary.select();
    document.execCommand('copy');
    temporary.remove();
  }
  window.showNotification(`${label} copied`, 'success');
}

function updatePreview() {
  const value = fields.map((input) => input.value).join('');
  $('mcu-id-preview').textContent = value || '—';
}

function setCurrentYearMonth() {
  const field = form.elements.year_month;
  if (field.value) return;
  const today = new Date();
  field.value = `${String(today.getFullYear() % 100).padStart(2, '0')}${String(today.getMonth() + 1).padStart(2, '0')}`;
}

function setDefaultBrandName() {
  const field = form.elements.brand_name;
  if (!field.value) field.value = 'APT';
}

function renderConnection(status) {
  connectedPort = status.port || '';
  if (connectedPort && [...$('port').options].some((option) => option.value === connectedPort)) {
    $('port').value = connectedPort;
  }
  const pill = $('connection-pill');
  pill.className = `connection-pill ${status.connected ? 'online' : 'offline'}`;
  pill.lastChild.textContent = status.connected ? 'Connected' : 'Disconnected';
  $('connect').disabled = status.connected || status.busy;
  $('disconnect').disabled = !status.connected || status.busy;
  $('refresh').disabled = status.busy;
}

function isStoredMcuId(value) {
  return typeof value === 'string' && value.length === 34 && value !== '*'.repeat(34);
}

function updateMcuIdFormLock(value) {
  mcuIdLocked = isStoredMcuId(value);
  fields.forEach((input) => { input.disabled = operationBusy || mcuIdLocked; });
  $('flash-mcu-id').disabled = operationBusy || mcuIdLocked;
  const qr = $('controller-mcu-qr');
  qr.hidden = !mcuIdLocked;
  if (mcuIdLocked) $('mcu-id-qr-image').src = `/api/mcu-id/qr?id=${encodeURIComponent(value)}`;
}

function setBusy(busy) {
  operationBusy = busy;
  updateMcuIdFormLock($('controller-mcu-id').textContent);
  $('read-mcu-id').disabled = busy;
}

function addLogRow(output, entry) {
  const row = document.createElement('div');
  row.className = `log-entry ${entry.level || 'info'}`;
  const time = document.createElement('time');
  time.textContent = entry.time;
  const text = document.createElement('span');
  text.textContent = entry.message;
  row.append(time, text);
  output.append(row);
}

function renderLogs(logs, generation) {
  const output = $('log-output');
  if (logGeneration !== generation) {
    logGeneration = generation;
    latestLogId = 0;
    output.replaceChildren();
  }
  const newLogs = logs.filter((entry) => Number(entry.id) > latestLogId);
  if (!newLogs.length) {
    if (!output.children.length) output.replaceChildren(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Waiting for bootloader activity…' }));
    return;
  }
  if (output.querySelector('.muted')) output.replaceChildren();
  newLogs.forEach((entry) => addLogRow(output, entry));
  latestLogId = Number(newLogs.at(-1).id);
  while (output.children.length > 400) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
}

async function getStatus() {
  const data = await api(`/api/status?after=${latestLogId}`);
  renderLogs(data.logs, data.log_generation);
  renderConnection(data.status);
  const controllerMcuId = data.controller.mcu_id || '—';
  $('controller-mcu-id').textContent = controllerMcuId;
  updateMcuIdFormLock(controllerMcuId);
  $('controller-firmware-id').textContent = data.controller.firmware_id || '—';
  return data.status;
}

async function refreshPorts() {
  const ports = await api('/api/ports');
  const select = $('port');
  const selectedPort = connectedPort || select.value;
  select.replaceChildren();
  if (!ports.length) {
    select.add(new Option('No serial ports found', ''));
    return;
  }
  ports.forEach((port) => select.add(new Option(`${port.device} — ${port.description || 'Serial device'}`, port.device)));
  if ([...select.options].some((option) => option.value === selectedPort)) select.value = selectedPort;
}

async function connect() {
  const port = $('port').value;
  if (!port) throw new Error('Select the Waveshare USB-CAN COM port first.');
  await api('/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port, bitrate: Number($('bitrate').value) }),
  });
  await getStatus();
}

async function waitForCompletion() {
  while (true) {
    const status = await getStatus();
    statusText.textContent = status.message;
    if (!status.busy) {
      if (status.phase === 'Error') throw new Error(status.message);
      window.showNotification(status.message, 'success');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

loadTheme();
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pic32mkUploaderTheme', next);
  applyTheme(next);
});
fields.forEach((input) => input.addEventListener('input', updatePreview));
$('clear-mcu-id-form').addEventListener('click', async () => {
  try {
    await api('/api/controller/clear', { method: 'POST' });
    form.reset();
    setDefaultBrandName();
    setCurrentYearMonth();
    updatePreview();
    statusText.textContent = '';
    $('controller-mcu-qr').hidden = true;
    $('mcu-id-qr-image').removeAttribute('src');
    await getStatus();
  } catch (error) {
    window.showNotification(error.message || String(error));
  }
});
$('refresh').addEventListener('click', () => { refreshPorts().catch((error) => window.showNotification(error.message || String(error))); });
$('connect').addEventListener('click', () => { connect().catch((error) => window.showNotification(error.message || String(error))); });
$('disconnect').addEventListener('click', () => {
  api('/api/disconnect', { method: 'POST' })
    .then(getStatus)
    .catch((error) => window.showNotification(error.message || String(error)));
});
$('download-log').addEventListener('click', () => { window.location.assign('/api/logs/download'); });
$('clear-log').addEventListener('click', async () => {
  try {
    await api('/api/logs/clear', { method: 'POST' });
    await getStatus();
  } catch (error) {
    window.showNotification(error.message || String(error));
  }
});
document.querySelectorAll('[data-copy-source]').forEach((button) => {
  button.addEventListener('click', () => {
    copyValue(button.dataset.copySource, button.dataset.copyLabel)
      .catch((error) => window.showNotification(error.message || String(error)));
  });
});
$('read-mcu-id').addEventListener('click', async () => {
  try {
    setBusy(true);
    statusText.textContent = 'Reading MCU ID and Firmware ID…';
    await api('/api/mcu-id/read', { method: 'POST' });
    await waitForCompletion();
  } catch (error) {
    statusText.textContent = error.message || String(error);
    window.showNotification(error.message || String(error));
  } finally {
    setBusy(false);
  }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    setBusy(true);
    statusText.textContent = 'Reading controller metadata…';
    await api('/api/mcu-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await waitForCompletion();
  } catch (error) {
    statusText.textContent = error.message || String(error);
    window.showNotification(error.message || String(error));
  } finally {
    setBusy(false);
  }
});
setDefaultBrandName();
setCurrentYearMonth();
updatePreview();
refreshPorts().catch(() => {});
setInterval(() => { getStatus().catch(() => {}); }, 700);
getStatus().catch(() => {});
