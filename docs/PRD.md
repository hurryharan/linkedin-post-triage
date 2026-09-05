# LinkedIn Saved-Post Triage — PRD

**Owner:** Hari Subramanian
**Status:** Draft, scoped from a working prototype
**Prototype:** [Post Triage](https://claude.ai/code/artifact/f4c01078-b66b-41b3-973d-213c241b9807) — Cowork Artifact + Claude-in-Chrome, tested on 2 posts

## Problem

Saved LinkedIn posts pile up with no triage step. Nothing captures why a post was saved, what should happen next, or whether it was ever acted on — so most saved posts are never revisited, and the ones worth a like, a comment, a research follow-up, or a CRM entry get lost with the rest.

## Goal

A repeatable pipeline: pull a saved post, classify it (author, company, topic, summary, why it was likely saved, relevant project, type), let Hari review and pick action items with a priority, execute the actions that can be executed automatically, and keep a durable record of every post processed — pending or done.

## Non-goals

Not a general LinkedIn automation tool, not a scheduler that posts on its own, not a CRM. It doesn't touch anything outside the saved-posts queue, and it never posts a comment or sends anything without Hari reviewing it first.

## Current state — the Cowork prototype

Right now this runs inside a Claude Cowork session: Claude-in-Chrome reads the saved-posts page and each post's DOM, classifies the post, writes a record to an Artifact's database, and publishes a review app (the link above) that reads/writes that same database live. Hari reviews and edits the classification, picks actions and a priority, and generates a suggested comment via an in-page "ask Claude" capability. Like/comment/CRM/research/post-idea/repost are all manual checkboxes Hari ticks after doing them on LinkedIn himself; unsaving the post is the one step Claude still does automatically, once verifying the post is actually saved. A `.xlsx` workbook (Pending / Processed tabs) is regenerated from the same data on request.

This works, but every post costs a full agent turn: screenshots, full-page text dumps, tool round-trips, and this session's system-prompt overhead, all to produce what is ultimately a short classification. It doesn't scale to processing a saved-posts backlog in bulk.

## Proposed v1 — Chrome extension

A Manifest V3 extension, personal use only (loaded unpacked, no Web Store review needed).

**Content script** runs on `linkedin.com/my-items/saved-posts` and individual post pages. Reads post data straight from the DOM — no screenshots, no page-text dumps, which is most of the current cost. Same script drives the three DOM actions that don't need a model at all: clicking Like, clicking Unsave, and inserting/submitting a comment once Hari has approved its text.

**Classification** is a single direct call to the Claude API (Messages API) per post: post text + author + a fixed system prompt, asking for the same structured fields the prototype produces today. No browser tooling, no conversation history, no skill-loading overhead — just the completion. This is where nearly all the token savings are: the model call itself is a few hundred to ~2K input tokens instead of an entire agent turn.

**Review UI** is a popup or an injected side panel — the same interaction the Artifact app has now (editable classification, action checkboxes, priority 1–5, comment drawer with an AI-suggested draft, execution checklist, Pending/Processed tabs) — reimplemented as extension UI instead of a published Artifact.

**Storage** is local (`chrome.storage.local` or IndexedDB) as the source of truth, with an "Export .xlsx" button that regenerates the same two-tab workbook on demand. Google Sheets sync is a later phase, not v1 (see Open questions).

## Why this instead of continuing in Cowork

Per-post cost drops by roughly an order of magnitude or more: the expensive parts of today's flow — screenshots, full-page text, tool-call round trips, reloading this session's system prompt and skills — go away entirely. The Claude API costs the same per token either way; the savings are from cutting the overhead around the classification call, not a cheaper rate.

**There is no direct LinkedIn API for this.** LinkedIn has no public API for a personal account's saved posts, feed, or engagement actions — that requires LinkedIn Marketing Partner status, an org-level approval, not something available for personal automation. The extension's content script is doing the same category of thing Claude-in-Chrome does today: scripting the real page in Hari's logged-in session. That's automation against LinkedIn's own terms either way; the extension doesn't remove that risk, it just runs faster and unattended, which if anything reads less human to LinkedIn's bot detection than an agent that pauses and reasons between steps.

## Data model (per post)

`url`, `urn`, `author`, `authorHeadline`, `company`, `postedRelative`, `savedConfirmed`, `postText`, `attachment`, `classification` (`topic`, `summary`, `whySaved`, `project`, `projectCustom`, `type`), `actions[]` (like / comment / crm / research / post_idea / repost), `priority` (1–5), `commentDraft`, `manualDone{}` per action, `unsaveStatus`, `reviewStatus`, `status` (pending / processed), timestamps. Same shape the prototype already uses — carries over directly.

## Core flow

Open saved posts → content script lists them → for each: classify via direct API call → review in the extension UI, edit anything, pick actions + priority, generate/edit a comment draft if needed → do Like/Comment on LinkedIn manually, checking each off → content script unsaves once every selected action is checked off → record written locally, exportable to `.xlsx` anytime.

## Risks and constraints

LinkedIn's DOM changes without notice and will break the selectors — in the Cowork prototype Claude adapts to that live; a standalone extension will just silently fail until someone notices and patches it, so this needs either monitoring or an easy "tell me it broke" path. An Anthropic API key has to live in the extension (options page, stored locally) — fine for personal, single-machine use, not something to package for anyone else. And the ToS exposure above applies to the whole tool, not just parts of it — worth being deliberate about volume and pacing (e.g., not ripping through the entire saved-posts backlog in one burst) regardless of which implementation runs it.

## Phasing

**v1:** everything above, local storage only, manual `.xlsx` export, single LinkedIn account, unpacked/developer-mode install.

**Later:** batch processing of the whole saved-posts backlog in one run; real Google Sheets sync (blocked today — no Sheets-specific connector exists, only a generic Google Drive file connector); a small local backend if the record needs to be shared beyond one browser profile.

## Open questions

Whether comment posting should stay fully manual (as it is now) or move to "content script fills the box, Hari clicks Post" — saves a step, still keeps a human in the loop before anything public goes out. Whether v1 needs batch/bulk processing or one-post-at-a-time is fine to start. And whether the `.xlsx` export is the permanent system of record or a bridge until Sheets access is sorted out.
