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

console.log('\nAll frontend logic tests passed successfully!');
