// Runs on the saved-posts list page and on individual post pages.
//
// LinkedIn's DOM has no stable public contract and changes without notice.
// Every selector lives in SELECTORS below so a breakage can be patched in one
// place. Every scrape/action is wrapped so one bad post doesn't kill a batch;
// failures are returned as { ok:false, error } and surfaced by the side panel
// rather than thrown, per the PRD's "tell me it broke" requirement.
//
// Wrapped in a load-guard block: the side panel re-injects this file via
// chrome.scripting.executeScript before every action, to cover tabs that
// were already open before the extension loaded (declarative content_scripts
// only auto-inject into new page loads). Re-running the file is otherwise
// unsafe — a bare top-level `const` would throw "already declared" on a
// second injection into the same page, and the message listener would
// double-fire; the `{ }` block below gives them fresh block scope instead.
if (!window.__ltpContentScriptLoaded) {
window.__ltpContentScriptLoaded = true;

// Persisted debug log (chrome.storage.local, ring buffer) so failures can be
// read from the side panel's Logs view instead of needing this LinkedIn
// tab's own devtools console. Keep the key/shape in sync with src/lib/logger.js.
const LTP_LOG_KEY = 'ltp_debug_log_v1';
const LTP_LOG_MAX = 300;

function appendLog(level, source, message) {
  chrome.storage.local.get(LTP_LOG_KEY).then((data) => {
    const list = data[LTP_LOG_KEY] || [];
    list.push({ ts: new Date().toISOString(), level, source, message });
    while (list.length > LTP_LOG_MAX) list.shift();
    return chrome.storage.local.set({ [LTP_LOG_KEY]: list });
  }).catch(() => {});
}

function log(source, ...args) {
  console.log(`[LTP:content:${source}]`, ...args);
  appendLog('log', `content:${source}`, args.map(String).join(' '));
}

function logError(source, ...args) {
  console.error(`[LTP:content:${source}]`, ...args);
  appendLog('error', `content:${source}`, args.map(String).join(' '));
}

// The saved-posts list (/my-items/saved-posts/) renders cards with LinkedIn's
// search "entity-result" layout, not the feed-update layout individual post
// pages (/feed/update/*) use — hence two variants side by side below. The
// entity-result card's own wrapper classes are per-build hashes with no
// stable hook, so postContainer targets the stable BEM child
// (.entity-result__content-container) directly rather than its <li> parent.
const SELECTORS = {
  postContainer: '.feed-shared-update-v2, div.occludable-update, div[data-urn], .entity-result__content-container',
  actorName: '.update-components-actor__name, .entity-result__content-actor a span[dir="ltr"] span',
  actorLink: '.update-components-actor__meta-link, .update-components-actor__container a[href], .entity-result__content-actor a[href]',
  actorHeadline: '.update-components-actor__description, .entity-result__content-actor .linked-area > div',
  actorSubDescription: '.update-components-actor__sub-description, .entity-result__content-actor .linked-area > p',
  postText: '.update-components-text, .entity-result__content-summary',
  seeMoreButton: 'button.feed-shared-inline-show-more-text__see-more-less-toggle, button.reusable-search-show-more-link',
  articleTitle: '.update-components-article__title',
  articleLink: 'a.update-components-article__link, a.update-components-article__meta',
  imageAttachment: '.update-components-image img, .entity-result__embedded-object-image',
  timestamp: 'time, .update-components-actor__sub-description span[aria-hidden="true"]',
  socialCounts: '.social-details-social-counts, [class*="social-details-social-counts"]',
  likeButton: 'button[aria-label^="Like"], button[aria-label^="Unlike"]',
  commentButton: 'button[aria-label^="Comment"]',
  commentEditor: 'div.ql-editor[contenteditable="true"]',
  commentSubmitButton: 'button.comments-comment-box__submit-button--cr, button[class*="comments-comment-box__submit-button"]',
  moreActionsButton: 'button[aria-label^="More actions"], button[aria-label*="Open control menu"], button[aria-label*="more actions" i]',
  dropdownItem: 'div.artdeco-dropdown__content-inner li, div.artdeco-dropdown__content-inner div[role="button"]',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeout = 3000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = check();
    if (result) return result;
    await sleep(interval);
  }
  return null;
}

