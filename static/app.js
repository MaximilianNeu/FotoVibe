import {
  acquireUploadLease,
  addOutboxEntry,
  clearOutbox,
  deleteOutboxEntry,
  getOfflineState,
  listOutbox,
  openOfflineStore,
  outboxSummary,
  releaseUploadLease,
  resetInterruptedUploads,
  setOfflineState,
  updateOutboxEntry,
} from '/static/offline-store.js';

const $ = (id) => document.getElementById(id);
const galleryPage = location.pathname === '/gallery';
const streamPage = location.pathname === '/stream';
const MAX_BYTES = 25 * 1024 * 1024;
const DEVICE_STORAGE_KEY = 'fotovibe_device_id';
const OUTBOX_MAX_ITEMS = 25;
const OUTBOX_MAX_BYTES = 250 * 1024 * 1024;
const OUTBOX_HEADROOM_BYTES = 20 * 1024 * 1024;
const OUTBOX_UPLOAD_CONCURRENCY = 2;
let cachedDeviceId = null;
let authenticated = false;
let currentUser = null;
let selected = null;
let selectedBytes = null;
let directServerPhotoId = null;
let previewUrl = null;
let previewGeneration = 0;
let previewMirrored = false;
let uploading = false;
let timer = null;
let galleryBusy = false;
let adminData = null;
let adminTasks = null;
let adminTab = 'users';
let adminSearchTimer = null;
let adminStreamSearchTimer = null;
let adminQuery = '';
let adminStreamQuery = '';
let adminStreamPhotos = [];
let nextCursor = null;
let galleryLoaded = false;
const photos = new Map();
let detailButton = null;
let scrollPosition = 0;
let activeDetailPhoto = null;
let galleryQuery = '';
let galleryMine = false;
let gallerySearchTimer = null;
let cameraStream = null;
const handheldPointer = typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;
// Phones start with the rear camera; laptops normally have one user-facing
// webcam, so starting with `user` also enables its display-flash affordance.
let cameraFacing = handheldPointer ? 'environment' : 'user';
let cameraTorchOn = false;
let cameraGeneration = 0;
let captureFullscreenWanted = false;
let selectionSource = null;
let selectedTask = null;
let selectedUploadMetadata = null;
let currentTask = null;
let taskBusy = false;
let cachedTasks = [];
let taskBag = [];
let lastDrawnTaskId = null;
let outboxEntries = [];
let queueSyncing = false;
let queueSyncTimer = null;
let queueDoneTimer = null;
let queueNoticeTimer = null;
let lastQueuedId = null;
let offlineMode = false;
let locallySignedOut = false;
const queueOwner = `page-${crypto.randomUUID()}`;
const queuePreviewUrls = new Map();
let queueDetailId = null;
let queueDetailPreviewUrl = null;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The stream keeps no server state: every screen derives what it shows from the
// clock, which is what keeps the television and the phones together.
const STREAM_SPACING = 340; // distance in depth between two photos
const STREAM_SPEED = 46; // pixels per second the camera glides forward
const STREAM_VISIBLE = 12; // photos in flight at any one moment
const STREAM_FRESH = 8; // newest photos that get the extra turn
const STREAM_PERSPECTIVE = 1200; // has to match the perspective on .stream-stage
const STREAM_SPREAD_X = 52; // widest scatter on screen, percent of the stage width
const STREAM_SPREAD_Y = 46; // widest scatter on screen, percent of the stage height
const STREAM_CONVERGE_MIN = 0.18; // scatter kept at the very front, so nothing snaps
const STREAM_FADE_OUT = 0.18; // fraction of one spacing a passing photo fades over
const STREAM_GOLDEN_ANGLE = 2.399963229728653; // 137.5 degrees, in radians
// Depth blur used to be recomputed per frame. Changing an element's filter
// forces the browser to repaint the whole card, and that repaint visibly snaps:
// measured on a background card, one such change moved 45 per cent of its
// pixels at once, which is the flicker along the frames. So the softening is
// now a fixed blur on a permanently soft copy of the photo, and the sharp copy
// is faded in over it. Opacity is a compositor property, so nothing repaints.
const STREAM_SHARP_SLOTS = 4; // nearest slots that load the full-size photo
const STREAM_SHARP_REACH = 2; // spacings over which the sharp copy fades in
const STREAM_HIGHLIGHT_EVERY = 10; // ordinary photos between two highlights
let streamTimer = null;
let streamFrameHandle = null;
let streamPollTimer = null;
let streamPlaylist = [];
let streamSignature = null;
let streamClockOffset = 0;
const streamSlots = [];
const streamPhotoById = new Map();
const streamStageSize = { width: 0, height: 0 };
// The television at the party is an old one. Rather than guess its budget,
// the stream watches its own frame rate and drops effects until it keeps up.
let streamQuality = 0;
let streamFrames = 0;
let streamWindowStart = 0;
let streamWarmUp = 0;
let streamSlowWindows = 0;
let streamFullscreenFallback = false;
const streamReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// /stream?tv=1 gives the television layout without the Fullscreen API, so a
// browser started in kiosk mode needs no interaction at all.
const tvMode = streamPage && new URLSearchParams(location.search).get('tv') === '1';
document.body.classList.toggle('tv-mode', tvMode);
$('page-backdrop').hidden = tvMode;
$(streamPage ? 'nav-stream' : galleryPage ? 'nav-gallery' : 'nav-upload').setAttribute('aria-current', 'page');
document.title = galleryPage ? 'Unsere Galerie · 180. Geburtstag' : streamPage ? 'Stream · 180. Geburtstag' : 'Foto teilen · 180. Geburtstag';

// Older iOS and embedded browsers calculate 100vh against browser chrome rather
// than the currently visible area. Keep one pixel-accurate viewport value for
// the camera, review and CSS fullscreen fallback.
function syncViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  if (height) document.documentElement.style.setProperty('--viewport-height', `${Math.round(height)}px`);
}

syncViewportHeight();
window.visualViewport?.addEventListener('resize', syncViewportHeight);

