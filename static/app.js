const $ = (id) => document.getElementById(id);
const controllerFields = ['mac_id', 'device_id', 'device_name', 'mcu_id', 'firmware_id', 'boot_version', 'status', 'app_size', 'crc'];
let latestLogId = 0;
let logGeneration = null;
let connectedPort = '';
let expectedSuccessMessage = null;
const forceUpdatePasswordModal = $('force-update-password-modal');
const forceUpdatePasswordForm = $('force-update-password-form');

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

function showError(error) { window.showNotification(error.message || String(error)); }

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

function setButtonState(status) {
  connectedPort = status.port || '';
  if (connectedPort && [...$('port').options].some((option) => option.value === connectedPort)) {
    $('port').value = connectedPort;
  }
  $('connect').disabled = status.connected || status.busy;
  $('disconnect').disabled = !status.connected || status.busy;
  $('refresh').disabled = status.busy;
  $('read-info').disabled = !status.connected || status.busy;
  $('force-update').disabled = !status.connected || status.busy;
  $('start-update').disabled = !status.connected || status.busy;
}

async function refreshPorts() {
  const ports = await api('/api/ports');
  const select = $('port');
  const selectedPort = connectedPort || select.value;
  select.replaceChildren();
  if (!ports.length) {
    const option = new Option('No serial ports found', '');
    select.add(option);
    return;
  }
  ports.forEach((port) => select.add(new Option(`${port.device} — ${port.description || 'Serial device'}`, port.device)));
  if ([...select.options].some((option) => option.value === selectedPort)) select.value = selectedPort;
}

function addLogRow(output, entry) {
  const row = document.createElement('div');
  row.className = `log-entry ${entry.level || 'info'}`;
  const time = document.createElement('time'); time.textContent = entry.time;
  const text = document.createElement('span'); text.textContent = entry.message;
  row.append(time, text); output.append(row);
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
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
  if (output.querySelector('.muted')) output.replaceChildren();
  newLogs.forEach((entry) => addLogRow(output, entry));
  latestLogId = Number(newLogs.at(-1).id);
  while (output.children.length > 400) output.firstElementChild.remove();
  if (atBottom || newLogs.length) output.scrollTop = output.scrollHeight;
}

function renderStatus(data) {
  const { status, controller, firmware, logs, log_generation } = data;
  $('phase').textContent = status.phase;
  $('status-message').textContent = status.message;
  $('progress-label').textContent = `${status.progress}%`;
  $('progress-bar').style.width = `${status.progress}%`;
  const progressTrack = document.querySelector('.progress-track');
  progressTrack?.setAttribute('aria-valuenow', String(status.progress));
  $('progress-rocket').style.left = `${status.progress}%`;
  const progressCard = document.querySelector('.progress-card');
  progressCard?.classList.toggle('is-active', status.busy);
  progressCard?.classList.toggle('is-force-update', Boolean(status.force_update));
  const pill = $('connection-pill');
  pill.className = `connection-pill ${status.connected ? 'online' : 'offline'}`;
  pill.lastChild.textContent = status.connected ? 'Connected' : 'Disconnected';
  controllerFields.forEach((field) => { $(field).textContent = controller[field] || '—'; });
  const mcuId = controller.mcu_id || '—';
  const hasMcuId = mcuId.length === 34 && mcuId !== '*'.repeat(34);
  const mcuQr = $('controller-mcu-qr');
  const mcuQrImage = $('controller-mcu-qr-image');
  mcuQr.hidden = !hasMcuId;
  if (hasMcuId && mcuQrImage.dataset.mcuId !== mcuId) {
    mcuQrImage.dataset.mcuId = mcuId;
    mcuQrImage.src = `/api/mcu-id/qr?id=${encodeURIComponent(mcuId)}`;
  } else if (!hasMcuId) {
    delete mcuQrImage.dataset.mcuId;
    mcuQrImage.removeAttribute('src');
  }
  const dropZone = $('drop-zone');
  const clearFirmware = $('clear-firmware');
  dropZone.classList.toggle('firmware-loaded', Boolean(firmware));
  clearFirmware.hidden = !firmware;
  clearFirmware.disabled = !firmware || status.busy;
  $('file-info').textContent = firmware
    ? `${firmware.name} · ${Number(firmware.size).toLocaleString()} bytes · ${firmware.crc}`
    : 'No firmware image selected';
  setButtonState(status);
  if (expectedSuccessMessage && !status.busy) {
    if (status.message === expectedSuccessMessage) {
      window.showNotification(status.message, 'success');
      expectedSuccessMessage = null;
    } else if (status.phase === 'Error') {
      window.showNotification(status.message);
      expectedSuccessMessage = null;
    }
  }
  renderLogs(logs, log_generation);
}

