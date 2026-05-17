document.addEventListener('DOMContentLoaded', () => {
  const navItems = document.querySelectorAll('.nav-item');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const overlayBar = document.getElementById('overlayBar');
  const toolbar = document.getElementById('toolbar');
  const welcomeScreen = document.getElementById('welcomeScreen');
  const urlDisplay = document.getElementById('urlDisplay');
  const serviceName = document.getElementById('serviceName');
  const backBtn = document.getElementById('backBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const reloadBtn = document.getElementById('reloadBtn');

  const providerNames = {
    netflix: 'Netflix',
    youtube: 'YouTube',
    disney: 'Disney+',
    prime: 'Prime Video',
    twitch: 'Twitch',
    spotify: 'Spotify'
  };

  navItems.forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      welcomeScreen.style.display = 'none';
      urlDisplay.textContent = item.dataset.url;
      serviceName.textContent = providerNames[item.dataset.provider] || '';
      window.electronAPI.navigate(item.dataset.url, item.dataset.provider);
    });
  });

  let isFullscreen = false;

  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    overlayBar.classList.toggle('compact', isFullscreen);
    toolbar.classList.toggle('compact', isFullscreen);
    welcomeScreen.classList.toggle('compact', isFullscreen);
    fullscreenBtn.classList.toggle('active', isFullscreen);
    window.electronAPI.toggleFullscreen(isFullscreen);
  }

  fullscreenBtn.addEventListener('click', toggleFullscreen);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen) {
      toggleFullscreen();
    }
  });

  window.electronAPI.onFullscreenState((state) => {
    isFullscreen = state;
    overlayBar.classList.toggle('compact', isFullscreen);
    toolbar.classList.toggle('compact', isFullscreen);
    welcomeScreen.classList.toggle('compact', isFullscreen);
    fullscreenBtn.classList.toggle('active', isFullscreen);
  });

  backBtn.addEventListener('click', () => window.electronAPI.goBack());
  forwardBtn.addEventListener('click', () => window.electronAPI.goForward());
  reloadBtn.addEventListener('click', () => window.electronAPI.reload());
});