function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let value = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(DEVICE_STORAGE_KEY, value);
    }
    cachedDeviceId = value;
  } catch { cachedDeviceId = crypto.randomUUID(); }
  return cachedDeviceId;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toLocaleString('de', { maximumFractionDigits: 1 })} MiB`;
}

function retryAfterMilliseconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp - Date.now() : 0;
}

function closeQueueMenu() {
  $('queue-menu').hidden = true;
  $('queue-button').setAttribute('aria-expanded', 'false');
  if (!outboxEntries.length && !lastQueuedId && navigator.onLine !== false) $('queue-control').hidden = true;
}

function openQueueMenu() {
  if ($('queue-control').hidden) {
    if (outboxEntries.length || lastQueuedId || navigator.onLine === false) return;
    $('queue-control').hidden = false;
    $('queue-button').dataset.state = 'queued';
    $('queue-badge').textContent = '0';
    $('queue-label').textContent = 'Keine Fotos vorgemerkt. Upload-Liste öffnen.';
  }
  closeProfileMenu();
  $('queue-menu').hidden = false;
  $('queue-button').setAttribute('aria-expanded', 'true');
}

function updateLocalCacheStatus(entries = outboxEntries) {
  const count = entries.length;
  const button = $('local-cache');
  button.hidden = count === 0;
  button.disabled = count === 0;
  $('local-cache-text').textContent = `${count} / ${OUTBOX_MAX_ITEMS} vorgemerkt`;
  button.setAttribute('aria-label', count === 0
    ? 'Keine Fotos lokal vorgemerkt. Upload-Liste öffnen.'
    : `${count} von ${OUTBOX_MAX_ITEMS} Fotos lokal vorgemerkt. Upload-Liste öffnen.`);
}

function showQueueNotice(count) {
  const notice = $('queue-notice');
  clearTimeout(queueNoticeTimer);
  notice.textContent = `Eingereiht · ${count} / ${OUTBOX_MAX_ITEMS}`;
  notice.hidden = false;
  queueNoticeTimer = setTimeout(() => { notice.hidden = true; }, 2400);
}

function updateSendAction() {
  if (!$('review').hidden && selected && !uploading) {
    $('send').textContent = navigator.onLine === false ? 'Später hochladen' : 'Foto hochladen';
  }
}

function releaseUnusedQueuePreviews(entries = outboxEntries) {
  const activeIds = new Set(entries.map((entry) => entry.id));
  for (const [entryId, url] of queuePreviewUrls) {
    if (activeIds.has(entryId)) continue;
    URL.revokeObjectURL(url);
    queuePreviewUrls.delete(entryId);
  }
}

function displayableBlob(value) {
  return value instanceof Blob && value.size > 0;
}

function storedBytesBlob(value, type) {
  if (value instanceof ArrayBuffer && value.byteLength > 0) {
    return new Blob([value], { type: type || 'application/octet-stream' });
  }
  if (ArrayBuffer.isView(value) && value.byteLength > 0) {
    return new Blob([value], { type: type || 'application/octet-stream' });
  }
  return null;
}

function blobBytes(value) {
  if (typeof value?.arrayBuffer === 'function') return value.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Das Foto konnte nicht lokal vorbereitet werden.'));
    reader.readAsArrayBuffer(value);
  });
}

function queuePhotoBlob(entry) {
  return displayableBlob(entry.blob)
    ? entry.blob
    : storedBytesBlob(entry.bytes, entry.type);
}

function queueThumbnailBlob(entry) {
  return displayableBlob(entry.thumbnail)
    ? entry.thumbnail
    : storedBytesBlob(entry.thumbnailBytes, entry.thumbnailType || 'image/jpeg');
}

function queuePreviewUrl(entry) {
  const existing = queuePreviewUrls.get(entry.id);
  if (existing) return existing;
  if (typeof entry.thumbnailDataUrl === 'string' && entry.thumbnailDataUrl.startsWith('data:image/')) {
    return entry.thumbnailDataUrl;
  }
  const preview = queueThumbnailBlob(entry) || queuePhotoBlob(entry);
  if (!preview) return null;
  const url = URL.createObjectURL(preview);
  queuePreviewUrls.set(entry.id, url);
  return url;
}

function queueThumbnailPlaceholder() {
  const placeholder = document.createElement('span');
  placeholder.className = 'queue-thumbnail-placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M4 7h3l1.5-2h7L17 7h3v12H4z');
  const lens = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  lens.setAttribute('cx', '12');
  lens.setAttribute('cy', '13');
  lens.setAttribute('r', '3');
  svg.append(body, lens);
  placeholder.append(svg);
  return placeholder;
}

function closeQueueDetail() {
  $('queue-detail').hidden = true;
  const image = $('queue-detail-image');
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = false;
  $('queue-detail-image-unavailable').hidden = true;
  if (queueDetailPreviewUrl) URL.revokeObjectURL(queueDetailPreviewUrl);
  queueDetailPreviewUrl = null;
  queueDetailId = null;
}

function openQueueDetail(entry) {
  closeQueueMenu();
  if (!entry) return;
  queueDetailId = entry.id;
  const image = $('queue-detail-image');
  const unavailable = $('queue-detail-image-unavailable');
  const candidates = [queuePhotoBlob(entry), queueThumbnailBlob(entry)].filter(displayableBlob);
  if (typeof entry.thumbnailDataUrl === 'string' && entry.thumbnailDataUrl.startsWith('data:image/')) {
    candidates.push(entry.thumbnailDataUrl);
  }
  const showCandidate = (index) => {
    if (queueDetailPreviewUrl) URL.revokeObjectURL(queueDetailPreviewUrl);
    queueDetailPreviewUrl = null;
    if (index >= candidates.length) {
      image.removeAttribute('src');
      image.hidden = true;
      unavailable.hidden = false;
      return;
    }
    queueDetailPreviewUrl = typeof candidates[index] === 'string'
      ? candidates[index]
      : URL.createObjectURL(candidates[index]);
    image.hidden = false;
    unavailable.hidden = true;
    image.onerror = () => showCandidate(index + 1);
    image.src = queueDetailPreviewUrl;
  };
  image.alt = 'Lokal vorgemerkte Fotoaufnahme';
  showCandidate(0);
  $('queue-detail-state').textContent = queueEntryLabel(entry);
  const task = entry.task;
  $('queue-detail-task').hidden = !task?.text;
  $('queue-detail-task-text').textContent = task?.text || '';
  $('queue-detail-error').hidden = entry.status !== 'error' || !entry.lastError;
  $('queue-detail-error').textContent = entry.lastError || '';
  $('queue-detail-delete-confirmation').hidden = true;
  $('queue-detail').hidden = false;
  $('queue-detail-close').focus();
}

function validUploadId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function finiteTimestamp(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizedClientMetadata(entry) {
  const stored = entry.clientMetadata || {};
  const createdAt = finiteTimestamp(entry.createdAt, Date.now());
  const source = ['camera', 'library', 'fallback'].includes(stored.source) ? stored.source : 'library';
  const metadata = {
    source,
    captured_at: finiteTimestamp(stored.captured_at, createdAt),
    queued_at: finiteTimestamp(stored.queued_at, createdAt),
  };
  if (entry.task?.id) metadata.task_id = entry.task.id;
  return metadata;
}

async function prepareOutboxEntry(entry) {
  const patch = {};
  if (!validUploadId(entry.serverPhotoId)) {
    // The IndexedDB key identifies only the local queue item. A separate UUID
    // is allocated exactly once when the first real upload starts and then
    // retained so interrupted requests stay idempotent.
    patch.serverPhotoId = validUploadId(entry.uploadId) ? entry.uploadId : crypto.randomUUID();
  }
  const clientMetadata = normalizedClientMetadata(entry);
  if (JSON.stringify(entry.clientMetadata) !== JSON.stringify(clientMetadata)) patch.clientMetadata = clientMetadata;
  if (!Object.keys(patch).length) return entry;
  await updateOutboxEntry(entry.id, patch);
  return { ...entry, ...patch };
}

function queueEntryLabel(entry) {
  if (entry.status === 'uploading') return entry.progress > 0 ? `${entry.progress} %` : 'Lädt hoch';
  if (entry.status === 'blocked') return 'Anmelden';
  if (entry.status === 'error') return 'Fehler';
  if ((entry.nextAttemptAt || 0) > Date.now() && entry.lastError) return 'Versucht erneut';
  if (navigator.onLine === false) return 'Offline';
  return 'Wartet';
}

function queueState(entries) {
  if (entries.some((entry) => entry.status === 'blocked')) return 'blocked';
  if (entries.some((entry) => entry.status === 'error')) return 'error';
  if (entries.some((entry) => entry.status === 'uploading')) return 'uploading';
  return 'queued';
}

function setSuccessStatus(text, symbol = '↑') {
  const status = $('success-status');
  status.replaceChildren();
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = symbol;
  status.append(icon, ` ${text}`);
}

function iconButton(label, symbol, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'queue-action';
  button.setAttribute('aria-label', label);
  button.textContent = symbol;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function queueTrashButton(onClick) {
  const button = iconButton('Dieses lokal gespeicherte Foto löschen', '', onClick);
  button.classList.add('queue-delete-action');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  ['M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5'].forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  });
  button.append(svg);
  return button;
}

function showQueueDeleteConfirmation(row, entry) {
  const actions = row.querySelector('.queue-actions');
  actions.replaceChildren();
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'queue-keep';
  keep.textContent = 'Behalten';
  keep.addEventListener('click', (event) => {
    event.stopPropagation();
    renderQueue();
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'queue-delete-confirm';
  remove.textContent = 'Löschen';
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    await deleteOutboxEntry(entry.id);
    if (lastQueuedId === entry.id) lastQueuedId = null;
    await refreshOutbox();
  });
  actions.append(keep, remove);
}

async function removeQueueEntry(entryId) {
  await deleteOutboxEntry(entryId);
  if (lastQueuedId === entryId) lastQueuedId = null;
  if (queueDetailId === entryId) closeQueueDetail();
  await refreshOutbox();
}

function renderQueue() {
  releaseUnusedQueuePreviews();
  const control = $('queue-control');
  const badge = $('queue-badge');
  const button = $('queue-button');
  const label = $('queue-label');
  const list = $('queue-list');
  const entries = outboxEntries;
  updateLocalCacheStatus(entries);
  const state = queueState(entries);
  button.dataset.state = state;
  button.style.removeProperty('--queue-progress');

  if (!entries.length) {
    if (lastQueuedId) {
      control.hidden = false;
      button.dataset.state = 'done';
      badge.textContent = '✓';
      label.textContent = 'Alle vorgemerkten Fotos wurden übertragen.';
      clearTimeout(queueDoneTimer);
      queueDoneTimer = setTimeout(() => {
        if (!outboxEntries.length) {
          control.hidden = true;
          closeQueueMenu();
        }
      }, 1500);
    } else if (navigator.onLine === false) {
      control.hidden = false;
      badge.textContent = '0';
      label.textContent = 'Keine Fotos vorgemerkt. Upload-Liste öffnen.';
      clearTimeout(queueDoneTimer);
    } else if (!$('queue-menu').hidden) {
      control.hidden = false;
      badge.textContent = '0';
      label.textContent = 'Keine Fotos vorgemerkt. Upload-Liste öffnen.';
    } else {
      control.hidden = true;
      closeQueueMenu();
    }
  } else {
    clearTimeout(queueDoneTimer);
    control.hidden = false;
    const uploading = entries.find((entry) => entry.status === 'uploading');
    badge.textContent = state === 'blocked' ? '🔒' : state === 'error' ? '!' : String(entries.length);
    if (uploading && Number.isFinite(uploading.progress)) {
      button.style.setProperty('--queue-progress', `${Math.max(0, Math.min(100, uploading.progress)) * 3.6}deg`);
    }
    const queuedText = entries.length === 1 ? 'Ein Foto' : `${entries.length} Fotos`;
    label.textContent = state === 'blocked'
      ? `${queuedText} warten auf eine Anmeldung.`
      : state === 'error'
        ? `${queuedText} brauchen Aufmerksamkeit.`
        : state === 'uploading'
          ? `${queuedText} werden übertragen.`
          : `${queuedText} warten auf den Upload.`;
  }
  button.setAttribute('aria-label', label.textContent);

  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'queue-empty';
    empty.textContent = 'Keine Fotos vorgemerkt.';
    list.append(empty);
  }
  for (const entry of entries) {
    const row = document.createElement('article');
    row.className = `queue-item is-${entry.status}`;
    const thumbnailButton = document.createElement('button');
    thumbnailButton.type = 'button';
    thumbnailButton.className = 'queue-thumbnail-button';
    thumbnailButton.setAttribute('aria-label', 'Vorgemerktes Foto groß anzeigen');
    const thumbnail = document.createElement('img');
    thumbnail.className = 'queue-thumbnail';
    const placeholder = queueThumbnailPlaceholder();
    const previewUrl = queuePreviewUrl(entry);
    if (previewUrl) {
      thumbnail.alt = '';
      thumbnail.addEventListener('load', () => { placeholder.hidden = true; }, { once: true });
      thumbnail.addEventListener('error', () => {
        thumbnail.hidden = true;
        placeholder.hidden = false;
        thumbnailButton.setAttribute('aria-label', 'Vorschau nicht verfügbar. Vorgemerktes Foto öffnen');
      }, { once: true });
      thumbnail.src = previewUrl;
    } else {
      thumbnail.hidden = true;
    }
    thumbnailButton.append(thumbnail, placeholder);
    thumbnailButton.addEventListener('click', () => openQueueDetail(entry));
    const detail = document.createElement('button');
    detail.type = 'button';
    detail.className = 'queue-item-detail queue-detail-trigger';
    detail.setAttribute('aria-label', 'Vorgemerktes Foto groß anzeigen');
    const line = document.createElement('p');
    line.className = 'queue-item-state';
    const stateIcon = document.createElement('span');
    stateIcon.setAttribute('aria-hidden', 'true');
    stateIcon.textContent = entry.status === 'blocked' ? '🔒' : entry.status === 'error' ? '!' : entry.status === 'uploading' ? '↑' : '○';
    line.append(stateIcon, ` ${queueEntryLabel(entry)}`);
    detail.append(line);
    let errorDetail = null;
    if (entry.lastError && (entry.status === 'error' || (entry.nextAttemptAt || 0) > Date.now())) {
      const error = document.createElement('p');
      error.className = 'queue-item-error';
      error.hidden = true;
      error.textContent = entry.lastError || 'Bitte erneut versuchen.';
      detail.append(error);
      errorDetail = error;
    }
    detail.addEventListener('click', () => openQueueDetail(entry));
    const actions = document.createElement('div');
    actions.className = 'queue-actions';
    if (errorDetail) {
      actions.append(iconButton('Fehlerdetails anzeigen', 'i', (clickEvent) => {
        const visible = errorDetail.hidden;
        errorDetail.hidden = !visible;
        clickEvent.currentTarget.setAttribute('aria-label', visible ? 'Fehlerdetails ausblenden' : 'Fehlerdetails anzeigen');
      }));
    }
    if (entry.status === 'error' || entry.status === 'blocked') {
      actions.append(iconButton('Upload erneut versuchen', '↻', async () => {
        await updateOutboxEntry(entry.id, {
          status: 'queued', nextAttemptAt: 0, lastError: '', progress: 0,
          serverPhotoId: null, uploadId: null,
        });
        await refreshOutbox();
        scheduleQueueSync();
      }));
    }
    actions.append(queueTrashButton(() => showQueueDeleteConfirmation(row, entry)));
    row.append(thumbnailButton, detail, actions);
    list.append(row);
  }

  if (!$('success').hidden && lastQueuedId) {
    const current = entries.find((entry) => entry.id === lastQueuedId);
    if (!current) setSuccessStatus('Geteilt', '✓');
    else if (current.status === 'blocked') setSuccessStatus('Anmeldung nötig', '🔒');
    else if (current.status === 'error') setSuccessStatus('Bitte prüfen', '!');
    else if (current.status === 'uploading') setSuccessStatus('Wird geteilt', '↑');
    else setSuccessStatus('Wartet auf Netz', '○');
  }
}

async function repairLegacyOutbox(entries) {
  let requeued = false;
  for (const entry of entries) {
    if (
      entry.status === 'error'
      && !entry.automaticUploadRepairAttempted
      && /Ungültige Foto-ID|Bitte genau ein Foto/i.test(entry.lastError || '')
    ) {
      await updateOutboxEntry(entry.id, {
        status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: '', progress: 0,
        serverPhotoId: null, uploadId: null, automaticUploadRepairAttempted: true,
      });
      requeued = true;
    }
  }
  return requeued;
}

async function refreshOutbox() {
  let requeued = false;
  try {
    outboxEntries = (await outboxSummary()).entries;
    requeued = await repairLegacyOutbox(outboxEntries);
    if (requeued) outboxEntries = (await outboxSummary()).entries;
  } catch {
    outboxEntries = [];
  }
  renderQueue();
  if (queueDetailId && !outboxEntries.some((entry) => entry.id === queueDetailId)) closeQueueDetail();
  scheduleNextQueueSync();
  if (requeued && authenticated && !locallySignedOut) setTimeout(scheduleQueueSync, 0);
  return outboxEntries;
}

function scheduleNextQueueSync() {
  clearTimeout(queueSyncTimer);
  if (!authenticated || locallySignedOut) return;
  const next = outboxEntries
    .filter((entry) => entry.status === 'queued' && entry.nextAttemptAt > Date.now())
    .map((entry) => entry.nextAttemptAt)
    .sort((left, right) => left - right)[0];
  if (next) queueSyncTimer = setTimeout(scheduleQueueSync, Math.max(250, next - Date.now()));
}

async function requestBackgroundSync() {
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration?.sync) await registration.sync.register('fotovibe-outbox');
  } catch {
    // Opening FotoVibe again remains the cross-browser fallback.
  }
}

function scheduleQueueSync() {
  void syncOutbox();
  void requestBackgroundSync();
}

async function syncOutbox() {
  if (queueSyncing || !authenticated || !currentUser || locallySignedOut) return;
  queueSyncing = true;
  let hasLease = false;
  try { hasLease = await acquireUploadLease(queueOwner); } catch {}
  if (!hasLease) {
    queueSyncing = false;
    return;
  }
  const leaseRenewal = setInterval(() => { void acquireUploadLease(queueOwner); }, 10_000);
  try {
    const entries = (await listOutbox()).filter(
      (entry) => entry.status === 'queued' && (entry.nextAttemptAt || 0) <= Date.now(),
    );
    for (let index = 0; index < entries.length; index += OUTBOX_UPLOAD_CONCURRENCY) {
      const batch = entries.slice(index, index + OUTBOX_UPLOAD_CONCURRENCY);
      const stops = await Promise.all(batch.map(uploadOutboxEntry));
      if (stops.some(Boolean)) break;
    }
  } finally {
    clearInterval(leaseRenewal);
    queueSyncing = false;
    await releaseUploadLease(queueOwner);
    await refreshOutbox();
  }
}

async function uploadOutboxEntry(candidate) {
  let entry = candidate;
  const photo = queuePhotoBlob(entry);
  if (!displayableBlob(photo)) {
    await updateOutboxEntry(entry.id, {
      status: 'error', progress: 0,
      lastError: 'Das lokal gespeicherte Foto fehlt. Bitte aus der Liste löschen.',
    });
    await refreshOutbox();
    return false;
  }
  entry = await prepareOutboxEntry(entry);
  await updateOutboxEntry(entry.id, { status: 'uploading', progress: 0 });
  await refreshOutbox();
  let shownProgress = -1;
  try {
    const result = await sendPhoto(
      photo,
      entry.serverPhotoId,
      entry.task,
      entry.clientMetadata,
      async (progress) => {
        if (progress < 100 && progress - shownProgress < 5) return;
        shownProgress = progress;
        await updateOutboxEntry(entry.id, { progress });
        await refreshOutbox();
      },
    );
    await deleteOutboxEntry(entry.id);
    if (result.created && currentUser?.values) {
      showUser({ ...currentUser, values: { ...currentUser.values, photos_uploaded: (currentUser.values.photos_uploaded || 0) + 1 } });
      void setOfflineState('user', currentUser);
    }
    await refreshOutbox();
    return false;
  } catch (error) {
    const attempts = (entry.attempts || 0) + 1;
    let shouldStop = false;
    if (error.status === 401) {
      await updateOutboxEntry(entry.id, { status: 'blocked', attempts, progress: 0, lastError: 'Bitte anmelden.' });
      showLogin('Bitte melde dich erneut an, damit deine Fotos geteilt werden können.');
      shouldStop = true;
    } else if (error.network || error.status === 429 || error.status >= 500) {
      const delay = error.retryAfter || Math.min(300000, 5000 * (2 ** Math.min(attempts, 6)));
      await updateOutboxEntry(entry.id, {
        status: 'queued', attempts, progress: 0, lastError: error.message,
        nextAttemptAt: Date.now() + delay,
      });
      shouldStop = true;
    } else {
      await updateOutboxEntry(entry.id, { status: 'error', attempts, progress: 0, lastError: error.message });
    }
    await refreshOutbox();
    return shouldStop;
  }
}

async function ensureOutboxCapacity(file) {
  const { count, bytes } = await outboxSummary();
  if (count >= OUTBOX_MAX_ITEMS || bytes + file.size > OUTBOX_MAX_BYTES) {
    throw new Error('Der lokale Foto-Speicher ist voll. Bitte warte auf einen Upload.');
  }
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const available = (estimate.quota || 0) - (estimate.usage || 0);
    if (estimate.quota && available < file.size + OUTBOX_HEADROOM_BYTES) {
      throw new Error('Auf diesem Gerät ist zu wenig freier Speicher für das Foto.');
    }
  }
}

async function queueThumbnail() {
  const image = $('preview');
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const scale = Math.min(1, 180 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

async function queueSelectedPhoto() {
  await ensureOutboxCapacity(selected);
  const thumbnailDataUrl = await queueThumbnail();
  const bytes = selectedBytes || await blobBytes(selected);
  const entry = {
    id: crypto.randomUUID(),
    bytes,
    thumbnailDataUrl,
    name: selected.name,
    type: selected.type,
    size: selected.size,
    lastModified: selected.lastModified,
    deviceId: deviceId(),
    task: selectedTask,
    clientMetadata: selectedUploadMetadata,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: '',
    progress: 0,
  };
  await addOutboxEntry(entry);
  lastQueuedId = entry.id;
  await refreshOutbox();
  return entry;
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted?.())) await navigator.storage.persist();
  } catch {
    // Browser storage remains best effort when persistent mode is unavailable.
  }
}

function closeProfileMenu() {
  $('profile-menu').hidden = true;
  $('profile-button').setAttribute('aria-expanded', 'false');
  $('logout-pending').hidden = true;
}

function showUser(user) {
  currentUser = user || null;
  $('profile-control').hidden = !currentUser;
  if (!currentUser) return;
  $('profile-name').textContent = currentUser.name;
  $('profile-initial').textContent = currentUser.name.trim().charAt(0).toLocaleUpperCase('de') || '?';
  $('profile-user-id').textContent = currentUser.id || '–';
  $('profile-device-id').textContent = currentUser.device_id || '–';
  const uploaded = currentUser.values?.photos_uploaded;
  $('profile-upload-count').textContent = Number.isInteger(uploaded) && uploaded >= 0 ? String(uploaded) : '–';
  $('profile-admin-badge').hidden = !currentUser.is_admin;
  $('admin-open').hidden = !currentUser.is_admin;
}

function showLogin(message = '') {
  stopCamera(false);
  document.body.classList.remove('review-open');
  $('review').hidden = true;
  stopStream();
  authenticated = false;
  showUser(null);
  closeProfileMenu();
  clearTimeout(timer);
  $('login').hidden = false;
  $('profile-setup').hidden = $('upload').hidden = $('gallery').hidden = $('stream').hidden = $('admin').hidden = $('logout').hidden = $('boot').hidden = true;
  $('login-error').textContent = message;
  $('party-code').focus();
}

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options }); }
  catch {
    const error = new Error('Keine Verbindung. Bitte dein Netz prüfen und erneut versuchen.');
    error.network = true;
    throw error;
  }
  if (!response.ok) {
    let message = 'Das hat gerade nicht geklappt. Bitte erneut versuchen.';
    try { const result = await response.json(); if (typeof result.detail === 'string') message = result.detail; } catch {}
    if (response.status === 401 && authenticated) showLogin('Dein Zugang ist abgelaufen. Bitte den Party-Code erneut eingeben.');
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function refreshTaskCache() {
  const result = await api('/api/tasks');
  cachedTasks = Array.isArray(result.tasks) ? result.tasks.filter((task) => task?.id && task?.text && task?.task_token) : [];
  taskBag = [];
  lastDrawnTaskId = cachedTasks.some((task) => task.id === lastDrawnTaskId) ? lastDrawnTaskId : null;
  await persistTaskState();
  return cachedTasks;
}

async function persistTaskState() {
  await setOfflineState('tasks', {
    tasks: cachedTasks,
    bag: taskBag,
    lastDrawnTaskId,
    fetchedAt: Date.now(),
  });
}

function nextCachedTask(previousId = lastDrawnTaskId) {
  const available = cachedTasks.filter((task) => task.id !== previousId);
  if (!available.length) return cachedTasks[0] || null;
  if (!taskBag.length || !taskBag.some((id) => available.some((task) => task.id === id))) {
    taskBag = available.map((task) => task.id);
    for (let index = taskBag.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      [taskBag[index], taskBag[swap]] = [taskBag[swap], taskBag[index]];
    }
  }
  const id = taskBag.shift();
  const task = available.find((candidate) => candidate.id === id) || available[0];
  lastDrawnTaskId = task.id;
  void persistTaskState().catch(() => {});
  return task;
}

async function resumeBlockedOutbox() {
  try {
    for (const entry of await listOutbox()) {
      if (entry.status === 'blocked') {
        await updateOutboxEntry(entry.id, { status: 'queued', nextAttemptAt: 0, lastError: '', progress: 0 });
      }
    }
  } catch {
    // A browser without IndexedDB still uses the direct upload fallback.
  }
}

async function enter(user, { offline = false } = {}) {
  authenticated = true;
  offlineMode = offline;
  $('boot').hidden = $('login').hidden = $('profile-setup').hidden = true;
  showUser(user);
  if (!currentUser) {
    $('upload').hidden = $('gallery').hidden = $('stream').hidden = $('logout').hidden = true;
    $('profile-setup').hidden = false;
    $('profile-input').focus();
    return false;
  }
  $('logout').hidden = false;
  $('admin').hidden = true;
  $('party-code').value = '';
  locallySignedOut = false;
  await setOfflineState('signed-out', false).catch(() => {});
  await setOfflineState('user', currentUser).catch(() => {});
  void requestPersistentStorage();
  if (!offline) {
    await resumeBlockedOutbox();
    void refreshTaskCache().catch(() => {});
  }
  $(galleryPage ? 'gallery' : streamPage ? 'stream' : 'upload').hidden = false;
  if (!galleryPage && !streamPage && selected) showReviewShell();
  if (galleryPage) {
    if (offline) $('gallery-error').textContent = 'Ohne Netz sind nur neue Fotos verfügbar.';
    else await loadGallery(false);
  }
  if (streamPage) {
    if (offline) $('stream-error').textContent = 'Ohne Netz ist der Stream nicht verfügbar.';
    else await loadStream();
  }
  await refreshOutbox();
  if (!offline) scheduleQueueSync();
  return true;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  $('login-submit').disabled = true;
  $('login-submit').textContent = 'Einen Moment …';
  try {
    const result = await api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('party-code').value, device_id: deviceId() }) });
    if (await enter(result.user)) $(galleryPage ? 'refresh' : streamPage ? 'stream-fullscreen' : 'camera').focus();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Dabei sein →'; }
});

async function completeLogout(deleteQueued) {
  if (deleteQueued) await clearOutbox();
  locallySignedOut = true;
  await setOfflineState('signed-out', true).catch(() => {});
  await refreshOutbox();
  closeProfileMenu();
  authenticated = false;
  showLogin();
  try { await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }); } catch {}
}

function beginLogout() {
  if (uploading) return;
  if (!outboxEntries.length) {
    void completeLogout(false);
    return;
  }
  $('logout-pending-text').textContent = `${outboxEntries.length} ${outboxEntries.length === 1 ? 'Foto wartet' : 'Fotos warten'} noch.`;
  $('logout-pending').hidden = false;
}

$('logout').addEventListener('click', beginLogout);
$('logout-keep').addEventListener('click', () => void completeLogout(false));
$('logout-delete').addEventListener('click', () => void completeLogout(true));
$('logout-cancel').addEventListener('click', () => { $('logout-pending').hidden = true; });

$('profile-logout').addEventListener('click', () => $('logout').click());
$('profile-button').addEventListener('click', () => {
  const opening = $('profile-menu').hidden;
  closeQueueMenu();
  $('profile-menu').hidden = !opening;
  $('profile-button').setAttribute('aria-expanded', String(opening));
});
$('queue-button').addEventListener('click', () => {
  if ($('queue-menu').hidden) openQueueMenu();
  else closeQueueMenu();
});
$('local-cache').addEventListener('click', openQueueMenu);
$('queue-detail-close').addEventListener('click', closeQueueDetail);
$('queue-detail-delete').addEventListener('click', () => { $('queue-detail-delete-confirmation').hidden = false; });
$('queue-detail-delete-cancel').addEventListener('click', () => { $('queue-detail-delete-confirmation').hidden = true; });
$('queue-detail-delete-confirm').addEventListener('click', () => {
  if (queueDetailId) void removeQueueEntry(queueDetailId);
});
document.addEventListener('click', (event) => {
  if (!$('profile-control').hidden && !$('profile-control').contains(event.target)) closeProfileMenu();
  if (!$('queue-control').hidden && !$('queue-control').contains(event.target) && !$('local-cache').contains(event.target)) closeQueueMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('queue-detail').hidden) {
    closeQueueDetail();
    return;
  }
  closeProfileMenu();
  closeQueueMenu();
  if (!$('camera-view').hidden) $('close-camera').click();
  else if (!$('review').hidden && !uploading) $('discard').click();
});

$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('profile-error').textContent = '';
  $('profile-submit').disabled = true;
  $('profile-submit').textContent = 'Wird gespeichert …';
  try {
    const result = await api('/api/users/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('profile-input').value }) });
    await enter(result.user);
    $(galleryPage ? 'refresh' : streamPage ? 'stream-fullscreen' : 'camera').focus();
  } catch (error) { $('profile-error').textContent = error.message; }
  finally { $('profile-submit').disabled = false; $('profile-submit').innerHTML = 'Weiter zur Party <span aria-hidden="true">→</span>'; }
});

function closeTaskAdd() {
  $('task-add-form').hidden = true;
  $('task-add-open').hidden = false;
  $('task-add-error').textContent = '';
}

$('task-add-open').addEventListener('click', () => {
  $('task-add-open').hidden = true;
  $('task-add-form').hidden = false;
  $('task-add-status').textContent = '';
  $('task-add-input').focus();
});
$('task-add-cancel').addEventListener('click', closeTaskAdd);
$('task-add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('task-add-error').textContent = '';
  $('task-add-status').textContent = '';
  $('task-add-submit').disabled = true;
  try {
    await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('task-add-input').value }) });
    await refreshTaskCache();
    $('task-add-input').value = '';
    $('task-add-status').textContent = 'Die Aufgabe ist ab jetzt in der Auswahl.';
  } catch (error) { $('task-add-error').textContent = error.message; }
  finally { $('task-add-submit').disabled = false; }
});

function adminReturnPage() {
  return galleryPage ? 'gallery' : streamPage ? 'stream' : 'upload';
}

function adminMetric(label, value) {
  const item = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = String(value);
  item.append(term, description);
  return item;
}

async function hidePhotoFromGallery(photoId, button, messageTarget) {
  if (!currentUser?.is_admin) return;
  if (!window.confirm('Dieses Foto wird nur aus der Galerie ausgeblendet. Die Dateien bleiben im Cloud Bucket erhalten.')) return;
  button.disabled = true;
  try {
    await api(`/api/admin/photos/${photoId}/hide`, { method: 'POST' });
    photos.delete(photoId);
    document.querySelectorAll(`.photo-tile[data-photo-id="${photoId}"]`).forEach((tile) => tile.remove());
    messageTarget.textContent = 'Das Foto ist nicht mehr in der Galerie sichtbar.';
    $('detail-hide').hidden = true;
    if (!$('admin').hidden) await loadAdmin();
  } catch (error) {
    messageTarget.textContent = error.message;
    button.disabled = false;
  }
}

function hotLabel(hot) {
  return hot ? 'Hot-Markierung entfernen' : 'Als Hot markieren';
}

/** Rules a photo hot or out of the rotation. Returns the ruling that now
 *  stands, or the previous one if the call failed. Leaves the button's wording
 *  alone: a caller whose button is a lamp must not have it relabelled. */
async function setPhotoHot(photoId, hot, button, messageTarget) {
  if (!currentUser?.is_admin) return !hot;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/photos/${photoId}/hot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hot }),
    });
    const photo = photos.get(photoId);
    if (photo) photo.hot = result.hot;
    return result.hot;
  } catch (error) {
    messageTarget.textContent = error.message;
    return !hot;
  } finally {
    button.disabled = false;
  }
}

/** Returns whether the photo runs on the wall afterwards, unchanged on failure. */
async function setPhotoOnStream(photoId, shown, button, messageTarget) {
  if (!currentUser?.is_admin) return !shown;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/photos/${photoId}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shown }),
    });
    return result.in_stream;
  } catch (error) {
    messageTarget.textContent = error.message;
    return !shown;
  } finally {
    button.disabled = false;
  }
}

async function updateAdminRole(user, button, status) {
  const desired = !user.is_admin;
  if (!desired && !window.confirm(`Adminrechte für ${user.name} entziehen?`)) return;
  button.disabled = true;
  status.textContent = desired ? 'Adminrechte werden vergeben …' : 'Adminrechte werden entzogen …';
  $('admin-error').textContent = '';
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(user.device_id)}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: desired }),
    });
    if (adminData?.users) {
      adminData.users = adminData.users.map((entry) => entry.device_id === user.device_id
        ? { ...entry, ...result.user, values: entry.values }
        : entry);
      renderAdminUsers(adminData);
    }
  } catch (error) {
    $('admin-error').textContent = error.message;
    status.textContent = 'Die Rolle konnte nicht geändert werden.';
    button.disabled = false;
  }
}

function normalizeAdminSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de');
}

function searchableAdminText(user) {
  const value = [user.name, user.id, user.device_id, ...(user.photos || []).map((photo) => photo.id)]
    .filter(Boolean)
    .join(' ');
  return normalizeAdminSearch(value);
}

function renderAdminUsers(result) {
  const users = $('admin-users');
  const summary = $('admin-summary');
  const query = normalizeAdminSearch(adminQuery);
  const visibleUsers = (result.users || []).filter((user) => searchableAdminText(user).includes(query));
  users.replaceChildren();
  summary.replaceChildren();
  summary.append(
    adminMetric('Gäste', visibleUsers.length),
    adminMetric('Admins', visibleUsers.filter((user) => user.is_admin).length),
    adminMetric('Fotos', visibleUsers.reduce((total, user) => total + (user.photos?.length || 0), 0)),
  );
  summary.hidden = false;
  $('admin-empty').hidden = visibleUsers.length > 0;

  for (const user of visibleUsers) {
    const group = document.createElement('details');
    group.className = 'admin-user';
    const summaryRow = document.createElement('summary');
    summaryRow.className = 'admin-user-summary';
    const identity = document.createElement('div');
    identity.className = 'admin-user-identity';
    const heading = document.createElement('div');
    heading.className = 'admin-user-heading';
    const name = document.createElement('h2');
    name.textContent = user.name;
    heading.append(name);
    if (user.is_admin) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      badge.textContent = 'Admin';
      heading.append(badge);
    }
    const identifiers = document.createElement('p');
    identifiers.className = 'admin-identifiers';
    identifiers.textContent = `${user.id} · ${user.device_id}`;
    identity.append(heading, identifiers);
    const metrics = document.createElement('dl');
    metrics.className = 'admin-user-metrics';
    metrics.append(
      adminMetric('Fotos', user.values?.photos_uploaded || 0),
      adminMetric('Sichtbar', user.values?.photos_visible || 0),
      adminMetric('Ausgeblendet', user.values?.photos_hidden || 0),
    );
    const disclosure = document.createElement('span');
    disclosure.className = 'admin-disclosure';
    disclosure.textContent = `${user.photos?.length || 0} ansehen`;
    summaryRow.append(identity, metrics, disclosure);
    group.append(summaryRow);

    const content = document.createElement('div');
    content.className = 'admin-user-photos';
    const roleActions = document.createElement('div');
    roleActions.className = 'admin-role-actions';
    const roleStatus = document.createElement('span');
    roleStatus.className = 'admin-role-status';
    roleStatus.textContent = user.is_admin ? 'Hat Adminrechte' : 'Gast';
    const roleButton = document.createElement('button');
    roleButton.type = 'button';
    roleButton.className = 'secondary';
    roleButton.textContent = user.is_admin ? 'Adminrechte entziehen' : 'Zum Admin machen';
    roleButton.addEventListener('click', () => updateAdminRole(user, roleButton, roleStatus));
    roleActions.append(roleStatus, roleButton);
    content.append(roleActions);
    if (!user.photos?.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-user-no-photos';
      empty.textContent = 'Noch keine Fotos hochgeladen.';
      content.append(empty);
    } else {
      const previews = document.createElement('div');
      previews.className = 'admin-photo-previews';
      for (const photo of user.photos) {
        const item = document.createElement('div');
        item.className = 'admin-photo-preview';
        const image = document.createElement('img');
        image.src = `/api/photos/${photo.id}/thumb`;
        image.alt = `Vorschau von ${user.name}`;
        image.loading = 'lazy';
        item.append(image);
        if (photo.hidden) {
          const hidden = document.createElement('span');
          hidden.textContent = 'Ausgeblendet';
          item.append(hidden);
        } else {
          const hide = document.createElement('button');
          hide.type = 'button';
          hide.className = 'secondary admin-preview-hide';
          hide.textContent = 'Entfernen';
          hide.setAttribute('aria-label', `Foto von ${user.name} aus der Galerie entfernen`);
          hide.addEventListener('click', () => hidePhotoFromGallery(photo.id, hide, $('admin-error')));
          item.append(hide);
        }
        previews.append(item);
      }
      content.append(previews);
    }
    group.append(content);
    users.append(group);
  }
}

function renderAdminTasks(tasks) {
  const container = $('admin-tasks');
  container.replaceChildren();
  $('admin-tasks-empty').hidden = tasks.length > 0;
  for (const task of tasks) {
    const item = document.createElement('article');
    item.className = 'admin-task';
    const text = document.createElement('textarea');
    text.value = task.text;
    text.maxLength = 500;
    text.rows = 3;
    text.setAttribute('aria-label', 'Foto-Aufgabe bearbeiten');
    const meta = document.createElement('code');
    meta.textContent = task.id;
    const actions = document.createElement('div');
    actions.className = 'admin-task-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'secondary';
    save.textContent = 'Speichern';
    save.addEventListener('click', async () => {
      save.disabled = true;
      $('admin-error').textContent = '';
      try {
        await api(`/api/admin/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.value }) });
        await refreshTaskCache();
        await loadAdminTasks();
      } catch (error) { $('admin-error').textContent = error.message; save.disabled = false; }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Löschen';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Diese Aufgabe wird aus der Auswahl entfernt. Bereits gemachte Fotos behalten ihre gespeicherte Aufgabe.')) return;
      remove.disabled = true;
      $('admin-error').textContent = '';
      try {
        await api(`/api/admin/tasks/${task.id}`, { method: 'DELETE' });
        await refreshTaskCache();
        await loadAdminTasks();
      } catch (error) { $('admin-error').textContent = error.message; remove.disabled = false; }
    });
    actions.append(save, remove);
    item.append(text, meta, actions);
    container.append(item);
  }
}