async function pollStatus() {
  try { renderStatus(await api(`/api/status?after=${latestLogId}`)); } catch (_) { /* Server may be stopping. */ }
}

async function connect() {
  const port = $('port').value;
  if (!port) throw new Error('Select the Waveshare USB-CAN COM port first.');
  await api('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, bitrate: Number($('bitrate').value) }) });
  await pollStatus();
}

async function uploadFirmware(file = $('firmware-file').files[0]) {
  if (!file) throw new Error('Choose or drop a .bin firmware file first.');
  if (!file.name.toLowerCase().endsWith('.bin')) throw new Error('Only .bin firmware files are supported.');
  const body = new FormData(); body.append('firmware', file);
  await api('/api/firmware', { method: 'POST', body });
  await pollStatus();
}

function guarded(task) { return async (...args) => { try { await task(...args); } catch (error) { showError(error); } }; }

function openForceUpdatePassword() {
  $('force-update-password').value = '';
  forceUpdatePasswordModal.hidden = false;
  document.body.classList.add('password-modal-open');
  $('force-update-password').focus();
}

function closeForceUpdatePassword() {
  forceUpdatePasswordModal.hidden = true;
  document.body.classList.remove('password-modal-open');
  $('force-update').focus();
}

loadTheme();
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pic32mkUploaderTheme', next); applyTheme(next);
});
$('refresh').addEventListener('click', guarded(refreshPorts));
$('connect').addEventListener('click', guarded(connect));
$('disconnect').addEventListener('click', guarded(async () => { await api('/api/disconnect', { method: 'POST' }); await pollStatus(); }));
$('firmware-file').addEventListener('change', guarded(() => uploadFirmware()));
$('clear-firmware').addEventListener('click', guarded(async () => {
  await api('/api/firmware/clear', { method: 'POST' });
  $('firmware-file').value = '';
  await pollStatus();
}));

const dropZone = $('drop-zone');
['dragenter', 'dragover'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.add('drag-over');
  });
});
['dragleave', 'drop'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove('drag-over');
  });
});
dropZone.addEventListener('drop', guarded(async (event) => {
  const [file] = event.dataTransfer.files;
  await uploadFirmware(file);
}));
$('read-info').addEventListener('click', guarded(async () => {
  await api('/api/controller/read', { method: 'POST' });
  expectedSuccessMessage = 'Controller information updated';
  await pollStatus();
}));
$('clear-controller-info').addEventListener('click', guarded(async () => {
  await api('/api/controller/clear', { method: 'POST' });
  await pollStatus();
}));
$('start-update').addEventListener('click', guarded(async () => {
  await api('/api/update', { method: 'POST' });
  expectedSuccessMessage = 'Firmware update completed successfully';
  await pollStatus();
}));
$('force-update').addEventListener('click', openForceUpdatePassword);
$('close-force-update-password').addEventListener('click', closeForceUpdatePassword);
forceUpdatePasswordModal.addEventListener('click', (event) => { if (event.target === forceUpdatePasswordModal) closeForceUpdatePassword(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !forceUpdatePasswordModal.hidden) closeForceUpdatePassword(); });
document.querySelectorAll('[data-password-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.passwordToggle);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    button.dataset.tooltip = visible ? 'Hide password' : 'Show password';
  });
});
forceUpdatePasswordForm.addEventListener('submit', guarded(async (event) => {
  event.preventDefault();
  if (!forceUpdatePasswordForm.reportValidity()) return;
  const password = $('force-update-password').value;
  await api('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  closeForceUpdatePassword();
  window.showWarningConfirmation('Force update keeps the bootloader active while the controller is reset, then erases and programs the selected firmware.', guarded(async () => {
    await api('/api/force-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    expectedSuccessMessage = 'Force update completed successfully';
    await pollStatus();
  }));
}));
$('download-log').addEventListener('click', () => { window.location.assign('/api/logs/download'); });
$('clear-log').addEventListener('click', guarded(async () => { await api('/api/logs/clear', { method: 'POST' }); await pollStatus(); }));
document.querySelectorAll('[data-copy-source]').forEach((button) => {
  button.addEventListener('click', guarded(() => copyValue(button.dataset.copySource, button.dataset.copyLabel)));
});

refreshPorts().catch(() => {});
pollStatus();
setInterval(pollStatus, 700);
