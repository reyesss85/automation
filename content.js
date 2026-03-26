// content.js
// Runs in the context of the Gemini web pages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'executeJob') {
    log('Received job request in content script');
    // We run the async process but return true to keep the message channel open
    executeJob(message.job).catch(e => {
      chrome.runtime.sendMessage({ action: 'jobFailed', error: e.message || String(e) });
    });
    sendResponse({ received: true });
    return true;
  }
});

function log(msg, level = 'info') {
  chrome.runtime.sendMessage({ action: 'log', message: msg, level });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function executeJob(job) {
  try {
    log(`Starting execution for job: ${job.prompt}`);

    // 1. Find input area
    const inputArea = await waitForElement([
      'div[contenteditable="true"][role="textbox"]',
      'textarea[aria-label="Chat input"]',
      'rich-textarea',
      // AI fallback heuristic: search for contenteditable with a common placeholder
      (root) => Array.from(root.querySelectorAll('[contenteditable="true"]')).find(el => el.offsetHeight > 20)
    ], 10000);

    if (!inputArea) throw new Error("Could not find input textarea.");

    // 2. Clear input
    inputArea.focus();
    inputArea.innerHTML = '';
    // Dispatch events to trigger React/Angular state updates
    inputArea.dispatchEvent(new Event('input', { bubbles: true }));
    inputArea.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(500);

    // 3. Inject prompt
    // For contenteditable, document.execCommand works better for preserving formatting and triggering framework events
    document.execCommand('insertText', false, job.prompt);
    inputArea.dispatchEvent(new Event('input', { bubbles: true }));
    inputArea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));

    await sleep(1000);

    // 4. Find and click send button
    const sendBtn = await waitForElement([
      'button[aria-label="Send message"]',
      'button[mattooltip="Send message"]',
      '.send-button',
      // Text anchor fallback
      (root) => Array.from(root.querySelectorAll('button')).find(btn =>
        btn.querySelector('svg') && !btn.disabled && btn.offsetParent !== null
      )
    ], 5000);

    if (!sendBtn || sendBtn.disabled) throw new Error("Could not find active send button.");

    log("Clicking send button");
    sendBtn.click();

    // 5. Wait for generation to finish and extract results
    const mediaUrls = await waitForResults(job.type, 120000); // Wait up to 2 mins

    log(`Successfully generated and extracted ${mediaUrls.length} ${job.type}s`);
    chrome.runtime.sendMessage({ action: 'jobCompleted', data: { mediaUrls, jobType: job.type } });

  } catch (error) {
    log(`Job execution error: ${error.message}`, 'error');
    chrome.runtime.sendMessage({ action: 'jobFailed', error: error.message || String(error) });
  }
}

// Adaptive element finding with heuristics
async function waitForElement(selectors, timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    for (const selector of selectors) {
      try {
        let el;
        if (typeof selector === 'function') {
          el = selector(document);
        } else {
          el = document.querySelector(selector);
        }

        if (el && isElementVisible(el)) {
          return el;
        }
      } catch (e) {
        // Selector error, skip
      }
    }
    await sleep(500);
  }
  return null;
}

function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0';
}

async function waitForResults(type, timeout = 120000) {
  const start = Date.now();
  let latestResponseContainer = null;
  let generationStarted = false;

  // Wait for the loading state to appear, then disappear
  while (Date.now() - start < timeout) {
    // Check if generating state is active (sparkles loading, stop button visible, etc.)
    const isGenerating = document.querySelector('button[aria-label="Stop generating"]') ||
                         document.querySelector('.loading-indicator, spark-icon');

    if (isGenerating) {
      generationStarted = true;
      log("Generation in progress...");
      await sleep(2000);
    } else if (generationStarted) {
      // Generation stopped, find the last response
      log("Generation finished, parsing results...");
      await sleep(2000); // Extra buffer for DOM to settle

      const responses = document.querySelectorAll('.message-content, .model-response, [data-message-author-role="model"]');
      if (responses.length > 0) {
        latestResponseContainer = responses[responses.length - 1];
        break;
      }
    } else {
      // Keep waiting for generation to start
      await sleep(1000);
    }
  }

  if (!latestResponseContainer) {
    throw new Error("Timeout waiting for response generation.");
  }

  // Extract media
  return extractMedia(latestResponseContainer, type);
}

async function extractMedia(container, type) {
  const urls = [];

  if (type === 'image') {
    // Find image elements inside the response container
    const imgs = container.querySelectorAll('img');
    for (const img of imgs) {
      // Exclude avatar icons, small UI elements
      if (img.width > 100 && img.height > 100 && img.src) {
        // Some images might be blob URLs or base64
        if (img.src.startsWith('http') || img.src.startsWith('blob:') || img.src.startsWith('data:image')) {
          urls.push(img.src);
        }
      }
    }

    // Check for explicit download buttons in the Gemini UI for images
    const downloadBtns = container.querySelectorAll('button[aria-label*="Download"] a, a[download]');
    for (const btn of downloadBtns) {
      if (btn.href) urls.push(btn.href);
    }

  } else if (type === 'video') {
    // Find video elements
    const videos = container.querySelectorAll('video');
    for (const video of videos) {
      if (video.src) urls.push(video.src);
      // Check for source tags inside video
      const sources = video.querySelectorAll('source');
      for (const source of sources) {
        if (source.src) urls.push(source.src);
      }
    }
  }

  // Deduplicate
  const uniqueUrls = [...new Set(urls)];

  if (uniqueUrls.length === 0) {
    throw new Error(`No ${type} media found in the generated response.`);
  }

  return uniqueUrls;
}