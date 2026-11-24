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
console.log('Test 7: Muted conversation detection & false-positive prevention');
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

function isMuteLabel(str) {
  if (!str || typeof str !== 'string' || str.length > 40) return false;
  const lower = str.trim().toLowerCase();
  for (const kw of MUTED_KEYWORDS) {
    if (lower === kw || lower.startsWith(kw + ' ') || lower.endsWith(' ' + kw)) {
      return true;
    }
  }
  return false;
}

function isMutedMock({ ariaLabel = '', childAriaLabels = [], svgPaths = [], snippetText = '' }) {
  // 1. Dedicated child badges (not snippet)
  for (const childAria of childAriaLabels) {
    if (childAria === snippetText) continue; // skip message snippet
    if (isMuteLabel(childAria)) return true;
  }

  // 2. Row aria-label trailing segment
  if (/(?:,\s*|\.\s*)(?:muted|silenced|notifications off|đã tắt thông báo|tắt thông báo|tắt chuông|tắt âm|stummgeschaltet|silenciado|muet|disattivato)\s*$/i.test(ariaLabel)) {
    return true;
  }

// 3. SVG bell-slash paths
  for (const p of svgPaths) {
    const norm = (typeof p === 'string' ? p : (p.d || '')).trim().replace(/\s+/g, ' ');
    if (norm === 'M2.5 6c0-.322.028-.637.081-.943l8.296 8.296A3.001 3.001 0 0 1 5 12.5H2.432a.98.98 0 0 1-.816-1.525A5.268 5.268 0 0 0 2.5 8.053V6zm4 6.5a1.5 1.5 0 0 0 3 0h-3zm7.06 0h.01a.98.98 0 0 0 .815-1.525 5.269 5.269 0 0 1-.885-2.922V6a5.5 5.5 0 0 0-9.83-3.39L2.28 1.22a.75.75 0 0 0-1.061 1.06l12.5 12.5a.75.75 0 0 0 1.06-1.06l-1.22-1.22z') {
      return true;
    }
    if (norm.startsWith('M2.5 6c0-.322') && norm.includes('8.296 8.296')) {
      return true;
    }
    if (norm.startsWith('M29.676') || norm.includes('29.676 7.746')) {
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

// False positive prevention: message preview text says "I have muted the stream"
const falsePositiveRow = {
  ariaLabel: 'Alice Smith, I have muted the video, 10:15 AM',
  childAriaLabels: ['I have muted the video'],
  snippetText: 'I have muted the video'
};
assert.strictEqual(isMutedMock(falsePositiveRow), false, 'Message containing "muted" must NOT falsely mark conversation as muted');
console.log('✓ Passed: Muted conversations properly identified, false positives on message text prevented');

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

// Test 13: Unread badge counts include muted conversations
console.log('Test 13: Unread badge counts include muted unread conversations');

function computeUnreadBadgeCount(conversations) {
  let count = 0;
  for (const c of conversations) {
    if (c.isUnread) count++;
  }
  return count;
}

const convos = [
  { threadId: '1', isUnread: true, isMuted: true },  // muted but unread -> MUST count!
  { threadId: '2', isUnread: true, isMuted: false }, // unmuted and unread -> MUST count!
  { threadId: '3', isUnread: false, isMuted: false },
  { threadId: '4', isUnread: false, isMuted: true }
];

assert.strictEqual(computeUnreadBadgeCount(convos), 2, 'Unread badge must count all unread conversations including muted ones');
console.log('✓ Passed: Unread badge correctly counts muted unread conversations');

// Test 14: Mute/Unmute state synchronization & notification re-enabling
console.log('Test 14: Mute cache synchronization and re-enabling notifications upon unmute');

const mockMuteCache = new Map();
let persistedMuted = [];

function setMuteState(threadId, isMuted) {
  const prev = mockMuteCache.get(threadId);
  if (prev !== isMuted) {
    mockMuteCache.set(threadId, isMuted);
    persistedMuted = Array.from(mockMuteCache.entries())
      .filter(([_, muted]) => muted)
      .map(([id]) => id);
  }
}

// User mutes thread_99
mockThreadSnippets.set('thread_99', 'Old baseline message');
setMuteState('thread_99', true);
assert.strictEqual(mockMuteCache.get('thread_99'), true);
assert.deepStrictEqual(persistedMuted, ['thread_99']);

// Incoming message while muted -> must suppress
const mutedArrival = simulateConversationArrival({
  isInitialized: true,
  threadId: 'thread_99',
  snippet: 'Message while muted',
  threadSnippets: mockThreadSnippets,
  isUnread: true,
  isMuted: mockMuteCache.get('thread_99'),
  elapsedSinceStart: 10000
});
assert.strictEqual(mutedArrival.notified, false);
assert.strictEqual(mutedArrival.reason, 'muted');

// User now un-mutes thread_99 in Messenger
setMuteState('thread_99', false);
assert.strictEqual(mockMuteCache.get('thread_99'), false);
assert.deepStrictEqual(persistedMuted, [], 'Persisted muted list must immediately remove unmuted thread');

// New incoming message after un-muting -> MUST notify!
const unmutedArrival = simulateConversationArrival({
  isInitialized: true,
  threadId: 'thread_99',
  snippet: 'Message after unmute!',
  threadSnippets: mockThreadSnippets,
  isUnread: true,
  isMuted: mockMuteCache.get('thread_99'),
  elapsedSinceStart: 12000
});
assert.strictEqual(unmutedArrival.notified, true, 'Unmuted thread must generate notifications again');
assert.strictEqual(unmutedArrival.reason, 'new_unread_message');

console.log('✓ Passed: Mute cache synchronization immediately updates storage and restores notifications on unmute');

// ==========================================
// Test 15: Exact Messenger 16x16 bell-slash SVG detection & multi-conversation notification filtering
// ==========================================
console.log('\nTest 15: Messenger 16x16 bell-slash SVG detection & multi-conversation notification filtering');

const MESSENGER_MUTED_PATH_16 = 'M2.5 6c0-.322.028-.637.081-.943l8.296 8.296A3.001 3.001 0 0 1 5 12.5H2.432a.98.98 0 0 1-.816-1.525A5.268 5.268 0 0 0 2.5 8.053V6zm4 6.5a1.5 1.5 0 0 0 3 0h-3zm7.06 0h.01a.98.98 0 0 0 .815-1.525 5.269 5.269 0 0 1-.885-2.922V6a5.5 5.5 0 0 0-9.83-3.39L2.28 1.22a.75.75 0 0 0-1.061 1.06l12.5 12.5a.75.75 0 0 0 1.06-1.06l-1.22-1.22z';

function normalizeSvgPath(d) {
  if (!d || typeof d !== 'string') return '';
  return d.trim().replace(/\s+/g, ' ');
}

function isMuteBellSvg(svg) {
  if (!svg) return false;
  const svgAria = (svg.getAttribute('aria-label') || '').trim();
  if (svgAria && isMuteLabel(svgAria)) return true;

  const rawViewBox = svg.getAttribute('viewBox') || '';
  const normViewBox = rawViewBox.trim().replace(/\s+/g, ' ');
  const is16ViewBox = normViewBox === '0 0 16 16';

  const paths = svg.querySelectorAll ? svg.querySelectorAll('path') : (svg.paths || []);
  for (const p of paths) {
    const rawD = p.getAttribute ? p.getAttribute('d') : p.d;
    const normD = normalizeSvgPath(rawD);
    if (!normD) continue;

    // 1. Exact match for Messenger 16x16 bell-slash SVG path
    if (normD === MESSENGER_MUTED_PATH_16) {
      return true;
    }

    // 2. Verified match with viewBox signal and key path segments
    if (is16ViewBox && normD.startsWith('M2.5 6c0-.322') && normD.includes('8.296 8.296')) {
      return true;
    }

    // 3. Fallback for alternative or legacy bell-slash icons
    if (normD.startsWith('M29.676') || normD.includes('29.676 7.746')) {
      return true;
    }
  }

  return false;
}

// 1. Test exact SVG recognition with attributes
const exactMessengerSvg = {
  getAttribute(name) {
    if (name === 'viewBox') return '0 0 16 16';
    if (name === 'width') return '16';
    if (name === 'height') return '16';
    if (name === 'fill') return 'currentColor';
    if (name === 'aria-hidden') return 'true';
    if (name === 'class') return 'x14rh7hd x1lliihq x1kpxq89'; // Generated class must be ignored
    return null;
  },
  querySelectorAll(sel) {
    if (sel === 'path') {
      return [{
        getAttribute(attr) {
          if (attr === 'd') return MESSENGER_MUTED_PATH_16;
          return null;
        }
      }];
    }
    return [];
  }
};

assert.strictEqual(isMuteBellSvg(exactMessengerSvg), true, 'Exact Messenger bell-slash SVG must be recognized as mute');

// 2. Test whitespace normalization in path and viewBox
const whitespaceSvg = {
  getAttribute(name) {
    if (name === 'viewBox') return '  0   0   16   16  ';
    return null;
  },
  querySelectorAll(sel) {
    if (sel === 'path') {
      return [{
        getAttribute(attr) {
          if (attr === 'd') {
            return `\n  M2.5 6c0-.322.028-.637.081-.943l8.296   8.296A3.001 3.001 0 0 1 5 12.5H2.432a.98.98 0 0 1-.816-1.525A5.268 5.268 0 0 0 2.5 8.053V6zm4 6.5a1.5 1.5 0 0 0 3 0h-3zm7.06 0h.01a.98.98 0 0 0 .815-1.525 5.269 5.269 0 0 1-.885-2.922V6a5.5 5.5 0 0 0-9.83-3.39L2.28 1.22a.75.75 0 0 0-1.061 1.06l12.5 12.5a.75.75 0 0 0 1.06-1.06l-1.22-1.22z\t\n`;
          }
          return null;
        }
      }];
    }
    return [];
  }
};
assert.strictEqual(isMuteBellSvg(whitespaceSvg), true, 'Whitespace normalized SVG must be recognized as mute');

// 3. Test non-mute SVGs (e.g. checkmark, search icon, call icon) are NOT recognized as mute
const searchIconSvg = {
  getAttribute(name) {
    if (name === 'viewBox') return '0 0 16 16';
    return null;
  },
  querySelectorAll(sel) {
    if (sel === 'path') {
      return [{
        getAttribute(attr) {
          if (attr === 'd') return 'M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z';
          return null;
        }
      }];
    }
    return [];
  }
};
assert.strictEqual(isMuteBellSvg(searchIconSvg), false, 'Non-mute SVG must NOT be recognized as mute');

// 4. Mock conversation rows and test row-level isolation
function createMockRow({ threadId, title, snippet, isMuted, isUnread = true }) {
  return {
    threadId,
    title,
    snippet,
    isMuted,
    isUnread,
    getAttribute(name) {
      if (name === 'aria-label') return `${this.title}, ${this.snippet}`;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'svg') return this.isMuted ? [exactMessengerSvg] : [searchIconSvg];
      if (selector === 'path') {
        const svgs = this.querySelectorAll('svg');
        const paths = [];
        for (const s of svgs) {
          paths.push(...s.querySelectorAll('path'));
        }
        return paths;
      }
      if (selector.includes('mute') || selector.includes('bell-slash')) return [];
      if (selector.includes('unread')) return this.isUnread ? [{}] : [];
      return [];
    },
    querySelector(selector) {
      const all = this.querySelectorAll(selector);
      return all.length > 0 ? all[0] : null;
    }
  };
}

function checkMockConversationMuted(row) {
  const svgs = row.querySelectorAll('svg');
  for (const s of svgs) {
    if (isMuteBellSvg(s)) return true;
  }
  return false;
}

// Create Row A (muted) and Row B (unmuted)
const rowA = createMockRow({ threadId: 'thread_muted_101', title: 'Work Announcements', snippet: 'Initial msg', isMuted: true, isUnread: true });
const rowB = createMockRow({ threadId: 'thread_regular_102', title: 'Alice Bestie', snippet: 'Initial msg', isMuted: false, isUnread: true });

assert.strictEqual(checkMockConversationMuted(rowA), true, 'Row A with bell-slash SVG must be identified as muted');
assert.strictEqual(checkMockConversationMuted(rowB), false, 'Row B without bell-slash SVG must be identified as NOT muted');

// 5. Test notification filtering on arrival
const multiThreadSnippets = new Map();
multiThreadSnippets.set('thread_muted_101', 'Initial msg');
multiThreadSnippets.set('thread_regular_102', 'Initial msg');

// New message arrives in muted conversation (Row A)
const arrivalMuted = simulateConversationArrival({
  isInitialized: true,
  threadId: rowA.threadId,
  snippet: 'New company announcement @everyone',
  threadSnippets: multiThreadSnippets,
  isUnread: true,
  isMuted: checkMockConversationMuted(rowA),
  elapsedSinceStart: 10000
});
assert.strictEqual(arrivalMuted.notified, false, 'Muted conversation containing SVG must suppress notification');
assert.strictEqual(arrivalMuted.reason, 'muted');

// New message arrives in unmuted conversation (Row B)
const arrivalUnmuted = simulateConversationArrival({
  isInitialized: true,
  threadId: rowB.threadId,
  snippet: 'Hey! Want to grab lunch?',
  threadSnippets: multiThreadSnippets,
  isUnread: true,
  isMuted: checkMockConversationMuted(rowB),
  elapsedSinceStart: 10000
});
assert.strictEqual(arrivalUnmuted.notified, true, 'Ordinary conversation must generate desktop notification');
assert.strictEqual(arrivalUnmuted.reason, 'new_unread_message');

// 6. Test that one muted conversation does not affect another conversation
assert.notStrictEqual(arrivalMuted.notified, arrivalUnmuted.notified, 'Muted conversation must not affect notifications of unmuted conversation');

// 7. Test unmuting Row A immediately restores notifications
rowA.isMuted = false; // User unmuted conversation in Messenger (SVG removed from DOM row)
assert.strictEqual(checkMockConversationMuted(rowA), false, 'Row A without SVG must immediately be detected as unmuted');

const arrivalAfterUnmute = simulateConversationArrival({
  isInitialized: true,
  threadId: rowA.threadId,
  snippet: 'Follow-up announcement after unmute',
  threadSnippets: multiThreadSnippets,
  isUnread: true,
  isMuted: checkMockConversationMuted(rowA),
  elapsedSinceStart: 12000
});
assert.strictEqual(arrivalAfterUnmute.notified, true, 'Unmuting must immediately restore notifications on subsequent messages');
assert.strictEqual(arrivalAfterUnmute.reason, 'new_unread_message');

// 8. Test unread badge counts include muted unread conversations
const unreadStateTest = [
  { threadId: 'thread_muted_101', isUnread: true, isMuted: true },
  { threadId: 'thread_regular_102', isUnread: true, isMuted: false }
];
assert.strictEqual(computeUnreadBadgeCount(unreadStateTest), 2, 'Unread badge must count all unread messages including muted conversations');

console.log('✓ Passed: Exact bell-slash SVG recognized, notification suppression/restoration verified, badge counts preserved');

console.log('\nAll frontend logic tests passed successfully!');