async function loadAdminTasks() {
  if (!currentUser?.is_admin) return;
  $('admin-error').textContent = '';
  $('admin-tasks-status').textContent = 'Aufgaben werden geladen …';
  try {
    const result = await api('/api/admin/tasks');
    adminTasks = result.tasks || [];
    renderAdminTasks(adminTasks);
    $('admin-tasks-status').textContent = `${adminTasks.length} ${adminTasks.length === 1 ? 'Aufgabe' : 'Aufgaben'} verfügbar`;
  } catch (error) {
    $('admin-error').textContent = error.message;
    $('admin-tasks-status').textContent = 'Die Aufgaben konnten nicht geladen werden.';
  }
}

// Every tile stays reachable after it is drawn, so a click can relight it where
// it sits instead of rebuilding the grid. Rebuilding would re-sort, and a photo
// jumping away from under the finger that just tapped it is the opposite of
// what a wall of two hundred photos needs.
const adminTiles = new Map();

function adminGridTile(photo) {
  const tile = document.createElement('div');
  fillPhotoTile(tile, photo);
  tile.classList.add('has-tile-actions');

  const actions = document.createElement('div');
  actions.className = 'photo-tile-actions';
  const who = photo.author?.name ? `Foto von ${photo.author.name}` : 'Foto';

  const hot = document.createElement('button');
  hot.type = 'button';
  hot.className = 'tile-action';
  hot.textContent = '🔥 Hot';
  hot.addEventListener('click', async () => {
    // The lamp already says what the wall is doing, votes included, so the
    // press simply asks for the opposite. The lamp flips at once and the list
    // is refreshed behind it, because one ruling can change another photo's
    // standing.
    const wanted = !photo.hot;
    photo.hot = wanted;
    refreshAdminStream();
    await setPhotoHot(photo.id, wanted, hot, $('admin-stream-status'));
    await reconcileAdminStream();
  });

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'tile-action';
  hide.textContent = 'Verstecken';
  hide.addEventListener('click', async () => {
    const onWall = photo.in_stream !== false;
    photo.in_stream = !onWall;
    refreshAdminStream();
    await setPhotoOnStream(photo.id, !onWall, hide, $('admin-stream-status'));
    await reconcileAdminStream();
  });

  actions.append(hot, hide);
  tile.append(actions);
  adminTiles.set(photo.id, { tile, hot, hide, photo, who });
  return tile;
}

