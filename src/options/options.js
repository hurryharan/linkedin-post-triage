import { getSettings, setSettings } from '../lib/storage.js';
import { testApiKey } from '../lib/claude-client.js';

const apiKeyEl = document.getElementById('apiKey');
const modelEl = document.getElementById('model');
const projectsEl = document.getElementById('projects');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

async function load() {
  const settings = await getSettings();
  apiKeyEl.value = settings.apiKey || '';
  modelEl.value = settings.model || 'claude-haiku-4-5-20251001';
  projectsEl.value = (settings.projects || []).join(', ');
}

function readForm() {
  return {
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
    projects: projectsEl.value.split(',').map((p) => p.trim()).filter(Boolean),
  };
}

saveBtn.addEventListener('click', async () => {
  await setSettings(readForm());
  setStatus('Saved.', true);
});

testBtn.addEventListener('click', async () => {
  const { apiKey, model } = readForm();
  if (!apiKey) return setStatus('Enter an API key first.', false);
  setStatus('Testing…', true);
  try {
    await testApiKey(apiKey, model);
    setStatus('Connection OK.', true);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, false);
  }
});

load();
