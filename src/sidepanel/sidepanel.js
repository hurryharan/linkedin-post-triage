import { getAllPosts, upsertPost, mergeScraped, clearAllPosts, getSettings, getActiveCredentials, getQueueState, setQueueState, SETTINGS_KEY } from '../lib/storage.js';
import { classifyPost, draftComment, PROVIDER_LABELS } from '../lib/ai-client.js';
import { POST_TYPES, TYPE_LABELS, ACTION_KEYS, ACTION_LABELS } from '../lib/prompts.js';
import { buildOfflinePrompt, parseOfflineResponse } from '../lib/offline-prompt.js';
import { downloadWorkbook } from '../lib/xlsx-export.js';
import { makeLogger } from '../lib/logger.js';

const logger = makeLogger('sidepanel');

// Tags for a separate, external workflow — this tool never drives LinkedIn's
// UI for these. Comment is the one exception (see the comment block below):
// drafting happens here, but posting is still manual, so it's rendered
// separately rather than as one of these chips.
const TAG_LABELS = Object.fromEntries(ACTION_KEYS.filter((k) => k !== 'comment').map((k) => [k, ACTION_LABELS[k]]));

const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const scanBtn = document.getElementById('scanBtn');
const classifyAllBtn = document.getElementById('classifyAllBtn');
const exportBtn = document.getElementById('exportBtn');
const resetBtn = document.getElementById('resetBtn');
let activeTab = 'pending';
let posts = [];
let settings = null;
let queueState = { currentId: null };
let lastPendingIndex = 0;
// True while a network/storage operation the whole panel should wait on is
// in flight (scan, classify, reset) — disables every action button so a
// second click can't fire a duplicate request or race the first one.
let busy = false;

// Toolbar buttons only, not the review card (that's rebuilt by render()
// itself, which reads `busy` directly) — called after every render() and
// right before/after any operation that sets `busy`.
function updateToolbarButtons() {
  const hasPosts = posts.length > 0;
  const hasClassifyTargets = posts.some((p) => p.status === 'pending' && !p.classifiedAt);
  scanBtn.disabled = busy;
  resetBtn.disabled = busy || !hasPosts;
  exportBtn.disabled = busy || !hasPosts;
  classifyAllBtn.disabled = busy || !hasClassifyTargets;
}

function setBanner(msg) {
  if (!msg) {
    bannerEl.hidden = true;
    return;
  }
  bannerEl.textContent = msg;
  bannerEl.hidden = false;
}

async function refresh() {
  posts = await getAllPosts();
  render();
}

function pendingQueue() {
  return posts.filter((p) => p.status === 'pending');
}

function isBulkMode() {
  return settings?.workflowMode === 'bulk';
}

function isOfflineMode() {
  return settings?.classifyMode === 'offline';
}

// Keeps the queue pointer valid after a scan, a post finishing, etc. If the
// remembered post is gone, hold the same list position rather than resetting
// to the front, so completing post 5 of 12 lands you on the new post 5.
function resolveCurrentIndex(queue, previousIndex = 0) {
  if (!queue.length) return -1;
  const idx = queueState.currentId ? queue.findIndex((p) => p.id === queueState.currentId) : -1;
  if (idx >= 0) return idx;
  return Math.min(previousIndex, queue.length - 1);
}

async function goToIndex(queue, index) {
  const clamped = Math.max(0, Math.min(index, queue.length - 1));
  lastPendingIndex = clamped;
  queueState = { currentId: queue[clamped]?.id || null };
  await setQueueState(queueState);
}

// --- Linked-in tab plumbing (scan only — see content.js) --------------------