/** Fetch the settled answer and relight, without touching the grid itself.
 *  One ruling can change another photo's standing -- a hand-picked hot photo
 *  adds to the count, and taking one off the wall frees a place -- so the list
 *  is refreshed after every action. Only the lamps move; the tiles do not. */
async function reconcileAdminStream() {
  if (!currentUser?.is_admin) return;
  try {
    const result = await api('/api/admin/photos');
    const fresh = new Map((result.photos || []).map((photo) => [photo.id, photo]));
    for (const photo of adminStreamPhotos) {
      const settled = fresh.get(photo.id);
      if (!settled) continue;
      photo.hot = settled.hot;
      photo.in_stream = settled.in_stream;
    }
    refreshAdminStream();
  } catch {
    // The lamps already show what was asked for; the next open settles them.
  }
}

/** Relight every tile and redo the counts from the list already in memory.
 *  Nothing is fetched, nothing is re-sorted, nothing moves. */
function refreshAdminStream() {
  const running = adminStreamPhotos.filter((photo) => photo.in_stream !== false);
  for (const { tile, hot, hide, photo, who } of adminTiles.values()) {
    const isHot = Boolean(photo.hot);
    const onWall = photo.in_stream !== false;
    hot.classList.toggle('is-on', isHot);
    hot.setAttribute('aria-pressed', String(isHot));
    hot.setAttribute('aria-label', `${who}: ${hotLabel(isHot)}`);
    hide.classList.toggle('is-off', !onWall);
    hide.setAttribute('aria-pressed', String(!onWall));
    hide.setAttribute('aria-label', onWall
      ? `${who}: vom Stream verstecken`
      : `${who}: wieder im Stream zeigen`);
    tile.classList.toggle('is-off-stream', !onWall);
  }
  $('admin-stream-summary').hidden = false;
  $('admin-stream-summary').replaceChildren(
    adminMetric('Fotos im Stream', running.length),
    adminMetric('Hot', adminStreamPhotos.filter((photo) => photo.hot).length),
  );
}

function adminStreamMatches(photo, query) {
  if (!query) return true;
  // The same words the gallery search understands, "hot" included.
  const haystack = [
    photo.author?.name || '',
    photo.task?.text || '',
    photo.hot ? 'hot' : '',
    photo.in_stream === false ? 'versteckt' : '',
  ].join(' ').toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function renderAdminStream(list) {
  // Newest first, exactly as the gallery orders itself. The order is fixed for
  // as long as the panel is open: sorting hot photos to the front would shuffle
  // the grid under the reader every time one was marked.
  const query = adminStreamQuery.trim().toLowerCase();
  const shown = list
    .filter((photo) => adminStreamMatches(photo, query))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  $('admin-stream-none').hidden = shown.length > 0;
  adminTiles.clear();
  $('admin-stream-all').replaceChildren(...shown.map(adminGridTile));
  refreshAdminStream();
}

async function loadAdminStream() {
  if (!currentUser?.is_admin) return;
  $('admin-error').textContent = '';
  $('admin-stream-status').textContent = 'Stream wird gelesen …';
  try {
    // Not the wall's own list: that one leaves out whatever was taken off it,
    // and an admin has to see a photo in order to put it back.
    const result = await api('/api/admin/photos');
    const list = result.photos || [];
    adminStreamPhotos = list;
    renderAdminStream(list);
    $('admin-stream-status').textContent = list.length
      ? 'Änderungen erscheinen innerhalb weniger Sekunden auf allen Bildschirmen.'
      : 'Noch keine Fotos in der Galerie.';
  } catch (error) {
    $('admin-error').textContent = error.message;
    $('admin-stream-status').textContent = 'Der Stream konnte nicht gelesen werden.';
  }
}

const ADMIN_TABS = ['users', 'stream', 'tasks'];

async function setAdminTab(tab) {
  adminTab = ADMIN_TABS.includes(tab) ? tab : 'users';
  // Whatever went wrong belonged to the pane being left, so it must not follow
  // the reader into the next one.
  $('admin-error').textContent = '';
  for (const name of ADMIN_TABS) {
    $(`admin-${name}-tab`).setAttribute('aria-selected', String(name === adminTab));
    $(`admin-${name}-pane`).hidden = name !== adminTab;
  }
  if (adminTab === 'tasks') await loadAdminTasks();
  if (adminTab === 'stream') await loadAdminStream();
}

async function loadAdmin() {
  if (!currentUser?.is_admin) return;
  $('admin-error').textContent = '';
  $('admin-status').textContent = 'Daten werden geladen …';
  try {
    const result = await api('/api/admin/overview');
    adminData = result;
    renderAdminUsers(result);
    $('admin-status').textContent = `${result.values?.users || 0} ${result.values?.users === 1 ? 'Person' : 'Personen'} · ${result.values?.photos || 0} Fotos`;
  } catch (error) {
    $('admin-error').textContent = error.message;
    $('admin-status').textContent = 'Die Verwaltung konnte nicht geladen werden.';
  }
}

$('admin-stream-search').addEventListener('input', () => {
  clearTimeout(adminStreamSearchTimer);
  adminStreamSearchTimer = setTimeout(() => {
    adminStreamQuery = $('admin-stream-search').value;
    if (adminStreamPhotos.length) renderAdminStream(adminStreamPhotos);
  }, 180);
});

$('admin-search').addEventListener('input', () => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    adminQuery = $('admin-search').value.trim();
    if (adminData) renderAdminUsers(adminData);
  }, 180);
});

for (const name of ADMIN_TABS) {
  $(`admin-${name}-tab`).addEventListener('click', () => setAdminTab(name));
}
$('admin-task-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('admin-error').textContent = '';
  $('admin-task-create-submit').disabled = true;
  try {
    await api('/api/admin/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('admin-task-create-input').value }) });
    $('admin-task-create-input').value = '';
    await refreshTaskCache();
    await loadAdminTasks();
  } catch (error) { $('admin-error').textContent = error.message; }
  finally { $('admin-task-create-submit').disabled = false; }
});

$('admin-open').addEventListener('click', async () => {
  closeProfileMenu();
  $('upload').hidden = $('gallery').hidden = $('stream').hidden = true;
  stopStream();
  $('admin').hidden = false;
  // The heading carries the party totals on every tab, so the overview is
  // always fetched, not only when the guest list happens to be open.
  await Promise.all([setAdminTab(adminTab), loadAdmin()]);
  $(adminTab === 'users' ? 'admin-back' : `admin-${adminTab}-tab`).focus();
});
$('admin-back').addEventListener('click', async () => {
  $('admin').hidden = true;
  $(adminReturnPage()).hidden = false;
  if (galleryPage) await loadGallery(false);
  if (streamPage) await loadStream();
  $('profile-button').focus();
});

$('camera').addEventListener('click', () => { clearChallenge(false); openCamera(cameraFacing); });
$('library').addEventListener('click', () => { clearChallenge(false); $('library-input').click(); });
$('challenge-draw').addEventListener('click', drawChallenge);
$('challenge-again').addEventListener('click', drawChallenge);
$('challenge-camera').addEventListener('click', () => openCamera(cameraFacing));
$('challenge-library').addEventListener('click', () => $('library-input').click());
$('challenge-cancel').addEventListener('click', () => { clearChallenge(true); $('camera').focus(); });
$('camera-fallback').addEventListener('click', () => $('camera-input').click());
$('close-camera').addEventListener('click', () => {
  stopCamera(true);
  $(currentTask ? 'challenge-camera' : 'camera').focus();
});
$('switch-camera').addEventListener('click', () => {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  cameraTorchOn = false;
  openCamera(cameraFacing);
});
$('shutter').addEventListener('click', captureCameraPhoto);
for (const id of ['camera-input', 'library-input']) {
  $(id).addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) {
      if (id === 'camera-input') stopCamera(false);
      selectPhoto(file, id === 'camera-input' ? 'fallback' : 'library');
    }
  });
}

