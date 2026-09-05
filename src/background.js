import { makeLogger } from './lib/logger.js';

const logger = makeLogger('background');

chrome.runtime.onInstalled.addListener((details) => {
  logger.log('installed', details.reason);
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => logger.error('setPanelBehavior failed', err));
});
