import { addLog } from './storage.js';

export async function log(message, level = 'info') {
  const timestamp = Date.now();
  const entry = {
    timestamp,
    level,
    message
  };

  // Also log to background console
  console[level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'log'](
    `[Gemini Automation] ${message}`
  );

  await addLog(entry);
}

export async function error(message) {
  return log(message, 'error');
}

export async function warn(message) {
  return log(message, 'warning');
}

export async function info(message) {
  return log(message, 'info');
}