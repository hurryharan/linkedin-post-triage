import { classifySystemPrompt, COMMENT_SYSTEM_PROMPT, POST_TYPES } from './prompts.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

class ClaudeApiError extends Error {}

async function callMessages(apiKey, body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ClaudeApiError(`Claude API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

const CLASSIFY_TOOL = {
  name: 'record_classification',
  description: 'Record the structured classification for one saved LinkedIn post.',
  input_schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Short topic label, a few words.' },
      summary: { type: 'string', description: 'One-sentence summary of the post.' },
      whySaved: { type: 'string', description: 'One-sentence best guess at why this was saved.' },
      project: { type: 'string', description: 'Best-matching known project/area, or "Other".' },
      projectCustom: { type: 'string', description: 'Free-text label when project is "Other". Empty string otherwise.' },
      type: { type: 'string', enum: POST_TYPES },
    },
    required: ['topic', 'summary', 'whySaved', 'project', 'projectCustom', 'type'],
  },
};

export async function classifyPost({ apiKey, model, author, authorHeadline, postText, projects }) {
  const userContent = [
    `Author: ${author || 'unknown'}${authorHeadline ? ` (${authorHeadline})` : ''}`,
    '',
    'Post text:',
    postText || '(no text captured)',
  ].join('\n');

  const data = await callMessages(apiKey, {
    model,
    max_tokens: 512,
    system: classifySystemPrompt(projects),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'record_classification' },
    messages: [{ role: 'user', content: userContent }],
  });

  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse) throw new ClaudeApiError('Claude did not return a classification tool call.');
  return toolUse.input;
}

export async function draftComment({ apiKey, model, postText, classification }) {
  const userContent = [
    'Post text:',
    postText || '(no text captured)',
    '',
    `Known context: topic="${classification?.topic || ''}", summary="${classification?.summary || ''}"`,
  ].join('\n');

  const data = await callMessages(apiKey, {
    model,
    max_tokens: 200,
    system: COMMENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

export async function testApiKey(apiKey, model) {
  await callMessages(apiKey, {
    model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  });
  return true;
}
