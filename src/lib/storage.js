import { DEFAULT_PROJECTS } from './prompts.js';
import { PROVIDERS } from './ai-client.js';

// Single-blob storage: chrome.storage.local key -> { [id]: PostRecord }.
// Fine at personal-backlog scale (low thousands of posts); revisit if it ever grows past that.
// Exported so callers can watch chrome.storage.onChanged without duplicating these strings.
export const STORE_KEY = 'ltp_posts_v1';
export const SETTINGS_KEY = 'ltp_settings_v1';
export const QUEUE_KEY = 'ltp_queue_state_v1';

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
    // Starts blank rather than null so the review form is always editable —
    // AI classification is optional, not a gate on manual triage.
    classification: { topic: '', summary: '', whySaved: '', project: '', projectCustom: '', type: '' },
    // Tags for a separate, external workflow to act on in bulk (like, repost,
    // crm, research, post_idea) — this tool only marks intent, never drives
    // LinkedIn's UI itself. "comment" is the one exception: drafting happens
    // here, but posting is still a manual copy-paste (see commentPosted).
    actions: emptyActionMap(),
    priority: 3,
    commentDraft: '',
    commentPosted: null, // ISO timestamp once you confirm you posted it yourself, else null
    status: 'pending', // pending | processed
    createdAt: now,
    updatedAt: now,
    classifiedAt: null,
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

// Wipes every scraped/triaged post so the next scan starts clean — e.g. after
// a synthetic id collision, a bad scrape, or just wanting a fresh start.
// Settings and debug logs are untouched.
export async function clearAllPosts() {
  await writeAll({});
  await setQueueState({ currentId: null });
}

function defaultSettings() {
  return {
    provider: 'anthropic',
    anthropicApiKey: '',
    anthropicModel: PROVIDERS.anthropic.DEFAULT_MODEL,
    openaiApiKey: '',
    openaiModel: PROVIDERS.openai.DEFAULT_MODEL,
    projects: DEFAULT_PROJECTS,
    // 'single' = review one post at a time (classify, tag, comment, done, next).
    // 'bulk' = classify everything pending in one shot and export, no per-post flow.
    workflowMode: 'single',
    // 'live' = call the configured provider's API. 'offline' = build a prompt
    // to paste into Claude/ChatGPT's own UI and paste the reply back in.
    classifyMode: 'live',
  };
}

export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = data[SETTINGS_KEY];
  if (!stored) return defaultSettings();
  // Migrate the pre-multi-provider schema (flat apiKey/model, Anthropic-only).
  if (stored.apiKey !== undefined || stored.model !== undefined) {
    const { apiKey, model, ...rest } = stored;
    return {
      ...defaultSettings(),
      ...rest,
      provider: 'anthropic',
      anthropicApiKey: apiKey || '',
      anthropicModel: model || PROVIDERS.anthropic.DEFAULT_MODEL,
    };
  }
  return { ...defaultSettings(), ...stored };
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// Resolves whichever provider is active into the {provider, apiKey, model}
// shape ai-client.js's functions expect, so callers don't branch themselves.
export function getActiveCredentials(settings) {
  const provider = settings.provider || 'anthropic';
  return {
    provider,
    apiKey: provider === 'openai' ? settings.openaiApiKey : settings.anthropicApiKey,
    model: provider === 'openai' ? settings.openaiModel : settings.anthropicModel,
  };
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