// Declarative content_scripts only auto-inject into *new* page loads — a tab
// that was already open before the extension was installed/reloaded never
// gets it, which is exactly what produces "Could not establish connection.
// Receiving end does not exist." So inject explicitly before every message;
// content.js's own load guard makes re-injecting into an already-loaded tab
// a harmless no-op.
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
  } catch (err) {
    // Fails on chrome:// pages, a tab mid-navigation, etc. — sendMessage
    // below will surface the real error if the script truly isn't there.
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.status === 'complete') return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Finds (or opens) the saved-posts tab specifically — scraping only ever
// makes sense there, so this never guesses among other open LinkedIn tabs.
async function ensureSavedPostsTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.linkedin.com/my-items/saved-posts/*' });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: 'https://www.linkedin.com/my-items/saved-posts/' });
}

// --- Toolbar actions ---------------------------------------------------------

scanBtn.addEventListener('click', async () => {
  busy = true;
  updateToolbarButtons();
  try {
    setBanner('Scanning saved posts…');
    const tab = await ensureSavedPostsTab();
    await waitForTabComplete(tab.id);
    // LinkedIn is a client-rendered SPA — "complete" fires before the saved
    // posts list has actually painted, so give it a beat before scraping.
    await new Promise((r) => setTimeout(r, 1200));
    await ensureContentScript(tab.id);
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'LPT_SCRAPE_SAVED_POSTS' });
    } catch (err) {
      logger.error('scan', String(err));
      setBanner(`Scan failed: ${err.message} (see Debug logs in Settings)`);
      return;
    }
    if (!res?.ok) {
      logger.error('scan', res?.error || 'no response from the saved-posts tab');
      setBanner(`Scan failed: ${res?.error || 'no response from the saved-posts tab'} (see Debug logs in Settings)`);
      return;
    }
    const added = await mergeScraped(res.posts);
    const errCount = res.errors?.length || 0;
    setBanner(
      `Scanned ${res.containerCount} post(s), added ${added} new.` +
        (errCount ? ` ${errCount} could not be parsed — LinkedIn's DOM may have changed; see README.` : '')
    );
    await refresh();
  } finally {
    busy = false;
    render();
  }
});

// Bulk mode's only classify affordance — classifies every pending,
// unclassified post in one shot, live-API or offline depending on Settings.
// The one-at-a-time review flow (below) has its own per-post Classify button
// instead; this button is hidden outside bulk mode.
classifyAllBtn.addEventListener('click', async () => {
  const targets = posts.filter((p) => p.status === 'pending' && !p.classifiedAt);
  if (!targets.length) return; // button is disabled in this state, but guard anyway
  if (isOfflineMode()) {
    openOfflinePanel(targets);
    return;
  }
  busy = true;
  updateToolbarButtons();
  try {
    await classifyViaApi(targets, (done, total) => setBanner(`Classifying ${done}/${total}…`));
  } finally {
    busy = false;
    render();
  }
});

exportBtn.addEventListener('click', async () => {
  downloadWorkbook(await getAllPosts());
});

// Deletes every scraped/triaged post (pending and processed) so a rescan
// starts from nothing — e.g. after a bad scrape, a synthetic-id collision,
// or just wanting to drop everything and start over. Settings are untouched.
resetBtn.addEventListener('click', async () => {
  const count = posts.length;
  if (!count) return; // button is disabled in this state, but guard anyway
  if (!confirm(`Delete all ${count} saved post(s) (pending and processed)? This can't be undone — export first if you want a copy.`)) return;
  busy = true;
  updateToolbarButtons();
  try {
    await clearAllPosts();
    setBanner(`Cleared ${count} post(s). Click "Scan saved posts" to rescan.`);
    await refresh();
  } finally {
    busy = false;
    render();
  }
});

document.getElementById('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
});

// --- Classification (live API or offline prompt, shared by both flows) -----

// Turns a classification's AI-recommended actions into pre-checked tags —
// the same tags xlsx-export.js reads to build per-action sheets — without
// ever un-checking a tag you'd already set yourself.
function applyRecommendedActions(post, recommendedActions) {
  for (const key of recommendedActions || []) {
    if (key in post.actions) post.actions[key] = true;
  }
}

async function classifyViaApi(targets, onProgress) {
  settings = settings || (await getSettings());
  const creds = getActiveCredentials(settings);
  if (!creds.apiKey) {
    setBanner(`Set an API key for ${PROVIDER_LABELS[creds.provider]} in Settings, or switch to Offline classification there.`);
    return;
  }
  let done = 0;
  let failed = 0;
  for (const post of targets) {
    try {
      const { recommendedActions, ...classification } = await classifyPost({
        ...creds,
        author: post.author,
        authorHeadline: post.authorHeadline,
        postText: post.postText,
        projects: settings.projects,
      });
      post.classification = classification;
      applyRecommendedActions(post, recommendedActions);
      post.classifiedAt = new Date().toISOString();
      await upsertPost(post);
    } catch (err) {
      failed++;
      logger.error('classifyViaApi', post.id, err);
    }
    done++;
    onProgress?.(done, targets.length);
  }
  setBanner(failed ? `Classified ${done - failed}/${targets.length}, ${failed} failed — see Debug logs in Settings.` : `Classified ${done} post(s).`);
  await refresh();
}

const offlinePanelEl = document.getElementById('offlinePanel');
const offlinePromptEl = document.getElementById('offlinePromptEl');
const offlinePasteEl = document.getElementById('offlinePasteEl');
const offlineApplyBtn = document.getElementById('offlineApplyBtn');
let offlineTargetIds = [];

function openOfflinePanel(targets) {
  settings = settings || {};
  offlineTargetIds = targets.map((p) => p.id);
  offlinePromptEl.value = buildOfflinePrompt(targets, settings.projects || []);
  offlinePasteEl.value = '';
  offlineApplyBtn.disabled = true; // nothing pasted yet
  offlinePanelEl.hidden = false;
  setBanner(`Prompt built for ${targets.length} post(s). Copy it into Claude or ChatGPT, then paste the reply back below.`);
}

offlinePasteEl.addEventListener('input', () => {
  offlineApplyBtn.disabled = !offlinePasteEl.value.trim();
});

document.getElementById('offlineCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(offlinePromptEl.value);
    setBanner('Prompt copied to clipboard.');
  } catch (err) {
    setBanner(`Copy failed: ${err.message}`);
  }
});

document.getElementById('offlineCloseBtn').addEventListener('click', () => {
  offlinePanelEl.hidden = true;
});

offlineApplyBtn.addEventListener('click', async () => {
  const { ok, classifications, errors } = parseOfflineResponse(offlinePasteEl.value);
  if (!ok) {
    setBanner(`Could not apply: ${errors[0] || 'no classifications found'}`);
    return;
  }
  offlineApplyBtn.disabled = true;
  try {
    const targetIds = new Set(offlineTargetIds);
    const byId = new Map(posts.map((p) => [p.id, p]));
    let applied = 0;
    for (const c of classifications) {
      if (!targetIds.has(c.id)) {
        errors.push(`id "${c.id}" wasn't one of the posts this prompt was built for — skipped.`);
        continue;
      }
      const post = byId.get(c.id);
      if (!post) {
        errors.push(`No post with id "${c.id}" — skipped.`);
        continue;
      }
      post.classification = { topic: c.topic, summary: c.summary, whySaved: c.whySaved, project: c.project, projectCustom: c.projectCustom, type: c.type };
      applyRecommendedActions(post, c.recommendedActions);
      // Don't clobber a draft you already wrote or generated yourself.
      if (c.commentDraft && !post.commentDraft) post.commentDraft = c.commentDraft;
      post.classifiedAt = new Date().toISOString();
      await upsertPost(post);
      applied++;
    }
    setBanner(`Applied ${applied} classification(s).` + (errors.length ? ` ${errors.length} issue(s) — see Debug logs in Settings.` : ''));
    errors.forEach((e) => logger.warn('offlineApply', e));
    if (applied) {
      offlinePanelEl.hidden = true;
      offlinePasteEl.value = '';
    }
    await refresh();
  } finally {
    offlineApplyBtn.disabled = !offlinePasteEl.value.trim();
  }
});

// --- Per-post actions (single-post review flow) -----------------------------

async function classifyCurrent(post) {
  if (isOfflineMode()) {
    openOfflinePanel([post]);
    return;
  }
  busy = true;
  render();
  try {
    await classifyViaApi([post], () => setBanner('Classifying…'));
  } finally {
    busy = false;
    render();
  }
}

async function suggestComment(post) {
  settings = settings || (await getSettings());
  const creds = getActiveCredentials(settings);
  if (!creds.apiKey) return setBanner(`Set an API key for ${PROVIDER_LABELS[creds.provider]} in Settings first, or just write the comment yourself.`);
  busy = true;
  render();
  try {
    post.commentDraft = await draftComment({
      ...creds,
      postText: post.postText,
      classification: post.classification,
    });
    await upsertPost(post);
  } catch (err) {
    logger.error('suggestComment', post.id, err);
    setBanner(`Suggest comment failed: ${err.message} (see Debug logs in Settings)`);
  } finally {
    busy = false;
    render();
  }
}

async function copyComment(post) {
  if (!post.commentDraft || !post.commentDraft.trim()) {
    setBanner('Write or suggest a comment first.');
    return;
  }
  try {
    await navigator.clipboard.writeText(post.commentDraft);
    setBanner('Comment copied — paste it on the post in LinkedIn, then post it yourself.');
  } catch (err) {
    setBanner(`Copy failed: ${err.message}`);
  }
}

async function markDoneAndAdvance(queue, index) {
  busy = true;
  render();
  try {
    const post = queue[index];
    post.status = 'processed';
    post.processedAt = new Date().toISOString();
    await upsertPost(post);
    posts = await getAllPosts();
    const nextQueue = pendingQueue();
    await goToIndex(nextQueue, Math.min(index, nextQueue.length - 1));
  } finally {
    busy = false;
    render();
  }
}

async function skipToNext(queue, index) {
  await goToIndex(queue, index + 1);
  render();
}

// --- Rendering -------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  });
  children.forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return node;
}

function inputField(post, key, onAfter) {
  return el('input', {
    type: 'text',
    value: post.classification?.[key] || '',
    onchange: async (e) => {
      post.classification[key] = e.target.value;
      await upsertPost(post);
      onAfter?.();
    },
  });
}

function textareaField(post, key, isTopLevel = false) {
  const value = isTopLevel ? post[key] || '' : post.classification?.[key] || '';
  return el('textarea', {
    onchange: async (e) => {
      if (isTopLevel) post[key] = e.target.value;
      else post.classification[key] = e.target.value;
      await upsertPost(post);
    },
  }, [value]);
}

function projectSelect(post, onAfter) {
  const known = settings?.projects || [];
  const options = ['', ...known, 'Other'];
  const current = post.classification?.project || '';
  return el(
    'select',
    {
      onchange: async (e) => {
        post.classification = post.classification || {};
        post.classification.project = e.target.value;
        await upsertPost(post);
        onAfter?.();
      },
    },
    options.map((opt) => el('option', { value: opt, ...(opt === current ? { selected: 'selected' } : {}) }, [opt || '(none)']))
  );
}

function typeSelect(post) {
  const current = post.classification?.type || '';
  return el(
    'select',
    {
      onchange: async (e) => {
        post.classification = post.classification || {};
        post.classification.type = e.target.value;
        await upsertPost(post);
      },
    },
    ['', ...POST_TYPES].map((t) => el('option', { value: t, ...(t === current ? { selected: 'selected' } : {}) }, [t ? (TYPE_LABELS[t] || t) : '(none)']))
  );
}

function prioritySelect(post) {
  return el(
    'select',
    {
      onchange: async (e) => {
        post.priority = Number(e.target.value);
        await upsertPost(post);
      },
    },
    [1, 2, 3, 4, 5].map((n) => el('option', { value: n, ...(n === post.priority ? { selected: 'selected' } : {}) }, [String(n)]))
  );
}

function metaLine(post) {
  const parts = [post.company, post.postDateTime || post.postedRelative, post.engagementMetrics].filter(Boolean);
  return parts.join(' · ');
}

// The single-post review card: classify → tag → (optionally) draft a
// comment → mark done. Every action here either edits local storage or
// copies text to the clipboard — nothing here clicks anything on linkedin.com.
function renderReviewCard(post, rerender) {
  const c = post.classification || {};
  const textNode = el('div', { class: 'post-text' }, [post.postText || '(no text captured)']);
  textNode.addEventListener('click', () => textNode.classList.toggle('expanded'));

  const header = el('div', { class: 'card-header' }, [
    el('span', { class: 'author' }, [
      post.authorProfileUrl ? el('a', { href: post.authorProfileUrl, target: '_blank' }, [post.author || 'Unknown author']) : el('span', {}, [post.author || 'Unknown author']),
    ]),
    el('span', { class: 'meta' }, [metaLine(post)]),
  ]);

  const links = post.url || post.mediaInfo
    ? el('div', { class: 'meta' }, [
        post.url ? el('a', { href: post.url, target: '_blank' }, ['Open post ↗']) : '',
        post.mediaInfo ? ` · ${post.mediaInfo}` : '',
      ])
    : null;

  const canClassify = isOfflineMode() || !!getActiveCredentials(settings || {}).apiKey;
  const classifyRow = el('div', { class: 'section-row' }, [
    el('span', { class: 'status-pill' }, [post.classifiedAt ? 'Classified' : 'Not classified']),
    el('button', { class: 'small', ...(busy || !canClassify ? { disabled: 'disabled' } : {}), onclick: () => classifyCurrent(post) }, [post.classifiedAt ? 'Re-classify' : 'Classify']),
  ]);

  const labeled = (label, control) => el('div', { class: 'labeled-field' }, [el('label', { class: 'field-label' }, [label]), control]);

  const classifyFields = el('div', { class: 'classify-fields' }, [
    labeled('Topic', inputField(post, 'topic')),
    el('div', { class: 'field-row' }, [
      labeled('Summary', textareaField(post, 'summary')),
      labeled('Why saved', textareaField(post, 'whySaved')),
    ]),
    el('div', { class: 'field-row three' }, [
      labeled('Project', projectSelect(post, rerender)),
      labeled('Type', typeSelect(post)),
      labeled('Priority', prioritySelect(post)),
    ]),
    c.project === 'Other' ? labeled('Custom project', inputField(post, 'projectCustom')) : null,
  ].filter(Boolean));

  const tagsRow = el(
    'div',
    { class: 'tags-row' },
    [
      el('label', { class: 'tag-chip' }, [
        el('input', {
          type: 'checkbox',
          ...(post.actions.comment ? { checked: 'checked' } : {}),
          onchange: async (e) => {
            post.actions.comment = e.target.checked;
            await upsertPost(post);
            rerender();
          },
        }),
        'Comment',
      ]),
      ...Object.keys(TAG_LABELS).map((key) =>
        el('label', { class: 'tag-chip' }, [
          el('input', {
            type: 'checkbox',
            ...(post.actions[key] ? { checked: 'checked' } : {}),
            onchange: async (e) => {
              post.actions[key] = e.target.checked;
              await upsertPost(post);
            },
          }),
          TAG_LABELS[key],
        ])
      ),
    ]
  );

  // Suggest with AI always calls the live provider API directly, regardless
  // of Settings' Classification input mode — offline mode instead gets its
  // draft for free from the classification prompt's own commentDraft field.
  const hasLiveKey = !!getActiveCredentials(settings || {}).apiKey;
  const hasDraft = !!(post.commentDraft && post.commentDraft.trim());
  const commentActionsRow = el('div', { class: 'section-row' }, [
    el('div', { class: 'btns' }, [
      el('button', { class: 'small', ...(busy || !hasLiveKey ? { disabled: 'disabled' } : {}), title: hasLiveKey ? '' : 'Set an API key in Settings to use this, or get a draft for free by classifying in Offline mode', onclick: () => suggestComment(post) }, ['Suggest with AI']),
      el('button', { class: 'small', ...(busy || !hasDraft ? { disabled: 'disabled' } : {}), onclick: () => copyComment(post) }, ['Copy']),
    ]),
    el('label', { class: 'tag-chip' }, [
      el('input', {
        type: 'checkbox',
        ...(post.commentPosted ? { checked: 'checked' } : {}),
        onchange: async (e) => {
          post.commentPosted = e.target.checked ? new Date().toISOString() : null;
          await upsertPost(post);
          rerender();
        },
      }),
      'Posted it myself',
    ]),
  ]);
  const commentTextarea = textareaField(post, 'commentDraft', true);
  // Live mode: the button that fills the field sits above it, same as
  // Classify sitting above the fields it populates. Offline mode: the draft
  // usually arrives pre-filled from the classification step itself, so the
  // content comes first and the (mostly secondary/Copy-only) actions follow.
  const commentBlock = post.actions.comment
    ? el('div', { class: 'comment-block' }, isOfflineMode() ? [commentTextarea, commentActionsRow] : [commentActionsRow, commentTextarea])
    : null;

  return el('div', { class: 'card' }, [
    header,
    links,
    textNode,
    classifyRow,
    classifyFields,
    tagsRow,
    commentBlock,
  ].filter(Boolean));
}

// One post at a time, in scrape order — classify, tag, comment, then Mark
// done advances to the next pending post. This is the whole point of the
// tool: never juggle more than one post's state at once.
function renderReviewFlow(queue) {
  const index = resolveCurrentIndex(queue, lastPendingIndex);
  lastPendingIndex = index;
  const current = queue[index];
  if (queueState.currentId !== current.id) {
    queueState = { currentId: current.id };
    setQueueState(queueState);
  }

  const rerender = () => render();
  const isLast = index >= queue.length - 1;

  // Top: pure position/navigation (where am I, go back). Bottom: the two
  // forward-progressing actions grouped together, primary CTA on the right —
  // reading the card top to bottom ends at the button that moves you on.
  const nav = el('div', { class: 'review-nav' }, [
    el('button', { class: 'small', ...(busy || index === 0 ? { disabled: 'disabled' } : {}), onclick: async () => { await goToIndex(queue, index - 1); render(); } }, ['← Prev']),
    el('span', { class: 'status-pill' }, [`${index + 1} of ${queue.length}`]),
  ]);

  const footer = el('div', { class: 'review-footer' }, [
    el('button', { class: 'link-btn', ...(busy || isLast ? { disabled: 'disabled' } : {}), onclick: () => skipToNext(queue, index) }, ['Skip for now →']),
    el('button', { class: 'primary', ...(busy ? { disabled: 'disabled' } : {}), onclick: () => markDoneAndAdvance(queue, index) }, ['Mark done → Next']),
  ]);

  listEl.appendChild(nav);
  listEl.appendChild(renderReviewCard(current, rerender));
  listEl.appendChild(footer);
}

function statusSummary(post) {
  return post.status === 'processed' ? (post.commentPosted ? 'commented' : 'processed') : (post.classifiedAt ? 'classified' : 'not classified');
}

// Read-only overview table — used for the Processed tab always, and for the
// Pending tab in bulk mode (no per-post flow there, just classify + export).
function renderTable(list) {
  const rows = list.map((post) => {
    const c = post.classification || {};
    const project = c.project === 'Other' ? (c.projectCustom || 'Other') : (c.project || '');
    const date = post.processedAt || post.postDateTime || post.postedRelative || post.createdAt || '';
    return el('tr', {}, [
      el('td', {}, [post.author || 'Unknown author']),
      el('td', { class: 'ellipsis' }, [c.topic || '']),
      el('td', {}, [project]),
      el('td', {}, [c.type ? (TYPE_LABELS[c.type] || c.type) : '']),
      el('td', {}, [statusSummary(post)]),
      el('td', {}, [/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date]),
    ]);
  });
  return el('table', { class: 'post-table' }, [
    el('thead', {}, [el('tr', {}, ['Author', 'Topic', 'Project', 'Type', 'Status', 'Date'].map((h) => el('th', {}, [h])))]),
    el('tbody', {}, rows),
  ]);
}

function render() {
  listEl.innerHTML = '';
  classifyAllBtn.hidden = !isBulkMode();
  updateToolbarButtons();

  if (activeTab === 'pending') {
    const queue = pendingQueue();
    if (!queue.length) {
      listEl.appendChild(el('div', { class: 'empty-state' }, ['No pending posts. Click "Scan saved posts" to pull from LinkedIn.']));
      return;
    }
    if (isBulkMode()) {
      listEl.appendChild(renderTable(queue));
    } else {
      renderReviewFlow(queue);
    }
    return;
  }

  const processed = posts.filter((p) => p.status === 'processed');
  if (!processed.length) {
    listEl.appendChild(el('div', { class: 'empty-state' }, ['Nothing processed yet.']));
    return;
  }
  listEl.appendChild(renderTable(processed));
}

// Settings are edited on a separate options page while this panel stays
// open, so a one-time load at init would go stale the moment you flip
// Classification input or Review flow mode there — pick up live changes.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
  settings = await getSettings();
  render();
});

(async function init() {
  settings = await getSettings();
  queueState = await getQueueState();
  await refresh();
})();
