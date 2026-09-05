const CACHE = 'fotovibe-shell-v10';
const SHELL = [
  '/',
  '/static/index.html',
  '/static/style.css?v=hot-search-v10',
  '/static/app.js?v=hot-search-v10',
  '/static/offline-store.js',
  '/static/vendor/heic-to.js',
  '/static/party.jpg',
  '/static/favicon.svg',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/manifest.webmanifest',
];
const DATABASE = 'fotovibe-offline';
const UPLOAD_CONCURRENCY = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  if (!url.pathname.startsWith('/static/') && url.pathname !== '/manifest.webmanifest') return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (!response || !response.ok) return response;
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, copy));
      return response;
    })),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'fotovibe-sync-outbox') event.waitUntil(drainOutbox());
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'fotovibe-outbox') event.waitUntil(drainOutbox());
});

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function listEntries() {
  const database = await openDatabase();
  const transaction = database.transaction('outbox', 'readonly');
  const entries = await requestValue(transaction.objectStore('outbox').getAll());
  await transactionDone(transaction);
  return entries.sort((left, right) => left.createdAt - right.createdAt);
}

async function stateValue(key) {
  const database = await openDatabase();
  const transaction = database.transaction('state', 'readonly');
  const record = await requestValue(transaction.objectStore('state').get(key));
  await transactionDone(transaction);
  return record?.value;
}

async function updateEntry(id, patch) {
  const database = await openDatabase();
  const transaction = database.transaction('outbox', 'readwrite');
  const store = transaction.objectStore('outbox');
  const entry = await requestValue(store.get(id));
  if (entry) store.put({ ...entry, ...patch, updatedAt: Date.now() });
  await transactionDone(transaction);
  return entry ? { ...entry, ...patch } : null;
}

async function deleteEntry(id) {
  const database = await openDatabase();
  const transaction = database.transaction('outbox', 'readwrite');
  transaction.objectStore('outbox').delete(id);
  await transactionDone(transaction);
}

async function acquireLease(owner) {
  const database = await openDatabase();
  const transaction = database.transaction('state', 'readwrite');
  const store = transaction.objectStore('state');
  const record = await requestValue(store.get('upload-lease'));
  const now = Date.now();
  const lease = record?.value;
  const allowed = !lease || lease.expiresAt <= now || lease.owner === owner;
  if (allowed) store.put({ key: 'upload-lease', value: { owner, expiresAt: now + 30_000 } });
  await transactionDone(transaction);
  return allowed;
}

async function releaseLease(owner) {
  const database = await openDatabase();
  const transaction = database.transaction('state', 'readwrite');
  const store = transaction.objectStore('state');
  const record = await requestValue(store.get('upload-lease'));
  if (record?.value?.owner === owner) store.delete('upload-lease');
  await transactionDone(transaction);
}

async function notifyClients() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: 'fotovibe-outbox-updated' }));
}

function responseMessage(response) {
  return response.json().then((payload) => payload?.detail || 'Upload fehlgeschlagen.').catch(() => 'Upload fehlgeschlagen.');
}

function retryAfterMilliseconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp - Date.now() : 0;
}

