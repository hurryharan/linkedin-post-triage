import { DEFAULT_PROJECTS } from './prompts.js';

// Single-blob storage: chrome.storage.local key -> { [id]: PostRecord }.
// Fine at personal-backlog scale (low thousands of posts); revisit if it ever grows past that.
const STORE_KEY = 'ltp_posts_v1';
const SETTINGS_KEY = 'ltp_settings_v1';
const QUEUE_KEY = 'ltp_queue_state_v1';

export const ACTION_KEYS = ['like', 'comment', 'crm', 'research', 'post_idea', 'repost'];

export function emptyActionMap() {
  return Object.fromEntries(ACTION_KEYS.map((k) => [k, false]));
}

export function newRecord(scraped) {
  const now = new Date().toISOString();
  return {
    id: scraped.urn || scraped.url,
    url: scraped.url || null,
    urn: scraped.urn || null,
    author: scraped.author || null,
    authorProfileUrl: scraped.authorProfileUrl || null,
    authorHeadline: scraped.authorHeadline || null,
    company: scraped.company || null,
    companyUrl: scraped.companyUrl || null,
    postedRelative: scraped.postedRelative || null,
    postDateTime: scraped.postDateTime || null,
    engagementMetrics: scraped.engagementMetrics || null,
    savedConfirmed: !!scraped.savedConfirmed,
    postText: scraped.postText || '',
    mediaInfo: scraped.mediaInfo || null,
    domError: scraped.domError || null,
    classification: null, // { topic, summary, whySaved, project, projectCustom, type }
    actions: emptyActionMap(),
    priority: 3,
    commentDraft: '',
    commentPosted: null,
    manualDone: emptyActionMap(),
    unsaveStatus: 'pending', // pending | done | failed
    reviewStatus: 'unreviewed', // unreviewed | reviewed
    status: 'pending', // pending | processed
    createdAt: now,
    updatedAt: now,
    classifiedAt: null,
    reviewedAt: null,
    processedAt: null,
  };
}

async function readAll() {
  const data = await chrome.storage.local.get(STORE_KEY);
  return data[STORE_KEY] || {};
}

async function writeAll(map) {
  await chrome.storage.local.set({ [STORE_KEY]: map });
}

export async function getAllPosts() {
  const map = await readAll();
  return Object.values(map).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export async function getPost(id) {
  const map = await readAll();
  return map[id] || null;
}

export async function upsertPost(record) {
  const map = await readAll();
  record.updatedAt = new Date().toISOString();
  map[record.id] = record;
  await writeAll(map);
  return record;
}

// Adds newly-scraped posts without clobbering existing records for the same id.
export async function mergeScraped(scrapedList) {
  const map = await readAll();
  let added = 0;
  for (const scraped of scrapedList) {
    const id = scraped.urn || scraped.url;
    if (!id) continue;
    if (map[id]) {
      // Keep existing triage state; refresh fields LinkedIn only shows on the list page.
      map[id].savedConfirmed = map[id].savedConfirmed || !!scraped.savedConfirmed;
      continue;
    }
    map[id] = newRecord(scraped);
    added++;
  }
  await writeAll(map);
  return added;
}

export async function removePost(id) {
  const map = await readAll();
  delete map[id];
  await writeAll(map);
}

export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return (
    data[SETTINGS_KEY] || {
      apiKey: '',
      model: 'claude-haiku-4-5-20251001',
      projects: DEFAULT_PROJECTS,
    }
  );
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// Tracks which pending post the one-at-a-time review queue is currently on,
// so reopening the side panel resumes there instead of restarting.
export async function getQueueState() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  return data[QUEUE_KEY] || { currentId: null };
}

export async function setQueueState(state) {
  await chrome.storage.local.set({ [QUEUE_KEY]: state });
}
