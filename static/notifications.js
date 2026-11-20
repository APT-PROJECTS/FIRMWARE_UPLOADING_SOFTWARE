window.showNotification = (message, type = 'warning') => {
  let region = document.getElementById('notification-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'notification-region';
    region.className = 'notification-region';
    region.setAttribute('aria-live', 'assertive');
    document.body.append(region);
  }

  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.setAttribute('role', 'alert');
  const icon = document.createElement('span');
  icon.className = 'notification-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = type === 'success' ? '✓' : '⚠';
  const text = document.createElement('span');
  text.className = 'notification-message';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notification-close';
  close.setAttribute('aria-label', 'Dismiss warning');
  close.textContent = '×';
  const dismiss = () => notification.remove();
  close.addEventListener('click', dismiss);
  notification.append(icon, text, close);
  region.append(notification);
  window.setTimeout(dismiss, 5000);
};

window.showWarningConfirmation = (message, onConfirm) => {
  let region = document.getElementById('notification-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'notification-region';
    region.className = 'notification-region';
    region.setAttribute('aria-live', 'assertive');
    document.body.append(region);
  }
  region.querySelectorAll('.notification.confirmation').forEach((item) => item.remove());

  const notification = document.createElement('div');
  notification.className = 'notification warning confirmation';
  notification.setAttribute('role', 'alert');
  const icon = document.createElement('span');
  icon.className = 'notification-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '⚠';
  const text = document.createElement('span');
  text.className = 'notification-message';
  text.textContent = message;
  const proceed = document.createElement('button');
  proceed.type = 'button';
  proceed.className = 'notification-action';
  proceed.textContent = 'Continue';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notification-close';
  close.setAttribute('aria-label', 'Cancel force update');
  close.textContent = '×';
  const dismiss = () => notification.remove();
  close.addEventListener('click', dismiss);
  proceed.addEventListener('click', () => {
    dismiss();
    onConfirm();
  });
  notification.append(icon, text, proceed, close);
  region.append(notification);
  window.setTimeout(dismiss, 5000);
};
