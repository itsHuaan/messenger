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

console.log('\nAll frontend logic tests passed successfully!');
