# LinkedIn Post Triage

Manifest V3 Chrome extension for personal use: pulls your LinkedIn saved
posts, classifies each with a direct Claude API call, lets you review and
pick actions, and keeps a local record you can export to `.xlsx`. v1 of the
pipeline described in [`docs/PRD.md`](docs/PRD.md) — replaces the Cowork-artifact prototype
with something that costs roughly an order of magnitude less per post
(no screenshots, no page-text dumps, no agent-turn overhead).

## Install (developer mode, unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this repo's root folder.
2. Click the extension's icon once to pin it, then open its **Details →
   Extension options** (or right-click the icon → Options) and enter your
   Anthropic API key. Click **Test connection** to confirm it works.
3. Click the toolbar icon to open the side panel.

## Using it

1. Open `linkedin.com/my-items/saved-posts` (or click **Scan saved posts**,
   which opens it for you).
2. **Scan saved posts** — reads post data straight from the DOM and adds any
   new posts to local storage as *pending*.
3. **Classify all pending** (or **Classify** on the current card) — one
   Claude API call per post, forced into a structured tool-call response
   (topic, summary, why-saved, project, type). Project/type default to a
   fixed list (Niti, Hetu, iSPIRT, Samyog, DEPA, Investing, Personal,
   Learning, GTM / Insight, Person, Company, News, Content inspiration,
   Research, Other) — edit the project list in Settings.
4. The **Pending** tab shows one post at a time — "Post 3 of 12" with
   Previous/Next — instead of a long scrolling list, and remembers your
   place if you close and reopen the side panel. Review the card: edit any
   field, tick the actions that apply, set a priority, and generate/edit a
   comment draft if `comment` is selected.
   - **Like** has a **Like it now** button — the content script clicks it on
     LinkedIn directly.
   - **Comment** has **Confirm & post** — it fills the comment box, shows you
     the exact text in a confirmation dialog, and only then clicks Post,
     verifying afterward that it went through. Nothing is ever posted
     without that explicit confirmation.
   - CRM / research / post-idea / repost stay manual: do them on LinkedIn,
     then tick "done" here.
5. Once every ticked action is marked done, the extension verifies the post
   is still saved and unsaves it automatically, moving the card to
   **Processed**.
6. **Export .xlsx** any time — regenerates a two-tab (Pending / Processed)
   workbook from whatever's in local storage.

## Architecture

- `src/content/content.js` — runs on the saved-posts list and individual
  post pages. Scrapes post data (including author/company URLs, post
  timestamp, and engagement metrics where LinkedIn exposes them) and
  performs the actions that don't need a model: Like, Unsave, filling a
  comment box, and — only after the side panel's own confirm step —
  submitting it.
- `src/background.js` — just wires the toolbar icon to open the side panel.
- `src/sidepanel/` — the review UI. Talks to `chrome.storage.local`
  directly and relays DOM actions to whichever open LinkedIn tab can handle
  them via `chrome.tabs.sendMessage`.
- `src/lib/claude-client.js` — direct `fetch` calls to the Anthropic
  Messages API (classification uses forced tool-use for structured output;
  comment drafting is a plain text completion). No SDK, no browser tooling,
  no conversation history — this is where the token savings over the Cowork
  prototype come from.
- `src/lib/storage.js` — one `chrome.storage.local` blob keyed by post
  URN/URL. Fine at personal-backlog scale; if this ever needs to be shared
  across machines, see "Later" in the PRD (small local backend).
- `vendor/xlsx.core.min.js` — [SheetJS](https://sheetjs.com) (Apache-2.0,
  license in `vendor/XLSX-LICENSE`), vendored because extension pages can't
  load remote scripts.

## Known risks (read before relying on this)

- **LinkedIn's DOM has no stable public contract.** Every selector lives in
  the `SELECTORS` object at the top of `src/content/content.js`. When
  LinkedIn ships a redesign, scraping/actions will start failing —
  the side panel surfaces a banner naming how many posts failed to parse
  when that happens, but there's no proactive monitoring; check back
  periodically and patch selectors there. **The scraping and action
  selectors here have not been verified against live LinkedIn markup** —
  treat v1 as a starting point to debug against the real DOM, not
  drop-in-and-forget code.
- **Automation against LinkedIn's own terms.** This scripts your logged-in
  session the same way Claude-in-Chrome did in the prototype — that's the
  case either way, not something this extension adds. Be deliberate about
  volume and pacing (don't rip through the whole backlog in one burst).
- **The extension can publish a comment itself** (via **Confirm & post**),
  gated only by an in-panel confirmation dialog, not a click on LinkedIn's
  own Post button. If that verification step (checking the editor emptied
  out) is ever fooled by a DOM change, a comment could appear posted when
  it wasn't, or vice versa — spot-check occasionally rather than trusting
  the "posted ✓" pill blindly at first.
- **API key lives in `chrome.storage.local` via the options page**, in
  plaintext, readable by anything with access to your Chrome profile. Fine
  for personal, single-machine use only — never package this for anyone
  else as-is.

## Data model

See the PRD for the full per-post schema; `src/lib/storage.js` implements
it directly (`newRecord`).

## Not in v1

Batch/bulk backlog processing beyond "scan the whole list at once", Google
Sheets sync (no Sheets-specific connector exists yet — Drive-file-only), and
a shared backend. See "Phasing" in the PRD.
