// Update controls, shown only inside the desktop app (where preload.cjs provides window.desktop).
const desktop = window.desktop;

const banner = document.getElementById('update-banner');
const bannerText = document.getElementById('update-banner-text');
const section = document.getElementById('updates-section');
const statusText = document.getElementById('update-status');
const checkButton = document.getElementById('update-check');

let dismissedVersion = null;

function describe(state) {
  const current = `Version ${state.version}`;
  switch (state.status) {
    case 'dev': return `${current} (development; updates work in the installed app)`;
    case 'checking': return `${current} · checking for updates…`;
    case 'up-to-date': return `${current} · up to date`;
    case 'downloading': return `${current} · downloading ${state.available}${state.percent ? ` (${state.percent}%)` : ''}…`;
    case 'downloaded': return `${current} · version ${state.available} is ready, restart to install`;
    case 'error': return `${current} · couldn’t check for updates (${state.message})`;
    default: return current;
  }
}

function render(state) {
  statusText.textContent = describe(state);
  statusText.classList.toggle('error', state.status === 'error');
  checkButton.disabled = ['dev', 'checking', 'downloading'].includes(state.status);
  checkButton.textContent = state.status === 'downloaded' ? 'Restart to update' : 'Check for updates';
  const showBanner = state.status === 'downloaded' && dismissedVersion !== state.available;
  banner.hidden = !showBanner;
  if (showBanner) bannerText.textContent = `Word Collector ${state.available} is ready to install.`;
}

if (desktop) {
  section.hidden = false;
  let latest = await desktop.getUpdateState();
  render(latest);
  desktop.onUpdateState((state) => { latest = state; render(state); });

  checkButton.addEventListener('click', async () => {
    if (latest.status === 'downloaded') return desktop.installUpdate();
    render({ ...latest, status: 'checking' });
    render(await desktop.checkForUpdates());
  });
  document.getElementById('update-restart').addEventListener('click', () => desktop.installUpdate());
  document.getElementById('update-later').addEventListener('click', () => {
    dismissedVersion = latest.available;
    render(latest);
  });
}