function resetMovableTask(card, restore) {
  card.style.removeProperty('left');
  card.style.removeProperty('top');
  card.style.removeProperty('transform');
  card.hidden = !currentTask;
  restore.hidden = true;
}

function syncTaskOverlay(cardId, textId, restoreId) {
  const card = $(cardId);
  $(textId).textContent = currentTask?.text || '';
  resetMovableTask(card, $(restoreId));
}

function setupMovableTask(cardId, restoreId, hideId) {
  const card = $(cardId);
  const restore = $(restoreId);
  const hide = () => {
    card.hidden = true;
    restore.hidden = !currentTask;
    restore.focus();
  };
  $(hideId).addEventListener('click', hide);
  restore.addEventListener('click', () => {
    resetMovableTask(card, restore);
    card.focus({ preventScroll: true });
  });
  card.tabIndex = 0;
  card.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || event.button !== 0) return;
    const rect = card.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    card.setPointerCapture(event.pointerId);
    card.classList.add('is-dragging');
    card.style.transform = 'none';
    const move = (moveEvent) => {
      card.style.left = `${moveEvent.clientX - offsetX}px`;
      card.style.top = `${moveEvent.clientY - offsetY}px`;
    };
    const finish = () => {
      card.classList.remove('is-dragging');
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', finish);
      card.removeEventListener('pointercancel', finish);
      const after = card.getBoundingClientRect();
      const almostOutside = after.right < 48 || after.left > innerWidth - 48 || after.bottom < 48 || after.top > innerHeight - 48;
      if (almostOutside) hide();
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
  });
}

setupMovableTask('camera-task', 'camera-task-restore', 'camera-task-hide');
setupMovableTask('active-task', 'preview-task-restore', 'preview-task-hide');

function setCaptureAccessibility(activeId = null) {
  const active = Boolean(activeId);
  document.querySelector('.topbar').inert = active;
  $('main').inert = active;
  document.querySelector('footer').inert = active;
  $('capture-root').inert = !active;
}

function stopCamera(showPicker) {
  cameraGeneration++;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $('camera-video').srcObject = null;
  $('camera-view').hidden = true;
  $('camera-view').classList.remove('screen-flash-on');
  document.body.classList.remove('camera-open');
  setCaptureAccessibility();
  scheduleCaptureFullscreenExit();
  cameraTorchOn = false;
  $('camera-torch').setAttribute('aria-pressed', 'false');
  $('camera-torch').setAttribute('aria-label', 'Blitz einschalten');
  $('shutter').disabled = true;
  $('switch-camera').hidden = true;
  $('camera-fallback').hidden = true;
  if (showPicker) {
    $('challenge').hidden = false;
    $('pick-actions').hidden = Boolean(currentTask);
    $('free-divider').hidden = Boolean(currentTask);
  }
}

function clearChallenge(showPicker) {
  currentTask = null;
  $('challenge-text').textContent = '';
  $('challenge-error').textContent = '';
  $('challenge-panel').hidden = true;
  $('challenge-draw').hidden = false;
  $('active-task').hidden = true;
  if (showPicker) {
    $('pick-actions').hidden = false;
    $('free-divider').hidden = false;
  }
}

async function drawChallenge() {
  if (taskBusy) return;
  taskBusy = true;
  const previous = currentTask?.id;
  $('challenge-error').textContent = '';
  $('challenge-draw').disabled = $('challenge-again').disabled = true;
  $('challenge-draw').querySelector('strong').textContent = 'Aufgabe wird gezogen …';
  $('challenge-again').textContent = 'Einen Moment …';
  try {
    if (!cachedTasks.length && !offlineMode) await refreshTaskCache();
    currentTask = nextCachedTask(previous);
    if (!currentTask) throw new Error('Gerade ist keine Foto-Aufgabe verfügbar.');
    $('challenge-text').textContent = currentTask.text;
    $('challenge-draw').hidden = true;
    $('challenge-panel').hidden = false;
    $('pick-actions').hidden = true;
    $('free-divider').hidden = true;
    $('challenge-camera').focus();
  } catch (error) {
    $('challenge-error').textContent = error.message;
  } finally {
    taskBusy = false;
    $('challenge-draw').disabled = $('challenge-again').disabled = false;
    $('challenge-draw').querySelector('strong').textContent = 'Aufgabe ziehen';
    $('challenge-again').textContent = 'Andere Aufgabe';
  }
}

function cameraErrorMessage(error) {
  if (!isSecureContext) return 'Die Live-Kamera benötigt eine sichere HTTPS-Verbindung.';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Der Kamerazugriff wurde nicht erlaubt. Erlaube ihn in den Browser-Einstellungen oder nutze die Gerätekamera unten.';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'Auf diesem Gerät wurde keine passende Kamera gefunden.';
  if (error?.name === 'NotReadableError' || error?.name === 'AbortError') return 'Die Kamera wird gerade von einer anderen App verwendet oder konnte nicht gestartet werden.';
  return 'Die Live-Kamera ist in diesem Browser nicht verfügbar. Du kannst stattdessen die Gerätekamera oder eine Datei öffnen.';
}

async function openCamera(facing) {
  stopCamera(false);
  const generation = cameraGeneration;
  document.body.classList.remove('review-open');
  document.body.classList.add('camera-open');
  setCaptureAccessibility('camera-view');
  $('review').hidden = true;
  $('pick-actions').hidden = true;
  $('free-divider').hidden = true;
  $('challenge').hidden = !currentTask;
  $('camera-view').hidden = false;
  $('camera-view').dataset.facing = facing;
  enterCaptureFullscreen();
  syncTaskOverlay('camera-task', 'camera-task-text', 'camera-task-restore');
  $('camera-video').hidden = true;
  $('camera-status').textContent = 'Kamera wird geöffnet …';
  $('camera-fallback').hidden = true;
  $('shutter').disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('getUserMedia unavailable', 'NotSupportedError');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (generation !== cameraGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    $('camera-video').srcObject = stream;
    $('camera-video').hidden = false;
    await $('camera-video').play();
    $('camera-status').textContent = 'Richte die Kamera aus und löse das Foto aus.';
    $('shutter').disabled = false;
    // Phones routinely report a single video input even when they have a front
    // and a rear lens, which hid this button on exactly the devices that need
    // it. A coarse pointer is taken as evidence of a handheld camera pair, and
    // switching is safe either way: facingMode is an ideal, so the worst case
    // is the same lens coming back.
    const track = stream.getVideoTracks()[0];
    const reportedFacing = track?.getSettings?.().facingMode;
    const resolvedFacing = facing === 'user'
      ? 'user'
      : ['user', 'environment'].includes(reportedFacing)
        ? reportedFacing
        : facing;
    $('camera-view').dataset.facing = resolvedFacing;
    // The front camera always gets a display light. Rear-camera flash is only
    // offered when the browser exposes a hardware torch.
    const torchCapable = Boolean(track?.getCapabilities?.().torch);
    const screenFlashCapable = resolvedFacing === 'user';
    cameraTorchOn = false;
    $('camera-view').classList.remove('screen-flash-on');
    $('camera-torch').hidden = !screenFlashCapable && !torchCapable;
    $('camera-torch').setAttribute('aria-pressed', 'false');
    $('camera-torch').setAttribute('aria-label', screenFlashCapable
      ? 'Display-Blitz einschalten'
      : 'Blitz einschalten');
    const handheld = handheldPointer;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === 'videoinput').length;
      $('switch-camera').hidden = cameras < 2 && !handheld;
    } catch {
      $('switch-camera').hidden = !handheld;
    }
    $('shutter').focus();
  } catch (error) {
    if (generation !== cameraGeneration) return;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    $('camera-video').srcObject = null;
    $('camera-video').hidden = true;
    $('camera-status').textContent = cameraErrorMessage(error);
    $('camera-fallback').hidden = false;
    $('camera-fallback').focus();
  }
}

