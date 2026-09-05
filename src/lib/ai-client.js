// Provider-agnostic entry point. Each provider module in ./providers/ exposes
// the same shape (classifyPost, draftComment, testApiKey, DEFAULT_MODEL,
// SUGGESTED_MODELS) so callers never need to branch on provider themselves.
import * as anthropic from './providers/anthropic-client.js';
import * as openai from './providers/openai-client.js';

export const PROVIDERS = { anthropic, openai };

export const PROVIDER_LABELS = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI' };

export function classifyPost({ provider, ...rest }) {
  return PROVIDERS[provider].classifyPost(rest);
}

export function draftComment({ provider, ...rest }) {
  return PROVIDERS[provider].draftComment(rest);
}

export function testApiKey({ provider, ...rest }) {
  return PROVIDERS[provider].testApiKey(rest);
}
