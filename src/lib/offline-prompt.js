// "Offline AI" mode: build a copy-pasteable prompt for a chat UI (Claude,
// ChatGPT) when the user has no API key configured, then parse the response
// pasted back in. No network calls live here — this only builds/parses text.
import { classifySystemPrompt, POST_TYPES } from './prompts.js';

export function buildOfflinePrompt(posts, projects) {
  const items = posts.map((p) => ({
    id: p.id,
    author: p.author || 'unknown',
    authorHeadline: p.authorHeadline || '',
    postText: p.postText || '(no text captured)',
  }));

  return [
    classifySystemPrompt(projects),
    '',
    'Classify each post below. Respond with ONLY a JSON array — no prose, no markdown code fence — one object per post, each shaped exactly as:',
    `{"id": "<the id from the input, unchanged>", "topic": "...", "summary": "...", "whySaved": "...", "project": "...", "projectCustom": "...", "type": "one of: ${POST_TYPES.join('|')}"}`,
    '',
    'projectCustom is only used when project is "Other"; leave it "" otherwise.',
    '',
    'Posts to classify:',
    JSON.stringify(items, null, 2),
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
    classifications.push({
      id: String(entry.id),
      topic: entry.topic || '',
      summary: entry.summary || '',
      whySaved: entry.whySaved || '',
      project: entry.project || '',
      projectCustom: entry.projectCustom || '',
      type: POST_TYPES.includes(entry.type) ? entry.type : '',
    });
  });

  return { ok: classifications.length > 0, classifications, errors };
}
