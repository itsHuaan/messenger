(() => {
  'use strict';

  // Prevent multiple executions in the same document
  if (window.__MESSENGER_DESKTOP_INITIALIZED__) {
    return;
  }
  window.__MESSENGER_DESKTOP_INITIALIZED__ = true;

  console.log('[Messenger Desktop] Initializing notifications & badge integration...');

  // ==========================================
  // Centralized Selectors & Patterns
  // ==========================================
  const SELECTORS = {
    // Left navigation container containing conversation items
    conversationListContainer: [
      'div[role="navigation"]',
      'div[role="grid"]',
      'div[data-pagelet="LeftRail"]',
      'div[aria-label="Chats" i]',
      'div[aria-label*="Đoạn chat" i]'
    ].join(','),

    // Individual conversation row
    conversationItem: [
      'div[role="row"]',
      'div[role="listitem"]',
      'a[role="link"][href*="/t/"]',
      'a[role="link"][href*="/e2ee/t/"]',
      'a[href*="/t/"]',
      'a[href*="/e2ee/t/"]',
      'div[data-testid="mwthreadlist-item"]'
    ].join(','),

    // Thread link
    threadLink: 'a[href*="/t/"], a[href*="/e2ee/t/"]',

    // Conversation title / recipient name
    titleElement: 'span[dir="auto"], h2, h3',

    // Snippet element (last message preview)
    snippetElement: 'span[dir="auto"], div[dir="auto"]',

    // Explicit unread indicators
    unreadIndicator: [
      '[aria-label*="unread" i]',
      '[aria-label*="Mark as read" i]',
      '[aria-label*="chưa đọc" i]',
      '[aria-label*="đã đọc" i]',
      '[data-testid*="unread" i]'
    ].join(','),

    // Active conversation message container
    activeMessageContainer: 'div[role="main"]',

    // Message row inside active conversation
    messageRow: 'div[role="row"], div[data-testid="message-container"]',

    // Chats navigation tab
    chatsTab: [
      'a[aria-label*="Chats" i]',
      'div[aria-label*="Chats" i]',
      'a[aria-label*="Đoạn chat" i]',
      'div[aria-label*="Đoạn chat" i]'
    ].join(','),

    // Message composer
    messageComposer: 'div[role="textbox"][contenteditable="true"]',

    // Send button
    sendButton: '[aria-label*="Send" i], [aria-label*="Gửi" i], button[type="submit"]'
  };

  // Prefixes indicating outgoing messages across common languages
  const OUTGOING_PREFIXES = [
    /^You:\s+/i,
    /^Bạn:\s+/i,
    /^Tú:\s+/i,
    /^Vous:\s+/i,
    /^Du:\s+/i,
    /^Vos:\s+/i,
    /^Ti:\s+/i,
    /^Io:\s+/i,
    /^You sent /i,
    /^Bạn đã gửi /i
  ];

  // ==========================================
  // Bounded Memory Deduplication
  // ==========================================
  class BoundedCache {
    constructor(maxSize = 300) {
      this.maxSize = maxSize;
      this.items = new Map();
    }
    has(key) {
      return this.items.has(key);
    }
    add(key) {
      if (this.items.size >= this.maxSize) {
        const oldestKey = this.items.keys().next().value;
        this.items.delete(oldestKey);
      }
      this.items.set(key, Date.now());
    }
  }

  // seenSignatures: signatures of notifications already fired (bounded, persists across nav)
  const seenSignatures = new BoundedCache(300);

  // threadSnippets: baseline snapshot of snippets per thread (populated during init scan)
  // Maps threadId -> snippet text at initialization time (or last seen)
  const threadSnippets = new Map();

  // ==========================================
  // Initialization Lifecycle
  // ==========================================
  // Phase 1: Scan – capture baseline, do not fire notifications
  // Phase 2: Live – fire notifications for snippet changes only
  let isInitialized = false;

  // Build a stable baseline from currently visible conversation list items.
  // Returns the number of threads snapshotted.
  function buildBaseline() {
    const items = document.querySelectorAll(SELECTORS.conversationItem);
    let count = 0;
    for (const item of items) {
      const threadId = extractThreadId(item);
      if (!threadId) continue;
      const snippet = extractSnippet(item);
      threadSnippets.set(threadId, snippet);
      count++;
    }
    console.log(`[Messenger Desktop] Baseline built: ${count} thread(s) snapshotted.`);
    return count;
  }

  // Re-baseline a specific thread (called after navigation to that thread).
  function rebaselineThread(threadId) {
    if (!threadId) return;
    // Find the conversation list item for this thread
    const items = document.querySelectorAll(SELECTORS.conversationItem);
    for (const item of items) {
      if (extractThreadId(item) === threadId) {
        const snippet = extractSnippet(item);
        threadSnippets.set(threadId, snippet);
        return;
      }
    }
    // If not found in list (e.g. direct URL nav), mark as empty to allow future diffs
    threadSnippets.set(threadId, '__baseline_empty__');
  }

  // Local settings cache (populated via get_settings on load)
  let appSettings = {
    notifications_enabled: true,
    badge_enabled: true,
    hide_message_content: false,
    badge_color: '#F52D2D'
  };

  // ==========================================
  // Tauri IPC Helper
  // ==========================================
  function invoke(cmd, args = {}) {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri IPC is not available'));
  }

  // Load initial settings from Rust
  invoke('get_settings')
    .then(settings => {
      if (settings) {
        appSettings = settings;
        console.log('[Messenger Desktop] Settings loaded:', {
          notifications_enabled: appSettings.notifications_enabled,
          badge_enabled: appSettings.badge_enabled,
          hide_message_content: appSettings.hide_message_content
        });
      }
    })
    .catch(err => {
      console.warn('[Messenger Desktop] Could not fetch settings from Rust:', err.message);
    });

  // ==========================================
  // Helper Functions
  // ==========================================
  function extractThreadId(element) {
    if (!element) return null;
    const link = element.matches('a[href*="/t/"]') || element.matches('a[href*="/e2ee/t/"]')
      ? element
      : element.querySelector(SELECTORS.threadLink);
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function extractSnippet(item) {
    const spans = Array.from(item.querySelectorAll(SELECTORS.titleElement))
      .map(s => (s.textContent || '').trim())
      .filter(t => t.length > 0);
    return spans.length > 1 ? spans[1] : (spans[0] || '');
  }

  function extractSenderName(item) {
    const spans = Array.from(item.querySelectorAll(SELECTORS.titleElement))
      .map(s => (s.textContent || '').trim())
      .filter(t => t.length > 0);
    return spans[0] || 'Messenger';
  }

  function getActiveThreadIdFromUrl() {
    const pathname = window.location.pathname;
    const match = pathname.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function isOutgoingText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    for (const prefix of OUTGOING_PREFIXES) {
      if (prefix.test(trimmed)) return true;
    }
    return false;
  }

  function cleanPreviewText(text) {
    if (!text) return 'New message received';
    let cleaned = text.trim();
    for (const prefix of OUTGOING_PREFIXES) {
      cleaned = cleaned.replace(prefix, '');
    }
    return cleaned.trim() || 'New message received';
  }

  function isUserActivelyViewing(threadId) {
    const isWindowFocused = document.hasFocus() && !document.hidden;
    if (!isWindowFocused) return false;
    const activeId = getActiveThreadIdFromUrl();
    if (activeId && threadId) {
      return activeId === threadId || activeId.includes(threadId) || threadId.includes(activeId);
    }
    return false;
  }

  // ==========================================
  // Incoming Message Detection
  // ==========================================
  function checkConversationItem(item) {
    if (!isInitialized) return; // Never fire before baseline is built

    const threadId = extractThreadId(item);
    if (!threadId) return;

    const snippet = extractSnippet(item);
    const lastSnippet = threadSnippets.get(threadId);

    // No change from baseline/last-seen → no new message
    if (lastSnippet === snippet) return;

    // Update stored snippet immediately to prevent duplicate firing
    threadSnippets.set(threadId, snippet);

    // Outgoing messages don't trigger notifications
    if (isOutgoingText(snippet)) return;

    // Empty snippet is not a new message (virtualized list clearing)
    if (!snippet) return;

    // Generate unique signature for deduplication across observer firings
    const senderName = extractSenderName(item);
    const signature = `${threadId}|${senderName}|${snippet}`;
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);

    // Suppress if user is actively viewing this conversation
    if (isUserActivelyViewing(threadId)) {
      console.log(`[Messenger Desktop] Suppressed notification for actively viewed thread: ${threadId}`);
      return;
    }

    if (!appSettings.notifications_enabled) return;

    const preview = cleanPreviewText(snippet);
    console.log(`[Messenger Desktop] Dispatching notification for thread: ${threadId}`);

    invoke('notify_message', {
      title: senderName,
      body: preview,
      conversationId: threadId
    }).catch(err => {
      console.error('[Messenger Desktop] Error invoking notify_message:', err);
    });
  }

  // Check active chat message stream for incoming messages when app is unfocused
  function checkActiveConversationStream() {
    if (!isInitialized) return;
    const isWindowFocused = document.hasFocus() && !document.hidden;
    if (isWindowFocused) return; // only needed when unfocused

    const activeThreadId = getActiveThreadIdFromUrl();
    if (!activeThreadId) return;

    const mainArea = document.querySelector(SELECTORS.activeMessageContainer);
    if (!mainArea) return;

    const messageRows = mainArea.querySelectorAll(SELECTORS.messageRow);
    if (messageRows.length === 0) return;

    const lastMessage = messageRows[messageRows.length - 1];
    if (!lastMessage) return;

    const ariaLabel = lastMessage.getAttribute('aria-label') || '';
    if (isOutgoingText(ariaLabel)) return;

    const text = (lastMessage.textContent || '').trim();
    if (!text) return;

    const signature = `active|${activeThreadId}|${text}`;
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);

    const headerTitle = document.querySelector('header span[dir="auto"], div[role="main"] h2');
    const sender = headerTitle ? (headerTitle.textContent || '').trim() : 'Messenger';

    if (!appSettings.notifications_enabled) return;

    console.log(`[Messenger Desktop] Dispatching notification from active stream while unfocused`);
    invoke('notify_message', {
      title: sender,
      body: cleanPreviewText(text),
      conversationId: activeThreadId
    }).catch(err => {
      console.error('[Messenger Desktop] Error sending notification from active stream:', err);
    });
  }

  // ==========================================
  // Unread Taskbar Badge Detection
  // ==========================================
  let lastBadgeCount = -1;
  let lastHasUnread = false;

  function updateUnreadBadge() {
    let unreadConversationCount = 0;
    let hasUnread = false;

    // 1. Check document.title for "(N) Messenger" or "(N+) Messenger"
    const titleMatch = document.title.match(/^\((\d+)\+?\)/);
    if (titleMatch) {
      const parsed = parseInt(titleMatch[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        unreadConversationCount = parsed;
        hasUnread = true;
      }
    }

    // 2. Count unread conversation items in the thread list
    const items = document.querySelectorAll(SELECTORS.conversationItem);
    let countedRows = 0;

    for (const item of items) {
      let isUnread = false;

      const unreadDot = item.querySelector(SELECTORS.unreadIndicator);
      if (unreadDot) isUnread = true;

      if (!isUnread) {
        const itemAria = (item.getAttribute('aria-label') || '').toLowerCase();
        if (itemAria.includes('unread') || itemAria.includes('chưa đọc')) isUnread = true;
      }

      if (!isUnread) {
        const snippetEl = item.querySelector(SELECTORS.snippetElement);
        if (snippetEl) {
          const style = window.getComputedStyle(snippetEl);
          const weight = parseInt(style.fontWeight, 10);
          if (weight >= 600 || style.fontWeight === 'bold') isUnread = true;
        }
      }

      if (isUnread) countedRows++;
    }

    if (countedRows > 0) {
      hasUnread = true;
      if (unreadConversationCount === 0) unreadConversationCount = countedRows;
    }

    // 3. Check Chats tab counter if still zero
    if (!hasUnread) {
      const chatsTab = document.querySelector(SELECTORS.chatsTab);
      if (chatsTab) {
        const aria = (chatsTab.getAttribute('aria-label') || '').toLowerCase();
        const numMatch = aria.match(/(\d+)\s*(?:unread|chưa đọc)/);
        if (numMatch) {
          unreadConversationCount = parseInt(numMatch[1], 10);
          hasUnread = unreadConversationCount > 0;
        }
      }
    }

    if (unreadConversationCount !== lastBadgeCount || hasUnread !== lastHasUnread) {
      lastBadgeCount = unreadConversationCount;
      lastHasUnread = hasUnread;

      console.log(`[Messenger Desktop] Updating unread badge: count=${unreadConversationCount}, hasUnread=${hasUnread}`);
      invoke('update_unread_badge', {
        count: unreadConversationCount,
        hasUnread: hasUnread
      }).catch(err => {
        console.error('[Messenger Desktop] Error updating unread badge:', err);
      });
    }
  }

  // ==========================================
  // Debounced Mutation Observer
  // ==========================================
  let mutationTimeout = null;

  function handleMutations() {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(() => {
      const items = document.querySelectorAll(SELECTORS.conversationItem);
      for (const item of items) checkConversationItem(item);
      checkActiveConversationStream();
      updateUnreadBadge();
    }, 150);
  }

  const observer = new MutationObserver(handleMutations);

  function startObserver() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'class', 'style', 'href']
    });
  }

  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver);
  }

  // Also listen for document title changes for immediate badge update
  const titleEl = document.querySelector('title');
  if (titleEl) {
    const titleObserver = new MutationObserver(() => updateUnreadBadge());
    titleObserver.observe(titleEl, { childList: true });
  }

  // ==========================================
  // Proper Baseline Initialization
  // ==========================================
  // We wait for the conversation list to appear, then snapshot all visible threads.
  // We only flip isInitialized=true AFTER the snapshot so no historical messages fire.

  function attemptInitialization() {
    // Build baseline — if the list is not yet rendered, wait and retry
    const count = buildBaseline();
    if (count === 0) {
      // List not rendered yet; retry in 500ms, up to 20 times (10 seconds total)
      return false;
    }
    isInitialized = true;
    console.log('[Messenger Desktop] Initialization complete. Live notifications active.');
    updateUnreadBadge();
    return true;
  }

  let initAttempts = 0;
  const MAX_INIT_ATTEMPTS = 20;

  function scheduleInitialization() {
    if (initAttempts >= MAX_INIT_ATTEMPTS) {
      // Force init anyway to avoid hanging forever (e.g., on login screen)
      isInitialized = true;
      console.log('[Messenger Desktop] Initialization forced after max retries.');
      return;
    }
    initAttempts++;
    setTimeout(() => {
      if (!attemptInitialization()) {
        scheduleInitialization();
      }
    }, 500);
  }

  // Start initialization after a brief DOM settle delay
  setTimeout(scheduleInitialization, 500);

  // ==========================================
  // SPA Navigation Handling
  // ==========================================
  // When the user navigates to a new thread, re-baseline that thread to avoid
  // firing a notification for the conversation that was just opened.
  let lastPathname = window.location.pathname;

  function handleNavigation() {
    const newPathname = window.location.pathname;
    if (newPathname === lastPathname) return;
    lastPathname = newPathname;

    const threadId = getActiveThreadIdFromUrl();
    if (threadId && isInitialized) {
      // Re-baseline this thread's snippet so opening a conversation doesn't trigger a notification
      setTimeout(() => rebaselineThread(threadId), 300);
    }
  }

  window.addEventListener('popstate', handleNavigation);

  // Messenger uses history.pushState for navigation — patch it
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    handleNavigation();
  };

  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replaceState(...args);
    handleNavigation();
  };

  // ==========================================
  // JS Bridge Functions (for Toast Activation)
  // ==========================================

  /**
   * Navigates to a conversation by threadId.
   * Called by Rust when the user clicks the toast body.
   */
  window.__MESSENGER_DESKTOP_OPEN_THREAD__ = function (threadId) {
    if (!threadId) return;
    console.log(`[Messenger Desktop] Opening thread: ${threadId}`);

    // Try clicking the conversation list item with matching href
    const items = document.querySelectorAll(SELECTORS.conversationItem);
    for (const item of items) {
      const id = extractThreadId(item);
      if (id && (id === threadId || id.includes(threadId) || threadId.includes(id))) {
        const link = item.matches('a') ? item : item.querySelector(SELECTORS.threadLink);
        if (link) {
          link.click();
          return;
        }
      }
    }

    // Fallback: direct URL navigation
    const currentPath = window.location.pathname;
    if (!currentPath.includes(threadId)) {
      window.location.href = `https://www.messenger.com/t/${threadId}`;
    }
  };

  /**
   * Sends a reply to a conversation by threadId.
   * Called by Rust when the user submits text from the inline toast reply input.
   */
  const _lastReplySent = new Map(); // threadId -> { text, time }

  window.__MESSENGER_DESKTOP_SEND_REPLY__ = async function (threadId, replyText) {
    if (!threadId || !replyText || !replyText.trim()) return;

    const trimmedReply = replyText.trim();

    // Duplicate reply guard (same thread + text within 10s)
    const last = _lastReplySent.get(threadId);
    if (last && last.text === trimmedReply && Date.now() - last.time < 10000) {
      console.log(`[Messenger Desktop] Duplicate reply suppressed for thread: ${threadId}`);
      return;
    }
    _lastReplySent.set(threadId, { text: trimmedReply, time: Date.now() });

    console.log(`[Messenger Desktop] Sending inline reply to thread: ${threadId}`);

    // 1. Ensure the target conversation is open
    const activeId = getActiveThreadIdFromUrl();
    const isCorrectThread = activeId && (activeId === threadId || activeId.includes(threadId) || threadId.includes(activeId));

    if (!isCorrectThread) {
      window.__MESSENGER_DESKTOP_OPEN_THREAD__(threadId);
      // Wait for navigation + compose area to load
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    // 2. Find the message composer
    const composer = document.querySelector(SELECTORS.messageComposer);
    if (!composer) {
      console.warn('[Messenger Desktop] Message composer not found for inline reply.');
      return;
    }

    // 3. Focus and populate composer using execCommand (works in contenteditable)
    composer.focus();
    composer.click();

    // Clear existing content first
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Insert reply text
    document.execCommand('insertText', false, trimmedReply);

    // Allow Messenger's React state to sync
    await new Promise(resolve => setTimeout(resolve, 150));

    // 4. Submit by pressing Enter
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    composer.dispatchEvent(enterEvent);

    // Fallback: click the send button if Enter didn't submit
    setTimeout(() => {
      const sendBtn = document.querySelector(SELECTORS.sendButton);
      if (sendBtn) {
        // Only click if composer still has text (Enter didn't work)
        if ((composer.textContent || '').trim()) {
          sendBtn.click();
        }
      }
    }, 300);
  };

  // ==========================================
  // Settings UI Injection
  // ==========================================
  function createSettingsUI() {
    if (document.getElementById('messenger-desktop-settings-root')) return;

    const container = document.createElement('div');
    container.id = 'messenger-desktop-settings-root';

    const style = document.createElement('style');
    style.textContent = `
      #md-settings-btn {
        position: fixed;
        bottom: 16px;
        left: 20px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background-color: rgba(30, 30, 30, 0.75);
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(8px);
        transition: transform 0.2s, background-color 0.2s;
      }
      #md-settings-btn:hover {
        transform: scale(1.08);
        background-color: rgba(0, 132, 255, 0.9);
      }
      #md-settings-btn svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
      }
      #md-settings-modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(4px);
        z-index: 1000000;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      #md-settings-card {
        background: #242526;
        color: #e4e6eb;
        width: 420px;
        max-width: 90vw;
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 24px;
        animation: md-slide-in 0.2s ease-out;
      }
      @keyframes md-slide-in {
        from { opacity: 0; transform: translateY(-16px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .md-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }
      .md-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #fff;
      }
      .md-close {
        background: transparent;
        border: none;
        color: #b0b3b8;
        font-size: 20px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
      }
      .md-close:hover { color: #fff; }
      .md-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .md-label {
        font-size: 14px;
        font-weight: 500;
        color: #e4e6eb;
      }
      .md-sublabel {
        font-size: 12px;
        color: #b0b3b8;
        margin-top: 2px;
      }
      .md-switch {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
        flex-shrink: 0;
      }
      .md-switch input { opacity: 0; width: 0; height: 0; }
      .md-slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: #3e4042;
        transition: .3s;
        border-radius: 24px;
      }
      .md-slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        transition: .3s;
        border-radius: 50%;
      }
      input:checked + .md-slider { background-color: #0084ff; }
      input:checked + .md-slider:before { transform: translateX(20px); }
      .md-btn-row {
        display: flex;
        gap: 10px;
        margin-top: 20px;
      }
      .md-action-btn {
        flex: 1;
        padding: 10px;
        border-radius: 8px;
        border: none;
        background: #3a3b3c;
        color: #e4e6eb;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      }
      .md-action-btn:hover { background: #4e4f50; }
    `;

    container.appendChild(style);

    // Floating Button
    const btn = document.createElement('button');
    btn.id = 'md-settings-btn';
    btn.title = 'Messenger Desktop Settings (Ctrl+,)';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
      </svg>
    `;

    // Modal
    const modal = document.createElement('div');
    modal.id = 'md-settings-modal';
    modal.innerHTML = `
      <div id="md-settings-card">
        <div class="md-header">
          <h2>Messenger Desktop Settings</h2>
          <button class="md-close" id="md-close-btn">&times;</button>
        </div>
        <div class="md-row">
          <div>
            <div class="md-label">Windows Toast Notifications</div>
            <div class="md-sublabel">Show native alerts for incoming messages</div>
          </div>
          <label class="md-switch">
            <input type="checkbox" id="md-toggle-notifications" checked>
            <span class="md-slider"></span>
          </label>
        </div>
        <div class="md-row">
          <div>
            <div class="md-label">Taskbar Unread Badge</div>
            <div class="md-sublabel">Display red dot / unread count on taskbar icon</div>
          </div>
          <label class="md-switch">
            <input type="checkbox" id="md-toggle-badge" checked>
            <span class="md-slider"></span>
          </label>
        </div>
        <div class="md-row">
          <div>
            <div class="md-label">Hide message content in notifications</div>
            <div class="md-sublabel">Show sender names without displaying message previews</div>
          </div>
          <label class="md-switch">
            <input type="checkbox" id="md-toggle-hide-content">
            <span class="md-slider"></span>
          </label>
        </div>
        <div class="md-row">
          <div>
            <div class="md-label">Unread badge color</div>
            <div class="md-sublabel">Color of the taskbar notification dot</div>
          </div>
          <input type="color" id="md-badge-color" value="#F52D2D" title="Pick badge color" style="width:36px;height:28px;border:none;background:none;cursor:pointer;padding:0;border-radius:6px;">
        </div>
        <div class="md-btn-row">
          <button class="md-action-btn" id="md-test-notif-btn">Test Notification</button>
          <button class="md-action-btn" id="md-test-badge-btn">Test Unread Badge</button>
        </div>
      </div>
    `;

    container.appendChild(btn);
    container.appendChild(modal);
    document.body.appendChild(container);

    // Event listeners
    const openModal = () => {
      document.getElementById('md-toggle-notifications').checked = !!appSettings.notifications_enabled;
      document.getElementById('md-toggle-badge').checked = !!appSettings.badge_enabled;
      document.getElementById('md-toggle-hide-content').checked = !!appSettings.hide_message_content;
      document.getElementById('md-badge-color').value = appSettings.badge_color || '#F52D2D';
      modal.style.display = 'flex';
    };

    const closeModal = () => { modal.style.display = 'none'; };

    btn.addEventListener('click', openModal);
    document.getElementById('md-close-btn').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    window.addEventListener('keydown', e => {
      if ((e.ctrlKey && e.key === ',') || (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's'))) {
        e.preventDefault();
        if (modal.style.display === 'flex') closeModal(); else openModal();
      }
    });

    // Toggle: Notifications
    document.getElementById('md-toggle-notifications').addEventListener('change', e => {
      const enabled = e.target.checked;
      appSettings.notifications_enabled = enabled;
      invoke('set_notifications_enabled', { enabled }).catch(console.error);
    });

    // Toggle: Badge
    document.getElementById('md-toggle-badge').addEventListener('change', e => {
      const enabled = e.target.checked;
      appSettings.badge_enabled = enabled;
      invoke('set_badge_enabled', { enabled }).catch(console.error);
    });

    // Toggle: Hide message content
    document.getElementById('md-toggle-hide-content').addEventListener('change', e => {
      const enabled = e.target.checked;
      appSettings.hide_message_content = enabled;
      invoke('set_hide_message_content', { enabled }).catch(console.error);
    });

    // Badge color picker
    document.getElementById('md-badge-color').addEventListener('input', e => {
      const color = e.target.value;
      appSettings.badge_color = color;
      invoke('set_badge_color', { color }).then(() => {
        // Refresh the unread badge with the new color immediately
        if (lastBadgeCount !== -1 || lastHasUnread) {
          invoke('update_unread_badge', {
            count: lastBadgeCount === -1 ? 0 : lastBadgeCount,
            hasUnread: lastHasUnread
          }).catch(console.error);
        }
      }).catch(console.error);
    });

    // Test Notification
    document.getElementById('md-test-notif-btn').addEventListener('click', () => {
      invoke('notify_message', {
        title: 'Messenger Desktop Test',
        body: appSettings.hide_message_content ? 'New message' : 'Clicking this toast brings Messenger to the foreground!',
        conversationId: 'test'
      }).catch(err => alert('Notification error: ' + err));
    });

    // Test Badge
    document.getElementById('md-test-badge-btn').addEventListener('click', () => {
      const testCounts = [1, 3, 9, 12, 0];
      const nextCount = testCounts[(testCounts.indexOf(lastBadgeCount) + 1) % testCounts.length];
      invoke('update_unread_badge', {
        count: nextCount,
        hasUnread: nextCount > 0
      }).catch(err => alert('Badge error: ' + err));
    });
  }

  // ==========================================
  // Drag-and-Drop File Upload Support
  // ==========================================
  function setupDragAndDrop() {
    let dragCounter = 0;

    // Create an overlay indicator to show drop target state
    const dropOverlay = document.createElement('div');
    dropOverlay.id = 'md-drop-overlay';
    dropOverlay.style.cssText = `
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 132, 255, 0.15);
      border: 3px dashed #0084ff;
      box-sizing: border-box;
      z-index: 999998;
      pointer-events: none;
      align-items: center;
      justify-content: center;
      color: #0084ff;
      font-size: 20px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;
    dropOverlay.innerHTML = '<div style="background: rgba(0,0,0,0.7); padding: 16px 28px; border-radius: 12px; pointer-events: none;">Drop files to send in Messenger</div>';

    document.body.appendChild(dropOverlay);

    window.addEventListener('dragenter', e => {
      // Check if files are being dragged
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        dragCounter++;
        dropOverlay.style.display = 'flex';
      }
    });

    window.addEventListener('dragleave', e => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.style.display = 'none';
      }
    });

    window.addEventListener('dragover', e => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    window.addEventListener('drop', e => {
      dragCounter = 0;
      dropOverlay.style.display = 'none';

      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // Find file input or chat composer in Messenger
      // Messenger typically has hidden file inputs (e.g., input[type="file"][accept*="*"])
      // for attachments or accepts drop events on the main chat area or composer
      const composer = document.querySelector(SELECTORS.messageComposer);
      const fileInput = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
      const mainChat = document.querySelector(SELECTORS.activeMessageContainer);

      if (fileInput) {
        // If file input exists, assign files to it and trigger change event
        try {
          const dataTransfer = new DataTransfer();
          for (let i = 0; i < files.length; i++) {
            dataTransfer.items.add(files[i]);
          }
          fileInput.files = dataTransfer.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          console.log(`[Messenger Desktop] Dispatched ${files.length} file(s) to Messenger file input`);
          e.preventDefault();
          return;
        } catch (err) {
          console.warn('[Messenger Desktop] Could not assign DataTransfer to file input:', err);
        }
      }

      // If targeted drop on main area or composer
      const target = composer || mainChat;
      if (target && target !== e.target && !target.contains(e.target)) {
        // Re-dispatch synthetic drop event to composer or main chat area
        try {
          const dropEvt = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: e.dataTransfer
          });
          target.dispatchEvent(dropEvt);
          console.log('[Messenger Desktop] Forwarded drop event to chat composer/container');
          e.preventDefault();
        } catch (err) {
          console.warn('[Messenger Desktop] Error forwarding drop event:', err);
        }
      }
    });
  }

  // Inject UI when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createSettingsUI();
      setupDragAndDrop();
    });
  } else {
    createSettingsUI();
    setupDragAndDrop();
  }
})();