function validUploadId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function finiteTimestamp(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function storedPhotoBlob(entry) {
  if (entry.blob instanceof Blob && entry.blob.size) return entry.blob;
  if (entry.bytes instanceof ArrayBuffer && entry.bytes.byteLength) {
    return new Blob([entry.bytes], { type: entry.type || 'application/octet-stream' });
  }
  if (ArrayBuffer.isView(entry.bytes) && entry.bytes.byteLength) {
    return new Blob([entry.bytes], { type: entry.type || 'application/octet-stream' });
  }
  return null;
}

async function prepareEntry(entry) {
  const patch = {};
  if (!validUploadId(entry.serverPhotoId)) {
    patch.serverPhotoId = validUploadId(entry.uploadId) ? entry.uploadId : crypto.randomUUID();
  }
  const stored = entry.clientMetadata || {};
  const createdAt = finiteTimestamp(entry.createdAt, Date.now());
  const metadata = {
    source: ['camera', 'library', 'fallback'].includes(stored.source) ? stored.source : 'library',
    captured_at: finiteTimestamp(stored.captured_at, createdAt),
    queued_at: finiteTimestamp(stored.queued_at, createdAt),
  };
  if (entry.task?.id) metadata.task_id = entry.task.id;
  if (JSON.stringify(entry.clientMetadata) !== JSON.stringify(metadata)) patch.clientMetadata = metadata;
  if (!Object.keys(patch).length) return entry;
  await updateEntry(entry.id, patch);
  return { ...entry, ...patch };
}

async function uploadEntry(entry) {
  const photo = storedPhotoBlob(entry);
  if (!(photo instanceof Blob) || !photo.size) {
    await updateEntry(entry.id, {
      status: 'error', progress: 0,
      lastError: 'Das lokal gespeicherte Foto fehlt. Bitte aus der Liste löschen.',
    });
    return false;
  }
  const headers = new Headers({ 'Content-Type': photo.type || 'application/octet-stream' });
  if (entry.serverPhotoId) headers.set('X-FotoVibe-Upload-ID', entry.serverPhotoId);
  if (entry.task?.task_token) headers.set('X-FotoVibe-Task-Token', entry.task.task_token);
  else if (entry.task?.id) headers.set('X-FotoVibe-Task-ID', entry.task.id);
  if (entry.clientMetadata) headers.set('X-FotoVibe-Client-Metadata', JSON.stringify(entry.clientMetadata));
  const response = await fetch('/api/photos', {
    method: 'POST', body: photo, headers, credentials: 'same-origin',
  });
  if (response.ok) {
    await deleteEntry(entry.id);
    return false;
  }
  const message = await responseMessage(response);
  const attempts = (entry.attempts || 0) + 1;
  if (response.status === 401) {
    await updateEntry(entry.id, { status: 'blocked', attempts, lastError: message, progress: 0 });
    return true;
  }
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = retryAfterMilliseconds(response.headers.get('Retry-After'));
    const delay = retryAfter || Math.min(300_000, 5_000 * (2 ** Math.min(attempts, 6)));
    await updateEntry(entry.id, {
      status: 'queued', attempts, lastError: message, progress: 0, nextAttemptAt: Date.now() + delay,
    });
    return true;
  }
  await updateEntry(entry.id, { status: 'error', attempts, lastError: message, progress: 0 });
  return false;
}

async function processEntry(candidate) {
  let entry = await prepareEntry(candidate);
  await updateEntry(entry.id, { status: 'uploading', progress: null });
  try {
    return await uploadEntry(entry);
  } catch {
    const attempts = (entry.attempts || 0) + 1;
    await updateEntry(entry.id, {
      status: 'queued', attempts, progress: 0,
      lastError: 'Keine Verbindung.',
      nextAttemptAt: Date.now() + Math.min(300_000, 5_000 * (2 ** Math.min(attempts, 6))),
    });
    return true;
  }
}

async function drainOutbox() {
  if (await stateValue('signed-out')) return;
  const owner = `worker-${crypto.randomUUID()}`;
  if (!(await acquireLease(owner))) return;
  const leaseRenewal = setInterval(() => { void acquireLease(owner); }, 10_000);
  try {
    const entries = (await listEntries()).filter(
      (entry) => ['queued', 'uploading'].includes(entry.status)
        && (entry.nextAttemptAt || 0) <= Date.now(),
    );
    for (let index = 0; index < entries.length; index += UPLOAD_CONCURRENCY) {
      const batch = entries.slice(index, index + UPLOAD_CONCURRENCY);
      const stops = await Promise.all(batch.map(processEntry));
      if (stops.some(Boolean)) break;
    }
  } finally {
    clearInterval(leaseRenewal);
    await releaseLease(owner);
    await notifyClients();
  }
}
