import * as Logger from './logger.js';

export async function downloadMedia(url, type, jobId, index) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = type === 'video' ? 'mp4' : 'jpg';
  const filename = `${timestamp}_${index}_${type}.${ext}`;

  try {
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(downloadId);
        }
      });
    });
    Logger.info(`Download started: ${filename} (${downloadId})`);
  } catch (error) {
    Logger.error(`Failed to download ${url}: ${error.message}`);
    throw error;
  }
}