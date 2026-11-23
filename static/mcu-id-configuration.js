const configurationForm = document.getElementById('mcu-id-configuration-form');
const configurationKey = 'pic32mkMcuIdConfiguration';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☼' : '◐';
}

function currentYearMonth() {
  const today = new Date();
  return `${String(today.getFullYear() % 100).padStart(2, '0')}${String(today.getMonth() + 1).padStart(2, '0')}`;
}

function readConfiguration() {
  try {
    const value = JSON.parse(localStorage.getItem(configurationKey) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function loadConfiguration() {
  const configuration = readConfiguration();
  [...configurationForm.elements].forEach((field) => {
    if (!field.name) return;
    field.value = configuration[field.name] || '';
  });
  if (!configurationForm.elements.brand_name.value) configurationForm.elements.brand_name.value = 'APT';
  if (!configurationForm.elements.year_month.value) configurationForm.elements.year_month.value = currentYearMonth();
}

applyTheme(localStorage.getItem('pic32mkUploaderTheme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pic32mkUploaderTheme', next);
  applyTheme(next);
});
configurationForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!configurationForm.reportValidity()) return;
  const configuration = Object.fromEntries(new FormData(configurationForm).entries());
  Object.keys(configuration).forEach((key) => { configuration[key] = configuration[key].trim().toUpperCase(); });
  localStorage.setItem(configurationKey, JSON.stringify(configuration));
  window.showNotification('MCU ID configuration saved', 'success');
});
loadConfiguration();
