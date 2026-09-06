import { getAllPosts, upsertPost, mergeScraped, getSettings, getActiveCredentials, getQueueState, setQueueState, ACTION_KEYS } from '../lib/storage.js';
import { classifyPost, draftComment, PROVIDER_LABELS } from '../lib/ai-client.js';
import { POST_TYPES, TYPE_LABELS } from '../lib/prompts.js';
import { buildOfflinePrompt, parseOfflineResponse } from '../lib/offline-prompt.js';
import { downloadWorkbook } from '../lib/xlsx-export.js';
import { makeLogger } from '../lib/logger.js';

const logger = makeLogger('sidepanel');

const ACTION_LABELS = {
  like: 'Like',
  comment: 'Comment',
  crm: 'CRM entry',
  research: 'Research',
  post_idea: 'Post idea',
  repost: 'Repost',
};

const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
let activeTab = 'pending';
let viewMode = 'cards';
let posts = [];
let settings = null;
let queueState = { currentId: null };
let lastPendingIndex = 0;

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

// --- Linked-in tab plumbing -------------------------------------------------

async function getLinkedInTabs() {
  return chrome.tabs.query({ url: '*://www.linkedin.com/*' });
}

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

async function sendToLinkedInTabs(message) {
  const tabs = await getLinkedInTabs();
  logger.log('sendToLinkedInTabs', message.type, `${tabs.length} candidate tab(s)`);
  if (!tabs.length) return { ok: false, error: 'no LinkedIn tab is open' };
  let last = { ok: false, error: 'no matching tab responded' };
  for (const tab of tabs) {
    try {
      await ensureContentScript(tab.id);
      const res = await chrome.tabs.sendMessage(tab.id, message);
      logger.log('sendToLinkedInTabs', message.type, 'tab', tab.id, '→', JSON.stringify(res));
      if (res && res.ok) return res;
      if (res) last = res;
    } catch (err) {
      logger.error('sendToLinkedInTabs', message.type, 'tab', tab.id, 'threw', err);
      last = { ok: false, error: String(err) };
    }
  }
  return last;
}

async function ensureSavedPostsTab() {
  const tabs = await getLinkedInTabs();
  const onSavedPage = tabs.find((t) => t.url.includes('/my-items/saved-posts'));
  if (onSavedPage) return onSavedPage;
  return chrome.tabs.create({ url: 'https://www.linkedin.com/my-items/saved-posts/' });
}

// --- Toolbar actions ---------------------------------------------------------

document.getElementById('scanBtn').addEventListener('click', async () => {
  setBanner('Scanning saved posts…');
  const tab = await ensureSavedPostsTab();
  await waitForTabComplete(tab.id);
  // LinkedIn is a client-rendered SPA — "complete" fires before the saved
  // posts list has actually painted, so give it a beat before scraping.
  await new Promise((r) => setTimeout(r, 1200));
  const res = await sendToLinkedInTabs({ type: 'LPT_SCRAPE_SAVED_POSTS' });
  if (!res.ok) {
    logger.error('scan', res.error);
    setBanner(`Scan failed: ${res.error} (see Debug logs in Settings)`);
    return;
  }
  const added = await mergeScraped(res.posts);
  const errCount = res.errors?.length || 0;
  setBanner(
    `Scanned ${res.containerCount} post(s), added ${added} new.` +
      (errCount ? ` ${errCount} could not be parsed — LinkedIn's DOM may have changed; see README.` : '')
  );
  await refresh();
});

