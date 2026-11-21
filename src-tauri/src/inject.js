(() => {
  'use strict';

  // Only run in the top-level window (never inside background/tracking iframes)
  if (window.top !== window) {
    return;
  }

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

    // Muted conversation indicators (SVG bell-slash, aria-labels, testids)
    muteIndicator: [
      '[aria-label*="muted" i]',
      '[aria-label*="tắt thông báo" i]',
      '[aria-label*="đã tắt thông báo" i]',
      '[aria-label*="tắt chuông" i]',
      '[aria-label*="tắt âm" i]',
      '[aria-label*="notifications off" i]',
      '[aria-label*="silenced" i]',
      '[title*="muted" i]',
      '[title*="tắt thông báo" i]',
      '[data-testid*="mute" i]',
      'path[d^="M29.676"]',
      'path[d*="29.676 7.746"]',
      '<path d="M2.5 6c0-.322.028-.637.081-.943l8.296 8.296A3.001 3.001 0 0 1 5 12.5H2.432a.98.98 0 0 1-.816-1.525A5.268 5.268 0 0 0 2.5 8.053V6zm4 6.5a1.5 1.5 0 0 0 3 0h-3zm7.06 0h.01a.98.98 0 0 0 .815-1.525 5.269 5.269 0 0 1-.885-2.922V6a5.5 5.5 0 0 0-9.83-3.39L2.28 1.22a.75.75 0 0 0-1.061 1.06l12.5 12.5a.75.75 0 0 0 1.06-1.06l-1.22-1.22z"></path>'
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

  // Keywords indicating muted conversations across multiple languages
  const MUTED_KEYWORDS = [
    'muted',
    'tắt thông báo',
    'đã tắt thông báo',
    'tắt chuông',
    'tắt âm',
    'silenced',
    'notifications off',
    'stummgeschaltet',
    'silenciado',
    'muet',
    'disattivato'
  ];

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

  // threadSnippets: baseline snapshot of snippets per thread
  // Maps threadId -> snippet text at initialization time (or last seen)
  const threadSnippets = new Map();

  // Set of known muted thread IDs
  const mutedThreadIds = new Set();

  // Persistent storage to retain seen snippets across app restarts
  const STORAGE_KEY_SEEN = 'messenger_desktop_seen_snippets';

  function loadPersistedSnippets() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SEEN);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [id, snip] of Object.entries(parsed)) {
          threadSnippets.set(id, snip);
        }
        console.log(`[Messenger Desktop] Loaded ${Object.keys(parsed).length} persisted thread snippet(s).`);
      }
    } catch (e) {
      console.warn('[Messenger Desktop] Could not load persisted snippets:', e);
    }
  }

  function savePersistedSnippets() {
    try {
      const obj = {};
      let count = 0;
      for (const [id, snip] of threadSnippets.entries()) {
        obj[id] = snip;
        count++;
        if (count >= 200) break;
      }
      localStorage.setItem(STORAGE_KEY_SEEN, JSON.stringify(obj));
    } catch { }
  }

  // Populate known snippets immediately from localStorage
  loadPersistedSnippets();

  // Grace period tracking: suppress toast notifications on launch to prevent historical bursts
  const appStartTime = Date.now();
  const STARTUP_GRACE_PERIOD_MS = 6000;

  // ==========================================
  // Initialization Lifecycle
  // ==========================================
  let isInitialized = false;

  // Build a stable baseline from currently visible conversation list items.
  function buildBaseline() {
    const items = document.querySelectorAll(SELECTORS.conversationItem);
    let count = 0;
    for (const item of items) {
      const threadId = extractThreadId(item);
      if (!threadId) continue;

      if (isConversationMuted(item)) {
        mutedThreadIds.add(threadId);
      } else {
        mutedThreadIds.delete(threadId);
      }

      const snippet = extractSnippet(item);
      threadSnippets.set(threadId, snippet);
      count++;
    }
    savePersistedSnippets();
    console.log(`[Messenger Desktop] Baseline built: ${count} thread(s) snapshotted (${mutedThreadIds.size} muted).`);
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
    badge_color: '#F52D2D',
    run_at_startup: false,
    minimize_to_tray: true,
    start_minimized_to_tray: false,
    download_dir: null,
    ask_download_location: false
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

  function isConversationMuted(item) {
    if (!item) return false;

    // 1. Check aria-label on the item itself
    const itemAria = (item.getAttribute('aria-label') || '').toLowerCase();
    for (const kw of MUTED_KEYWORDS) {
      if (itemAria.includes(kw)) {
        return true;
      }
    }

    // 2. Check child selectors for mute indicators
    if (item.querySelector(SELECTORS.muteIndicator)) {
      return true;
    }

    // 3. Check inline SVGs for bell slash or mute icon patterns
    const svgs = item.querySelectorAll('svg');
    for (const svg of svgs) {
      const svgAria = (svg.getAttribute('aria-label') || '').toLowerCase();
      for (const kw of MUTED_KEYWORDS) {
        if (svgAria.includes(kw)) return true;
      }
      const paths = svg.querySelectorAll('path');
      for (const p of paths) {
        const d = p.getAttribute('d') || '';
        if (d.startsWith('M29.676') || d.includes('29.676 7.746')) {
          return true;
        }
      }
    }

    return false;
  }

  function isConversationUnread(item) {
    if (!item) return false;

    // 1. Explicit unread indicators
    const unreadDot = item.querySelector(SELECTORS.unreadIndicator);
    if (unreadDot) return true;

    // 2. Item's aria-label
    const itemAria = (item.getAttribute('aria-label') || '').toLowerCase();
    if (itemAria.includes('unread') || itemAria.includes('chưa đọc')) return true;

    // 3. Bold font-weight on message preview snippet
    const snippetEl = item.querySelector(SELECTORS.snippetElement);
    if (snippetEl) {
      const style = window.getComputedStyle(snippetEl);
      const weight = parseInt(style.fontWeight, 10);
      if (weight >= 600 || style.fontWeight === 'bold') return true;
    }

    return false;
  }

  function isCurrentConversationMuted(activeThreadId) {
    if (activeThreadId && mutedThreadIds.has(activeThreadId)) {
      return true;
    }
    const header = document.querySelector('header, div[role="main"] header, [role="main"]');
    if (header) {
      const headerAria = (header.getAttribute('aria-label') || '').toLowerCase();
      for (const kw of MUTED_KEYWORDS) {
        if (headerAria.includes(kw)) return true;
      }
      if (header.querySelector(SELECTORS.muteIndicator)) {
        return true;
      }
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

    // Check and track muted state
    if (isConversationMuted(item)) {
      mutedThreadIds.add(threadId);
      return; // Never fire notifications for muted conversations
    } else {
      mutedThreadIds.delete(threadId);
    }

    const snippet = extractSnippet(item);
    if (!snippet) return; // Empty snippet is not a new message (virtualized list clearing)

    const lastSnippet = threadSnippets.get(threadId);

    // If this thread was never seen before in our map (e.g. newly mounted row from scroll):
    // Record it as baseline. DO NOT fire a notification on initial discovery of an existing thread!
    if (lastSnippet === undefined) {
      threadSnippets.set(threadId, snippet);
      savePersistedSnippets();
      return;
    }

    // No change from baseline/last-seen → no new message
    if (lastSnippet === snippet) return;

    // Update stored snippet immediately to prevent duplicate firing
    threadSnippets.set(threadId, snippet);
    savePersistedSnippets();

    // CRITICAL: If the conversation is NOT unread (i.e. seen / read), DO NOT NOTIFY!
    if (!isConversationUnread(item)) {
      return;
    }

    // During startup grace period, do not fire toast notifications for pre-existing messages
    if (Date.now() - appStartTime < STARTUP_GRACE_PERIOD_MS) {
      return;
    }

    // Outgoing messages don't trigger notifications
    if (isOutgoingText(snippet)) return;

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
    if (Date.now() - appStartTime < STARTUP_GRACE_PERIOD_MS) return;

    const isWindowFocused = document.hasFocus() && !document.hidden;
    if (isWindowFocused) return; // only needed when unfocused

    const activeThreadId = getActiveThreadIdFromUrl();
    if (!activeThreadId) return;

    if (isCurrentConversationMuted(activeThreadId)) {
      mutedThreadIds.add(activeThreadId);
      return;
    }

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
      // Muted conversations should not count towards unread badge
      if (isConversationMuted(item)) {
        const tid = extractThreadId(item);
        if (tid) mutedThreadIds.add(tid);
        continue;
      }

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
        item.click();
        return;
      }
    }

    // Fallback: SPA navigation without full page reload
    const currentPath = window.location.pathname;
    if (!currentPath.includes(threadId)) {
      try {
        window.history.pushState(null, '', `/t/${threadId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch {
        window.location.href = `https://www.messenger.com/t/${threadId}`;
      }
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
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(6px);
        z-index: 2147483646;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        overscroll-behavior: contain;
      }
      #md-settings-card {
        background: #242526;
        color: #e4e6eb;
        width: 70vw;
        height: 70vh;
        min-width: min(560px, calc(100vw - 32px));
        max-width: min(960px, calc(100vw - 32px));
        min-height: min(440px, calc(100vh - 32px));
        max-height: min(800px, calc(100vh - 32px));
        border-radius: 14px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
        border: 1px solid #3a3b3c;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: md-card-pop 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        overscroll-behavior: contain;
      }
      @keyframes md-card-pop {
        from { opacity: 0; transform: scale(0.96) translateY(8px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .md-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 20px;
        background: #242526;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
      }
      .md-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .md-header h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 600;
        color: #fff;
      }
      .md-close {
        background: transparent;
        border: none;
        color: #b0b3b8;
        font-size: 22px;
        cursor: pointer;
        padding: 4px 8px;
        line-height: 1;
        border-radius: 6px;
        transition: background-color 0.15s, color 0.15s;
      }
      .md-close:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.1);
      }
      #md-settings-body {
        display: flex;
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
      }
      #md-sidebar {
        width: 180px;
        flex-shrink: 0;
        background: #1c1d1e;
        border-right: 1px solid rgba(255, 255, 255, 0.08);
        padding: 12px 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .md-nav-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 12px;
        border-radius: 8px;
        background: transparent;
        border: none;
        color: #b0b3b8;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
        text-align: left;
        width: 100%;
        position: relative;
        font-family: inherit;
      }
      .md-nav-item:hover {
        background: rgba(255, 255, 255, 0.06);
        color: #e4e6eb;
      }
      .md-nav-item.active {
        background: #0084ff;
        color: #ffffff;
        font-weight: 600;
      }
      .md-nav-item svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
        flex-shrink: 0;
      }
      .md-nav-badge {
        margin-left: auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #0084ff;
        display: none;
      }
      .md-nav-item.active .md-nav-badge {
        background: #ffffff;
      }
      #md-content-area {
        flex: 1;
        min-width: 0;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 22px 26px;
        background: #242526;
      }
      #md-content-area::-webkit-scrollbar,
      #md-sidebar::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      #md-content-area::-webkit-scrollbar-thumb,
      #md-sidebar::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      #md-content-area::-webkit-scrollbar-thumb:hover,
      #md-sidebar::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
      }
      .md-tab-pane {
        animation: md-pane-fade 0.18s ease;
      }
      @keyframes md-pane-fade {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .md-pane-header {
        margin-bottom: 16px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .md-pane-title {
        font-size: 16px;
        font-weight: 600;
        color: #ffffff;
        margin: 0;
      }
      .md-pane-desc {
        font-size: 12px;
        color: #b0b3b8;
        margin: 4px 0 0 0;
      }
      .md-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .md-row:last-child {
        border-bottom: none;
      }
      .md-label {
        font-size: 13.5px;
        font-weight: 500;
        color: #e4e6eb;
      }
      .md-sublabel {
        font-size: 12px;
        color: #b0b3b8;
        margin-top: 2px;
        line-height: 1.35;
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
        transition: .25s;
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
        transition: .25s;
        border-radius: 50%;
      }
      input:checked + .md-slider { background-color: #0084ff; }
      input:checked + .md-slider:before { transform: translateX(20px); }
      .md-btn-row {
        display: flex;
        gap: 10px;
        margin-top: 18px;
      }
      .md-action-btn {
        padding: 8px 14px;
        border-radius: 8px;
        border: none;
        background: #3a3b3c;
        color: #e4e6eb;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s, opacity 0.2s;
        text-align: center;
        font-family: inherit;
      }
      .md-action-btn:hover { background: #4e4f50; }
      .md-action-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .md-btn-primary {
        background: #0084ff !important;
        color: #fff !important;
      }
      .md-btn-primary:hover {
        background: #0073e6 !important;
      }
      .md-btn-secondary {
        background: #3a3b3c !important;
        color: #e4e6eb !important;
      }
      .md-btn-secondary:hover {
        background: #4e4f50 !important;
      }
      .md-section-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        margin: 16px 0;
      }
      .md-update-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      #md-update-indicator {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #0084ff;
        border: 2px solid #1e1e1e;
        display: none;
      }
      .md-about-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 16px;
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 16px;
      }
      .md-about-icon {
        width: 44px;
        height: 44px;
        border-radius: 10px;
        background: linear-gradient(135deg, #0866ff 0%, #0866ff 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .md-about-icon svg {
        width: 24px;
        height: 24px;
        fill: #ffffff;
      }
      .md-link {
        color: #0084ff;
        text-decoration: none;
        transition: color 0.15s;
      }
      .md-link:hover {
        color: #2e89ff;
        text-decoration: underline;
      }
      .md-spec-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
        margin-top: 14px;
      }
      .md-spec-item {
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .md-spec-label {
        font-size: 11px;
        color: #8a8d91;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .md-spec-val {
        font-size: 13px;
        font-weight: 500;
        color: #e4e6eb;
        margin-top: 2px;
      }

      /* Responsive Compact Mode for Narrow Windows */
      @media (max-width: 680px) {
        #md-settings-card {
          width: calc(100vw - 20px);
          height: calc(100vh - 20px);
          max-height: calc(100vh - 20px);
        }
        #md-settings-body {
          flex-direction: column;
        }
        #md-sidebar {
          width: 100%;
          flex-direction: row;
          border-right: none;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          padding: 8px 10px;
          gap: 6px;
          overflow-x: auto;
          overflow-y: hidden;
          flex-shrink: 0;
        }
        .md-nav-item {
          width: auto;
          padding: 6px 12px;
          font-size: 12px;
          white-space: nowrap;
        }
        #md-content-area {
          padding: 16px;
        }
        .md-spec-grid {
          grid-template-columns: 1fr;
        }
      }
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
      <span id="md-update-indicator"></span>
    `;

    // Modal
    const modal = document.createElement('div');
    modal.id = 'md-settings-modal';
    modal.innerHTML = `
      <div id="md-settings-card">
        <div class="md-header">
          <div class="md-header-left">
            <svg style="width:20px;height:20px;fill:#0084ff;" viewBox="0 0 24 24">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
            <h2>Settings</h2>
          </div>
          <button class="md-close" id="md-close-btn" title="Close (Esc)">&times;</button>
        </div>

        <div id="md-settings-body">
          <!-- Category Navigation Sidebar -->
          <nav id="md-sidebar" aria-label="Settings Categories">
            <button class="md-nav-item active" data-tab="general">
              <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              <span>General</span>
            </button>
            <button class="md-nav-item" data-tab="notifications">
              <svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/></svg>
              <span>Notifications</span>
            </button>
            <button class="md-nav-item" data-tab="downloads">
              <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <span>Downloads</span>
            </button>
            <button class="md-nav-item" data-tab="updates">
              <svg viewBox="0 0 24 24"><path d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 2.49-.95 4.83-2.68 6.57-3.71 3.7-9.73 3.7-13.45 0-3.71-3.7-3.71-9.71 0-13.42 3.71-3.7 9.73-3.7 13.45 0l2.68-2.69v7.56z"/></svg>
              <span>Updates</span>
              <span class="md-nav-badge" id="md-nav-update-indicator"></span>
            </button>
            <button class="md-nav-item" data-tab="about">
              <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
              <span>About</span>
            </button>
          </nav>

          <!-- Scrollable Category Content -->
          <main id="md-content-area">
            <!-- 1. General Category -->
            <div class="md-tab-pane" id="md-tab-general">
              <div class="md-pane-header">
                <h3 class="md-pane-title">General Settings</h3>
                <p class="md-pane-desc">Manage startup behavior and system tray integration</p>
              </div>

              <div class="md-row">
                <div>
                  <div class="md-label">Run at startup</div>
                  <div class="md-sublabel">Launch Messenger automatically when Windows starts</div>
                </div>
                <label class="md-switch">
                  <input type="checkbox" id="md-toggle-startup">
                  <span class="md-slider"></span>
                </label>
              </div>

              <div class="md-row">
                <div>
                  <div class="md-label">Minimize to Tray</div>
                  <div class="md-sublabel">Closing the window hides it to the system tray instead of exiting</div>
                </div>
                <label class="md-switch">
                  <input type="checkbox" id="md-toggle-minimize-tray" checked>
                  <span class="md-slider"></span>
                </label>
              </div>

              <div class="md-row" id="md-row-start-minimized">
                <div>
                  <div class="md-label">Start Minimized to Tray</div>
                  <div class="md-sublabel">Launch Messenger hidden in system tray (requires Minimize to Tray)</div>
                </div>
                <label class="md-switch">
                  <input type="checkbox" id="md-toggle-start-minimized">
                  <span class="md-slider"></span>
                </label>
              </div>
            </div>

            <!-- 2. Notifications Category -->
            <div class="md-tab-pane" id="md-tab-notifications" style="display: none;">
              <div class="md-pane-header">
                <h3 class="md-pane-title">Notifications & Badge</h3>
                <p class="md-pane-desc">Configure native Windows alerts and taskbar indicators</p>
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
                  <div class="md-sublabel">Show sender names without displaying message previews for privacy</div>
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
                <button class="md-action-btn" id="md-test-notif-btn" style="flex:1;">Test Notification</button>
                <button class="md-action-btn" id="md-test-badge-btn" style="flex:1;">Test Unread Badge</button>
              </div>
            </div>

            <!-- 3. Downloads Category -->
            <div class="md-tab-pane" id="md-tab-downloads" style="display: none;">
              <div class="md-pane-header">
                <h3 class="md-pane-title">Downloads</h3>
                <p class="md-pane-desc">Choose where downloaded files are saved on your computer</p>
              </div>

              <div class="md-row" style="flex-direction: column; align-items: stretch; gap: 6px; padding-bottom: 14px;">
                <div class="md-label">Download location</div>
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                  <div class="md-sublabel" id="md-download-path-label" style="min-width: 0; flex: 1; word-break: break-all; font-family: Consolas, monospace; font-size: 11.5px; background: rgba(0,0,0,0.3); padding: 7px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); color: #ced0d4;">
                    Loading...
                  </div>
                  <div style="display: flex; gap: 6px; flex-shrink: 0;">
                    <button class="md-action-btn md-btn-secondary" id="md-change-download-dir-btn" style="padding: 6px 12px; font-size: 12px;" title="Choose a new folder">Change</button>
                    <button class="md-action-btn md-btn-secondary" id="md-open-download-dir-btn" style="padding: 6px 10px; font-size: 12px;" title="Open folder in Windows Explorer">Open</button>
                    <button class="md-action-btn md-btn-secondary" id="md-reset-download-dir-btn" style="display: none; padding: 6px 10px; font-size: 12px;" title="Reset to default Downloads folder">Reset</button>
                  </div>
                </div>
              </div>

              <div class="md-row">
                <div>
                  <div class="md-label">Ask where to save each file before downloading</div>
                  <div class="md-sublabel">Show save file dialog for each download instead of saving automatically</div>
                </div>
                <label class="md-switch">
                  <input type="checkbox" id="md-toggle-ask-download">
                  <span class="md-slider"></span>
                </label>
              </div>
            </div>

            <!-- 4. Updates Category -->
            <div class="md-tab-pane" id="md-tab-updates" style="display: none;">
              <div class="md-pane-header">
                <h3 class="md-pane-title">Software Updates</h3>
                <p class="md-pane-desc">Check for new releases and manage application updates</p>
              </div>

              <div class="md-update-header">
                <div>
                  <div class="md-label" id="md-app-version-label">Messenger Desktop</div>
                  <div class="md-sublabel" id="md-last-check-label" style="font-size:11.5px;color:#8a8d91;margin-top:2px;">Last checked: Never</div>
                </div>
                <button class="md-action-btn md-btn-secondary" id="md-check-update-btn" style="flex:0 0 auto;padding:8px 14px;">Check for Updates</button>
              </div>

              <!-- Update status and progress panel -->
              <div id="md-update-box" style="display:none;margin-top:14px;padding:14px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);">
                <div id="md-update-status-text" style="font-size:13px;font-weight:500;"></div>
                
                <div id="md-update-notes-container" style="display:none;margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,0.3);font-size:12px;color:#ced0d4;max-height:110px;overflow-y:auto;white-space:pre-wrap;line-height:1.4;"></div>

                <div id="md-update-progress-container" style="display:none;margin-top:10px;">
                  <div style="display:flex;justify-content:space-between;font-size:11px;color:#b0b3b8;margin-bottom:4px;">
                    <span id="md-update-progress-label">Downloading update...</span>
                    <span id="md-update-progress-percent">0%</span>
                  </div>
                  <div style="width:100%;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
                    <div id="md-update-progress-bar" style="width:0%;height:100%;background:#0084ff;transition:width 0.15s ease;"></div>
                  </div>
                </div>

                <div id="md-update-actions" style="display:flex;gap:8px;margin-top:12px;">
                  <button class="md-action-btn md-btn-primary" id="md-download-update-btn" style="display:none;">Download and Install</button>
                  <button class="md-action-btn md-btn-primary" id="md-restart-update-btn" style="display:none;">Restart to Update</button>
                  <button class="md-action-btn" id="md-retry-update-btn" style="display:none;">Retry</button>
                </div>
              </div>
            </div>

            <!-- 5. About Category -->
            <div class="md-tab-pane" id="md-tab-about" style="display: none;">
              <div class="md-pane-header">
                <h3 class="md-pane-title">About</h3>
                <p class="md-pane-desc">Application details, links, and system information</p>
              </div>

              <div class="md-about-card">
                <div class="md-about-icon">
                  <svg viewBox="0 0 502 502" width="24" height="24">
                    <path style="fill-rule: evenodd;" d="M501,243.5c0,139.34-109.17,242.5-250,242.5-25.29,0-49.56-3.34-72.37-9.61-4.43-1.23-9.14-.88-13.35.97l-49.62,21.91c-12.98,5.73-27.63-3.5-28.06-17.68l-1.36-44.48c-.17-5.48-2.63-10.6-6.72-14.25C30.87,379.36,1,316.39,1,243.5,1,104.16,110.17,1,251,1s250,103.16,250,242.5Z M318.88,313.31l87.04-134.52c8.75-13.52-7.46-29.26-20.72-20.11l-90.86,62.67c-3.06,2.11-7.1,2.17-10.22.15l-80.65-52.18c-6.83-4.42-15.94-2.46-20.35,4.36l-87.05,134.52c-8.75,13.52,7.46,29.26,20.72,20.11l90.88-62.68c3.06-2.11,7.1-2.17,10.22-.15l80.63,52.17c6.83,4.42,15.94,2.46,20.36-4.36Z"/>
                  </svg>
                </div>
                <div>
                  <div style="font-size:15px;font-weight:600;color:#fff;">Messenger Desktop</div>
                  <div style="font-size:12px;color:#8a8d91;margin-top:2px;" id="md-about-version-label">v0.0.8 (Tauri v2)</div>
                </div>
              </div>

              <div class="md-row" style="border-bottom:none;padding:4px 0 10px 0;">
                <div class="md-sublabel" style="font-size:12.5px;color:#b0b3b8;line-height:1.5;">
                  A fast, privacy-conscious native desktop client for Facebook Messenger with native Windows toast notifications, system tray badge integration, download manager, and drag-and-drop file support.
                </div>
              </div>

              <div class="md-spec-grid">
                <div class="md-spec-item">
                  <div class="md-spec-label">Framework</div>
                  <div class="md-spec-val">Tauri v2 + WebView2</div>
                </div>
                <div class="md-spec-item">
                  <div class="md-spec-label">Platform</div>
                  <div class="md-spec-val">Microsoft Windows (x64)</div>
                </div>
                <div class="md-spec-item">
                  <div class="md-spec-label">License</div>
                  <div class="md-spec-val">MIT License</div>
                </div>
                <div class="md-spec-item">
                  <div class="md-spec-label">Shortcut</div>
                  <div class="md-spec-val"><kbd style="background:#3a3b3c;padding:2px 6px;border-radius:4px;font-size:11px;">Ctrl</kbd> + <kbd style="background:#3a3b3c;padding:2px 6px;border-radius:4px;font-size:11px;">,</kbd></div>
                </div>
              </div>

              <div class="md-section-divider"></div>

              <div style="display:flex;gap:16px;font-size:12.5px;">
                <a href="https://github.com/itsHuaan/messenger" target="_blank" class="md-link">GitHub Repository ↗</a>
                <a href="https://github.com/itsHuaan/messenger/releases" target="_blank" class="md-link">Releases & Changelog ↗</a>
                <a href="https://github.com/itsHuaan/messenger/issues" target="_blank" class="md-link">Report an Issue ↗</a>
              </div>
            </div>
          </main>
        </div>
      </div>
    `;

    container.appendChild(btn);
    container.appendChild(modal);
    document.body.appendChild(container);

    // Stop click events inside the card from propagating to backdrop
    const settingsCard = document.getElementById('md-settings-card');
    if (settingsCard) {
      settingsCard.addEventListener('click', e => {
        e.stopPropagation();
      });
    }

    // Category navigation handling
    const navButtons = modal.querySelectorAll('.md-nav-item');
    const tabPanes = modal.querySelectorAll('.md-tab-pane');

    function selectCategory(tabId) {
      navButtons.forEach(btn => {
        if (btn.dataset.tab === tabId) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      tabPanes.forEach(pane => {
        if (pane.id === `md-tab-${tabId}`) {
          pane.style.display = 'block';
        } else {
          pane.style.display = 'none';
        }
      });

      const contentArea = document.getElementById('md-content-area');
      if (contentArea) {
        contentArea.scrollTop = 0;
      }
    }

    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        selectCategory(btn.dataset.tab);
      });
    });

    // Independent Scroll Isolation: prevent wheel and touch chaining from leaking to Messenger
    function handleModalWheel(e) {
      const scrollable = e.target.closest('#md-content-area, #md-sidebar');
      if (!scrollable) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (scrollable.scrollHeight <= scrollable.clientHeight) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const delta = e.deltaY;
      const atTop = scrollable.scrollTop <= 0 && delta < 0;
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1 && delta > 0;

      if (atTop || atBottom) {
        e.preventDefault();
      }
      e.stopPropagation();
    }

    function handleModalTouch(e) {
      const scrollable = e.target.closest('#md-content-area, #md-sidebar');
      if (!scrollable) {
        e.preventDefault();
      }
      e.stopPropagation();
    }

    // Event listeners
    let defaultDownloadDir = '';
    let lastFocusedElement = null;

    const updateDownloadDirUI = () => {
      const pathLabel = document.getElementById('md-download-path-label');
      const resetBtn = document.getElementById('md-reset-download-dir-btn');
      const askToggle = document.getElementById('md-toggle-ask-download');

      if (askToggle) {
        askToggle.checked = !!appSettings.ask_download_location;
      }

      if (appSettings.download_dir) {
        if (pathLabel) pathLabel.textContent = appSettings.download_dir;
        if (resetBtn) resetBtn.style.display = 'inline-block';
      } else {
        if (pathLabel) {
          pathLabel.textContent = defaultDownloadDir ? `${defaultDownloadDir} (Default)` : 'Default Downloads Folder';
        }
        if (resetBtn) resetBtn.style.display = 'none';
      }
    };

    const openModal = () => {
      lastFocusedElement = document.activeElement;

      document.getElementById('md-toggle-notifications').checked = !!appSettings.notifications_enabled;
      document.getElementById('md-toggle-badge').checked = !!appSettings.badge_enabled;
      document.getElementById('md-toggle-hide-content').checked = !!appSettings.hide_message_content;
      document.getElementById('md-toggle-startup').checked = !!appSettings.run_at_startup;
      document.getElementById('md-badge-color').value = appSettings.badge_color || '#F52D2D';

      updateDownloadDirUI();
      invoke('get_default_download_dir')
        .then(dir => {
          defaultDownloadDir = dir || '';
          updateDownloadDirUI();
        })
        .catch(() => {
          updateDownloadDirUI();
        });

      const minToTrayChecked = appSettings.minimize_to_tray !== false;
      const toggleMinTray = document.getElementById('md-toggle-minimize-tray');
      if (toggleMinTray) {
        toggleMinTray.checked = minToTrayChecked;
      }
      const toggleStartMin = document.getElementById('md-toggle-start-minimized');
      const rowStartMin = document.getElementById('md-row-start-minimized');
      if (toggleStartMin) {
        toggleStartMin.checked = !!appSettings.start_minimized_to_tray;
        toggleStartMin.disabled = !minToTrayChecked;
      }
      if (rowStartMin) {
        rowStartMin.style.opacity = minToTrayChecked ? '1' : '0.5';
      }

      // Query version and last check time
      invoke('get_update_status')
        .then(status => {
          if (status) {
            if (status.current_version) {
              const versionStr = `Messenger Desktop v${status.current_version}`;
              document.getElementById('md-app-version-label').textContent = versionStr;
              const aboutVersion = document.getElementById('md-about-version-label');
              if (aboutVersion) aboutVersion.textContent = `v${status.current_version} (Tauri v2)`;
            }
            if (status.last_check) {
              document.getElementById('md-last-check-label').textContent = `Last checked: ${status.last_check}`;
            }
          }
        })
        .catch(console.error);

      modal.style.display = 'flex';
      modal.addEventListener('wheel', handleModalWheel, { passive: false });
      modal.addEventListener('touchmove', handleModalTouch, { passive: false });
    };

    const closeModal = () => {
      modal.style.display = 'none';
      modal.removeEventListener('wheel', handleModalWheel);
      modal.removeEventListener('touchmove', handleModalTouch);
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        try { lastFocusedElement.focus(); } catch (_) { }
      }
    };

    btn.addEventListener('click', openModal);
    document.getElementById('md-close-btn').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    window.addEventListener('keydown', e => {
      if ((e.ctrlKey && e.key === ',') || (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's'))) {
        e.preventDefault();
        if (modal.style.display === 'flex') closeModal(); else openModal();
      } else if (e.key === 'Escape' && modal.style.display === 'flex') {
        e.preventDefault();
        closeModal();
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

    // Toggle: Run at startup
    document.getElementById('md-toggle-startup').addEventListener('change', e => {
      const enabled = e.target.checked;
      appSettings.run_at_startup = enabled;
      invoke('set_run_at_startup', { enabled }).catch(err => {
        console.error('[Messenger Desktop] Error setting run at startup:', err);
        // Revert switch on error
        e.target.checked = !enabled;
        appSettings.run_at_startup = !enabled;
      });
    });

    // Toggle: Minimize to Tray
    const toggleMinTray = document.getElementById('md-toggle-minimize-tray');
    if (toggleMinTray) {
      toggleMinTray.addEventListener('change', e => {
        const enabled = e.target.checked;
        appSettings.minimize_to_tray = enabled;

        const toggleStartMin = document.getElementById('md-toggle-start-minimized');
        const rowStartMin = document.getElementById('md-row-start-minimized');
        if (toggleStartMin) {
          toggleStartMin.disabled = !enabled;
        }
        if (rowStartMin) {
          rowStartMin.style.opacity = enabled ? '1' : '0.5';
        }

        invoke('set_minimize_to_tray', { enabled }).catch(err => {
          console.error('[Messenger Desktop] Error setting minimize to tray:', err);
          e.target.checked = !enabled;
          appSettings.minimize_to_tray = !enabled;
        });
      });
    }

    // Toggle: Start Minimized to Tray
    const toggleStartMin = document.getElementById('md-toggle-start-minimized');
    if (toggleStartMin) {
      toggleStartMin.addEventListener('change', e => {
        const enabled = e.target.checked;
        appSettings.start_minimized_to_tray = enabled;
        invoke('set_start_minimized_to_tray', { enabled }).catch(err => {
          console.error('[Messenger Desktop] Error setting start minimized to tray:', err);
          e.target.checked = !enabled;
          appSettings.start_minimized_to_tray = !enabled;
        });
      });
    }

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

    // ==========================================
    // Download Location Controls
    // ==========================================
    const changeDirBtn = document.getElementById('md-change-download-dir-btn');
    if (changeDirBtn) {
      changeDirBtn.addEventListener('click', () => {
        invoke('choose_download_dir')
          .then(newSettings => {
            if (newSettings) {
              appSettings = newSettings;
              updateDownloadDirUI();
            }
          })
          .catch(err => {
            console.error('[Messenger Desktop] Error choosing download folder:', err);
          });
      });
    }

    const openDirBtn = document.getElementById('md-open-download-dir-btn');
    if (openDirBtn) {
      openDirBtn.addEventListener('click', () => {
        invoke('open_download_dir').catch(err => {
          console.error('[Messenger Desktop] Error opening download folder:', err);
        });
      });
    }

    const resetDirBtn = document.getElementById('md-reset-download-dir-btn');
    if (resetDirBtn) {
      resetDirBtn.addEventListener('click', () => {
        invoke('set_download_dir', { path: null })
          .then(newSettings => {
            if (newSettings) {
              appSettings = newSettings;
              updateDownloadDirUI();
            }
          })
          .catch(err => {
            console.error('[Messenger Desktop] Error resetting download folder:', err);
          });
      });
    }

    const askDownloadToggle = document.getElementById('md-toggle-ask-download');
    if (askDownloadToggle) {
      askDownloadToggle.addEventListener('change', e => {
        const enabled = e.target.checked;
        appSettings.ask_download_location = enabled;
        invoke('set_ask_download_location', { enabled }).catch(err => {
          console.error('[Messenger Desktop] Error setting ask download location:', err);
          e.target.checked = !enabled;
          appSettings.ask_download_location = !enabled;
        });
      });
    }

    // ==========================================
    // Update Manager Controls
    // ==========================================
    const checkBtn = document.getElementById('md-check-update-btn');
    const updateBox = document.getElementById('md-update-box');
    const statusText = document.getElementById('md-update-status-text');
    const notesContainer = document.getElementById('md-update-notes-container');
    const progressContainer = document.getElementById('md-update-progress-container');
    const progressLabel = document.getElementById('md-update-progress-label');
    const progressPercent = document.getElementById('md-update-progress-percent');
    const progressBar = document.getElementById('md-update-progress-bar');
    const downloadBtn = document.getElementById('md-download-update-btn');
    const restartBtn = document.getElementById('md-restart-update-btn');
    const retryBtn = document.getElementById('md-retry-update-btn');
    const indicator = document.getElementById('md-update-indicator');

    let isCheckingUpdates = false;
    let isDownloadingUpdate = false;

    // Background download progress event listener
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('update-download-progress', evt => {
        const payload = evt.payload || {};
        const pct = payload.percent != null ? payload.percent : 0;
        progressPercent.textContent = `${pct}%`;
        progressBar.style.width = `${pct}%`;
        if (payload.total) {
          const dlMB = (payload.downloaded / (1024 * 1024)).toFixed(1);
          const totMB = (payload.total / (1024 * 1024)).toFixed(1);
          progressLabel.textContent = `Downloading: ${dlMB} MB / ${totMB} MB`;
        }
      }).catch(console.error);

      window.__TAURI__.event.listen('update-download-complete', evt => {
        progressContainer.style.display = 'none';
        downloadBtn.style.display = 'none';
        restartBtn.style.display = 'inline-block';
        const v = (evt.payload && evt.payload.version) ? ` v${evt.payload.version}` : '';
        statusText.style.color = '#31a24c';
        statusText.textContent = `Update${v} ready to install. Restart Messenger to apply.`;
      }).catch(console.error);
    }

    const performUpdateCheck = () => {
      if (isCheckingUpdates || isDownloadingUpdate) return;
      isCheckingUpdates = true;

      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking...';
      updateBox.style.display = 'block';
      statusText.style.color = '#e4e6eb';
      statusText.textContent = 'Checking for updates...';
      notesContainer.style.display = 'none';
      progressContainer.style.display = 'none';
      downloadBtn.style.display = 'none';
      restartBtn.style.display = 'none';
      retryBtn.style.display = 'none';

      invoke('check_for_updates')
        .then(info => {
          isCheckingUpdates = false;
          checkBtn.disabled = false;
          checkBtn.textContent = 'Check for Updates';

          if (info.current_version) {
            document.getElementById('md-app-version-label').textContent = `Messenger Desktop v${info.current_version}`;
          }
          if (info.last_check) {
            document.getElementById('md-last-check-label').textContent = `Last checked: ${info.last_check}`;
          }

          if (info.available) {
            indicator.style.display = 'block';
            const navUpdateDot = document.getElementById('md-nav-update-indicator');
            if (navUpdateDot) navUpdateDot.style.display = 'inline-block';
            statusText.textContent = `Update available: v${info.version}`;
            statusText.style.color = '#31a24c';

            if (info.body && info.body.trim()) {
              notesContainer.textContent = info.body.trim();
              notesContainer.style.display = 'block';
            } else {
              notesContainer.style.display = 'none';
            }

            downloadBtn.style.display = 'inline-block';
          } else {
            indicator.style.display = 'none';
            const navUpdateDot = document.getElementById('md-nav-update-indicator');
            if (navUpdateDot) navUpdateDot.style.display = 'none';
            statusText.textContent = `You're up to date! Version ${info.current_version} is the latest release.`;
            statusText.style.color = '#2e89ff';
          }
        })
        .catch(err => {
          isCheckingUpdates = false;
          checkBtn.disabled = false;
          checkBtn.textContent = 'Check for Updates';
          statusText.style.color = '#fa383e';
          statusText.textContent = typeof err === 'string' ? err : (err.message || 'Update check failed.');
          retryBtn.style.display = 'inline-block';
          console.warn('[Messenger Desktop] Update check failed:', err);
        });
    };

    checkBtn.addEventListener('click', performUpdateCheck);
    retryBtn.addEventListener('click', performUpdateCheck);

    downloadBtn.addEventListener('click', () => {
      if (isDownloadingUpdate) return;
      isDownloadingUpdate = true;

      downloadBtn.disabled = true;
      checkBtn.disabled = true;
      retryBtn.style.display = 'none';
      progressContainer.style.display = 'block';
      progressBar.style.width = '0%';
      progressPercent.textContent = '0%';
      progressLabel.textContent = 'Starting download...';
      statusText.style.color = '#e4e6eb';
      statusText.textContent = 'Downloading update in the background...';

      invoke('download_update')
        .then(version => {
          isDownloadingUpdate = false;
          checkBtn.disabled = false;
          progressContainer.style.display = 'none';
          downloadBtn.style.display = 'none';
          restartBtn.style.display = 'inline-block';
          statusText.style.color = '#31a24c';
          statusText.textContent = `Update v${version} downloaded and verified! Restart Messenger to apply.`;
        })
        .catch(err => {
          isDownloadingUpdate = false;
          checkBtn.disabled = false;
          downloadBtn.disabled = false;
          progressContainer.style.display = 'none';
          statusText.style.color = '#fa383e';
          statusText.textContent = typeof err === 'string' ? err : (err.message || 'Download failed.');
          retryBtn.style.display = 'inline-block';
          console.error('[Messenger Desktop] Download failed:', err);
        });
    });

    restartBtn.addEventListener('click', () => {
      restartBtn.disabled = true;
      restartBtn.textContent = 'Restarting...';
      statusText.textContent = 'Launching installer and updating Messenger...';
      invoke('install_and_restart').catch(err => {
        restartBtn.disabled = false;
        restartBtn.textContent = 'Restart to Update';
        alert('Failed to launch installer: ' + err);
      });
    });

    // Expose programmatic trigger for manual updater (used by system tray context menu)
    window.__MESSENGER_DESKTOP_CHECK_UPDATES__ = () => {
      openModal();
      selectCategory('updates');
      performUpdateCheck();
    };

    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('trigger-check-updates', () => {
        openModal();
        selectCategory('updates');
        performUpdateCheck();
      }).catch(console.error);
    }
  }

  // ==========================================
  // Drag-and-Drop File Upload Support
  // ==========================================
  function setupDragAndDrop() {
    // Ensure Windows Explorer file dragging displays a copy cursor over the webview
    window.addEventListener('dragover', e => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    // Support dropping files anywhere on the Messenger window
    window.addEventListener('drop', e => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;

      const mainChat = document.querySelector(SELECTORS.activeMessageContainer);
      const composer = document.querySelector(SELECTORS.messageComposer);
      const target = composer || mainChat;

      // If dropped directly onto the chat conversation or composer, Messenger's native drop zone handles it
      if (e.target && (e.target === target || (target && target.contains(e.target)))) {
        return;
      }

      // If dropped outside the active chat area (e.g. on sidebar or header), forward to the active chat
      if (target) {
        try {
          const dropEvt = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: e.dataTransfer
          });
          target.dispatchEvent(dropEvt);
          console.log('[Messenger Desktop] Forwarded dropped files to active chat area');
        } catch (err) {
          console.warn('[Messenger Desktop] Could not forward drop event:', err);
        }
      }
    });
  }

  // ==========================================
  // Native File Download Support
  // ==========================================
  const DOWNLOAD_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    'txt', 'csv', 'rtf', 'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'mp4', 'mkv', 'avi', 'mov',
    'wmv', 'webm', 'm4v', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
    'ico', 'exe', 'msi', 'apk', 'dmg', 'iso'
  ]);

  function isDownloadUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') return false;
    if (urlString.startsWith('blob:')) return true;

    try {
      const u = new URL(urlString, window.location.href);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();

      // Facebook / Messenger attachment domains
      if (host === 'cdn.fbsbx.com' || host.endsWith('.fbsbx.com') || host === 'lookaside.fbsbx.com') {
        return true;
      }
      if (
        host.endsWith('.fbcdn.net') &&
        (path.includes('/v/') ||
          u.searchParams.get('dl') === '1' ||
          u.searchParams.get('attachment') === '1')
      ) {
        return true;
      }

      // Check file extensions
      const extMatch = path.match(/\.([a-z0-9]+)$/);
      if (extMatch && DOWNLOAD_EXTENSIONS.has(extMatch[1])) {
        return true;
      }

      // Query param explicitly indicating download
      if (
        u.searchParams.get('dl') === '1' ||
        u.searchParams.get('download') === '1' ||
        u.searchParams.get('download') === 'true'
      ) {
        return true;
      }
    } catch (_) { }
    return false;
  }

  function triggerDownload(url, suggestedName = '') {
    if (!url) return;
    try {
      const a = document.createElement('a');
      a.href = url;
      if (suggestedName) {
        a.download = suggestedName;
      } else {
        a.setAttribute('download', '');
      }
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) {
          a.parentNode.removeChild(a);
        }
      }, 150);
    } catch (err) {
      console.warn('[Messenger Desktop] Error triggering download:', err);
    }
  }

  window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__ = triggerDownload;

  // Intercept programmatic anchor clicks so that target="_blank" doesn't open an external browser
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      if (this.hasAttribute('download') || isDownloadUrl(this.href)) {
        this.removeAttribute('target');
      }
    } catch (_) { }
    return originalAnchorClick.apply(this, arguments);
  };

  // Intercept user DOM clicks for attachments and download actions
  function setupDownloadInterception() {
    window.addEventListener(
      'click',
      e => {
        const target = e.target;
        if (!target) return;

        // 1. Check if an anchor tag was clicked
        const anchor = target.closest('a');
        if (anchor && anchor.href) {
          const href = anchor.href;
          if (anchor.hasAttribute('download') || isDownloadUrl(href)) {
            if (anchor.target === '_blank') {
              e.preventDefault();
              e.stopPropagation();
              triggerDownload(href, anchor.download || '');
              return;
            }
          }
        }

        // 2. Check if a download button was clicked in media viewer / attachments
        const downloadBtn = target.closest(
          '[role="button"][aria-label*="Download" i], ' +
          '[role="button"][aria-label*="Tải xuống" i], ' +
          '[role="button"][title*="Download" i], ' +
          '[role="button"][title*="Tải xuống" i], ' +
          '[aria-label*="Download photo" i], ' +
          '[aria-label*="Download video" i], ' +
          '[aria-label*="Tải ảnh xuống" i], ' +
          '[aria-label*="Tải video xuống" i]'
        );
        if (downloadBtn) {
          console.log('[Messenger Desktop] Download button activated in UI');
        }
      },
      true
    );
  }

  // ==========================================
  // Download Manager UI Feedback
  // ==========================================
  function setupDownloadManagerUI() {
    const activeDownloads = new Map();

    // Inject slide-in animation styles if not already present
    if (!document.getElementById('md-download-styles')) {
      const style = document.createElement('style');
      style.id = 'md-download-styles';
      style.textContent = `
        @keyframes md-download-slide-in {
          from { opacity: 0; transform: translateY(-16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes md-indeterminate-bar {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .md-dl-open-btn:hover { background: #1877f2 !important; }
        .md-dl-folder-btn:hover { background: #4e4f50 !important; }
        .md-dl-cancel-btn:hover { color: #ffffff !important; background: rgba(255, 255, 255, 0.1) !important; }
      `;
      document.head.appendChild(style);
    }

    const container = document.createElement('div');
    container.id = 'md-download-manager-container';
    container.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      width: 360px;
      max-width: calc(100vw - 48px);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;
    document.body.appendChild(container);

    function formatBytes(bytes) {
      if (!bytes || bytes <= 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function getFileIcon(filename) {
      const ext = (filename.split('.').pop() || '').toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
        return '🖼️';
      }
      if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'].includes(ext)) {
        return '🎬';
      }
      if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) {
        return '🎵';
      }
      if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'].includes(ext)) {
        return '📄';
      }
      if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
        return '📦';
      }
      return '📁';
    }

    function createOrUpdateDownloadCard(payload, status = 'downloading') {
      let card = activeDownloads.get(payload.id);
      if (!card) {
        card = document.createElement('div');
        card.id = `md-dl-${payload.id}`;
        card.style.cssText = `
          pointer-events: auto;
          background: #242526;
          color: #e4e6eb;
          border: 1px solid #3a3b3c;
          border-radius: 12px;
          padding: 14px 16px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          animation: md-download-slide-in 0.25s ease;
        `;

        card.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <span class="md-dl-icon" style="font-size: 18px;">${getFileIcon(payload.filename)}</span>
              <span class="md-dl-title" title="${payload.filename}" style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px;">
                ${payload.filename}
              </span>
            </div>
            <button class="md-dl-cancel-btn" title="Cancel Download" style="background: transparent; border: none; color: #b0b3b8; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; transition: all 0.15s ease;">✕</button>
          </div>
          <div class="md-dl-progress-bar-bg" style="width: 100%; height: 6px; background: #3a3b3c; border-radius: 3px; overflow: hidden; position: relative;">
            <div class="md-dl-progress-bar-fill" style="width: 0%; height: 100%; background: #2e89ff; border-radius: 3px; transition: width 0.2s ease;"></div>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #b0b3b8;">
            <span class="md-dl-status-text">Starting download...</span>
            <span class="md-dl-percent-text">0%</span>
          </div>
          <div class="md-dl-actions" style="display: none; align-items: center; gap: 10px; margin-top: 2px;">
            <button class="md-dl-open-btn" style="background: #2e89ff; color: white; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.15s ease;">Open</button>
            <button class="md-dl-folder-btn" style="background: #3a3b3c; color: #e4e6eb; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.15s ease;">Show in Folder</button>
          </div>
        `;

        const cancelBtn = card.querySelector('.md-dl-cancel-btn');
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          invoke('cancel_download', { id: payload.id }).catch(() => { });
          removeCard(payload.id);
        });

        container.appendChild(card);
        activeDownloads.set(payload.id, card);
      }

      if (payload.path) {
        card.dataset.filePath = payload.path;
      }

      const barFill = card.querySelector('.md-dl-progress-bar-fill');
      const statusText = card.querySelector('.md-dl-status-text');
      const percentText = card.querySelector('.md-dl-percent-text');
      const actionsDiv = card.querySelector('.md-dl-actions');
      const cancelBtn = card.querySelector('.md-dl-cancel-btn');

      if (status === 'downloading') {
        if (payload.percent != null) {
          barFill.style.width = `${payload.percent}%`;
          barFill.style.background = '#2e89ff';
          percentText.textContent = `${payload.percent}%`;
        } else {
          // Indeterminate progress
          barFill.style.width = '100%';
          barFill.style.background = 'linear-gradient(90deg, #2e89ff 0%, #45bd62 50%, #2e89ff 100%)';
          barFill.style.backgroundSize = '200% 200%';
          barFill.style.animation = 'md-indeterminate-bar 2s ease infinite';
          percentText.textContent = '';
        }

        const receivedStr = formatBytes(payload.received_bytes || 0);
        if (payload.total_bytes) {
          statusText.textContent = `${receivedStr} / ${formatBytes(payload.total_bytes)}`;
        } else {
          statusText.textContent = `${receivedStr} downloaded`;
        }
      } else if (status === 'completed') {
        barFill.style.width = '100%';
        barFill.style.background = '#31a24c';
        barFill.style.animation = 'none';
        statusText.style.color = '#31a24c';
        statusText.textContent = `Completed (${formatBytes(payload.total_bytes)})`;
        percentText.textContent = '100%';
        actionsDiv.style.display = 'flex';

        // Keep close button so user can dismiss anytime
        cancelBtn.title = 'Dismiss';
        cancelBtn.style.display = 'block';
        cancelBtn.onclick = (e) => {
          e.stopPropagation();
          removeCard(payload.id);
        };

        const openBtn = card.querySelector('.md-dl-open-btn');
        openBtn.onclick = (e) => {
          e.stopPropagation();
          const targetPath = payload.path || card.dataset.filePath;
          if (!targetPath) return;
          invoke('open_downloaded_file', { path: targetPath }).catch(err => {
            console.error('[Messenger Desktop] open_downloaded_file error:', err);
            statusText.style.color = '#fa383e';
            statusText.textContent = 'Could not open file';
          });
        };

        const folderBtn = card.querySelector('.md-dl-folder-btn');
        folderBtn.onclick = (e) => {
          e.stopPropagation();
          const targetPath = payload.path || card.dataset.filePath;
          if (!targetPath) return;
          invoke('show_in_folder', { path: targetPath }).catch(err => {
            console.error('[Messenger Desktop] show_in_folder error:', err);
            statusText.style.color = '#fa383e';
            statusText.textContent = 'Could not reveal folder';
          });
        };

        // Automatically dismiss completed card after 8 seconds, pausing on hover
        let dismissTimer = null;
        const scheduleDismiss = (ms) => {
          if (dismissTimer) clearTimeout(dismissTimer);
          dismissTimer = setTimeout(() => {
            removeCard(payload.id);
          }, ms);
        };

        card.onmouseenter = () => {
          if (dismissTimer) {
            clearTimeout(dismissTimer);
            dismissTimer = null;
          }
        };

        card.onmouseleave = () => {
          scheduleDismiss(3000);
        };

        scheduleDismiss(5000);
      } else if (status === 'error') {
        barFill.style.background = '#fa383e';
        barFill.style.animation = 'none';
        statusText.style.color = '#fa383e';
        statusText.textContent = payload.error || 'Download failed';
        percentText.textContent = 'Error';
        setTimeout(() => {
          removeCard(payload.id);
        }, 5000);
      }
    }

    function removeCard(id) {
      const card = activeDownloads.get(id);
      if (card) {
        card.style.opacity = '0';
        card.style.transform = 'translateY(-10px)';
        setTimeout(() => {
          if (card.parentNode) {
            card.parentNode.removeChild(card);
          }
          activeDownloads.delete(id);
        }, 250);
      }
    }

    // Attach listeners to Tauri events
    if (
      window.__TAURI__ &&
      window.__TAURI__.event &&
      typeof window.__TAURI__.event.listen === 'function'
    ) {
      window.__TAURI__.event.listen('download-started', evt => {
        createOrUpdateDownloadCard(evt.payload || {}, 'downloading');
      });

      window.__TAURI__.event.listen('download-progress', evt => {
        createOrUpdateDownloadCard(evt.payload || {}, 'downloading');
      });

      window.__TAURI__.event.listen('download-completed', evt => {
        createOrUpdateDownloadCard(evt.payload || {}, 'completed');
      });

      window.__TAURI__.event.listen('download-error', evt => {
        createOrUpdateDownloadCard(evt.payload || {}, 'error');
      });
    }
  }

  // Inject UI when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createSettingsUI();
      setupDragAndDrop();
      setupDownloadInterception();
      setupDownloadManagerUI();
    });
  } else {
    createSettingsUI();
    setupDragAndDrop();
    setupDownloadInterception();
    setupDownloadManagerUI();
  }
})();
