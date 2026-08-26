// ==========================================================================
// threadNormalize.js — Post-proceso del JSON que devuelve Grok.
// ==========================================================================

const { parseCount } = require('./parseCount');
const { normalizeHandle } = require('./influencersParse');

function asText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function metricsOf(raw) {
  return {
    likes: parseCount(raw?.likes ?? raw?.likesCount),
    retweets: parseCount(raw?.retweets ?? raw?.reposts ?? raw?.rtCount),
    quotes: parseCount(raw?.quotes ?? raw?.quoteCount),
    replies: parseCount(raw?.replies ?? raw?.replyCount),
    bookmarks: parseCount(raw?.bookmarks ?? raw?.bookmarkCount ?? raw?.saves),
    views: parseCount(raw?.views ?? raw?.viewCount ?? raw?.impressions),
  };
}

function normalizeItem(raw, fallbackKind) {
  if (!raw || typeof raw !== 'object') return null;
  const handle = normalizeHandle(raw.authorHandle || raw.username || raw.handle);
  const id = asText(raw.id || raw.postId || raw.tweetId);
  const url = asText(raw.url || raw.link);
  const text = asText(raw.text || raw.content);
  if (!id && !url && !text) return null;

  let kind = asText(raw.kind || fallbackKind || 'reply').toLowerCase();
  if (kind === 'qt' || kind === 'quoted' || kind === 'quote_tweet') kind = 'quote';
  if (kind === 'original' || kind === 'post' || kind === 'status') kind = 'original';
  if (kind !== 'quote' && kind !== 'original') kind = 'reply';

  return {
    id: id || url || `${handle}:${text.slice(0, 24)}`,
    url,
    kind,
    username: handle,
    displayName: asText(raw.authorName || raw.displayName || raw.name) || handle,
    text,
    inReplyToId: asText(raw.inReplyToId || raw.replyToId) || null,
    quotedId: asText(raw.quotedId || raw.quoted_tweet_id || raw.quoteOfId) || null,
    timestamp: asText(raw.createdAt || raw.timestamp) || null,
    ...metricsOf(raw),
  };
}

function normalizePost(raw, fallbackUrl) {
  const item = normalizeItem({ ...raw, kind: 'original' }, 'original');
  if (!item) return null;
  return {
    ...item,
    kind: 'original',
    url: item.url || fallbackUrl || '',
    authorName: item.displayName,
    authorHandle: item.username,
  };
}

/**
 * Tira quotes cuyo origen no es el posteo analizado (QT → QT).
 * @param {string} originalId
 * @param {Array} items
 */
function dropQuoteOfQuotes(originalId, items) {
  const origin = String(originalId || '');
  const originUrls = new Set(
    [origin, `https://x.com/i/web/status/${origin}`].filter(Boolean)
  );
  return (items || []).filter((item) => {
    if (!item || item.kind !== 'quote') return true;
    const quoted = String(item.quotedId || '');
    if (!quoted) return false;
    if (quoted === origin) return true;
    if (originUrls.has(quoted)) return true;
    if (origin && quoted.endsWith(`/status/${origin}`)) return true;
    return false;
  });
}

function hasPostMetrics(post) {
  if (!post) return false;
  return [post.likes, post.retweets, post.quotes, post.replies, post.views, post.bookmarks]
    .some((n) => n != null);
}

/**
 * @param {object} parsed JSON de Grok
 * @param {string} requestUrl
 */
function normalizeThread(parsed, requestUrl) {
  const raw = parsed && typeof parsed === 'object' ? parsed : {};
  const post = normalizePost(raw.post || raw.tweet || raw.status, requestUrl);
  const rawItems = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(raw.replies)
      ? raw.replies
      : [];
  const items = dropQuoteOfQuotes(
    post?.id,
    rawItems.map((row) => normalizeItem(row)).filter(Boolean)
  );
  return { post, items, threadComplete: raw.threadComplete !== false };
}

module.exports = {
  parseCount,
  normalizeItem,
  normalizePost,
  dropQuoteOfQuotes,
  hasPostMetrics,
  normalizeThread,
};