async function captureCameraPhoto() {
  const video = $('camera-video');
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!cameraStream || !width || !height) {
    $('camera-status').textContent = 'Die Kamera ist noch nicht bereit. Bitte einen Moment warten.';
    return;
  }
  if (width * height > 64_000_000) {
    $('camera-status').textContent = 'Die Kameraaufnahme hat mehr als 64 Megapixel und kann nicht gespeichert werden.';
    return;
  }
  $('shutter').disabled = true;
  $('camera-status').textContent = 'Aufnahme wird vorbereitet …';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  // The front-camera mirror is a viewfinder-only CSS transform. Drawing the
  // raw stream keeps the saved photo unmirrored, matching native phone cameras.
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  if (!blob) {
    $('camera-status').textContent = 'Das Foto konnte nicht erstellt werden. Bitte erneut versuchen.';
    $('shutter').disabled = false;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([blob], `aufnahme-${stamp}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  const mirrored = $('camera-view').dataset.facing === 'user';
  stopCamera(false);
  await selectPhoto(file, 'camera', mirrored);
}

function clearSelection() {
  previewGeneration++;
  selected = null;
  selectedBytes = null;
  directServerPhotoId = null;
  selectedTask = null;
  selectedUploadMetadata = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewMirrored = false;
  selectionSource = null;
  document.body.classList.remove('review-open');
  setCaptureAccessibility();
  scheduleCaptureFullscreenExit();
  $('preview').removeAttribute('src');
  $('preview').classList.remove('is-mirrored');
  $('preview').hidden = $('review').hidden = $('success').hidden = $('progress-wrap').hidden = true;
  $('challenge').hidden = false;
  $('challenge-draw').hidden = Boolean(currentTask);
  $('challenge-panel').hidden = !currentTask;
  $('active-task').hidden = true;
  $('preview-task-restore').hidden = true;
  $('pick-actions').hidden = Boolean(currentTask);
  $('free-divider').hidden = Boolean(currentTask);
  $('upload-error').textContent = '';
  $('send').disabled = true;
  $('send').textContent = 'Foto hochladen';
}

function showReviewShell() {
  captureFullscreenWanted = true;
  document.body.classList.remove('camera-open');
  document.body.classList.add('review-open');
  setCaptureAccessibility('review');
  $('challenge').hidden = true;
  $('pick-actions').hidden = true;
  $('free-divider').hidden = true;
  $('review').hidden = false;
  syncTaskOverlay('active-task', 'active-task-text', 'preview-task-restore');
  const returnsToCamera = selectionSource === 'camera';
  $('discard').setAttribute('aria-label', returnsToCamera ? 'Zurück zur Kamera' : 'Vorschau schließen');
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Bildvorschau nicht verfügbar.'));
    image.src = url;
  });
}

let heicModule;
async function convertHeic(file) {
  heicModule ||= import('/static/vendor/heic-to.js');
  const module = await heicModule;
  return module.heicTo({ blob: file, type: 'image/jpeg', quality: 0.75 });
}

async function selectPhoto(file, source = 'library', mirrored = false) {
  clearSelection();
  selectionSource = source;
  showReviewShell();
  const generation = previewGeneration;
  if (file.size > MAX_BYTES) { $('upload-error').textContent = 'Dieses Foto ist größer als 25 MiB. Bitte ein anderes wählen.'; return; }
  if (!file.size) { $('upload-error').textContent = 'Die Datei ist leer. Bitte ein anderes Foto wählen.'; return; }
  selected = file;
  previewMirrored = mirrored;
  selectedTask = currentTask ? { id: currentTask.id, text: currentTask.text, task_token: currentTask.task_token } : null;
  selectedUploadMetadata = {
    source,
    captured_at: Date.now(),
    queued_at: Date.now(),
    ...(selectedTask?.id ? { task_id: selectedTask.id } : {}),
  };
  const bytesPromise = blobBytes(file);
  let url = URL.createObjectURL(file);
  try {
    const bytes = await bytesPromise;
    if (generation !== previewGeneration) { URL.revokeObjectURL(url); return; }
    selectedBytes = bytes;
    let image;
    try { image = await decodeImage(url); }
    catch {
      if (!/heic|heif/i.test(file.type + file.name)) throw new Error('Dieses Bild lässt sich nicht anzeigen. Bitte ein JPEG-, PNG-, WebP- oder HEIC-Foto wählen.');
      URL.revokeObjectURL(url);
      const converted = await convertHeic(file);
      url = URL.createObjectURL(converted);
      image = await decodeImage(url);
    }
    if (generation !== previewGeneration) { URL.revokeObjectURL(url); return; }
    if (image.naturalWidth * image.naturalHeight > 64_000_000) throw new Error('Dieses Foto hat mehr als 64 Megapixel. Bitte ein anderes wählen.');
    previewUrl = url;
    $('preview').src = url;
    $('preview').classList.toggle('is-mirrored', previewMirrored);
    $('preview').hidden = false;
    $('send').disabled = false;
    updateSendAction();
    $('send').focus();
  } catch (error) {
    URL.revokeObjectURL(url);
    if (generation !== previewGeneration) return;
    $('upload-error').textContent = error.message || 'Die Vorschau konnte nicht erstellt werden. Bitte ein anderes Foto wählen.';
  }
}

$('discard').addEventListener('click', () => {
  const reopenCamera = selectionSource === 'camera';
  const focusTarget = currentTask ? 'challenge-camera' : 'camera';
  clearSelection();
  if (reopenCamera) openCamera(cameraFacing);
  else $(focusTarget).focus();
});
$('another').addEventListener('click', () => { clearSelection(); $('camera').focus(); });

function sendPhoto(file, id, task, clientMetadata, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/photos');
    xhr.timeout = 300000;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (id) xhr.setRequestHeader('X-FotoVibe-Upload-ID', id);
    if (task?.task_token) xhr.setRequestHeader('X-FotoVibe-Task-Token', task.task_token);
    else if (task?.id) xhr.setRequestHeader('X-FotoVibe-Task-ID', task.id);
    if (clientMetadata) xhr.setRequestHeader('X-FotoVibe-Client-Metadata', JSON.stringify(clientMetadata));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const value = Math.round(event.loaded / event.total * 100);
      void onProgress(value);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve({ created: xhr.status === 201 }); return; }
      let message = 'Upload fehlgeschlagen. Du kannst es mit demselben Foto erneut versuchen.';
      try { const result = JSON.parse(xhr.responseText); if (typeof result.detail === 'string') message = result.detail; } catch {}
      const error = new Error(message);
      error.status = xhr.status;
      const retryAfter = retryAfterMilliseconds(xhr.getResponseHeader('Retry-After'));
      if (retryAfter) error.retryAfter = retryAfter;
      reject(error);
    };
    xhr.onerror = () => {
      const error = new Error('Die Verbindung wurde unterbrochen.');
      error.network = true;
      reject(error);
    };
    xhr.ontimeout = () => {
      const error = new Error('Die Übertragung dauert zu lange.');
      error.network = true;
      reject(error);
    };
    // Sending the Blob as the request body avoids Safari's inconsistent
    // multipart serialization for Blobs restored from IndexedDB.
    xhr.send(file);
  });
}

$('send').addEventListener('click', async () => {
  if (!selected || uploading) return;
  const queuedOffline = navigator.onLine === false;
  uploading = true;
  $('send').disabled = $('discard').disabled = $('logout').disabled = true;
  $('send').textContent = 'Wird gespeichert …';
  $('upload-error').textContent = '';
  try {
    await queueSelectedPhoto();
    clearSelection();
    clearChallenge(queuedOffline);
    if (queuedOffline) {
      showQueueNotice(outboxEntries.length);
      $('camera').focus();
    } else {
      $('challenge').hidden = true;
      $('free-divider').hidden = true;
      $('pick-actions').hidden = true;
      $('success').hidden = false;
      setSuccessStatus('Wird geteilt', '↑');
      $('another').focus();
    }
    scheduleQueueSync();
  } catch (error) {
    if (navigator.onLine !== false) {
      $('progress-wrap').hidden = false;
      $('progress').value = 0;
      $('progress-text').textContent = 'Foto wird übertragen …';
      try {
        directServerPhotoId ||= crypto.randomUUID();
        const result = await sendPhoto(
          selected,
          directServerPhotoId,
          selectedTask,
          selectedUploadMetadata,
          (value) => {
            $('progress').value = value;
            $('progress-text').textContent = value < 100 ? `Foto wird übertragen: ${value} %` : 'Foto wird gespeichert …';
          },
        );
        if (result.created && currentUser?.values) {
          showUser({ ...currentUser, values: { ...currentUser.values, photos_uploaded: (currentUser.values.photos_uploaded || 0) + 1 } });
          void setOfflineState('user', currentUser);
        }
        lastQueuedId = null;
        clearSelection();
        clearChallenge(false);
        $('challenge').hidden = true;
        $('free-divider').hidden = true;
        $('pick-actions').hidden = true;
        $('success').hidden = false;
        setSuccessStatus('Geteilt', '✓');
        $('another').focus();
      } catch (uploadError) {
        $('upload-error').textContent = uploadError.message;
        $('progress-wrap').hidden = true;
        $('send').disabled = false;
        $('send').textContent = 'Erneut hochladen ↑';
      }
    } else {
      $('upload-error').textContent = error.message;
      $('send').disabled = false;
      $('send').textContent = 'Erneut speichern ↑';
    }
  } finally {
    uploading = false;
    $('discard').disabled = $('logout').disabled = false;
  }
});

window.addEventListener('pagehide', () => stopCamera(false));

const REACTION_EMOJIS = ['❤️', '😂', '😍', '👏', '🔥'];
const pendingReactions = new Set();

function reactionSummaryText(interactions) {
  const reactions = Array.isArray(interactions?.reactions) ? interactions.reactions : [];
  const reactionText = reactions
    .filter((reaction) => reaction?.emoji && Number(reaction.count) > 0)
    .map((reaction) => `${reaction.emoji} ${reaction.count}`)
    .join(' ');
  const comments = Number(interactions?.comments_count) || 0;
  return [reactionText, comments ? `💬 ${comments}` : ''].filter(Boolean).join(' · ');
}

function renderTileInteractions(tile, interactions) {
  const text = reactionSummaryText(interactions);
  const current = tile.querySelector('.photo-interaction-summary');
  if (!text) {
    current?.remove();
    return;
  }
  const summary = current || document.createElement('span');
  summary.className = 'photo-interaction-summary';
  summary.textContent = text;
  if (!current) {
    const meta = tile.querySelector('.photo-tile-meta');
    (meta || tile).append(summary);
  }
}

function updatePhotoInteractions(photoId, interactions) {
  const photo = photos.get(photoId);
  if (photo) {
    photo.interactions = {
      reactions: interactions.reactions || [],
      comments_count: interactions.comments_count || 0,
    };
  }
  document.querySelectorAll(`.photo-tile[data-photo-id="${photoId}"]`).forEach((tile) => {
    renderTileInteractions(tile, interactions);
  });
}

function commentDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('de', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function renderDetailInteractions(interactions) {
  const mine = new Set(interactions.mine || []);
  const options = $('detail-reaction-options');
  const counts = $('detail-reaction-counts');
  const comments = $('detail-comments');
  options.replaceChildren();
  for (const emoji of REACTION_EMOJIS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-button';
    button.textContent = emoji;
    button.title = `Mit ${emoji} reagieren`;
    button.setAttribute('aria-label', mine.has(emoji) ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`);
    button.setAttribute('aria-pressed', String(mine.has(emoji)));
    if (mine.has(emoji)) button.title = `Du hast mit ${emoji} reagiert`;
    button.addEventListener('click', async () => {
      if (!activeDetailPhoto) return;
      const photoId = activeDetailPhoto.id;
      const reactionKey = `${photoId}:${emoji}`;
      if (pendingReactions.has(reactionKey)) return;
      const active = !mine.has(emoji);
      pendingReactions.add(reactionKey);
      button.setAttribute('aria-pressed', String(active));
      button.title = active ? `Du hast mit ${emoji} reagiert` : `Mit ${emoji} reagieren`;
      button.setAttribute('aria-label', active ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`);
      try {
        const result = await api(`/api/photos/${photoId}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji, active }),
        });
        if (activeDetailPhoto?.id === photoId) {
          updatePhotoInteractions(photoId, result);
          renderDetailInteractions(result);
        }
      } catch (error) {
        $('detail-comment-error').textContent = error.message;
        button.setAttribute('aria-pressed', String(!active));
        button.title = !active ? `Du hast mit ${emoji} reagiert` : `Mit ${emoji} reagieren`;
        button.setAttribute('aria-label', !active ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`);
      } finally {
        pendingReactions.delete(reactionKey);
      }
    });
    options.append(button);
  }
  const reactionText = reactionSummaryText(interactions);
  counts.textContent = reactionText || 'Noch keine Reaktionen.';
  comments.replaceChildren();
  const entries = Array.isArray(interactions.comments) ? interactions.comments : [];
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'comment-empty';
    empty.textContent = 'Noch keine Kommentare.';
    comments.append(empty);
    return;
  }
  for (const comment of entries) {
    const item = document.createElement('article');
    item.className = 'comment';
    const metadata = document.createElement('p');
    metadata.className = 'comment-meta';
    metadata.textContent = `${comment.author?.name || 'Gast'}${commentDate(comment.created_at) ? ` · ${commentDate(comment.created_at)}` : ''}`;
    const text = document.createElement('p');
    text.textContent = comment.text || '';
    item.append(metadata, text);
    comments.append(item);
  }
}

async function loadDetailInteractions(photoId) {
  $('detail-reaction-counts').textContent = 'Reaktionen werden geladen …';
  $('detail-comments').replaceChildren();
  try {
    const interactions = await api(`/api/photos/${photoId}/interactions`);
    if (activeDetailPhoto?.id !== photoId) return;
    updatePhotoInteractions(photoId, interactions);
    renderDetailInteractions(interactions);
  } catch (error) {
    if (activeDetailPhoto?.id === photoId) {
      $('detail-reaction-counts').textContent = 'Reaktionen konnten nicht geladen werden.';
      $('detail-comment-error').textContent = error.message;
    }
  }
}

/** Fill any element with the gallery tile's contents. The admin panel needs the
 * very same tile on a plain element, because it puts its own buttons on top and
 * a button may not contain buttons. */
function fillPhotoTile(element, photo) {
  element.className = 'photo-tile';
  element.dataset.photoId = photo.id;
  const width = Number(photo.width);
  const height = Number(photo.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    element.style.setProperty('--gallery-photo-ratio', `${width} / ${height}`);
    element.classList.add(width > height ? 'is-landscape' : width < height ? 'is-portrait' : 'is-square');
  } else {
    element.classList.add('is-portrait');
  }
  const date = new Date(photo.created_at).toLocaleString('de', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const task = photo.task || photo.metadata?.task;
  const author = photo.author || photo.metadata?.author;
  const image = document.createElement('img');
  image.src = `/api/photos/${photo.id}/thumb`;
  image.alt = `Partyfoto vom ${date}`;
  image.loading = 'lazy';
  image.decoding = 'async';
  if (task?.text) {
    const label = document.createElement('span');
    label.className = 'photo-task-label';
    label.textContent = task.text;
    element.append(label);
  }
  element.append(image);
  const meta = document.createElement('div');
  meta.className = 'photo-tile-meta';
  if (author?.name) {
    const credit = document.createElement('span');
    credit.className = 'photo-author-label';
    credit.textContent = author.name;
    meta.append(credit);
  }
  element.append(meta);
  renderTileInteractions(element, photo.interactions);
  return { date, task, author };
}

function photoButton(photo) {
  const button = document.createElement('button');
  button.type = 'button';
  const { date, task, author } = fillPhotoTile(button, photo);
  const authorText = author?.name ? ` Hochgeladen von ${author.name}.` : '';
  button.setAttribute('aria-label', task ? `Foto vom ${date} öffnen.${authorText} Aufgabe: ${task.text}` : `Foto vom ${date} öffnen.${authorText}`);
  button.addEventListener('click', () => {
    activeDetailPhoto = photo;
    detailButton = button;
    scrollPosition = window.scrollY;
    $('gallery-overview').hidden = true;
    $('photo-detail').hidden = false;
    $('detail-status').textContent = 'Foto wird geladen …';
    $('detail-image').onload = () => { $('detail-status').textContent = ''; };
    $('detail-image').onerror = () => { $('detail-status').textContent = 'Foto nicht erreichbar. Bitte die Galerie aktualisieren oder neu anmelden.'; };
    $('detail-image').src = `/api/photos/${photo.id}/display`;
    $('detail-image').alt = `Partyfoto vom ${date}`;
    $('detail-author').hidden = !author?.name;
    $('detail-author').textContent = author?.name ? `Hochgeladen von ${author.name}` : '';
    $('detail-task').hidden = !task?.text;
    $('detail-task-text').textContent = task?.text || '';
    $('download').href = `/api/photos/${photo.id}/original`;
    $('detail-hide').hidden = !currentUser?.is_admin;
    $('detail-hide').onclick = () => hidePhotoFromGallery(photo.id, $('detail-hide'), $('detail-status'));
    // Here the button carries words rather than a lamp, so it says what the
    // next press will do and reports the outcome.
    let hot = photo.hot === true;
    $('detail-pin').hidden = !currentUser?.is_admin;
    $('detail-pin').textContent = hotLabel(hot);
    $('detail-pin').setAttribute('aria-pressed', String(hot));
    $('detail-pin').onclick = async () => {
      hot = await setPhotoHot(photo.id, !hot, $('detail-pin'), $('detail-status'));
      $('detail-pin').textContent = hotLabel(hot);
      $('detail-pin').setAttribute('aria-pressed', String(hot));
      $('detail-status').textContent = hot
        ? 'Das Foto läuft jetzt als Hot im Stream.'
        : 'Das Foto ist nicht mehr als Hot markiert.';
    };
    $('detail-comment-input').value = '';
    $('detail-comment-error').textContent = '';
    void loadDetailInteractions(photo.id);
    window.scrollTo(0, 0);
    $('back-to-grid').focus();
  });
  return button;
}

function streamHighlights(list) {
  // The server decides what is hot, from the admins' rulings and the party's
  // reactions together, and every screen reads the same answer. Doing it here
  // as well would be a second copy of the rule, free to drift from the one the
  // gallery search uses.
  return list
    .filter((photo) => photo.hot)
    .map((photo) => ({ ...photo, highlight: 'hot' }));
}

function streamPlaylistFrom(list) {
  if (!list.length) return [];
  // The server sends newest first. Alternating the freshest photos with a walk
  // through the whole list gives new uploads a visible head start while every
  // photo keeps coming back around.
  const fresh = list.slice(0, Math.min(STREAM_FRESH, list.length));
  const rotation = [];
  for (let i = 0; i < Math.max(list.length, fresh.length); i += 1) {
    rotation.push(fresh[i % fresh.length]);
    rotation.push(list[i % list.length]);
  }
  // The same picture twice in a row reads as a frozen screen.
  const ordinary = rotation.filter((photo, index) => index === 0 || photo.id !== rotation[index - 1].id);
  const highlights = streamHighlights(list);
  if (!highlights.length) return ordinary;
  const playlist = [];
  let next = 0;
  for (let i = 0; i < ordinary.length; i += 1) {
    playlist.push(ordinary[i]);
    if ((i + 1) % STREAM_HIGHLIGHT_EVERY) continue;
    // The corridor holds a dozen photos at once, so a highlight must not repeat
    // a picture that is already somewhere on the screen: the same photo twice,
    // one of them in flames, reads as a fault rather than as an honour. The
    // rotation moves on to the next candidate instead.
    const near = new Set();
    for (let step = -STREAM_VISIBLE; step <= STREAM_VISIBLE; step += 1) {
      near.add(ordinary[((i + step) % ordinary.length + ordinary.length) % ordinary.length].id);
    }
    let chosen = 0;
    for (let tries = 0; tries < highlights.length; tries += 1) {
      if (near.has(highlights[(next + tries) % highlights.length].id)) continue;
      chosen = tries;
      break;
    }
    // A gallery smaller than the corridor cannot satisfy this at all: every
    // photo is always on screen somewhere. Showing the highlight anyway beats
    // dropping it, so an unavoidable clash falls through to the next in turn.
    playlist.push(highlights[(next + chosen) % highlights.length]);
    next = (next + chosen + 1) % highlights.length;
  }
  return playlist;
}

// Photos sit on a fixed grid in depth and the camera glides forward along it,
// so a photo's position is a plain function of the clock. That is what keeps
// the television and every phone showing the same thing.
function streamCameraZ() {
  return ((Date.now() + streamClockOffset) / 1000) * STREAM_SPEED;
}

function streamPlacement(index) {
  // A golden-angle spiral instead of a pseudo-random scatter: successive photos
  // land a third of a turn apart, so none of them ends up hidden straight
  // behind its neighbour. The angle is folded into one turn first, which keeps
  // the trigonometry well conditioned for the very large indices the clock
  // produces. Everything derives from the index alone, so every screen places
  // the photos identically.
  // The radius must not be driven by the golden ratio as well: it correlates
  // with the golden angle and leaves the corners of the stage empty, so it uses
  // a different irrational. Keeping it well away from zero turns the field into
  // a ring: the far photos sweep around the edges of the screen and leave the
  // middle to whichever photo is currently arriving.
  const angle = (index * STREAM_GOLDEN_ANGLE) % (Math.PI * 2);
  const radius = 0.6 + 0.4 * ((index * 0.4142135623730951) % 1);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    tilt: (((index * 0.7548776662466927) % 1) - 0.5) * 8,
  };
}

function buildStreamSlots() {
  const track = $('stream-track');
  track.replaceChildren();
  streamSlots.length = 0;
  for (let i = 0; i <= STREAM_VISIBLE; i += 1) {
    const figure = document.createElement('figure');
    const shot = document.createElement('div');
    const soft = document.createElement('img');
    const sharp = document.createElement('img');
    const edge = document.createElement('span');
    const caption = document.createElement('figcaption');
    figure.className = 'stream-photo';
    shot.className = 'stream-shot';
    // The halo around the card, on its own layer. It replaces the gold hairline
    // that used to sit here: perspective shrinks a far card to a fifth, so a
    // one-pixel line covered a fifth of a screen pixel and flickered on and off
    // as it drifted across the grid. A soft dark glow has no such edge to lose,
    // and a hot photo swaps it for a warm one.
    edge.className = 'stream-edge';
    edge.setAttribute('aria-hidden', 'true');
    // The soft copy comes from the server already blurred and tiny. Blurring in
    // CSS instead would cost a repaint every time perspective rescales the card,
    // and that repaint is what made the frames flicker.
    soft.className = 'stream-soft';
    sharp.className = 'stream-sharp';
    soft.decoding = sharp.decoding = 'async';
    soft.alt = sharp.alt = '';
    caption.className = 'stream-caption';
    // A slot always keeps its place in the queue, so its stacking order is
    // fixed. Stating it explicitly matters because a blurred element drops out
    // of the 3D sorting and would otherwise paint in DOM order.
    figure.style.zIndex = String(STREAM_VISIBLE + 1 - i);
    shot.append(soft, sharp);
    figure.append(shot, caption, edge);
    track.append(figure);
    const slot = {
      node: figure,
      shot,
      soft,
      sharp,
      edge,
      caption,
      photoId: null,
      highlight: null,
      index: null,
      place: null,
      sharpId: null,
      sharpReady: false,
      sharpOpacity: null,
    };
    sharp.addEventListener('load', () => { slot.sharpReady = true; });
    // A photo that will not load must not leave a hole: the blurred copy stays
    // put and the sharp layer simply never fades in.
    sharp.addEventListener('error', () => { slot.sharpReady = false; });
    streamSlots.push(slot);
  }
}

function measureStreamStage() {
  // Read once per resize rather than per frame: the scatter is expressed in
  // stage widths, and touching layout inside the animation loop would stall it.
  const stage = $('stream-stage');
  streamStageSize.width = stage.clientWidth;
  streamStageSize.height = stage.clientHeight;
}

function renderStreamCaption(slot, photo) {
  if (!photo) {
    slot.caption.replaceChildren();
    return;
  }
  const parts = [];
  if (photo.highlight) {
    const flag = document.createElement('span');
    flag.className = 'stream-flag';
    flag.textContent = '🔥 Hot';
    parts.push(flag);
  }
  if (photo.task) {
    const task = document.createElement('span');
    task.className = 'stream-task';
    task.textContent = photo.task;
    parts.push(task);
  }
  const meta = document.createElement('span');
  meta.className = 'stream-meta';
  if (photo.author) {
    const author = document.createElement('span');
    author.className = 'stream-author';
    author.textContent = photo.author;
    meta.append(author);
  }
  for (const reaction of photo.reactions || []) {
    const badge = document.createElement('span');
    badge.className = 'stream-reaction';
    badge.textContent = `${reaction.emoji} ${reaction.count}`;
    meta.append(badge);
  }
  if (meta.childElementCount) parts.push(meta);
  slot.caption.replaceChildren(...parts);
}

function paintStream() {
  if (!streamPlaylist.length || !streamSlots.length) return;
  if (!streamStageSize.width) measureStreamStage();
  const cameraZ = streamCameraZ();
  // Ceil, not floor: this has to be the first photo the camera has not passed yet.
  const front = Math.ceil(cameraZ / STREAM_SPACING);
  const furthest = STREAM_SPACING * STREAM_VISIBLE;
  for (let position = 0; position < streamSlots.length; position += 1) {
    const slot = streamSlots[position];
    // One slot trails the camera so a photo is still visible while it sweeps past.
    const index = front - 1 + position;
    const depth = index * STREAM_SPACING - cameraZ;
    if (slot.index !== index) {
      const photo = streamPlaylist[((index % streamPlaylist.length) + streamPlaylist.length) % streamPlaylist.length];
      if (slot.photoId !== photo.id) {
        slot.soft.src = `/api/photos/${photo.id}/soft`;
        slot.photoId = photo.id;
      }
      // The same photo also comes round as an ordinary picture, so the frame
      // belongs to this turn through the rotation, not to the photo itself.
      if (slot.highlight !== (photo.highlight || null)) {
        slot.highlight = photo.highlight || null;
        slot.node.classList.toggle('is-highlight', Boolean(slot.highlight));
      }
      renderStreamCaption(slot, { ...(streamPhotoById.get(photo.id) || photo), highlight: slot.highlight });
      slot.place = streamPlacement(index);
      slot.node.style.setProperty('--tilt', `${slot.place.tilt}deg`);
      slot.index = index;
    }
    // Only the photos about to arrive are worth their full weight in pixels.
    // The rest stay on the thumbnail, which is blurred anyway.
    const wantsSharp = position < STREAM_SHARP_SLOTS;
    if (wantsSharp && slot.sharpId !== slot.photoId) {
      slot.sharpId = slot.photoId;
      slot.sharpReady = false;
      slot.sharp.src = `/api/photos/${slot.photoId}/display`;
    } else if (!wantsSharp && slot.sharpId !== null) {
      slot.sharpId = null;
      slot.sharpReady = false;
      slot.sharp.removeAttribute('src');
    }
    // Fade in from the far end, fade out again while passing the camera, so
    // nothing pops into or out of existence.
    const arriving = Math.min(1, Math.max(0, (furthest - depth) / (STREAM_SPACING * 1.6)));
    const leaving = depth >= 0 ? 1 : Math.max(0, 1 + depth / (STREAM_SPACING * STREAM_FADE_OUT));
    const scale = STREAM_PERSPECTIVE / (STREAM_PERSPECTIVE + Math.max(0, depth));

    // Perspective alone would do the opposite of what is wanted here: it pulls
    // distant photos towards the vanishing point and throws near ones outwards.
    // So the scatter is aimed at the screen instead — widest at the back,
    // collapsing onto the centre as a photo arrives — and then divided by the
    // scale, which is exactly what the projection multiplies it by again.
    // Smoothstep, not a power curve: an exponent below one has infinite slope
    // at the near end, which is what made a photo appear to snap to the centre
    // at the last moment. This eases in and out, and it never collapses all the
    // way, so the last stretch of the journey stays gentle.
    const towards = Math.min(1, Math.max(0, depth) / furthest);
    const eased = towards * towards * (3 - 2 * towards);
    const reach = STREAM_CONVERGE_MIN + (1 - STREAM_CONVERGE_MIN) * eased;
    const shiftX = (slot.place.x * STREAM_SPREAD_X * streamStageSize.width * reach) / (100 * scale);
    const shiftY = (slot.place.y * STREAM_SPREAD_Y * streamStageSize.height * reach) / (100 * scale);
    slot.node.style.transform =
      `translate3d(calc(-50% + ${shiftX.toFixed(1)}px), calc(-50% + ${shiftY.toFixed(1)}px), ${-depth}px)`
      + ' rotate(var(--tilt, 0deg))';
    slot.node.style.opacity = String(Math.min(arriving, leaving));
    slot.node.classList.toggle('is-front', position === 1);

    // Softening whatever is further back leaves the eye on the nearest photo.
    // The soft copy underneath is blurred by a fixed amount that never changes,
    // and the sharp copy is faded in on top of it as the photo arrives. Because
    // only an opacity changes, this costs a compositor pass and nothing repaints
    // -- which is what stopped the frames from flickering. The second photo is
    // already halfway sharp while the first one is still leaving.
    const focus = slot.sharpReady
      ? Math.min(1, Math.max(0, 1 - depth / (STREAM_SPACING * STREAM_SHARP_REACH)))
      : 0;
    // Two decimals is finer than any screen resolves and saves a style write on
    // most frames.
    const sharpOpacity = Math.round(focus * 100) / 100;
    if (slot.sharpOpacity !== sharpOpacity) {
      slot.sharp.style.opacity = String(sharpOpacity);
      slot.sharpOpacity = sharpOpacity;
    }

  }
}

function streamAdapt(now) {
  if (!streamWindowStart) {
    streamWindowStart = now;
    return;
  }
  streamFrames += 1;
  const elapsed = now - streamWindowStart;
  if (elapsed < 2500) return;
  const fps = (streamFrames * 1000) / elapsed;
  streamWindowStart = now;
  streamFrames = 0;
  // The opening seconds decode thirteen photographs at once and the frame rate
  // dips no matter how capable the machine is. Judging it then would leave a
  // perfectly good laptop on the lowest setting for the rest of the evening.
  if (streamWarmUp > 0) {
    streamWarmUp -= 1;
    return;
  }
  streamSlowWindows = fps < 40 ? streamSlowWindows + 1 : 0;
  if (streamSlowWindows < 2 || streamQuality >= 2) return;
  // Softening goes first, because it costs the most and is the least missed;
  // only if that is not enough does the corridor get shorter.
  streamSlowWindows = 0;
  streamQuality += 1;
  $('stream-stage').classList.toggle('is-lean', streamQuality >= 1);
  $('stream-stage').classList.toggle('is-minimal', streamQuality >= 2);
}

function streamFrame(now) {
  streamAdapt(now);
  paintStream();
  streamFrameHandle = requestAnimationFrame(streamFrame);
}

function startStreamMotion() {
  stopStreamMotion();
  if (!authenticated || !streamPage || document.hidden || !streamPlaylist.length) return;
  if (!streamWindowStart) streamWarmUp = 3;
  if (streamReducedMotion.matches) {
    // One still picture at a time, refreshed as the camera passes each photo.
    paintStream();
    streamTimer = setTimeout(startStreamMotion, STREAM_SPACING / STREAM_SPEED * 1000);
    return;
  }
  streamFrameHandle = requestAnimationFrame(streamFrame);
}

function stopStreamMotion() {
  if (streamFrameHandle !== null) cancelAnimationFrame(streamFrameHandle);
  streamFrameHandle = null;
  clearTimeout(streamTimer);
  streamTimer = null;
}

function stopStream() {
  stopStreamMotion();
  clearTimeout(streamPollTimer);
  streamPollTimer = null;
}

async function loadStream() {
  if (!authenticated || !streamPage) return;
  clearTimeout(streamPollTimer);
  try {
    const result = await api('/api/photos/stream');
    const list = result.photos || [];
    const serverNow = Date.parse(result.now);
    // Correcting against the server clock is what keeps separate screens on the
    // same picture; without it they drift apart by whatever their clocks differ.
    if (Number.isFinite(serverNow)) streamClockOffset = serverNow - Date.now();
    $('stream-error').textContent = '';
    streamPhotoById.clear();
    for (const photo of list) streamPhotoById.set(photo.id, photo);
    const signature = list.map((photo) => photo.id).join(',');
    // Reactions change far more often than the photo list. Rebuilding the
    // rotation only when the list itself changes keeps the flow steady, while
    // captions still pick up new reaction counts on the next poll.
    if (signature !== streamSignature) {
      streamSignature = signature;
      streamPlaylist = streamPlaylistFrom(list);
      if (!streamSlots.length) buildStreamSlots();
    }
    for (const slot of streamSlots) {
      const photo = slot.photoId && streamPhotoById.get(slot.photoId);
      if (photo) renderStreamCaption(slot, { ...photo, highlight: slot.highlight });
    }
    $('stream-stage').hidden = !list.length;
    $('stream-empty').hidden = Boolean(list.length);
    // Measure only once the stage is on screen, otherwise it reports nothing.
    if (list.length) measureStreamStage();
    $('stream-status').textContent = list.length
      ? `${list.length} ${list.length === 1 ? 'Foto' : 'Fotos'} im Stream · Neue Fotos werden bevorzugt gezeigt.`
      : 'Noch keine Fotos in der Galerie.';
    startStreamMotion();
  } catch (error) {
    $('stream-error').textContent = error.message;
    $('stream-status').textContent = 'Der Stream konnte nicht aktualisiert werden.';
  } finally {
    if (authenticated && streamPage) streamPollTimer = setTimeout(loadStream, 10000);
  }
}

$('camera-torch').addEventListener('click', async () => {
  const track = cameraStream?.getVideoTracks()[0];
  if (!track) return;
  const wanted = !cameraTorchOn;
  const screenFlash = $('camera-view').dataset.facing === 'user';
  if (screenFlash) {
    cameraTorchOn = wanted;
    $('camera-view').classList.toggle('screen-flash-on', wanted);
    $('camera-status').textContent = wanted
      ? 'Display-Blitz eingeschaltet.'
      : 'Display-Blitz ausgeschaltet.';
  } else {
    try {
      await track.applyConstraints({ advanced: [{ torch: wanted }] });
      cameraTorchOn = wanted;
    } catch {
      cameraTorchOn = false;
      $('camera-status').textContent = 'Das Licht lässt sich auf diesem Gerät nicht schalten.';
    }
  }
  $('camera-torch').setAttribute('aria-pressed', String(cameraTorchOn));
  const label = screenFlash ? 'Display-Blitz' : 'Blitz';
  $('camera-torch').setAttribute('aria-label', `${label} ${cameraTorchOn ? 'ausschalten' : 'einschalten'}`);
});

// Fullscreen is still fragmented on older WebKit and embedded TV browsers.
// iPhone Safari does not offer element fullscreen at all, so every native path
// has a viewport-sized CSS fallback that preserves the stream and its controls.
let streamControlsTimer = null;

function nativeFullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement
    || document.msFullscreenElement
    || null;
}

function nativeFullscreenRequest(element) {
  const request = element.requestFullscreen
    || element.webkitRequestFullscreen
    || element.webkitRequestFullScreen
    || element.mozRequestFullScreen
    || element.msRequestFullscreen;
  if (!request) return Promise.resolve(false);
  try {
    return Promise.resolve(request.call(element))
      .then(() => Boolean(nativeFullscreenElement()), () => false);
  } catch {
    return Promise.resolve(false);
  }
}

function nativeFullscreenExit() {
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.webkitCancelFullScreen
    || document.mozCancelFullScreen
    || document.msExitFullscreen;
  if (!exit) return Promise.resolve();
  try {
    return Promise.resolve(exit.call(document)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function captureFlowActive() {
  return document.body.classList.contains('camera-open')
    || document.body.classList.contains('review-open');
}

function captureNativeFullscreenActive() {
  return nativeFullscreenElement() === $('capture-root');
}

function enterCaptureFullscreen() {
  captureFullscreenWanted = true;
  syncViewportHeight();
  if (nativeFullscreenElement()) return;
  nativeFullscreenRequest($('capture-root')).then((entered) => {
    if (entered && !captureFullscreenWanted) nativeFullscreenExit();
  });
}

function scheduleCaptureFullscreenExit() {
  Promise.resolve().then(() => {
    // Camera -> preview and rear -> front camera both briefly close one view.
    // Waiting one microtask keeps native fullscreen intact during that handoff.
    if (captureFlowActive()) return;
    captureFullscreenWanted = false;
    if (captureNativeFullscreenActive()) nativeFullscreenExit();
  });
}

function streamNativeFullscreenActive() {
  return nativeFullscreenElement() === $('stream-stage');
}

function streamFullscreenActive() {
  return streamNativeFullscreenActive() || streamFullscreenFallback;
}

function syncStreamFullscreen() {
  const nativeActive = streamNativeFullscreenActive();
  if (nativeActive) streamFullscreenFallback = false;
  const active = nativeActive || streamFullscreenFallback;
  document.body.classList.toggle('is-fullscreen', active);
  $('stream-fullscreen').textContent = active ? 'Vollbild beenden' : 'Vollbild';
  $('page-backdrop').hidden = active || tvMode;
  syncViewportHeight();
  requestAnimationFrame(syncViewportHeight);
  if (active) revealStreamControls();
  else {
    clearTimeout(streamControlsTimer);
    $('stream-stage').classList.remove('controls-visible');
  }
  if (streamPage) measureStreamStage();
}

async function enterStreamFullscreen() {
  streamFullscreenFallback = false;
  const enteredNatively = await nativeFullscreenRequest($('stream-stage'));
  if (!enteredNatively && !streamNativeFullscreenActive()) streamFullscreenFallback = true;
  syncStreamFullscreen();
}

async function exitStreamFullscreen() {
  streamFullscreenFallback = false;
  if (streamNativeFullscreenActive()) await nativeFullscreenExit();
  syncStreamFullscreen();
}

$('stream-fullscreen').addEventListener('click', () => {
  if (streamFullscreenActive()) exitStreamFullscreen();
  else enterStreamFullscreen();
});

// In fullscreen there is no browser chrome and no Escape key on a phone, so a
// tap brings back a way out for a few seconds.
function revealStreamControls() {
  if (!streamFullscreenActive()) return;
  clearTimeout(streamControlsTimer);
  $('stream-stage').classList.add('controls-visible');
  streamControlsTimer = setTimeout(
    () => $('stream-stage').classList.remove('controls-visible'), 3500);
}

$('stream-stage').addEventListener('pointerdown', revealStreamControls);
$('stream-stage').addEventListener('touchstart', revealStreamControls, { passive: true });
$('stream-stage').addEventListener('mousedown', revealStreamControls);
$('stream-exit').addEventListener('click', (event) => {
  event.stopPropagation();
  exitStreamFullscreen();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && streamFullscreenFallback) exitStreamFullscreen();
});

function handleFullscreenChange() {
  syncViewportHeight();
  requestAnimationFrame(syncViewportHeight);
  if (captureNativeFullscreenActive() && !captureFullscreenWanted) {
    nativeFullscreenExit();
    return;
  }
  syncStreamFullscreen();
}

for (const eventName of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']) {
  document.addEventListener(eventName, handleFullscreenChange);
}
if (tvMode) syncStreamFullscreen();
window.addEventListener('resize', () => {
  syncViewportHeight();
  if (streamPage) measureStreamStage();
});

$('back-to-grid').addEventListener('click', () => {
  $('photo-detail').hidden = true;
  $('gallery-overview').hidden = false;
  activeDetailPhoto = null;
  $('detail-comment-error').textContent = '';
  window.scrollTo(0, scrollPosition);
  detailButton?.focus({ preventScroll: true });
});

$('detail-comment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeDetailPhoto) return;
  const photoId = activeDetailPhoto.id;
  const submit = $('detail-comment-submit');
  $('detail-comment-error').textContent = '';
  submit.disabled = true;
  try {
    const result = await api(`/api/photos/${photoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('detail-comment-input').value }),
    });
    if (activeDetailPhoto?.id === photoId && !$('photo-detail').hidden) {
      updatePhotoInteractions(photoId, result);
      renderDetailInteractions(result);
      $('detail-comment-input').value = '';
    }
  } catch (error) {
    $('detail-comment-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

function scheduleRefresh() {
  clearTimeout(timer);
  if (authenticated && galleryPage && !document.hidden) timer = setTimeout(() => loadGallery(false), 15000);
}

async function loadGallery(more) {
  if (galleryBusy || !authenticated) return;
  const requestedQuery = galleryQuery;
  const requestedMine = galleryMine;
  galleryBusy = true;
  $('refresh').disabled = $('load-more').disabled = true;
  $('gallery-error').textContent = '';
  try {
    const parameters = new URLSearchParams();
    if (more && nextCursor) parameters.set('cursor', nextCursor);
    if (requestedQuery) parameters.set('q', requestedQuery);
    if (requestedMine) parameters.set('mine', '1');
    const query = parameters.size ? `?${parameters}` : '';
    let result = await api('/api/photos' + query);
    if (requestedQuery !== galleryQuery || requestedMine !== galleryMine) return;
    let batch = [...result.photos];
    if (more || !galleryLoaded) nextCursor = result.next_cursor;
    // Catch up even if over 30 photos arrive between polls, without resetting older pages.
    if (!more && galleryLoaded && photos.size) {
      while (result.next_cursor && !result.photos.some((photo) => photos.has(photo.id))) {
        const catchup = new URLSearchParams({ cursor: result.next_cursor });
        if (requestedQuery) catchup.set('q', requestedQuery);
        if (requestedMine) catchup.set('mine', '1');
        result = await api('/api/photos?' + catchup);
        if (requestedQuery !== galleryQuery || requestedMine !== galleryMine) return;
        batch.push(...result.photos);
      }
    } else if (!more && galleryLoaded && !photos.size) nextCursor = result.next_cursor;
    const fragment = document.createDocumentFragment();
    for (const photo of batch) {
      if (photos.has(photo.id)) continue;
      photos.set(photo.id, photo);
      fragment.append(photoButton(photo));
    }
    if (more) $('photo-grid').append(fragment); else $('photo-grid').prepend(fragment);
    galleryLoaded = true;
    $('gallery-empty').hidden = photos.size > 0;
    if (!photos.size && requestedMine && requestedQuery) {
      $('gallery-empty').querySelector('h2').textContent = 'Keine passenden Fotos von dir gefunden.';
      $('gallery-empty').querySelector('p').textContent = `Für „${requestedQuery}“ gibt es von dir noch keinen Treffer.`;
    } else if (!photos.size && requestedMine) {
      $('gallery-empty').querySelector('h2').textContent = 'Du hast noch kein Foto geteilt.';
      $('gallery-empty').querySelector('p').textContent = 'Deine eigenen Fotos erscheinen hier nach dem Teilen.';
    } else if (!photos.size && requestedQuery) {
      $('gallery-empty').querySelector('h2').textContent = 'Keine passenden Fotos gefunden.';
      $('gallery-empty').querySelector('p').textContent = `Für „${requestedQuery}“ gibt es noch keinen Treffer.`;
    } else {
      $('gallery-empty').querySelector('h2').textContent = 'Der erste Moment fehlt noch.';
      $('gallery-empty').querySelector('p').textContent = 'Mach den Anfang und teile ein Foto von der Party.';
    }
    $('load-more').hidden = !nextCursor;
  } catch (error) { $('gallery-error').textContent = error.message; }
  finally {
    galleryBusy = false;
    $('refresh').disabled = $('load-more').disabled = false;
    if (requestedQuery !== galleryQuery || requestedMine !== galleryMine) void loadGallery(false);
    else scheduleRefresh();
  }
}

$('refresh').addEventListener('click', () => loadGallery(false));
$('load-more').addEventListener('click', () => loadGallery(true));
$('gallery-search-toggle').addEventListener('click', () => {
  const toggle = $('gallery-search-toggle');
  const opening = $('gallery-toolbar').hidden;
  $('gallery-toolbar').hidden = !opening;
  toggle.setAttribute('aria-expanded', String(opening));
  toggle.setAttribute('aria-label', opening ? 'Suche schließen' : 'Suche öffnen');
  toggle.querySelector('.sr-only').textContent = opening ? 'Suche schließen' : 'Suche öffnen';
  if (opening) $('gallery-search').focus();
});
$('gallery-mine-toggle').addEventListener('click', () => {
  galleryMine = !galleryMine;
  $('gallery-mine-toggle').setAttribute('aria-pressed', String(galleryMine));
  nextCursor = null;
  galleryLoaded = false;
  photos.clear();
  $('photo-grid').replaceChildren();
  $('load-more').hidden = true;
  void loadGallery(false);
});
$('gallery-search').addEventListener('input', () => {
  clearTimeout(gallerySearchTimer);
  gallerySearchTimer = setTimeout(() => {
    const query = $('gallery-search').value.trim();
    if (query === galleryQuery) return;
    galleryQuery = query;
    nextCursor = null;
    galleryLoaded = false;
    photos.clear();
    $('photo-grid').replaceChildren();
    $('load-more').hidden = true;
    void loadGallery(false);
  }, 180);
});
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer);
  if (!document.hidden && galleryPage && authenticated) loadGallery(false);
  if (!document.hidden && authenticated) scheduleQueueSync();
  // Position comes from the clock, so a tab that was away simply rejoins the
  // stream exactly where every other screen already is.
  if (streamPage && authenticated) {
    if (document.hidden) stopStreamMotion();
    else startStreamMotion();
  }
});

