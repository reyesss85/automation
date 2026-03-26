// storage.js
// Wraps chrome.storage.local for persistent state management

const DEFAULT_STATE = {
  queue: [], // { id, prompt, platform, type, status, retries }
  metrics: {
    downloaded: 0
  },
  isRunning: false,
  isPaused: false,
  logs: [] // { timestamp, level, message }
};

export async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get('automationState', (result) => {
      resolve(result.automationState || DEFAULT_STATE);
    });
  });
}

export async function updateState(updates) {
  const currentState = await getState();
  const newState = { ...currentState, ...updates };
  return new Promise((resolve) => {
    chrome.storage.local.set({ automationState: newState }, () => resolve(newState));
  });
}

export async function addJobs(jobs) {
  const state = await getState();
  const newQueue = [...state.queue, ...jobs];
  return updateState({ queue: newQueue });
}

export async function updateJob(jobId, updates) {
  const state = await getState();
  const newQueue = state.queue.map(job =>
    job.id === jobId ? { ...job, ...updates } : job
  );
  return updateState({ queue: newQueue });
}

export async function getNextJob() {
  const state = await getState();
  if (state.isPaused || !state.isRunning) return null;
  return state.queue.find(job => job.status === 'pending');
}

export async function addLog(logEntry) {
  const state = await getState();
  const logs = [...state.logs, logEntry].slice(-100); // Keep last 100 logs
  return updateState({ logs });
}

export async function incrementDownloaded() {
  const state = await getState();
  return updateState({
    metrics: {
      ...state.metrics,
      downloaded: state.metrics.downloaded + 1
    }
  });
}

export async function resetState() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ automationState: DEFAULT_STATE }, () => resolve(DEFAULT_STATE));
  });
}