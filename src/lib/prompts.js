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

// Single source of truth for the action tags a classification can recommend.
// storage.js, the side panel, xlsx-export.js, and both providers' schemas all
// import from here so a new action only needs adding in one place.
export const ACTION_KEYS = ['like', 'comment', 'crm', 'research', 'post_idea', 'repost', 'info', 'opportunities'];

export const ACTION_LABELS = {
  like: 'Like',
  comment: 'Comment',
  crm: 'CRM entry',
  research: 'Research',
  post_idea: 'Post idea',
  repost: 'Repost',
  info: 'Info',
  opportunities: 'Opportunities',
};

const ACTION_GUIDANCE = {
  like: 'a quick, low-effort acknowledgement — no real follow-up needed',
  comment: 'worth a substantive reply (the tool will draft one for you to review)',
  crm: 'ties to a specific person/company worth logging in your CRM',
  research: 'flags something to dig into further (a claim, a tool, a market)',
  post_idea: 'sparks an idea for your own post',
  repost: 'worth resharing to your own network as-is',
  info: 'just worth having noted/remembered — no action on LinkedIn or elsewhere needed',
  opportunities: 'a concrete business opportunity worth pursuing — a partnership, deal, hire, or lead',
};

export function classifySystemPrompt(projects) {
  const projectList = projects && projects.length ? projects.join(', ') : '(none configured)';
  const actionList = ACTION_KEYS.map((k) => `"${k}" (${ACTION_GUIDANCE[k]})`).join(', ');
  return `You triage LinkedIn posts that a busy operator saved for later. Given a post's author and text, call record_classification with your best single-pass read. Be concise: summary and whySaved are each one short sentence. Known projects/areas to match against: ${projectList}. If nothing fits, set project to "Other" and put a short label in projectCustom. Also recommend zero or more follow-up actions from this fixed set: ${actionList}. Only recommend an action when the post genuinely warrants it — recommending nothing is a valid, common answer, and recommending everything is not useful.`;
}

export const COMMENT_SYSTEM_PROMPT = `You draft a short LinkedIn comment for a busy operator to review and post themselves. Write 1-3 sentences, specific to the post content, adding a genuine reaction, question, or point of agreement/disagreement. No generic filler ("Great post!", "Thanks for sharing"), no hashtags, no emoji unless the post itself is very casual. Output only the comment text, nothing else.`;
