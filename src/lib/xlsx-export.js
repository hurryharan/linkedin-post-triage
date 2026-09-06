// Expects the vendored SheetJS build to already be loaded as a classic
// <script>, exposing the global `XLSX`.
import { ACTION_KEYS, ACTION_LABELS } from './prompts.js';

const COLUMNS = [
  ['url', 'Post URL'],
  ['author', 'Author'],
  ['authorProfileUrl', 'Author URL'],
  ['company', 'Company'],
  ['companyUrl', 'Company URL'],
  ['postDateTime', 'Post Date'],
  ['engagementMetrics', 'Engagement'],
  ['mediaInfo', 'Media/Link'],
  ['topic', 'Topic'],
  ['summary', 'Summary'],
  ['whySaved', 'Why Saved'],
  ['project', 'Project'],
  ['type', 'Type'],
  ['actionsList', 'Tagged Actions'],
  ['priority', 'Priority'],
  ['commentDraft', 'Comment Draft/Posted'],
  ['commentStatus', 'Comment Status'],
  ['createdAt', 'Created At'],
  ['processedAt', 'Processed At'],
];

function flatten(record) {
  const c = record.classification || {};
  const selectedActions = Object.entries(record.actions || {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  return {
    id: record.id,
    status: record.status,
    url: record.url,
    author: record.author,
    authorProfileUrl: record.authorProfileUrl,
    company: record.company,
    companyUrl: record.companyUrl,
    postDateTime: record.postDateTime || record.postedRelative,
    engagementMetrics: record.engagementMetrics,
    mediaInfo: record.mediaInfo,
    topic: c.topic,
    summary: c.summary,
    whySaved: c.whySaved,
    project: c.project === 'Other' ? record.classification?.projectCustom : c.project,
    type: c.type,
    actionsList: selectedActions,
    priority: record.priority,
    commentDraft: record.commentDraft,
    commentStatus: record.commentPosted ? `posted ${record.commentPosted.slice(0, 10)}` : (record.actions?.comment ? 'drafted' : ''),
    createdAt: record.createdAt,
    processedAt: record.processedAt,
  };
}

function toSheet(records, columns) {
  const header = columns.map(([, label]) => label);
  const rows = records.map((r) => {
    const flat = flatten(r);
    return columns.map(([key]) => flat[key] ?? '');
  });
  return XLSX.utils.aoa_to_sheet([header, ...rows]);
}

// Per-action columns: just enough for an external, single-purpose workflow
// (a "like everything in this sheet" script, a CRM importer, etc.) to act
// without carrying the full triage record. Comment gets its own draft/status
// columns since, unlike the others, this tool actually produces content for it.
const ACTION_COLUMNS = [
  ['id', 'Post ID'],
  ['url', 'Post URL'],
  ['author', 'Author'],
  ['authorProfileUrl', 'Author URL'],
  ['topic', 'Topic'],
  ['summary', 'Summary'],
  ['project', 'Project'],
  ['priority', 'Priority'],
  ['status', 'Triage Status'],
];
const COMMENT_ACTION_COLUMNS = [...ACTION_COLUMNS, ['commentDraft', 'Comment Draft'], ['commentStatus', 'Comment Status']];

// XLSX sheet names: max 31 chars, no : \ / ? * [ ]  — action labels are all
// short plain words already, so no sanitizing needed here.
function actionSheetName(key) {
  return ACTION_LABELS[key];
}

export function buildWorkbook(allRecords) {
  const pending = allRecords.filter((r) => r.status === 'pending');
  const processed = allRecords.filter((r) => r.status === 'processed');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, toSheet(pending, COLUMNS), 'Pending');
  XLSX.utils.book_append_sheet(wb, toSheet(processed, COLUMNS), 'Processed');

  // One sheet per action tag (whether AI-recommended or hand-checked), each
  // with just the posts carrying that tag — so a separate bulk-like/
  // bulk-repost/CRM-import/etc. workflow can consume one sheet at a time
  // instead of filtering the full Tagged Actions column itself.
  for (const key of ACTION_KEYS) {
    const tagged = allRecords.filter((r) => r.actions?.[key]);
    if (!tagged.length) continue;
    const columns = key === 'comment' ? COMMENT_ACTION_COLUMNS : ACTION_COLUMNS;
    XLSX.utils.book_append_sheet(wb, toSheet(tagged, columns), actionSheetName(key));
  }

  return wb;
}

export function downloadWorkbook(allRecords, filename = `linkedin-post-triage-${new Date().toISOString().slice(0, 10)}.xlsx`) {
  const wb = buildWorkbook(allRecords);
  const wbBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbBinary], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => URL.revokeObjectURL(url));
}