function text(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function findUrn(container) {
  const direct = container.getAttribute('data-urn');
  if (direct) return direct;
  const nested = container.querySelector('[data-urn]');
  return nested ? nested.getAttribute('data-urn') : null;
}

// FNV-1a — good enough to fingerprint a post's author+text so re-scanning the
// same saved-posts card yields the same id.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function guessCompany(headline) {
  if (!headline) return null;
  const match = headline.match(/\bat\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function scrapeMediaInfo(container) {
  const articleTitle = container.querySelector(SELECTORS.articleTitle);
  if (articleTitle) {
    const link = container.querySelector(SELECTORS.articleLink);
    return `article: ${text(articleTitle)}${link ? ` (${link.href})` : ''}`;
  }
  const img = container.querySelector(SELECTORS.imageAttachment);
  if (img) return `image: ${img.alt || '(no alt text)'}`;
  return null;
}

// LinkedIn exposes the absolute post time as a title/datetime attribute on an
// otherwise relatively-worded element; falls back to null if neither is present.
function scrapePostDateTime(container) {
  const el = container.querySelector(SELECTORS.timestamp);
  if (!el) return null;
  return el.getAttribute('datetime') || el.getAttribute('title') || null;
}

function scrapeEngagementMetrics(container) {
  const el = container.querySelector(SELECTORS.socialCounts);
  return el ? text(el) : null;
}

function scrapePostFromContainer(container) {
  const urn = findUrn(container);
  const authorEl = container.querySelector(SELECTORS.actorName);
  const linkEl = container.querySelector(SELECTORS.actorLink);
  const headlineEl = container.querySelector(SELECTORS.actorHeadline);
  const subDescEl = container.querySelector(SELECTORS.actorSubDescription);
  const textEl = container.querySelector(SELECTORS.postText);
  const permalink = container.querySelector('a[href*="/feed/update/"]');

  if (!urn && !authorEl && !textEl) {
    return { ok: false, error: 'container matched but no recognizable post fields found' };
  }

  const author = text(authorEl);
  const authorHeadline = text(headlineEl);
  const profileUrl = linkEl ? linkEl.href.split('?')[0] : null;
  const isCompanyPage = profileUrl && profileUrl.includes('/company/');
  const postTextValue = text(textEl);

  // The saved-posts entity-result card has no data-urn and no anchor to the
  // post's own permalink — storage.js's mergeScraped() keys posts by
  // urn||url and silently drops anything with neither, so without this the
  // scan would find every card and still report "added 0 new". Falls back to
  // a fingerprint of author+text; stable across re-scans of the same post.
  const effectiveUrn = urn || (author || postTextValue ? `ltp-synth:${hashString(`${author}|${postTextValue}`)}` : null);

  return {
    ok: true,
    post: {
      urn: effectiveUrn,
      url: permalink ? permalink.href.split('?')[0] : (urn ? `https://www.linkedin.com/feed/update/${urn}/` : null),
      author: author || null,
      authorProfileUrl: isCompanyPage ? null : profileUrl,
      authorHeadline: authorHeadline || null,
      company: guessCompany(authorHeadline),
      companyUrl: isCompanyPage ? profileUrl : null,
      postedRelative: text(subDescEl) || null,
      postDateTime: scrapePostDateTime(container),
      engagementMetrics: scrapeEngagementMetrics(container),
      savedConfirmed: location.pathname.includes('/my-items/saved-posts'),
      postText: postTextValue,
      mediaInfo: scrapeMediaInfo(container),
    },
  };
}

async function expandTruncatedText(container) {
  const btn = container.querySelector(SELECTORS.seeMoreButton);
  if (btn && /more/i.test(btn.textContent)) {
    btn.click();
    await sleep(150);
  }
}

// LinkedIn's saved-posts list is virtualized/lazy-rendered — a single
// querySelectorAll right after the tab reports "complete" can catch the page
// before any post has actually painted. Poll for a while instead of a single
// snapshot before concluding there's nothing there.
async function waitForContainers() {
  const found = await waitFor(() => {
    const els = document.querySelectorAll(SELECTORS.postContainer);
    return els.length ? els : null;
  }, { timeout: 8000, interval: 250 });
  return found || [];
}

async function scrapeSavedPosts() {
  const containers = Array.from(await waitForContainers());
  const results = [];
  const errors = [];
  for (const container of containers) {
    try {
      await expandTruncatedText(container);
      const scraped = scrapePostFromContainer(container);
      if (scraped.ok) results.push(scraped.post);
      else errors.push(scraped.error);
    } catch (err) {
      errors.push(String(err));
    }
  }
  // One log call, not two — back-to-back appendLog() calls each read the
  // stored list before either writes it back, so the second silently
  // clobbers the first (lost update). Fold the diagnostic into the same line.
  const diag = containers.length ? '' : `; any [data-urn] elements=${document.querySelectorAll('[data-urn]').length}, readyState=${document.readyState}, url=${location.href}`;
  log('scrapeSavedPosts', `found ${containers.length} container(s), ${results.length} parsed, ${errors.length} failed${diag}`);
  return { ok: true, posts: results, errors, containerCount: containers.length };
}

function findContainerByUrn(urn) {
  if (!urn) return null;
  const direct = document.querySelector(`div[data-urn="${CSS.escape(urn)}"]`);
  if (direct) return direct.closest(SELECTORS.postContainer) || direct;
  const containers = Array.from(document.querySelectorAll(SELECTORS.postContainer));
  return containers.find((c) => findUrn(c) === urn) || null;
}

async function doLike(urn) {
  const container = findContainerByUrn(urn);
  if (!container) return { ok: false, error: 'post not found on this page' };
  const btn = container.querySelector(SELECTORS.likeButton);
  if (!btn) return { ok: false, error: 'like button not found (selector may be stale)' };
  const alreadyLiked = btn.getAttribute('aria-pressed') === 'true' || /^unlike/i.test(btn.getAttribute('aria-label') || '');
  if (alreadyLiked) return { ok: true, alreadyDone: true };
  btn.click();
  const confirmed = await waitFor(() => {
    const b = container.querySelector(SELECTORS.likeButton);
    return b && (b.getAttribute('aria-pressed') === 'true' || /^unlike/i.test(b.getAttribute('aria-label') || ''));
  });
  return confirmed ? { ok: true } : { ok: false, error: 'clicked Like but could not confirm state change' };
}

async function isSaved(urn) {
  const container = findContainerByUrn(urn);
  if (!container) return { ok: false, error: 'post not found on this page' };
  const moreBtn = container.querySelector(SELECTORS.moreActionsButton);
  if (!moreBtn) return { ok: false, error: 'more-actions button not found (selector may be stale)' };
  moreBtn.click();
  const menu = await waitFor(() => document.querySelector(SELECTORS.dropdownItem));
  if (!menu) return { ok: false, error: 'dropdown menu did not open' };
  const items = Array.from(document.querySelectorAll(SELECTORS.dropdownItem));
  const saveItem = items.find((i) => /\bsave(d)?\b/i.test(i.textContent));
  const saved = saveItem ? /^saved\b/i.test(saveItem.textContent.trim()) : null;
  moreBtn.click(); // close menu without acting
  return { ok: saved !== null, saved, error: saved === null ? 'could not locate save/unsave menu item' : undefined };
}

async function doUnsave(urn) {
  const container = findContainerByUrn(urn);
  if (!container) return { ok: false, error: 'post not found on this page' };
  const moreBtn = container.querySelector(SELECTORS.moreActionsButton);
  if (!moreBtn) return { ok: false, error: 'more-actions button not found (selector may be stale)' };
  moreBtn.click();
  const menu = await waitFor(() => document.querySelector(SELECTORS.dropdownItem));
  if (!menu) return { ok: false, error: 'dropdown menu did not open' };
  const items = Array.from(document.querySelectorAll(SELECTORS.dropdownItem));
  const saveItem = items.find((i) => /\bsave(d)?\b/i.test(i.textContent));
  if (!saveItem) return { ok: false, error: 'save/unsave menu item not found' };
  if (!/^saved\b/i.test(saveItem.textContent.trim())) {
    return { ok: true, alreadyDone: true };
  }
  saveItem.click();
  await sleep(300);
  return { ok: true };
}

async function insertCommentDraft(urn, commentText) {
  const container = findContainerByUrn(urn);
  if (!container) return { ok: false, error: 'post not found on this page' };
  const commentBtn = container.querySelector(SELECTORS.commentButton);
  if (!commentBtn) return { ok: false, error: 'comment button not found (selector may be stale)' };
  commentBtn.click();
  const editor = await waitFor(() => container.querySelector(SELECTORS.commentEditor));
  if (!editor) return { ok: false, error: 'comment editor did not open (selector may be stale)' };
  editor.focus();
  document.execCommand('insertText', false, commentText);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  // Fills the box only; submitting is a separate, explicit step (submitComment)
  // so nothing public goes out without the side panel's own confirm step.
  return { ok: true };
}

// Only ever called after the side panel has shown its own explicit
// "post this comment now?" confirmation — see sidepanel.js postCommentNow().
async function submitComment(urn) {
  const container = findContainerByUrn(urn);
  if (!container) return { ok: false, error: 'post not found on this page' };
  const editor = container.querySelector(SELECTORS.commentEditor);
  if (!editor || !text(editor)) return { ok: false, error: 'no comment text found in the editor to submit' };
  const submitBtn = container.querySelector(SELECTORS.commentSubmitButton);
  if (!submitBtn) return { ok: false, error: 'comment submit button not found (selector may be stale)' };
  submitBtn.click();
  const confirmed = await waitFor(() => {
    const e = container.querySelector(SELECTORS.commentEditor);
    return !e || text(e) === '';
  }, { timeout: 5000 });
  return confirmed ? { ok: true } : { ok: false, error: 'clicked post but could not confirm the comment went through' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    log('onMessage', 'received', message.type, message.urn || '');
    let result;
    try {
      switch (message.type) {
        case 'LPT_SCRAPE_SAVED_POSTS':
          result = await scrapeSavedPosts();
          break;
        case 'LPT_DO_LIKE':
          result = await doLike(message.urn);
          break;
        case 'LPT_IS_SAVED':
          result = await isSaved(message.urn);
          break;
        case 'LPT_DO_UNSAVE':
          result = await doUnsave(message.urn);
          break;
        case 'LPT_INSERT_COMMENT':
          result = await insertCommentDraft(message.urn, message.text);
          break;
        case 'LPT_SUBMIT_COMMENT':
          result = await submitComment(message.urn);
          break;
        default:
          result = { ok: false, error: `unknown message type: ${message.type}` };
      }
    } catch (err) {
      // A handler throwing (rather than returning { ok: false }) would
      // otherwise leave the side panel's sendMessage call hanging with no
      // response — surface it as a normal failure instead, and log it.
      result = { ok: false, error: `${message.type} threw: ${err?.message || err}` };
    }
    if (!result.ok) logError('onMessage', message.type, result.error);
    sendResponse(result);
  })();
  return true; // keep the channel open for the async response
});

} // end __ltpContentScriptLoaded guard