document.getElementById('classifyAllBtn').addEventListener('click', async () => {
  settings = await getSettings();
  const creds = getActiveCredentials(settings);
  if (!creds.apiKey) {
    setBanner(`Set an API key for ${PROVIDER_LABELS[creds.provider]} in Settings first, or just fill this in by hand.`);
    return;
  }
  const targets = posts.filter((p) => p.status === 'pending' && !p.classifiedAt);
  setBanner(`Classifying ${targets.length} post(s)…`);
  let failed = 0;
  for (const post of targets) {
    try {
      post.classification = await classifyPost({
        ...creds,
        author: post.author,
        authorHeadline: post.authorHeadline,
        postText: post.postText,
        projects: settings.projects,
      });
      post.classifiedAt = new Date().toISOString();
      await upsertPost(post);
    } catch (err) {
      failed++;
      logger.error('classifyAll', post.id, err);
    }
  }
  setBanner(failed ? `Done, ${failed} failed — check the API key/model in Settings.` : 'Classification complete.');
  await refresh();
});

// --- Offline AI: no API key needed, classify via a pasted chat-UI reply ----

const offlinePanelEl = document.getElementById('offlinePanel');
const offlinePromptEl = document.getElementById('offlinePromptEl');
const offlinePasteEl = document.getElementById('offlinePasteEl');

document.getElementById('offlineAiBtn').addEventListener('click', async () => {
  settings = settings || (await getSettings());
  const targets = posts.filter((p) => p.status === 'pending' && !p.classifiedAt);
  if (!targets.length) {
    setBanner('No pending, unclassified posts to build a prompt for.');
    return;
  }
  offlinePromptEl.value = buildOfflinePrompt(targets, settings.projects);
  offlinePasteEl.value = '';
  offlinePanelEl.hidden = false;
  setBanner(`Prompt built for ${targets.length} post(s). Copy it into Claude or ChatGPT.`);
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

document.getElementById('offlineApplyBtn').addEventListener('click', async () => {
  const { ok, classifications, errors } = parseOfflineResponse(offlinePasteEl.value);
  if (!ok) {
    setBanner(`Could not apply: ${errors[0] || 'no classifications found'}`);
    return;
  }
  let applied = 0;
  const byId = new Map(posts.map((p) => [p.id, p]));
  for (const c of classifications) {
    const post = byId.get(c.id);
    if (!post) {
      errors.push(`No pending post with id "${c.id}" — skipped.`);
      continue;
    }
    post.classification = { topic: c.topic, summary: c.summary, whySaved: c.whySaved, project: c.project, projectCustom: c.projectCustom, type: c.type };
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
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  downloadWorkbook(await getAllPosts());
});

document.getElementById('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
});

document.querySelectorAll('.view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    viewMode = btn.dataset.view;
    document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
});

// --- Per-post helpers ----------------------------------------------------

async function maybeAutoUnsave(post) {
  const selected = ACTION_KEYS.filter((k) => post.actions[k]);
  if (!selected.length) return;
  const allDone = selected.every((k) => post.manualDone[k]);
  if (!allDone || post.status === 'processed') return;

  const savedCheck = await sendToLinkedInTabs({ type: 'LPT_IS_SAVED', urn: post.urn });
  if (!savedCheck.ok) {
    post.unsaveStatus = 'failed';
    await upsertPost(post);
    return;
  }
  if (savedCheck.saved === false) {
    post.unsaveStatus = 'done';
    post.status = 'processed';
    post.processedAt = new Date().toISOString();
    await upsertPost(post);
    return;
  }
  const res = await sendToLinkedInTabs({ type: 'LPT_DO_UNSAVE', urn: post.urn });
  post.unsaveStatus = res.ok ? 'done' : 'failed';
  if (res.ok) {
    post.status = 'processed';
    post.processedAt = new Date().toISOString();
  } else {
    setBanner(`Couldn't verify unsave: ${res.error}. Left in Pending.`);
  }
  await upsertPost(post);
}

async function reclassify(post) {
  settings = settings || (await getSettings());
  const creds = getActiveCredentials(settings);
  if (!creds.apiKey) return setBanner(`Set an API key for ${PROVIDER_LABELS[creds.provider]} in Settings first, or just fill this in by hand.`);
  try {
    post.classification = await classifyPost({
      ...creds,
      author: post.author,
      authorHeadline: post.authorHeadline,
      postText: post.postText,
      projects: settings.projects,
    });
    post.classifiedAt = new Date().toISOString();
    await upsertPost(post);
    await refresh();
  } catch (err) {
    logger.error('reclassify', post.id, err);
    setBanner(`Classify failed: ${err.message} (see Debug logs in Settings)`);
  }
}

async function suggestComment(post) {
  settings = settings || (await getSettings());
  const creds = getActiveCredentials(settings);
  if (!creds.apiKey) return setBanner(`Set an API key for ${PROVIDER_LABELS[creds.provider]} in Settings first, or just fill this in by hand.`);
  try {
    post.commentDraft = await draftComment({
      ...creds,
      postText: post.postText,
      classification: post.classification,
    });
    await upsertPost(post);
    await refresh();
  } catch (err) {
    logger.error('suggestComment', post.id, err);
    setBanner(`Suggest comment failed: ${err.message} (see Debug logs in Settings)`);
  }
}

// Only path that publishes anything: fills the box, then requires an explicit
// confirm before the content script clicks Post, then verifies it went through.
async function postCommentNow(post) {
  if (!post.commentDraft || !post.commentDraft.trim()) {
    setBanner('Write or suggest a comment first.');
    return;
  }
  if (!confirm(`Post this comment to LinkedIn now?\n\n"${post.commentDraft}"`)) return;

  setBanner('Posting comment…');
  const insertRes = await sendToLinkedInTabs({ type: 'LPT_INSERT_COMMENT', urn: post.urn, text: post.commentDraft });
  if (!insertRes.ok) {
    setBanner(`Comment not posted — couldn't open the comment box: ${insertRes.error}`);
    return;
  }
  const submitRes = await sendToLinkedInTabs({ type: 'LPT_SUBMIT_COMMENT', urn: post.urn });
  if (!submitRes.ok) {
    setBanner(`Comment drafted on LinkedIn but posting failed: ${submitRes.error}. Check the post directly.`);
    return;
  }
  post.commentPosted = post.commentDraft;
  post.manualDone.comment = true;
  await upsertPost(post);
  setBanner('Comment posted and verified.');
  await maybeAutoUnsave(post);
  await refresh();
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

function projectOptions(post) {
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
        render();
      },
    },
    options.map((opt) => el('option', { value: opt, ...(opt === current ? { selected: 'selected' } : {}) }, [opt || '(none)']))
  );
}

