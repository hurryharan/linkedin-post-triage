// Expects the vendored SheetJS build to already be loaded as a classic
// <script>, exposing the global `XLSX`.

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

function toSheet(records) {
  const header = COLUMNS.map(([, label]) => label);
  const rows = records.map((r) => {
    const flat = flatten(r);
    return COLUMNS.map(([key]) => flat[key] ?? '');
  });
  return XLSX.utils.aoa_to_sheet([header, ...rows]);
}

export function buildWorkbook(allRecords) {
  const pending = allRecords.filter((r) => r.status === 'pending');
  const processed = allRecords.filter((r) => r.status === 'processed');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, toSheet(pending), 'Pending');
  XLSX.utils.book_append_sheet(wb, toSheet(processed), 'Processed');
  return wb;
}

export function downloadWorkbook(allRecords, filename = `linkedin-post-triage-${new Date().toISOString().slice(0, 10)}.xlsx`) {
  const wb = buildWorkbook(allRecords);
  const wbBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbBinary], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => URL.revokeObjectURL(url));
}
