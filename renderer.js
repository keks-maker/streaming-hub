if (altKey && key === 'ArrowLeft') {
  // Zuerst die echte Browser-Historie der aktuell geöffneten Seite verwenden.
  // Dadurch bleiben Scrollposition, SPA-Zustand und der bisherige Seitenzustand
  // erhalten, statt die URL über loadURL() neu zu laden.
  if (
    webviewReady &&
    currentProvider &&
    currentProvider !== '__tv__' &&
    webview.getURL() !== 'about:blank' &&
    webview.canGoBack()
  ) {
    webview.goBack();
    return true;
  }

  // Wenn die Webview keine eigene Historie mehr besitzt, zur vorherigen
  // App-Ansicht wechseln.
  if (navStack.length) {
    goBack();
    return true;
  }

  return false;
}
