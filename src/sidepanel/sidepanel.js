import { getAllPosts, upsertPost, mergeScraped, getSettings, ACTION_KEYS } from '../lib/storage.js';
import { classifyPost, draftComment } from '../lib/claude-client.js';
import { POST_TYPES } from '../lib/prompts.js';
import { downloadWorkbook } from '../lib/xlsx-export.js';

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
let posts = [];
let settings = null;

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

// --- Linked-in tab plumbing -------------------------------------------------

async function getLinkedInTabs() {
  return chrome.tabs.query({ url: '*://www.linkedin.com/*' });
}

async function sendToLinkedInTabs(message) {
  const tabs = await getLinkedInTabs();
  if (!tabs.length) return { ok: false, error: 'no LinkedIn tab is open' };
  let last = { ok: false, error: 'no matching tab responded' };
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, message);
      if (res && res.ok) return res;
      if (res) last = res;
    } catch (err) {
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

// --- Actions -----------------------------------------------------------------

document.getElementById('scanBtn').addEventListener('click', async () => {
  setBanner('Scanning saved posts…');
  const tab = await ensureSavedPostsTab();
  // Give a freshly-opened tab a moment to load before scraping.
  await new Promise((r) => setTimeout(r, tab.status === 'complete' ? 100 : 2500));
  const res = await sendToLinkedInTabs({ type: 'LPT_SCRAPE_SAVED_POSTS' });
  if (!res.ok) {
    setBanner(`Scan failed: ${res.error}`);
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
  if (!settings.apiKey) {
    setBanner('Set an Anthropic API key in Settings first.');
    return;
  }
  const targets = posts.filter((p) => p.status === 'pending' && !p.classification);
  setBanner(`Classifying ${targets.length} post(s)…`);
  let failed = 0;
  for (const post of targets) {
    try {
      const classification = await classifyPost({
        apiKey: settings.apiKey,
        model: settings.model,
        author: post.author,
        authorHeadline: post.authorHeadline,
        postText: post.postText,
        projects: settings.projects,
      });
      post.classification = classification;
      post.classifiedAt = new Date().toISOString();
      await upsertPost(post);
    } catch (err) {
      failed++;
      console.error('classify failed', post.id, err);
    }
  }
  setBanner(failed ? `Done, ${failed} failed — check the API key/model in Settings.` : 'Classification complete.');
  await refresh();
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  const all = await getAllPosts();
  downloadWorkbook(all);
});

document.getElementById('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
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
  }
  await upsertPost(post);
}

async function reclassify(post) {
  settings = settings || (await getSettings());
  if (!settings.apiKey) return setBanner('Set an Anthropic API key in Settings first.');
  const classification = await classifyPost({
    apiKey: settings.apiKey,
    model: settings.model,
    author: post.author,
    authorHeadline: post.authorHeadline,
    postText: post.postText,
    projects: settings.projects,
  });
  post.classification = classification;
  post.classifiedAt = new Date().toISOString();
  await upsertPost(post);
  await refresh();
}

async function suggestComment(post) {
  settings = settings || (await getSettings());
  if (!settings.apiKey) return setBanner('Set an Anthropic API key in Settings first.');
  post.commentDraft = await draftComment({
    apiKey: settings.apiKey,
    model: settings.model,
    postText: post.postText,
    classification: post.classification,
  });
  await upsertPost(post);
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
  const options = [...known, 'Other'];
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
    options.map((opt) => el('option', { value: opt, ...(opt === current ? { selected: 'selected' } : {}) }, [opt]))
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
    POST_TYPES.map((t) => el('option', { value: t, ...(t === current ? { selected: 'selected' } : {}) }, [t]))
  );
}

function renderCard(post) {
  const c = post.classification || {};
  const textEl = el('div', { class: 'post-text' }, [post.postText || '(no text captured)']);
  textEl.addEventListener('click', () => textEl.classList.toggle('expanded'));

  const header = el('div', { class: 'card-header' }, [
    el('span', { class: 'author' }, [post.author || 'Unknown author']),
    el('span', { class: 'meta' }, [post.company || post.postedRelative || '']),
  ]);

  const link = post.url ? el('div', {}, [el('a', { href: post.url, target: '_blank' }, ['Open on LinkedIn ↗'])]) : null;

  const classificationBlock = post.classification
    ? el('div', {}, [
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
      ].filter(Boolean))
    : el('div', { class: 'card-footer' }, [
        el('span', { class: 'status-pill' }, ['not classified']),
        el('button', { class: 'small primary', onclick: () => reclassify(post) }, ['Classify']),
      ]);

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
        selectedActions.map((key) =>
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
        ['Like it now']
      )
    : null;

  const commentDrawer = post.actions.comment
    ? el('div', { class: 'comment-drawer' }, [
        el('label', { class: 'field-label' }, ['Comment draft']),
        textareaField(post, 'commentDraft', true),
        el('div', { class: 'card-footer' }, [
          el('span', {}, []),
          el('div', { class: 'btns' }, [
            el('button', { class: 'small', onclick: () => suggestComment(post) }, ['Suggest comment']),
            el(
              'button',
              {
                class: 'small',
                onclick: async () => {
                  const res = await sendToLinkedInTabs({ type: 'LPT_INSERT_COMMENT', urn: post.urn, text: post.commentDraft || '' });
                  setBanner(res.ok ? 'Comment inserted — review and click Post on LinkedIn.' : `Insert failed: ${res.error}`);
                },
              },
              ['Insert into LinkedIn']
            ),
          ]),
        ]),
      ])
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
    link,
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

function render() {
  const filtered = posts.filter((p) => p.status === activeTab);
  listEl.innerHTML = '';
  if (!filtered.length) {
    listEl.appendChild(el('div', { class: 'empty-state' }, [activeTab === 'pending' ? 'No pending posts. Click "Scan saved posts" to pull from LinkedIn.' : 'Nothing processed yet.']));
    return;
  }
  filtered.forEach((post) => listEl.appendChild(renderCard(post)));
}

(async function init() {
  settings = await getSettings();
  await refresh();
})();
