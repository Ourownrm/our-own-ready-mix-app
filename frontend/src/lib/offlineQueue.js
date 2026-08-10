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
// might take with no signal. It tries immediately; if that fails because the
// request never reached the server at all, it queues. A real HTTP error
// response (validation failure, expired session, server error — apiRequest
// sets err.status for these) is NOT a connectivity problem and must not be
// queued: retrying the identical request later would just fail the same way
// every time, leaving it stuck in the queue forever while the person sees a
// misleading "no signal" message instead of the actual problem.
export async function queuedRequest(path, options) {
  if (!navigator.onLine) {
    enqueue(path, options);
    return { queued: true };
  }
  try {
    return await apiRequest(path, options);
  } catch (err) {
    if (err.status !== undefined) {
      // The server responded — this is a real error, not a signal problem.
      throw err;
    }
    // fetch() itself failed (TypeError, no err.status) — the request never
    // reached the server at all. This is a genuine network failure even
    // though navigator.onLine said we're online (flaky signal).
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

const FAILED_KEY = "oorm_offline_failed";

function readFailed() {
  try {
    return JSON.parse(localStorage.getItem(FAILED_KEY)) || [];
  } catch {
    return [];
  }
}

function writeFailed(list) {
  localStorage.setItem(FAILED_KEY, JSON.stringify(list));
}

export function failedCount() {
  return readFailed().length;
}

export function clearFailed() {
  writeFailed([]);
}

export async function flushQueue() {
  let queue = readQueue();
  const remaining = [];
  const newlyFailed = [];
  for (const item of queue) {
    try {
      await apiRequest(item.path, item.options);
    } catch (err) {
      if (err.status !== undefined) {
        // A real error, not a connectivity problem — retrying the exact same
        // request later will just fail the same way forever. Move it out of
        // the sync queue so it stops claiming to be "waiting for signal,"
        // but keep it visible rather than losing it silently.
        newlyFailed.push({ ...item, error: err.message });
      } else {
        remaining.push(item); // genuine network failure — still worth retrying
      }
    }
  }
  writeQueue(remaining);
  if (newlyFailed.length > 0) writeFailed([...readFailed(), ...newlyFailed]);
  return remaining.length;
}

// Auto-flush whenever the browser comes back online
window.addEventListener("online", () => {
  flushQueue();
});

// The 'online' event only fires on an offline→online *transition* — it never
// fires if the app is simply reopened while already connected (e.g. closed
// at a low-signal site, reopened later somewhere with signal). Without this,
// a queued action could sit in local storage indefinitely with no further
// attempt to send it, even though the connection is fine. Call this once on
// app load, and periodically while the app stays open, as a safety net.
export function startPeriodicFlush(intervalMs = 30000) {
  if (navigator.onLine) flushQueue();
  return setInterval(() => {
    if (navigator.onLine) flushQueue();
  }, intervalMs);
}
