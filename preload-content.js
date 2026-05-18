const { contextBridge, ipcRenderer } = require('electron');

const script = document.createElement('script');
script.textContent = `
Object.defineProperty(navigator, 'webdriver', { value: undefined });
if (!window.chrome) {
  window.chrome = {
    runtime: { id: '' },
    loadTimes: () => ({
      requestTime: 0, startLoadTime: 0, commitLoadTime: 0,
      finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0,
      firstPaintAfterLoadTime: 0, navigationType: 'other',
      wasFetchedViaSpdy: true, wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
      connectionInfo: 'http/2',
    }),
    csi: () => ({ startE: 0, onloadT: 0, pageT: Date.now(), tran: 15 }),
    app: { isInstalled: false },
  };
}
`;
document.documentElement.appendChild(script);

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
});
