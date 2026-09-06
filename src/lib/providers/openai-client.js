import { classifySystemPrompt, COMMENT_SYSTEM_PROMPT, POST_TYPES, ACTION_KEYS } from '../prompts.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const SUGGESTED_MODELS = ['gpt-4o-mini', 'gpt-4o'];

class OpenAiApiError extends Error {}

async function callChat(apiKey, body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OpenAiApiError(`OpenAI API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

const CLASSIFY_TOOL = {
  type: 'function',
  function: {
    name: 'record_classification',
    description: 'Record the structured classification for one saved LinkedIn post.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short topic label, a few words.' },
        summary: { type: 'string', description: 'One-sentence summary of the post.' },
        whySaved: { type: 'string', description: 'One-sentence best guess at why this was saved.' },
        project: { type: 'string', description: 'Best-matching known project/area, or "Other".' },
        projectCustom: { type: 'string', description: 'Free-text label when project is "Other". Empty string otherwise.' },
        type: { type: 'string', enum: POST_TYPES },
        recommendedActions: {
          type: 'array',
          items: { type: 'string', enum: ACTION_KEYS },
          description: 'Zero or more recommended follow-up actions. Empty array if none fit.',
        },
      },
      required: ['topic', 'summary', 'whySaved', 'project', 'projectCustom', 'type', 'recommendedActions'],
      additionalProperties: false,
    },
  },
};

export async function classifyPost({ apiKey, model, author, authorHeadline, postText, projects }) {
  const userContent = [
    `Author: ${author || 'unknown'}${authorHeadline ? ` (${authorHeadline})` : ''}`,
    '',
    'Post text:',
    postText || '(no text captured)',
  ].join('\n');

  const data = await callChat(apiKey, {
    model,
    max_tokens: 512,
    messages: [
      { role: 'system', content: classifySystemPrompt(projects) },
      { role: 'user', content: userContent },
    ],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'function', function: { name: 'record_classification' } },
  });

  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new OpenAiApiError('OpenAI did not return a classification tool call.');
  return JSON.parse(toolCall.function.arguments);
}

export async function draftComment({ apiKey, model, postText, classification }) {
  const userContent = [
    'Post text:',
    postText || '(no text captured)',
    '',
    `Known context: topic="${classification?.topic || ''}", summary="${classification?.summary || ''}"`,
  ].join('\n');

  const data = await callChat(apiKey, {
    model,
    max_tokens: 200,
    messages: [
      { role: 'system', content: COMMENT_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  return (data.choices?.[0]?.message?.content || '').trim();
}

export async function testApiKey({ apiKey, model }) {
  await callChat(apiKey, {
    model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  });
  return true;
}
