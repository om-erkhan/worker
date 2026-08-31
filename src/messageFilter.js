/**
 * Skip common / low-value chat texts so they never hit the DB or AI normalizer.
 * Keep real listings, inquiries, prices, locations, etc.
 */

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
}

/** Normalize for exact matching: lowercase, collapse spaces, strip most punctuation. */
function normalizeForMatch(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMMON_EXACT = new Set([
  // acknowledgements
  'ok', 'okay', 'okk', 'okkk', 'k', 'kk', 'kkk', 'oke', 'okey',
  'yes', 'no', 'yeah', 'yep', 'yup', 'nope', 'na', 'nah', 'yea',
  'done', 'ok done', 'okay done',
  'sure', 'alright', 'all right', 'right', 'fine',
  'please', 'plz', 'pls', 'please confirm',
  // greetings / closings
  'hi', 'hello', 'hey', 'hy', 'hii', 'hiii', 'helloo', 'helo',
  'bye', 'goodbye', 'good night', 'goodnight', 'gn', 'good morning', 'gm',
  'good evening', 'good afternoon',
  'assalamualaikum', 'assalam o alaikum', 'asalamualaikum', 'salam',
  'walaikum assalam', 'wa alaikum assalam', 'ws', 'aoa', 'aoa wr wb',
  'jazakallah', 'jazakallah khair', 'allah hafiz', 'allah hafiz',
  // roman urdu fillers
  'ji', 'jee', 'haan', 'han', 'ha', 'theek', 'theek hai', 'thik', 'thik hai',
  'acha', 'achha', 'accha', 'sahi', 'sahi hai', 'bilkul',
  'bhai', 'bro', 'sir', 'mam', 'madam', 'ji bhai',
  // reactions / noise
  'hmm', 'hm', 'hmmm', 'lol', 'haha', 'hahaha', 'hehe', 'hehehe',
  'nice', 'cool', 'great', 'perfect', 'awesome', 'wow',
  'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'tysm', 'thanks bro',
  'ok thanks', 'ok thank you', 'okay thanks',
  'seen', 'check', 'checking', 'wait', 'waiting', 'ok wait', 'hold on',
  'yes please', 'ok please',
  // lone punctuation / placeholders
  '?', '??', '???', '...', '..', '.', '!', '!!',
  'null', 'undefined', 'test', 'testing',
]);

const SYSTEM_SUBSTRINGS = [
  'disappearing messages',
  'turned off',
  'turned on',
  'click to change',
  'end-to-end encrypted',
  'messages and calls are end-to-end encrypted',
  'added you',
  'created this group',
  'created group',
  'changed the group',
  'left',
  'removed',
  'security code changed',
  'this message was deleted',
  'you deleted this message',
  'waiting for this message',
];

function isEmojiOnly(text) {
  const t = cleanText(text);
  if (!t) return true;
  // letters or digits → keep (could be property text)
  if (/\p{L}|\p{N}/u.test(t)) return false;
  return true;
}

function isSystemNotificationText(text) {
  const cleaned = cleanText(text).toLowerCase();
  if (!cleaned || cleaned.length < 2) return true;
  if (/^\d{1,2}:\d{2}(\s?[ap]m)?$/i.test(cleaned)) return true;
  if (/\.(json|txt|pdf|png|jpg|jpeg|docx|webp)$/i.test(cleaned)) return true;
  return SYSTEM_SUBSTRINGS.some((s) => cleaned.includes(s));
}

/**
 * Returns true if this message body should NOT be scraped / saved.
 */
function isCommonJunkMessage(text) {
  const raw = cleanText(text);
  if (!raw) return true;
  if (isSystemNotificationText(raw)) return true;
  if (isEmojiOnly(raw)) return true;

  const norm = normalizeForMatch(raw);
  if (!norm) return true;

  // Very short filler (1–2 chars) with no digit — e.g. "ok", "k", "?" already covered;
  // bare "a" / "o" etc.
  if (norm.length <= 2 && !/\d/.test(norm) && !COMMON_EXACT.has(norm)) {
    return true;
  }

  if (COMMON_EXACT.has(norm)) return true;

  // Repeated same character: "??????", "......", "okkkkk"
  if (/^(.)\1{2,}$/u.test(norm.replace(/\s/g, ''))) return true;

  return false;
}

module.exports = {
  cleanText,
  isCommonJunkMessage,
  isSystemNotificationText
};
