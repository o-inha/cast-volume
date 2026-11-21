(() => {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const mode = view === 'window' || view === 'panel' ? view : 'toolbar';
  document.body.dataset.view = mode;

  const button = document.getElementById('view-mode');
  if (params.get('demo') === '1') {
    button.hidden = true;
    return;
  }
  const icon = document.querySelector('#view-mode-icon path');
  const status = document.getElementById('view-status');
  const normalWindows = {windowTypes: ['normal']};
  const canOpenToolbar = Boolean(chrome.action?.openPopup);
  const canCyclePanel = Boolean(chrome.sidePanel?.open && chrome.sidePanel?.close && canOpenToolbar);

  const views = {
    window: ['Open in a separate window', 'M13 5h6v6m0-6-8 8m5 0v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h5'],
    panel: ['Move to Chrome side panel', 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm10 0v14'],
    toolbar: ['Return to toolbar popup', 'M4 5h16v5H4zM10 13h10v7H10zM7 7.5h.01'],
    close: ['Close separate window', 'm6 6 12 12M18 6 6 18'],
  };
  const next = {
    toolbar: 'window',
    window: canCyclePanel ? 'panel' : canOpenToolbar ? 'toolbar' : 'close',
    panel: 'toolbar',
  }[mode];
  const [label, path] = views[next];
  button.title = label;
  button.setAttribute('aria-label', label);
  icon.setAttribute('d', path);
  button.hidden = mode === 'panel' && !canCyclePanel;

  let owner;
  let switching = false;
  let resolvingOwner = false;

  async function findOwner(preferredId) {
    resolvingOwner = true;
    button.disabled = true;
    const preferred = mode === 'window'
      ? preferredId ? chrome.windows.get(Number(preferredId), normalWindows) : Promise.resolve(null)
      : chrome.windows.getCurrent(normalWindows);
    const normal = await preferred.catch(() => null);
    owner = normal || await chrome.windows.getLastFocused(normalWindows).catch(() => null);
    resolvingOwner = false;
    button.disabled = switching;
  }

  async function detach() {
    const url = new URL(chrome.runtime.getURL('popup.html'));
    url.searchParams.set('view', 'window');
    if (owner?.id != null) url.searchParams.set('owner', owner.id);
    const existing = await chrome.runtime.getContexts?.({contextTypes: ['TAB'], documentUrls: [url.href]});
    if (existing?.length) {
      await chrome.windows.update(existing[0].windowId, {focused: true});
    } else {
      await chrome.windows.create({url: url.href, type: 'popup', width: 360, height: 340, focused: true});
    }
    window.close();
  }

  async function switchView() {
    if (switching || resolvingOwner) return;
    const windowId = owner?.id;
    status.hidden = true;
    switching = true;
    button.disabled = true;
    try {
      if (next === 'window') {
        await detach();
      } else if (next === 'close') {
        window.close();
      } else if (windowId == null) {
        status.textContent = 'Open a regular Chrome window first.';
        status.hidden = false;
      } else if (next === 'panel') {
        // Chrome requires this call to run before the click's user gesture expires.
        await chrome.sidePanel.open({windowId});
        await chrome.windows.update(windowId, {focused: true});
        window.close();
      } else {
        if (mode === 'window') {
          await chrome.windows.update(windowId, {focused: true});
        }
        await chrome.action.openPopup({windowId});
        if (mode === 'panel') {
          await chrome.sidePanel.close({windowId});
        } else {
          window.close();
        }
      }
    } catch (error) {
      console.warn('Cast Volume could not switch views.', error);
      status.textContent = 'Could not switch views. Try again from a regular Chrome window.';
      status.hidden = false;
    } finally {
      switching = false;
      button.disabled = resolvingOwner;
    }
  }

  button.addEventListener('click', switchView);
  findOwner(params.get('owner'));
  if (mode === 'window') {
    chrome.windows.onRemoved.addListener(windowId => {
      if (windowId === owner?.id) findOwner();
    });
    chrome.windows.onCreated.addListener(browserWindow => {
      if (!owner && browserWindow.type === 'normal') findOwner(browserWindow.id);
    });
  }
})();
