export const POST_TYPES = ['insight', 'person', 'company', 'news', 'content_inspiration', 'research', 'other'];

export const TYPE_LABELS = {
  insight: 'Insight',
  person: 'Person',
  company: 'Company',
  news: 'News',
  content_inspiration: 'Content inspiration',
  research: 'Research',
  other: 'Other',
};

export const DEFAULT_PROJECTS = ['Niti', 'Hetu', 'iSPIRT', 'Samyog', 'DEPA', 'Investing', 'Personal', 'Learning', 'GTM'];

export function classifySystemPrompt(projects) {
  const projectList = projects && projects.length ? projects.join(', ') : '(none configured)';
  return `You triage LinkedIn posts that a busy operator saved for later. Given a post's author and text, call record_classification with your best single-pass read. Be concise: summary and whySaved are each one short sentence. Known projects/areas to match against: ${projectList}. If nothing fits, set project to "Other" and put a short label in projectCustom.`;
}

export const COMMENT_SYSTEM_PROMPT = `You draft a short LinkedIn comment for a busy operator to review and post themselves. Write 1-3 sentences, specific to the post content, adding a genuine reaction, question, or point of agreement/disagreement. No generic filler ("Great post!", "Thanks for sharing"), no hashtags, no emoji unless the post itself is very casual. Output only the comment text, nothing else.`;
