// "Offline AI" mode: build a copy-pasteable prompt for a chat UI (Claude,
// ChatGPT) when the user has no API key configured, then parse the response
// pasted back in. No network calls live here — this only builds/parses text.
import { classifySystemPrompt, POST_TYPES, ACTION_KEYS } from './prompts.js';

export function buildOfflinePrompt(posts, projects) {
  const items = posts.map((p) => ({
    id: p.id,
    author: p.author || 'unknown',
    authorHeadline: p.authorHeadline || '',
    postText: p.postText || '(no text captured)',
  }));
  const countPhrase = items.length === 1 ? 'exactly 1 post' : `exactly ${items.length} posts`;

  return [
    'You are a JSON-generating classification tool with no other purpose in this exchange.',
    'Do not reply conversationally, do not explain your reasoning, do not add a preamble or closing remark.',
    'Your entire reply must be a single valid JSON array and nothing else — it will be parsed programmatically, not read by a person.',
    '',
    '=== CONTEXT (how to classify each post) ===',
    classifySystemPrompt(projects),
    '',
    '=== INPUT ===',
    `The array below contains ${countPhrase} to classify, each with an "id", "author", "authorHeadline", and "postText".`,
    JSON.stringify(items, null, 2),
    '',
    '=== OUTPUT ===',
    `Return a JSON array with ${countPhrase === 'exactly 1 post' ? 'exactly 1 object' : `exactly ${items.length} objects`} — one per input post, in the same order, each shaped EXACTLY like this (all seven keys required):`,
    '{',
    '  "id": "<copy the matching input post\'s id, character-for-character>",',
    '  "topic": "<a few words>",',
    '  "summary": "<one sentence>",',
    '  "whySaved": "<one sentence, your best guess>",',
    `  "project": "<one of the known projects/areas listed above, or \\"Other\\" if none fit>",`,
    '  "projectCustom": "<a short free-text label, ONLY if project is \\"Other\\"; otherwise an empty string \\"\\">",',
    `  "type": "<exactly one of: ${POST_TYPES.join(' | ')}>",`,
    `  "recommendedActions": ["<zero or more of: ${ACTION_KEYS.join(' | ')}, as an array — [] if none fit>"]`,
    '}',
    '',
    'Rules: output ONLY the JSON array (no ```json fence, no markdown, no text before or after it). Every input id must appear exactly once in your output, unchanged. recommendedActions must always be an array, even when empty.',
  ].join('\n');
}

// Tolerant of a wrapping ```json fence or stray prose around the array,
// since chat UIs don't reliably follow "output only JSON" instructions.
export function parseOfflineResponse(raw) {
  const text = (raw || '').trim();
  if (!text) return { ok: false, classifications: [], errors: ['Paste the response first.'] };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) {
      return { ok: false, classifications: [], errors: ['Could not find a JSON array in the pasted text.'] };
    }
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch (err) {
      return { ok: false, classifications: [], errors: [`Invalid JSON: ${err.message}`] };
    }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, classifications: [], errors: ['Expected a JSON array of classifications.'] };
  }

  const errors = [];
  const classifications = [];
  parsed.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || !entry.id) {
      errors.push(`Entry ${i} has no "id" — skipped.`);
      return;
    }
    const recommendedActions = Array.isArray(entry.recommendedActions)
      ? entry.recommendedActions.filter((a) => ACTION_KEYS.includes(a))
      : [];
    classifications.push({
      id: String(entry.id),
      topic: entry.topic || '',
      summary: entry.summary || '',
      whySaved: entry.whySaved || '',
      project: entry.project || '',
      projectCustom: entry.projectCustom || '',
      type: POST_TYPES.includes(entry.type) ? entry.type : '',
      recommendedActions,
    });
  });

  return { ok: classifications.length > 0, classifications, errors };
}
