import { getSettings, setSettings, getActiveCredentials } from '../lib/storage.js';
import { testApiKey } from '../lib/ai-client.js';
import { getLogEntries, clearLogEntries } from '../lib/logger.js';

const workflowModeEl = document.getElementById('workflowMode');
const classifyModeEl = document.getElementById('classifyMode');
const providerSettingsEl = document.getElementById('providerSettings');
const providerEl = document.getElementById('provider');
const anthropicBlock = document.getElementById('anthropicBlock');
const anthropicApiKeyEl = document.getElementById('anthropicApiKey');
const anthropicModelEl = document.getElementById('anthropicModel');
const openaiBlock = document.getElementById('openaiBlock');
const openaiApiKeyEl = document.getElementById('openaiApiKey');
const openaiModelEl = document.getElementById('openaiModel');
const projectsEl = document.getElementById('projects');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

function highlightActiveProvider() {
  anthropicBlock.classList.toggle('inactive', providerEl.value !== 'anthropic');
  openaiBlock.classList.toggle('inactive', providerEl.value !== 'openai');
}

function highlightClassifyMode() {
  const offline = classifyModeEl.value === 'offline';
  providerSettingsEl.hidden = offline;
  testBtn.hidden = offline;
}

providerEl.addEventListener('change', highlightActiveProvider);
classifyModeEl.addEventListener('change', highlightClassifyMode);

async function load() {
  const settings = await getSettings();
  workflowModeEl.value = settings.workflowMode || 'single';
  classifyModeEl.value = settings.classifyMode || 'live';
  providerEl.value = settings.provider;
  anthropicApiKeyEl.value = settings.anthropicApiKey || '';
  anthropicModelEl.value = settings.anthropicModel || '';
  openaiApiKeyEl.value = settings.openaiApiKey || '';
  openaiModelEl.value = settings.openaiModel || '';
  projectsEl.value = (settings.projects || []).join(', ');
  highlightActiveProvider();
  highlightClassifyMode();
}

function readForm() {
  return {
    workflowMode: workflowModeEl.value,
    classifyMode: classifyModeEl.value,
    provider: providerEl.value,
    anthropicApiKey: anthropicApiKeyEl.value.trim(),
    anthropicModel: anthropicModelEl.value.trim(),
    openaiApiKey: openaiApiKeyEl.value.trim(),
    openaiModel: openaiModelEl.value.trim(),
    projects: projectsEl.value.split(',').map((p) => p.trim()).filter(Boolean),
  };
}

saveBtn.addEventListener('click', async () => {
  await setSettings(readForm());
  setStatus('Saved.', true);
});

testBtn.addEventListener('click', async () => {
  const settings = readForm();
  const { provider, apiKey, model } = getActiveCredentials(settings);
  if (!apiKey) return setStatus(`Enter a ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key first.`, false);
  setStatus('Testing…', true);
  try {
    await testApiKey({ provider, apiKey, model });
    setStatus('Connection OK.', true);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, false);
  }
});

const logsContentEl = document.getElementById('logsContent');

async function renderLogs() {
  const entries = await getLogEntries();
  logsContentEl.textContent = entries.length
    ? entries.map((e) => `[${e.ts}] ${e.level.toUpperCase().padEnd(5)} ${e.source}: ${e.message}`).join('\n')
    : '(no log entries yet)';
  logsContentEl.scrollTop = logsContentEl.scrollHeight;
}

document.getElementById('logsRefreshBtn').addEventListener('click', renderLogs);

document.getElementById('logsClearBtn').addEventListener('click', async () => {
  await clearLogEntries();
  await renderLogs();
});

document.getElementById('logsCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logsContentEl.textContent);
    setStatus('Log copied to clipboard.', true);
  } catch (err) {
    setStatus(`Copy failed: ${err.message}`, false);
  }
});

load();
renderLogs();
