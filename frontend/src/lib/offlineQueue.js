// Queues API calls made while offline (SRS requirement: Driver/Site Supervisor
// screens must keep working with no signal, syncing automatically once reconnected).

import { apiRequest } from "./api.js";

const QUEUE_KEY = "oorm_offline_queue";

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

// Call this instead of apiRequest() for any action a driver/site supervisor
// might take with no signal. It tries immediately; if that fails, it queues.
export async function queuedRequest(path, options) {
  if (!navigator.onLine) {
    enqueue(path, options);
    return { queued: true };
  }
  try {
    return await apiRequest(path, options);
  } catch (err) {
    // Network failure even though navigator.onLine said we're online (flaky signal)
    enqueue(path, options);
    return { queued: true };
  }
}

function enqueue(path, options) {
  const queue = readQueue();
  queue.push({ path, options, queuedAt: new Date().toISOString() });
  writeQueue(queue);
}

export function pendingCount() {
  return readQueue().length;
}

export async function flushQueue() {
  let queue = readQueue();
  const remaining = [];
  for (const item of queue) {
    try {
      await apiRequest(item.path, item.options);
    } catch {
      remaining.push(item); // still failing, keep it queued
    }
  }
  writeQueue(remaining);
  return remaining.length;
}

// Auto-flush whenever the browser comes back online
window.addEventListener("online", () => {
  flushQueue();
});
