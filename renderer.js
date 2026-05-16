document.addEventListener('DOMContentLoaded', () => {
  const navItems = document.querySelectorAll('.nav-item');
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const welcomeScreen = document.getElementById('welcomeScreen');
  const urlDisplay = document.getElementById('urlDisplay');
  const serviceName = document.getElementById('serviceName');
  const backBtn = document.getElementById('backBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const reloadBtn = document.getElementById('reloadBtn');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      welcomeScreen.style.display = 'none';
      urlDisplay.textContent = item.dataset.url;
      serviceName.textContent = item.querySelector('.nav-label').textContent;
      window.electronAPI.navigate(item.dataset.url);
    });
  });

  sidebarToggle.addEventListener('click', () => {
    window.electronAPI.toggleSidebar();
  });

  window.electronAPI.onSidebarState((collapsed) => {
    sidebar.classList.toggle('collapsed', collapsed);
  });

  backBtn.addEventListener('click', () => window.electronAPI.goBack());
  forwardBtn.addEventListener('click', () => window.electronAPI.goForward());
  reloadBtn.addEventListener('click', () => window.electronAPI.reload());
});
