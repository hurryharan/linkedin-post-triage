import { getSettings, setSettings, getActiveCredentials } from '../lib/storage.js';
import { testApiKey } from '../lib/ai-client.js';

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

providerEl.addEventListener('change', highlightActiveProvider);

async function load() {
  const settings = await getSettings();
  providerEl.value = settings.provider;
  anthropicApiKeyEl.value = settings.anthropicApiKey || '';
  anthropicModelEl.value = settings.anthropicModel || '';
  openaiApiKeyEl.value = settings.openaiApiKey || '';
  openaiModelEl.value = settings.openaiModel || '';
  projectsEl.value = (settings.projects || []).join(', ');
  highlightActiveProvider();
}

function readForm() {
  return {
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

load();