function typeOptions(post) {
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

function metaLine(post) {
  const parts = [post.company, post.postDateTime || post.postedRelative, post.engagementMetrics].filter(Boolean);
  return parts.join(' · ');
}

function renderCard(post) {
  const c = post.classification || {};
  const textEl = el('div', { class: 'post-text' }, [post.postText || '(no text captured)']);
  textEl.addEventListener('click', () => textEl.classList.toggle('expanded'));

  const authorLine = [
    post.authorProfileUrl ? el('a', { href: post.authorProfileUrl, target: '_blank' }, [post.author || 'Unknown author']) : el('span', {}, [post.author || 'Unknown author']),
  ];
  const header = el('div', { class: 'card-header' }, [
    el('span', { class: 'author' }, authorLine),
    el('span', { class: 'meta' }, [metaLine(post)]),
  ]);

  const links = el('div', { class: 'meta' }, [
    post.url ? el('a', { href: post.url, target: '_blank' }, ['Open post ↗']) : '',
    post.mediaInfo ? ` · ${post.mediaInfo}` : '',
  ]);

  // Classification fields are always editable — an API key is optional.
  // The AI button just pre-fills them; typing your own is equally valid.
  const classificationBlock = el('div', {}, [
    el('div', { class: 'card-footer' }, [
      el('span', { class: 'status-pill' }, [post.classifiedAt ? 'AI-classified' : 'not classified']),
      el('button', { class: 'small', onclick: () => reclassify(post) }, [post.classifiedAt ? 'Re-classify with AI' : 'Classify with AI']),
    ]),
    el('label', { class: 'field-label' }, ['Topic']),
    inputField(post, 'topic'),
    el('label', { class: 'field-label' }, ['Summary']),
    textareaField(post, 'summary'),
    el('label', { class: 'field-label' }, ['Why saved']),
    textareaField(post, 'whySaved'),
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', { class: 'field-label' }, ['Project']), projectOptions(post)]),
      el('div', {}, [el('label', { class: 'field-label' }, ['Type']), typeOptions(post)]),
    ]),
    c.project === 'Other'
      ? el('div', {}, [el('label', { class: 'field-label' }, ['Custom project label']), inputField(post, 'projectCustom')])
      : null,
  ].filter(Boolean));

  const actionsRow = el(
    'div',
    { class: 'actions-row' },
    ACTION_KEYS.map((key) =>
      el('label', { class: 'action-chip' }, [
        el('input', {
          type: 'checkbox',
          ...(post.actions[key] ? { checked: 'checked' } : {}),
          onchange: async (e) => {
            post.actions[key] = e.target.checked;
            await upsertPost(post);
            render();
          },
        }),
        ACTION_LABELS[key],
      ])
    )
  );

  const selectedActions = ACTION_KEYS.filter((k) => post.actions[k]);
  const doneRow = selectedActions.length
    ? el(
        'div',
        { class: 'done-row' },
        selectedActions
          .filter((key) => key !== 'comment') // comment's "done" is set by postCommentNow, not a manual tick
          .map((key) =>
            el('label', { class: 'action-chip' }, [
              el('input', {
                type: 'checkbox',
                ...(post.manualDone[key] ? { checked: 'checked' } : {}),
                onchange: async (e) => {
                  post.manualDone[key] = e.target.checked;
                  await upsertPost(post);
                  await maybeAutoUnsave(post);
                  await refresh();
                },
              }),
              `${ACTION_LABELS[key]} done`,
            ])
          )
      )
    : null;

  const likeBtn = post.actions.like
    ? el(
        'button',
        {
          class: 'small',
          onclick: async () => {
            const res = await sendToLinkedInTabs({ type: 'LPT_DO_LIKE', urn: post.urn });
            if (res.ok) {
              post.manualDone.like = true;
              await upsertPost(post);
              await maybeAutoUnsave(post);
              await refresh();
            } else {
              setBanner(`Like failed: ${res.error}`);
            }
          },
        },
        [post.manualDone.like ? 'Liked ✓' : 'Like it now']
      )
    : null;

  const commentDrawer = post.actions.comment
    ? el('div', { class: 'comment-drawer' }, [
        el('label', { class: 'field-label' }, ['Comment draft']),
        textareaField(post, 'commentDraft', true),
        post.commentPosted ? el('div', { class: 'status-pill' }, ['posted ✓']) : null,
        el('div', { class: 'card-footer' }, [
          el('span', {}, []),
          el('div', { class: 'btns' }, [
            el('button', { class: 'small', onclick: () => suggestComment(post) }, ['Suggest comment']),
            el('button', { class: 'small primary', onclick: () => postCommentNow(post) }, ['Confirm & post']),
          ]),
        ]),
      ].filter(Boolean))
    : null;

  const priorityRow = el('div', { class: 'field-row' }, [
    el('div', {}, [
      el('label', { class: 'field-label' }, ['Priority (1 = highest)']),
      el(
        'select',
        {
          onchange: async (e) => {
            post.priority = Number(e.target.value);
            await upsertPost(post);
          },
        },
        [1, 2, 3, 4, 5].map((n) => el('option', { value: n, ...(n === post.priority ? { selected: 'selected' } : {}) }, [String(n)]))
      ),
    ]),
    el('div', {}, [
      el('label', { class: 'field-label' }, ['Unsave status']),
      el('span', { class: `status-pill ${post.unsaveStatus === 'failed' ? 'error' : ''}` }, [post.unsaveStatus]),
    ]),
  ]);

  return el('div', { class: 'card' }, [
    header,
    links,
    textEl,
    classificationBlock,
    actionsRow,
    doneRow,
    el('div', { class: 'card-footer' }, [likeBtn || el('span', {}, [])]),
    commentDrawer,
    priorityRow,
  ].filter(Boolean));
}

