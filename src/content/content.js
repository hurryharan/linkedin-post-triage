// Runs on the saved-posts list page and on individual post pages.
//
// LinkedIn's DOM has no stable public contract and changes without notice.
// Every selector lives in SELECTORS below so a breakage can be patched in one
// place. Every scrape/action is wrapped so one bad post doesn't kill a batch;
// failures are returned as { ok:false, error } and surfaced by the side panel
// rather than thrown, per the PRD's "tell me it broke" requirement.

const SELECTORS = {
  postContainer: '.feed-shared-update-v2, div.occludable-update, div[data-urn]',
  actorName: '.update-components-actor__name',
  actorHeadline: '.update-components-actor__description',
  actorSubDescription: '.update-components-actor__sub-description',
  postText: '.update-components-text',
  seeMoreButton: 'button.feed-shared-inline-show-more-text__see-more-less-toggle',
  articleTitle: '.update-components-article__title',
  articleLink: 'a.update-components-article__link, a.update-components-article__meta',
  imageAttachment: '.update-components-image img',
  likeButton: 'button[aria-label^="Like"], button[aria-label^="Unlike"]',
  commentButton: 'button[aria-label^="Comment"]',
  commentEditor: 'div.ql-editor[contenteditable="true"]',
  commentSubmitButton: 'button.comments-comment-box__submit-button--cr, button[class*="comments-comment-box__submit-button"]',
  moreActionsButton: 'button[aria-label^="More actions"], button[aria-label*="Open control menu"]',
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

function guessCompany(headline) {
  if (!headline) return null;
  const match = headline.match(/\bat\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function scrapeAttachment(container) {
  const articleTitle = container.querySelector(SELECTORS.articleTitle);
  if (articleTitle) {
    const link = container.querySelector(SELECTORS.articleLink);
    return `article: ${text(articleTitle)}${link ? ` (${link.href})` : ''}`;
  }
  const img = container.querySelector(SELECTORS.imageAttachment);
  if (img) return `image: ${img.alt || '(no alt text)'}`;
  return null;
}

function scrapePostFromContainer(container) {
  const urn = findUrn(container);
  const authorEl = container.querySelector(SELECTORS.actorName);
  const headlineEl = container.querySelector(SELECTORS.actorHeadline);
  const subDescEl = container.querySelector(SELECTORS.actorSubDescription);
  const textEl = container.querySelector(SELECTORS.postText);
  const permalink = container.querySelector('a[href*="/feed/update/"]');

  if (!urn && !authorEl && !textEl) {
    return { ok: false, error: 'container matched but no recognizable post fields found' };
  }

  const author = text(authorEl);
  const authorHeadline = text(headlineEl);

  return {
    ok: true,
    post: {
      urn,
      url: permalink ? permalink.href.split('?')[0] : (urn ? `https://www.linkedin.com/feed/update/${urn}/` : null),
      author: author || null,
      authorHeadline: authorHeadline || null,
      company: guessCompany(authorHeadline),
      postedRelative: text(subDescEl) || null,
      savedConfirmed: location.pathname.includes('/my-items/saved-posts'),
      postText: text(textEl),
      attachment: scrapeAttachment(container),
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

async function scrapeSavedPosts() {
  const containers = Array.from(document.querySelectorAll(SELECTORS.postContainer));
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
  return { posts: results, errors, containerCount: containers.length };
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
  // Intentionally does not submit: a human clicks Post so nothing public
  // goes out without a final review, per the PRD's default posture.
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'LPT_SCRAPE_SAVED_POSTS':
        sendResponse(await scrapeSavedPosts());
        break;
      case 'LPT_DO_LIKE':
        sendResponse(await doLike(message.urn));
        break;
      case 'LPT_IS_SAVED':
        sendResponse(await isSaved(message.urn));
        break;
      case 'LPT_DO_UNSAVE':
        sendResponse(await doUnsave(message.urn));
        break;
      case 'LPT_INSERT_COMMENT':
        sendResponse(await insertCommentDraft(message.urn, message.text));
        break;
      default:
        sendResponse({ ok: false, error: `unknown message type: ${message.type}` });
    }
  })();
  return true; // keep the channel open for the async response
});