window.addEventListener('online', () => {
  offlineMode = false;
  updateSendAction();
  void refreshOutbox();
  if (authenticated && !locallySignedOut) {
    void refreshTaskCache().catch(() => {});
    scheduleQueueSync();
  }
});

window.addEventListener('offline', () => {
  offlineMode = true;
  updateSendAction();
  void refreshOutbox();
});

if (!document.querySelector('script[src="/static/dev-reload.js"]') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'fotovibe-outbox-updated') void refreshOutbox();
  });
}

let cachedOfflineUser = null;
try {
  await openOfflineStore();
  await resetInterruptedUploads();
  locallySignedOut = Boolean(await getOfflineState('signed-out'));
  cachedOfflineUser = await getOfflineState('user');
  const taskState = await getOfflineState('tasks');
  cachedTasks = Array.isArray(taskState?.tasks) ? taskState.tasks.filter((task) => task?.task_token) : [];
  taskBag = Array.isArray(taskState?.bag) ? taskState.bag.filter((id) => cachedTasks.some((task) => task.id === id)) : [];
  lastDrawnTaskId = cachedTasks.some((task) => task.id === taskState?.lastDrawnTaskId) ? taskState.lastDrawnTaskId : null;
  await refreshOutbox();
} catch {
  // Direct upload remains available if a browser refuses IndexedDB.
}

if (locallySignedOut) {
  showLogin();
} else {
  try {
    const activeSession = await api('/api/session');
    await enter(activeSession.user);
  } catch (error) {
    if (error.network && cachedOfflineUser) {
      await enter(cachedOfflineUser, { offline: true });
    } else {
      try {
        const restored = await api('/api/session/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId() }),
        });
        await enter(restored.user);
      } catch (restoreError) {
        if (restoreError.network && cachedOfflineUser) await enter(cachedOfflineUser, { offline: true });
        else showLogin(error.status === 401 ? '' : error.message);
      }
    }
  }
}
