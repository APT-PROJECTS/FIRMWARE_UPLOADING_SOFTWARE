const $ = (id) => document.getElementById(id);
const fields = [...document.querySelectorAll('#mcu-id-form input')];
const form = $('mcu-id-form');
const statusText = $('mcu-id-status');
const MCU_ID_CONFIGURATION_KEY = 'pic32mkMcuIdConfiguration';
const configurationForm = $('mcu-id-configuration-form');
const configurationModal = $('mcu-id-configuration-modal');
const configurationPasswordModal = $('mcu-id-configuration-password-modal');
const configurationPasswordForm = $('mcu-id-configuration-password-form');
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

function currentYearMonth() {
  const today = new Date();
  return `${String(today.getFullYear() % 100).padStart(2, '0')}${String(today.getMonth() + 1).padStart(2, '0')}`;
}

function getMcuIdConfiguration() {
  try {
    const value = JSON.parse(localStorage.getItem(MCU_ID_CONFIGURATION_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function applyMcuIdConfiguration() {
  const config = getMcuIdConfiguration();
  const modelTypeDefaults = { phases: '3', switch_type: 'M' };
  const values = {
    brand_name: config.brand_name || 'APT',
    model_type: ['phases', 'switches_in_parallel', 'switch_type', 'pcb_type'].map((name) => config[name] || modelTypeDefaults[name] || '').join(''),
    version_code: config.version_code || 'XXXX',
    application_type: ['sensor', 'ntc_resistor', 'ntc_volt', 'ntc_value_b'].map((name) => config[name] || '').join(''),
    ems: config.ems || 'XX',
    year_month: config.year_month || currentYearMonth(),
    batch_number: config.batch_number || 'XXXX',
  };
  Object.entries(values).forEach(([name, value]) => { form.elements[name].value = value; });
}

function populateConfigurationForm() {
  const config = getMcuIdConfiguration();
  [...configurationForm.elements].forEach((field) => {
    if (field.name) field.value = config[field.name] || '';
  });
  if (!configurationForm.elements.brand_name.value) configurationForm.elements.brand_name.value = 'APT';
  if (!configurationForm.elements.phases.value) configurationForm.elements.phases.value = '3';
  if (!configurationForm.elements.switch_type.value) configurationForm.elements.switch_type.value = 'M';
  if (!configurationForm.elements.version_code.value) configurationForm.elements.version_code.value = 'XXXX';
  if (!configurationForm.elements.ems.value) configurationForm.elements.ems.value = 'XX';
  if (!configurationForm.elements.year_month.value) configurationForm.elements.year_month.value = currentYearMonth();
  if (!configurationForm.elements.batch_number.value) configurationForm.elements.batch_number.value = 'XXXX';
}

function openConfiguration() {
  populateConfigurationForm();
  configurationModal.hidden = false;
  document.body.classList.add('configuration-modal-open');
  configurationForm.elements.brand_name.focus();
}

function openConfigurationPassword() {
  $('mcu-id-configuration-password').value = '';
  configurationPasswordModal.hidden = false;
  document.body.classList.add('password-modal-open');
  $('mcu-id-configuration-password').focus();
}

function closeConfigurationPassword() {
  configurationPasswordModal.hidden = true;
  document.body.classList.remove('password-modal-open');
  $('open-mcu-id-configuration').focus();
}

function closeConfiguration() {
  configurationModal.hidden = true;
  document.body.classList.remove('configuration-modal-open');
  $('open-mcu-id-configuration').focus();
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
$('open-mcu-id-configuration').addEventListener('click', openConfigurationPassword);
$('close-mcu-id-configuration').addEventListener('click', closeConfiguration);
configurationModal.addEventListener('click', (event) => {
  if (event.target === configurationModal) closeConfiguration();
});
$('close-mcu-id-configuration-password').addEventListener('click', closeConfigurationPassword);
configurationPasswordModal.addEventListener('click', (event) => {
  if (event.target === configurationPasswordModal) closeConfigurationPassword();
});
document.querySelectorAll('[data-password-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.passwordToggle);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    button.dataset.tooltip = visible ? 'Hide password' : 'Show password';
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !configurationModal.hidden) closeConfiguration();
  if (event.key === 'Escape' && !configurationPasswordModal.hidden) closeConfigurationPassword();
});
configurationPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!configurationPasswordForm.reportValidity()) return;
  try {
    await api('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('mcu-id-configuration-password').value }),
    });
    closeConfigurationPassword();
    openConfiguration();
  } catch (error) {
    window.showNotification(error.message || String(error));
  }
});
configurationForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!configurationForm.reportValidity()) return;
  const configuration = Object.fromEntries(new FormData(configurationForm).entries());
  Object.keys(configuration).forEach((key) => { configuration[key] = configuration[key].trim().toUpperCase(); });
  configuration.ntc_resistor = String(Number(configuration.ntc_resistor)).padStart(3, '0');
  localStorage.setItem(MCU_ID_CONFIGURATION_KEY, JSON.stringify(configuration));
  applyMcuIdConfiguration();
  updatePreview();
  closeConfiguration();
  window.showNotification('MCU ID configuration saved', 'success');
});
fields.forEach((input) => input.addEventListener('input', updatePreview));
$('clear-mcu-id-form').addEventListener('click', async () => {
  try {
    await api('/api/controller/clear', { method: 'POST' });
    form.reset();
    applyMcuIdConfiguration();
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
applyMcuIdConfiguration();
updatePreview();
refreshPorts().catch(() => {});
setInterval(() => { getStatus().catch(() => {}); }, 700);
getStatus().catch(() => {});
