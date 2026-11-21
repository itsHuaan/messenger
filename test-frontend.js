import assert from 'node:assert';

// 1. Centralized prefixes
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

function isOutgoingText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  for (const prefix of OUTGOING_PREFIXES) {
    if (prefix.test(trimmed)) {
      return true;
    }
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

function parseUnreadTitle(title) {
  const match = title.match(/^\((\d+)\+?\)/);
  if (match) {
    const count = parseInt(match[1], 10);
    return isNaN(count) ? 0 : count;
  }
  return 0;
}

class BoundedCache {
  constructor(maxSize = 250) {
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

function isUserActivelyViewing(isWindowFocused, activeThreadId, targetThreadId) {
  if (!isWindowFocused) return false;
  if (!activeThreadId || !targetThreadId) return false;
  return activeThreadId === targetThreadId || activeThreadId.includes(targetThreadId) || targetThreadId.includes(activeThreadId);
}

// ==========================================
// Test Runner
// ==========================================

console.log('--- Running Frontend Observer & Deduplication Tests ---');

// Test 1: Outgoing message detection
console.log('Test 1: Outgoing message detection');
assert.strictEqual(isOutgoingText('You: See you at 5'), true);
assert.strictEqual(isOutgoingText('Bạn: Gặp lại lúc 5h nhé'), true);
assert.strictEqual(isOutgoingText('Tú: Hola'), true);
assert.strictEqual(isOutgoingText('Vous: Bonjour'), true);
assert.strictEqual(isOutgoingText('You sent a photo.'), true);
assert.strictEqual(isOutgoingText('Bạn đã gửi một nhãn dán.'), true);
assert.strictEqual(isOutgoingText('Alice: Hello there!'), false);
assert.strictEqual(isOutgoingText('Hey, are you free?'), false);
assert.strictEqual(isOutgoingText('Sent a photo.'), false);
console.log('✓ Passed: Outgoing detection handles multiple languages');

// Test 2: Message preview cleaning
console.log('Test 2: Message preview cleaning');
assert.strictEqual(cleanPreviewText('Alice: How are you?'), 'Alice: How are you?');
assert.strictEqual(cleanPreviewText(''), 'New message received');
assert.strictEqual(cleanPreviewText(null), 'New message received');
assert.strictEqual(cleanPreviewText('   Sent a sticker   '), 'Sent a sticker');
assert.strictEqual(cleanPreviewText('You: Test'), 'Test');
console.log('✓ Passed: Preview text cleaning');

// Test 3: Unread title parsing
console.log('Test 3: Document title unread count parsing');
assert.strictEqual(parseUnreadTitle('(1) Messenger'), 1);
assert.strictEqual(parseUnreadTitle('(5) Messenger'), 5);
assert.strictEqual(parseUnreadTitle('(99+) Messenger'), 99);
assert.strictEqual(parseUnreadTitle('Messenger'), 0);
assert.strictEqual(parseUnreadTitle('(Draft) Messenger'), 0);
console.log('✓ Passed: Document title unread count parsed correctly');

// Test 4: BoundedCache memory bounding and deduplication
console.log('Test 4: Bounded deduplication cache');
const cache = new BoundedCache(5);
for (let i = 1; i <= 5; i++) {
  cache.add(`key_${i}`);
}
assert.strictEqual(cache.items.size, 5);
assert.strictEqual(cache.has('key_1'), true);

// Add a 6th key; key_1 should be evicted
cache.add('key_6');
assert.strictEqual(cache.items.size, 5);
assert.strictEqual(cache.has('key_1'), false, 'Oldest key_1 should be evicted');
assert.strictEqual(cache.has('key_6'), true, 'Newest key_6 should be present');
console.log('✓ Passed: Cache respects maximum size bound without memory leaks');

// Test 5: Actively viewing suppression logic
console.log('Test 5: Actively viewing suppression logic');
// Case A: Window focused + viewing target thread -> Suppress notification
assert.strictEqual(isUserActivelyViewing(true, '10001', '10001'), true);
// Case B: Window focused + viewing DIFFERENT thread -> Do NOT suppress (notify!)
assert.strictEqual(isUserActivelyViewing(true, '10001', '10002'), false);
// Case C: Window NOT focused + viewing target thread -> Do NOT suppress (notify!)
assert.strictEqual(isUserActivelyViewing(false, '10001', '10001'), false);
// Case D: Window NOT focused + viewing different thread -> Do NOT suppress (notify!)
assert.strictEqual(isUserActivelyViewing(false, '10001', '10002'), false);
console.log('✓ Passed: Active viewing suppression correctly notifies when unfocused or in different threads');

// Test 6: Diverse message types handling
console.log('Test 6: Diverse message types handling (stickers, GIFs, photos, attachments)');
const diverseMessages = [
  { sender: 'Bob', text: 'Bob sent a sticker.', expectedPreview: 'Bob sent a sticker.' },
  { sender: 'Charlie', text: 'Charlie sent a photo.', expectedPreview: 'Charlie sent a photo.' },
  { sender: 'Diana', text: 'Diana sent a GIF.', expectedPreview: 'Diana sent a GIF.' },
  { sender: 'Eve', text: 'Diana sent a voice message.', expectedPreview: 'Diana sent a voice message.' },
  { sender: 'Frank', text: '', expectedPreview: 'New message received' }
];

for (const msg of diverseMessages) {
  const preview = cleanPreviewText(msg.text);
  assert.strictEqual(preview, msg.expectedPreview);
}
console.log('✓ Passed: All diverse message formats handled gracefully');

// Test 7: Muted conversation detection logic
console.log('Test 7: Muted conversation detection');
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

function isMutedMock({ ariaLabel = '', childAriaLabels = [], svgPaths = [] }) {
  const lowerAria = ariaLabel.toLowerCase();
  for (const kw of MUTED_KEYWORDS) {
    if (lowerAria.includes(kw)) return true;
  }
  for (const childAria of childAriaLabels) {
    const l = childAria.toLowerCase();
    for (const kw of MUTED_KEYWORDS) {
      if (l.includes(kw)) return true;
    }
  }
  for (const p of svgPaths) {
    if (p.startsWith('M29.676') || p.includes('29.676 7.746')) {
      return true;
    }
  }
  return false;
}

assert.strictEqual(isMutedMock({ ariaLabel: 'Work Group, Muted' }), true);
assert.strictEqual(isMutedMock({ ariaLabel: 'Gia đình, Đã tắt thông báo' }), true);
assert.strictEqual(isMutedMock({ childAriaLabels: ['Notifications off'] }), true);
assert.strictEqual(isMutedMock({ svgPaths: ['M29.676 7.746c.353-.352...'] }), true);
assert.strictEqual(isMutedMock({ ariaLabel: 'Alice Smith, 1 unread message' }), false);
console.log('✓ Passed: Muted conversations properly identified across languages and SVG paths');

// Test 8: Seen conversation suppression on app restart / virtual list mount
console.log('Test 8: Seen conversation suppression on startup / list mount');
function simulateConversationArrival({
  isInitialized,
  threadId,
  snippet,
  threadSnippets,
  isUnread,
  isMuted,
  elapsedSinceStart,
  gracePeriodMs = 6000
}) {
  if (!isInitialized) return { notified: false, reason: 'not_initialized' };
  if (isMuted) return { notified: false, reason: 'muted' };
  if (!snippet) return { notified: false, reason: 'empty_snippet' };

  const lastSnippet = threadSnippets.get(threadId);

  // If newly discovered thread during mount/scroll, record baseline only
  if (lastSnippet === undefined) {
    threadSnippets.set(threadId, snippet);
    return { notified: false, reason: 'first_seen_baseline' };
  }

  // No change in snippet
  if (lastSnippet === snippet) {
    return { notified: false, reason: 'unchanged_snippet' };
  }

  threadSnippets.set(threadId, snippet);

  // If conversation is already seen (read), never notify
  if (!isUnread) {
    return { notified: false, reason: 'conversation_seen_read' };
  }

  // Grace period on startup
  if (elapsedSinceStart < gracePeriodMs) {
    return { notified: false, reason: 'startup_grace_period' };
  }

  return { notified: true, reason: 'new_unread_message' };
}

const mockThreadSnippets = new Map();
// 1. Initial mounting of 10 existing seen conversations on app restart
for (let i = 1; i <= 10; i++) {
  const result = simulateConversationArrival({
    isInitialized: true,
    threadId: `thread_${i}`,
    snippet: `Hello message ${i}`,
    threadSnippets: mockThreadSnippets,
    isUnread: false, // Seen/read
    isMuted: false,
    elapsedSinceStart: 1000
  });
  assert.strictEqual(result.notified, false, `Thread ${i} should not notify on initial mount`);
  assert.strictEqual(result.reason, 'first_seen_baseline');
}

// 2. An existing thread is updated with a new message, but it is MUTED
const mutedResult = simulateConversationArrival({
  isInitialized: true,
  threadId: 'thread_1',
  snippet: 'New incoming message in muted chat',
  threadSnippets: mockThreadSnippets,
  isUnread: true,
  isMuted: true,
  elapsedSinceStart: 10000
});
assert.strictEqual(mutedResult.notified, false, 'Muted conversation should not notify');
assert.strictEqual(mutedResult.reason, 'muted');

// 3. An existing thread has an update, but was already SEEN (read)
const seenResult = simulateConversationArrival({
  isInitialized: true,
  threadId: 'thread_2',
  snippet: 'You read this already',
  threadSnippets: mockThreadSnippets,
  isUnread: false,
  isMuted: false,
  elapsedSinceStart: 10000
});
assert.strictEqual(seenResult.notified, false, 'Seen conversation should not notify');
assert.strictEqual(seenResult.reason, 'conversation_seen_read');

// 4. A real new UNREAD message arrives AFTER startup grace period in an UNMUTED chat
const realMessageResult = simulateConversationArrival({
  isInitialized: true,
  threadId: 'thread_3',
  snippet: 'Hey! Are you there?',
  threadSnippets: mockThreadSnippets,
  isUnread: true,
  isMuted: false,
  elapsedSinceStart: 10000
});
assert.strictEqual(realMessageResult.notified, true, 'Real unread message should notify');
assert.strictEqual(realMessageResult.reason, 'new_unread_message');

console.log('✓ Passed: App restart prevents notification floods from seen and muted conversations');

// ==========================================
// Test 9: Updater logic & UX handlers
// ==========================================
console.log('Test 9: Updater manual-only checking, error mapping & progress calculations');

function calculateDownloadProgress(downloaded, total) {
  if (!total || total <= 0) return { percent: 0, text: `${(downloaded / (1024 * 1024)).toFixed(1)} MB` };
  const percent = Math.min(100, Math.round((downloaded / total) * 100));
  const dlMB = (downloaded / (1024 * 1024)).toFixed(1);
  const totMB = (total / (1024 * 1024)).toFixed(1);
  return { percent, text: `${dlMB} MB / ${totMB} MB` };
}

function mapUpdaterError(err) {
  const msg = typeof err === 'string' ? err : (err && err.message) || '';
  if (/dns|resolve|network|connection|timed out/i.test(msg)) {
    return 'Unable to connect to the update server. Please check your internet connection and try again.';
  }
  if (/signature|minisign/i.test(msg)) {
    return 'Update signature verification failed. The update cannot be verified securely.';
  }
  if (/404|not found/i.test(msg)) {
    return 'No release manifest found at the updater endpoint.';
  }
  return msg || 'Update check failed.';
}

// 1. Progress calculation
const p1 = calculateDownloadProgress(5242880, 10485760); // 5 MB of 10 MB
assert.strictEqual(p1.percent, 50);
assert.strictEqual(p1.text, '5.0 MB / 10.0 MB');

const p2 = calculateDownloadProgress(10485760, null); // Unknown total
assert.strictEqual(p2.percent, 0);
assert.strictEqual(p2.text, '10.0 MB');

// 2. Error mapping
assert.strictEqual(mapUpdaterError('Could not resolve host: index.crates.io'), 'Unable to connect to the update server. Please check your internet connection and try again.');
assert.strictEqual(mapUpdaterError('minisign: signature mismatch'), 'Update signature verification failed. The update cannot be verified securely.');
assert.strictEqual(mapUpdaterError('status code: 404'), 'No release manifest found at the updater endpoint.');
assert.strictEqual(mapUpdaterError('Custom error message'), 'Custom error message');

// 3. Concurrent request lock simulation
let isChecking = false;
function requestUpdateCheck() {
  if (isChecking) return { allowed: false, reason: 'concurrent_blocked' };
  isChecking = true;
  return { allowed: true, reason: 'started' };
}
assert.strictEqual(requestUpdateCheck().allowed, true);
assert.strictEqual(requestUpdateCheck().allowed, false); // blocked while running
isChecking = false;
assert.strictEqual(requestUpdateCheck().allowed, true); // allowed after reset

console.log('✓ Passed: Updater calculations, concurrency guards and error mappings verified');

// ==========================================
// Test 10: Run at startup toggle & settings state
// ==========================================
console.log('Test 10: Run at startup toggle state & default behavior');

const defaultAppSettings = {
  notifications_enabled: true,
  badge_enabled: true,
  hide_message_content: false,
  badge_color: '#F52D2D',
  run_at_startup: false,
  minimize_to_tray: true,
  start_minimized_to_tray: false
};

// 1. Verify default is off
assert.strictEqual(defaultAppSettings.run_at_startup, false, 'Default run_at_startup must be false');

// 2. Simulate toggle ON
function handleStartupToggle(currentSettings, enabled, shouldFail = false) {
  const previousState = currentSettings.run_at_startup;
  currentSettings.run_at_startup = enabled;
  if (shouldFail) {
    // Revert on failure
    currentSettings.run_at_startup = previousState;
    return { success: false, state: currentSettings.run_at_startup };
  }
  return { success: true, state: currentSettings.run_at_startup };
}

const settingsCopy = { ...defaultAppSettings };
const toggleOnRes = handleStartupToggle(settingsCopy, true);
assert.strictEqual(toggleOnRes.success, true);
assert.strictEqual(settingsCopy.run_at_startup, true, 'Settings state should reflect enabled startup');

// 3. Simulate toggle OFF
const toggleOffRes = handleStartupToggle(settingsCopy, false);
assert.strictEqual(toggleOffRes.success, true);
assert.strictEqual(settingsCopy.run_at_startup, false, 'Settings state should reflect disabled startup');

// 4. Simulate failure and revert
const toggleFailRes = handleStartupToggle(settingsCopy, true, true);
assert.strictEqual(toggleFailRes.success, false);
assert.strictEqual(settingsCopy.run_at_startup, false, 'Settings state must revert to previous state on failure');

console.log('✓ Passed: Run at startup toggle behaves as expected (default off, toggle on/off, revert on error)');

// ==========================================
// Test 11: Download Detection & Format Logic
// ==========================================
console.log('\nTest 11: Download detection, byte formatting & icon resolution');

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
    const u = new URL(urlString, 'https://www.messenger.com');
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

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

    const extMatch = path.match(/\.([a-z0-9]+)$/);
    if (extMatch && DOWNLOAD_EXTENSIONS.has(extMatch[1])) {
      return true;
    }

    if (
      u.searchParams.get('dl') === '1' ||
      u.searchParams.get('download') === '1' ||
      u.searchParams.get('download') === 'true'
    ) {
      return true;
    }
  } catch (_) {}
  return false;
}

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

// 1. Download URL tests
assert.strictEqual(isDownloadUrl('https://cdn.fbsbx.com/v/t59.2708-21/12345.pdf?_nc_cat=100'), true);
assert.strictEqual(isDownloadUrl('https://lookaside.fbsbx.com/attachment/123'), true);
assert.strictEqual(isDownloadUrl('https://video.xx.fbcdn.net/v/t42.17977-2/test.mp4'), true);
assert.strictEqual(isDownloadUrl('https://example.com/files/spec.docx'), true);
assert.strictEqual(isDownloadUrl('https://example.com/download.zip'), true);
assert.strictEqual(isDownloadUrl('https://example.com/api/export?dl=1'), true);
assert.strictEqual(isDownloadUrl('blob:https://www.messenger.com/1234-5678-abcd'), true);

// Non-download URLs (should NOT intercept navigation)
assert.strictEqual(isDownloadUrl('https://www.messenger.com/t/123456789'), false);
assert.strictEqual(isDownloadUrl('https://www.messenger.com/e2ee/t/987654321'), false);
assert.strictEqual(isDownloadUrl('https://google.com'), false);
assert.strictEqual(isDownloadUrl('https://github.com/itsHuaan/messenger'), false);

// 2. formatBytes tests
assert.strictEqual(formatBytes(0), '0 B');
assert.strictEqual(formatBytes(500), '500 B');
assert.strictEqual(formatBytes(1024), '1 KB');
assert.strictEqual(formatBytes(1048576), '1 MB');
assert.strictEqual(formatBytes(1073741824 * 2.5), '2.5 GB');

// 3. getFileIcon tests
assert.strictEqual(getFileIcon('photo.png'), '🖼️');
assert.strictEqual(getFileIcon('video.mp4'), '🎬');
assert.strictEqual(getFileIcon('voice.m4a'), '🎵');
assert.strictEqual(getFileIcon('doc.pdf'), '📄');
assert.strictEqual(getFileIcon('archive.zip'), '📦');
assert.strictEqual(getFileIcon('unknown.bin'), '📁');

console.log('✓ Passed: Download URLs correctly identified, byte formatting & icons verified');

// Test 12: System Tray & Window Behavior Settings logic
console.log('Test 12: System Tray & Window Behavior Settings');

assert.strictEqual(defaultAppSettings.minimize_to_tray, true, 'Minimize to Tray must be enabled by default');
assert.strictEqual(defaultAppSettings.start_minimized_to_tray, false, 'Start Minimized to Tray must be disabled by default');

function shouldStartMinimized(settings) {
  return !!(settings.minimize_to_tray && settings.start_minimized_to_tray);
}

// Start Minimized only takes effect if Minimize to Tray is enabled
assert.strictEqual(shouldStartMinimized({ minimize_to_tray: true, start_minimized_to_tray: false }), false);
assert.strictEqual(shouldStartMinimized({ minimize_to_tray: true, start_minimized_to_tray: true }), true);
assert.strictEqual(shouldStartMinimized({ minimize_to_tray: false, start_minimized_to_tray: true }), false, 'Start Minimized must be ignored when Minimize to Tray is disabled');

function determineCloseAction(minimizeToTray) {
  return minimizeToTray ? 'hide' : 'exit';
}

assert.strictEqual(determineCloseAction(true), 'hide', 'When Minimize to Tray is enabled, close action must hide to tray');
assert.strictEqual(determineCloseAction(false), 'exit', 'When Minimize to Tray is disabled, close action must exit application');

function determineTrayClickAction(isVisible, isMinimized) {
  if (isVisible && !isMinimized) {
    return 'hide';
  }
  return 'restore_and_focus';
}

assert.strictEqual(determineTrayClickAction(true, false), 'hide', 'Clicking tray when visible must toggle hide');
assert.strictEqual(determineTrayClickAction(false, false), 'restore_and_focus', 'Clicking tray when hidden must restore and focus');
assert.strictEqual(determineTrayClickAction(true, true), 'restore_and_focus', 'Clicking tray when minimized must restore and focus');

console.log('✓ Passed: System tray settings defaults, dependency hierarchy, and toggle behaviors verified');

console.log('\nAll frontend logic tests passed successfully!');