function inputField(post, key) {
  return el('input', {
    type: 'text',
    value: post.classification?.[key] || '',
    onchange: async (e) => {
      post.classification[key] = e.target.value;
      await upsertPost(post);
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

// One post at a time, in scrape order, with Prev/Next — matches "default to
// the first unprocessed saved post" and resumes where you left off.
function renderPendingQueue(queue) {
  const index = resolveCurrentIndex(queue, lastPendingIndex);
  lastPendingIndex = index;
  const current = queue[index];
  if (queueState.currentId !== current.id) {
    queueState = { currentId: current.id };
    setQueueState(queueState);
  }

  const nav = el('div', { class: 'card-footer' }, [
    el('button', { class: 'small', ...(index === 0 ? { disabled: 'disabled' } : {}), onclick: async () => { await goToIndex(queue, index - 1); render(); } }, ['← Previous']),
    el('span', { class: 'status-pill' }, [`Post ${index + 1} of ${queue.length}`]),
    el('button', { class: 'small', ...(index === queue.length - 1 ? { disabled: 'disabled' } : {}), onclick: async () => { await goToIndex(queue, index + 1); render(); } }, ['Next →']),
  ]);

  listEl.appendChild(nav);
  listEl.appendChild(renderCard(current));
}

function statusSummary(post) {
  if (post.status === 'processed') return post.unsaveStatus === 'done' ? 'unsaved' : post.unsaveStatus;
  return post.classifiedAt ? 'classified' : 'not classified';
}

function renderTable(list) {
  const rows = list.map((post) => {
    const c = post.classification || {};
    const project = c.project === 'Other' ? (c.projectCustom || 'Other') : (c.project || '');
    const date = post.processedAt || post.postDateTime || post.postedRelative || post.createdAt || '';
    return el('tr', { onclick: () => selectFromTable(post) }, [
      el('td', {}, [post.author || 'Unknown author']),
      el('td', { class: 'ellipsis' }, [c.topic || '']),
      el('td', {}, [project]),
      el('td', {}, [c.type ? (TYPE_LABELS[c.type] || c.type) : '']),
      el('td', {}, [post.status === 'pending' ? String(post.priority ?? '') : '']),
      el('td', {}, [statusSummary(post)]),
      el('td', {}, [/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date]),
    ]);
  });
  const table = el('table', { class: 'post-table' }, [
    el('thead', {}, [el('tr', {}, ['Author', 'Topic', 'Project', 'Type', 'Priority', 'Status', 'Date'].map((h) => el('th', {}, [h])))]),
    el('tbody', {}, rows),
  ]);
  return table;
}

// Jumps a table row into the single-post card view — for a pending post that
// means positioning the review queue on it, since renderPendingQueue only
// ever shows the queue's current post.
async function selectFromTable(post) {
  if (post.status === 'pending') {
    const queue = pendingQueue();
    const idx = queue.findIndex((p) => p.id === post.id);
    if (idx >= 0) await goToIndex(queue, idx);
  }
  viewMode = 'cards';
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'cards'));
  render();
}

function render() {
  listEl.innerHTML = '';
  const list = activeTab === 'pending' ? pendingQueue() : posts.filter((p) => p.status === 'processed');
  if (!list.length) {
    listEl.appendChild(el('div', { class: 'empty-state' }, [
      activeTab === 'pending' ? 'No pending posts. Click "Scan saved posts" to pull from LinkedIn.' : 'Nothing processed yet.',
    ]));
    return;
  }
  if (viewMode === 'table') {
    listEl.appendChild(renderTable(list));
    return;
  }
  if (activeTab === 'pending') renderPendingQueue(list);
  else list.forEach((post) => listEl.appendChild(renderCard(post)));
}

(async function init() {
  settings = await getSettings();
  queueState = await getQueueState();
  await refresh();
})();
