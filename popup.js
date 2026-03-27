import * as Storage from './storage.js';
import * as Logger from './logger.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const tabBtns = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const promptTextarea = document.getElementById('promptTextarea');
  const addTasksBtn = document.getElementById('addTasksBtn');
  const fileUpload = document.getElementById('fileUpload');

  // Dashboard Elements
  const globalStatus = document.getElementById('globalStatus');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const metricTotal = document.getElementById('metricTotal');
  const metricCompleted = document.getElementById('metricCompleted');
  const metricFailed = document.getElementById('metricFailed');
  const metricSkipped = document.getElementById('metricSkipped');
  const metricDownloaded = document.getElementById('metricDownloaded');
  const currentTaskDisplay = document.getElementById('currentTaskDisplay');
  const logContainer = document.getElementById('logContainer');

  // Control Elements
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const skipBtn = document.getElementById('skipBtn');
  const exportLogsBtn = document.getElementById('exportLogsBtn');
  const closeSidebarBtn = document.getElementById('closeSidebarBtn');

  // Load initial state
  await updateUI();

  // Listen for state changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      updateUI();
    }
  });

  // Tab switching
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });

  // Add tasks from textarea
  addTasksBtn.addEventListener('click', async () => {
    const text = promptTextarea.value.trim();
    if (!text) return;

    const platform = document.getElementById('platformSelect').value;
    const type = document.getElementById('typeSelect').value;

    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    const newJobs = lines.map(prompt => ({
      prompt,
      platform,
      type,
      status: 'pending',
      retries: 0,
      id: Date.now() + Math.random().toString(36).substr(2, 9)
    }));

    if (newJobs.length > 0) {
      await Storage.addJobs(newJobs);
      promptTextarea.value = '';
      Logger.log(`Added ${newJobs.length} tasks to queue.`);
    }
  });

  // Add tasks from file
  fileUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const defaultPlatform = document.getElementById('defaultPlatformSelect').value;
    const defaultType = document.getElementById('defaultTypeSelect').value;

    const text = await file.text();
    let newJobs = [];

    if (file.name.endsWith('.csv')) {
      // Parse CSV: prompt,platform,type
      const lines = text.split('\n').map(line => line.trim()).filter(line => line);
      newJobs = lines.map(line => {
        // Simple CSV parse handling quotes roughly
        const parts = line.split(',');
        return {
          prompt: parts[0]?.replace(/^"|"$/g, '').trim(),
          platform: (parts[1]?.trim().toLowerCase() === 'business') ? 'business' : 'gemini',
          type: (parts[2]?.trim().toLowerCase() === 'video') ? 'video' : 'image',
          status: 'pending',
          retries: 0,
          id: Date.now() + Math.random().toString(36).substr(2, 9)
        };
      }).filter(job => job.prompt);
    } else {
      // Parse TXT: one prompt per line
      const lines = text.split('\n').map(line => line.trim()).filter(line => line);
      newJobs = lines.map(prompt => ({
        prompt,
        platform: defaultPlatform,
        type: defaultType,
        status: 'pending',
        retries: 0,
        id: Date.now() + Math.random().toString(36).substr(2, 9)
      }));
    }

    if (newJobs.length > 0) {
      await Storage.addJobs(newJobs);
      fileUpload.value = '';
      Logger.log(`Added ${newJobs.length} tasks from file to queue.`);
    }
  });

  // Controls
  startBtn.addEventListener('click', async () => {
    await Storage.updateState({ isRunning: true, isPaused: false });
    chrome.runtime.sendMessage({ action: 'startQueue' });
  });

  pauseBtn.addEventListener('click', async () => {
    await Storage.updateState({ isRunning: false, isPaused: true });
    chrome.runtime.sendMessage({ action: 'pauseQueue' });
  });

  stopBtn.addEventListener('click', async () => {
    await Storage.updateState({ isRunning: false, isPaused: false });
    chrome.runtime.sendMessage({ action: 'stopQueue' });
  });

  resetBtn.addEventListener('click', async () => {
    if(confirm("Are you sure you want to reset all progress and clear the queue?")) {
      await Storage.resetState();
      chrome.runtime.sendMessage({ action: 'stopQueue' });
    }
  });

  skipBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'skipCurrent' });
  });

  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', () => {
      // Send message to content script to remove iframe
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "toggleSidebar" });
        }
      });
    });
  }

  exportLogsBtn.addEventListener('click', async () => {
    const state = await Storage.getState();
    if (!state.logs || state.logs.length === 0) return;

    const logText = state.logs.map(l => `[${new Date(l.timestamp).toLocaleString()}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({
      url: url,
      filename: `gemini_automation_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      saveAs: true
    });
  });

  async function updateUI() {
    const state = await Storage.getState();

    // Status
    if (state.isRunning) {
      globalStatus.innerHTML = '⚡ Process Running';
      globalStatus.style.color = 'var(--success-color)';
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
    } else if (state.isPaused) {
      globalStatus.innerHTML = '⏸ Process Paused';
      globalStatus.style.color = 'var(--warning-color)';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      globalStatus.innerHTML = '🛑 Process Stopped';
      globalStatus.style.color = 'var(--text-color)';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
    }

    // Metrics
    const total = state.queue.length;
    const completed = state.queue.filter(j => j.status === 'completed').length;
    const failed = state.queue.filter(j => j.status === 'failed').length;
    const skipped = state.queue.filter(j => j.status === 'skipped').length;
    const downloaded = state.metrics.downloaded;

    const processed = completed + failed + skipped;
    const percent = total === 0 ? 0 : Math.round((processed / total) * 100);

    metricTotal.textContent = total;
    metricCompleted.textContent = completed;
    metricFailed.textContent = failed;
    metricSkipped.textContent = skipped;
    metricDownloaded.textContent = downloaded;

    progressBar.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;

    // Current Task
    const currentTask = state.queue.find(j => j.status === 'processing');
    currentTaskDisplay.textContent = currentTask ? currentTask.prompt : 'None';

    // Logs
    logContainer.innerHTML = '';
    [...state.logs].reverse().forEach(log => {
      const el = document.createElement('div');
      el.className = `log-entry ${log.level}`;
      const time = new Date(log.timestamp).toLocaleTimeString();
      el.textContent = `[${time}] ${log.message}`;
      logContainer.appendChild(el);
    });
  }
});