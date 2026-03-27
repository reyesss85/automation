import * as Storage from './storage.js';
import * as Logger from './logger.js';
import { downloadMedia } from './downloader.js';

let activeTabId = null;
let currentJobId = null;
let isProcessing = false;

// URLs
const URLS = {
  gemini: 'https://gemini.google.com/app',
  business: 'https://business.gemini.google/app'
};

// Initialize
chrome.runtime.onInstalled.addListener(async () => {
  await Storage.resetState();
  // Ensure the side panel is enabled
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  }
  Logger.info('Extension installed and state reset.');
});

// Enable opening side panel via icon click
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

// Message listener from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startQueue') {
    startProcessing();
    sendResponse({ success: true });
  } else if (message.action === 'pauseQueue') {
    pauseProcessing();
    sendResponse({ success: true });
  } else if (message.action === 'stopQueue') {
    stopProcessing();
    sendResponse({ success: true });
  } else if (message.action === 'skipCurrent') {
    skipCurrentJob();
    sendResponse({ success: true });
  } else if (message.action === 'jobCompleted') {
    handleJobCompleted(message.data);
    sendResponse({ success: true });
  } else if (message.action === 'jobFailed') {
    handleJobFailed(message.error);
    sendResponse({ success: true });
  } else if (message.action === 'log') {
    Logger.log(message.message, message.level);
    sendResponse({ success: true });
  }
  return true;
});

// Helper: Sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startProcessing() {
  const state = await Storage.getState();
  if (!state.isRunning || state.isPaused) return;
  if (isProcessing) return;

  isProcessing = true;
  await processNextJob();
}

function pauseProcessing() {
  isProcessing = false;
  Logger.info('Queue paused.');
}

async function stopProcessing() {
  isProcessing = false;
  if (currentJobId) {
    await Storage.updateJob(currentJobId, { status: 'pending' });
    currentJobId = null;
  }
  // We no longer close the tab when stopping, just reset activeTabId
  activeTabId = null;
  Logger.info('Queue stopped and execution cleared.');
}

async function skipCurrentJob() {
  if (currentJobId) {
    await Storage.updateJob(currentJobId, { status: 'skipped' });
    Logger.warn(`Job ${currentJobId} skipped by user.`);
    currentJobId = null;
    isProcessing = false; // Reset to allow loop to pick up next
    setTimeout(startProcessing, 1000);
  }
}

async function processNextJob() {
  const state = await Storage.getState();
  if (!state.isRunning || state.isPaused) {
    isProcessing = false;
    return;
  }

  const job = await Storage.getNextJob();
  if (!job) {
    isProcessing = false;
    Logger.info('Queue empty or all jobs completed.');
    await Storage.updateState({ isRunning: false });
    activeTabId = null; // Do not close tab
    return;
  }

  currentJobId = job.id;
  await Storage.updateJob(job.id, { status: 'processing' });
  Logger.info(`Processing job: ${job.prompt}`);

  try {
    const targetUrl = URLS[job.platform] || URLS.gemini;
    await ensureTab(targetUrl);

    // Add randomized delay (2-5 seconds) before injecting to simulate human behavior and wait for load
    const delay = Math.floor(Math.random() * 3000) + 2000;
    Logger.info(`Waiting ${delay}ms before injecting prompt...`);
    await sleep(delay);

    // Send prompt to content script
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        action: 'executeJob',
        job: job
      });
    } catch (e) {
      // If content script is not ready, reload tab and retry
      Logger.warn(`Content script not ready, reloading tab...`);
      await chrome.tabs.reload(activeTabId);
      await sleep(5000); // Wait for reload
      await chrome.tabs.sendMessage(activeTabId, {
        action: 'executeJob',
        job: job
      });
    }

    // Execution is now handed off to content script
    // It will reply with 'jobCompleted' or 'jobFailed'
  } catch (error) {
    handleJobFailed(error.message || String(error));
  }
}

async function ensureTab(url) {
  // Get the currently active tab in the current window
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || !activeTab.url) {
    throw new Error("No active tab found. Please open Gemini manually.");
  }

  // Check if the current tab is on the correct Gemini platform
  if (!activeTab.url.startsWith("https://gemini.google.com") && !activeTab.url.startsWith("https://business.gemini.google")) {
    throw new Error(`Current tab is not a Gemini page (${url}). Please navigate to Gemini first.`);
  }

  activeTabId = activeTab.id;
  return activeTabId;
}

async function handleJobCompleted(data) {
  if (!currentJobId) return;

  Logger.info(`Job completed successfully. Media extracted: ${data.mediaUrls.length}`);

  if (data.mediaUrls && data.mediaUrls.length > 0) {
    for (let i = 0; i < data.mediaUrls.length; i++) {
      await downloadMedia(data.mediaUrls[i], data.jobType, currentJobId, i);
      await Storage.incrementDownloaded();
    }
  }

  await Storage.updateJob(currentJobId, { status: 'completed' });
  currentJobId = null;

  // Wait a bit before next job to prevent rate limits
  await sleep(Math.floor(Math.random() * 2000) + 1000);
  processNextJob();
}

async function handleJobFailed(errorMessage) {
  if (!currentJobId) return;

  const state = await Storage.getState();
  const job = state.queue.find(j => j.id === currentJobId);

  if (!job) return;

  Logger.error(`Job failed: ${errorMessage}`);

  if (job.retries < 3) {
    const newRetries = job.retries + 1;
    // Exponential backoff: 2s, 5s, 10s roughly
    const backoff = [2000, 5000, 10000][job.retries] || 2000;
    Logger.warn(`Retrying job (Attempt ${newRetries}/3) in ${backoff}ms...`);

    await Storage.updateJob(currentJobId, {
      status: 'pending',
      retries: newRetries
    });
    currentJobId = null;

    // Attempt to reload tab on failure to reset state
    if (activeTabId) {
      try {
        await chrome.tabs.reload(activeTabId);
      } catch (e) {}
    }

    await sleep(backoff);
    processNextJob();
  } else {
    Logger.error(`Job failed 3 times, marking as skipped: ${job.prompt}`);
    await Storage.updateJob(currentJobId, { status: 'skipped' });
    currentJobId = null;

    await sleep(2000);
    processNextJob();
  }
}