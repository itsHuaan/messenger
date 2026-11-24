(() => {
  if (window.__MESSENGER_CALL_BRIDGE_INITIALIZED__) {
    return;
  }
  window.__MESSENGER_CALL_BRIDGE_INITIALIZED__ = true;

  console.log('[Messenger Desktop] Initializing call window close bridge...');

  function requestCallWindowClose(source) {
    console.log('[Messenger Desktop] Requesting call window close from:', source);

    // 1. Send native WebView2 WebMessage (highest reliability on Windows WebView2)
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage(JSON.stringify({ cmd: 'close_call_window', source }));
      }
    } catch (e) {
      console.warn('[Messenger Desktop] Error posting WebMessage to native host:', e);
    }

    // 2. Invoke Tauri command if available
    try {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        window.__TAURI_INTERNALS__.invoke('close_call_window', { source }).catch(() => {});
      } else if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
        window.__TAURI__.core.invoke('close_call_window', { source }).catch(() => {});
      }
    } catch (e) {
      console.warn('[Messenger Desktop] Error invoking close_call_window command:', e);
    }
  }

  // Intercept window.close()
  try {
    const originalClose = window.close;
    window.close = function() {
      requestCallWindowClose('window.close()');
      try {
        if (typeof originalClose === 'function') {
          originalClose.call(window);
        }
      } catch (e) {}
    };
  } catch (e) {
    console.warn('[Messenger Desktop] Could not override window.close:', e);
  }

  // Intercept Window.prototype.close()
  try {
    if (window.Window && window.Window.prototype) {
      const originalProtoClose = window.Window.prototype.close;
      window.Window.prototype.close = function() {
        requestCallWindowClose('Window.prototype.close()');
        try {
          if (typeof originalProtoClose === 'function') {
            originalProtoClose.call(this);
          }
        } catch (e) {}
      };
    }
  } catch (e) {
    console.warn('[Messenger Desktop] Could not override Window.prototype.close:', e);
  }

  // Fallback: Listen for click on Messenger's ended-call "Close" / "Đóng" button
  document.addEventListener(
    'click',
    (evt) => {
      try {
        const target = evt.target;
        if (!target) return;
        const btn = target.closest('button, div[role="button"], a[role="button"]');
        if (!btn) return;

        const text = (btn.textContent || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const isCloseBtn = text === 'close' || text === 'đóng' || ariaLabel === 'close' || ariaLabel === 'đóng';

        if (isCloseBtn) {
          // Verify we are on a call-ended screen before acting
          const bodyText = document.body ? document.body.innerText : '';
          const isCallEnded = /call ended|cuộc gọi đã kết thúc|cuộc gọi kết thúc|call has ended/i.test(bodyText);
          if (isCallEnded) {
            console.log('[Messenger Desktop] Close button clicked on call-ended screen');
            requestCallWindowClose('click:close_button');
          }
        }
      } catch (e) {}
    },
    true
  );
})();
