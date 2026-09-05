import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('login surface fits the selected device viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/180\. Geburtstag/);
  await expect(page.getByRole('heading', { name: 'Schön, dass du da bist.' })).toBeVisible();
  await expect(page.getByLabel('Party-Code')).toBeVisible();

  const viewportFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
  expect(viewportFits).toBe(true);
});

test('a blocked device sees the dedicated access page and can retry', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!['/api/session', '/api/session/restore'].includes(url.pathname)) {
        return nativeFetch(input, options);
      }
      return Promise.resolve(new Response(JSON.stringify({
        detail: 'Du wurdest aus dieser Party entfernt.',
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-FotoVibe-Reason': 'party-blocked',
        },
      }));
    };
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Du wurdest aus dieser Party entfernt.' })).toBeVisible();
  await expect(page.locator('#blocked img')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Erneut prüfen' })).toBeVisible();
  await page.getByRole('button', { name: 'Erneut prüfen' }).click();
  await expect(page.locator('#blocked-status')).toContainText('Noch nicht freigegeben');
});

test('a local developer can reach the camera entry point', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await expect(page.getByRole('heading', { name: 'Wie dürfen wir dich nennen?' })).toBeVisible();
  await page.getByLabel('Dein Name').fill('Playwright Test');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Foto aufnehmen/ }).first()).toBeVisible();
  await expect(page.locator('#local-cache')).toBeHidden();
});

test('the photo library turns any browser-readable image into an uploadable cover', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Bildformat');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();

  const input = page.locator('#library-input');
  await expect(input).toHaveAttribute('accept', 'image/*,.heic,.heif,.avif');
  await input.setInputFiles({
    name: 'bewegtes-foto.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
  });
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Foto hochladen' })).toBeEnabled();

  const uploadResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/photos' && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: 'Foto hochladen' }).click();
  const response = await uploadResponse;
  expect(response.ok()).toBe(true);
  expect(response.request().headers()['content-type']).toBe('image/jpeg');
  await expect(response.json()).resolves.toMatchObject({ content_type: 'image/jpeg', extension: 'jpg' });
});

test('the profile menu omits technical identifiers and personal task creation', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Profil');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();

  await page.getByRole('button', { name: 'Profil öffnen' }).click();
  const profileMenu = page.locator('#profile-menu');
  await expect(profileMenu).toBeVisible();
  await expect(profileMenu).not.toContainText('Nutzer-ID');
  await expect(profileMenu).not.toContainText('Geräte-ID');
  await expect(profileMenu.getByRole('button', { name: 'Eigene Aufgabe hinzufügen' })).toHaveCount(0);
});

test('an opaque invite link skips the party code and disappears from the address bar', async ({ page }) => {
  await page.goto('/dev-invite-token-only-1234');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Wie dürfen wir dich nennen?' })).toBeVisible();
  await expect(page.getByLabel('Party-Code')).toBeHidden();

  await page.getByLabel('Dein Name').fill('Playwright Einladung');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
});

test('admins can see and copy the current party invite link', async ({ page }) => {
  const invitePath = '/admin_InviteToken0123456789XYZ';
  await page.addInitScript((path) => {
    const nativeFetch = window.fetch.bind(window);
    const admin = {
      id: 'u_admin1234567890',
      name: 'Alex Admin',
      device_id: 'd_admin12345678',
      is_admin: true,
      blocked: false,
      values: { photos_uploaded: 0 },
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__copiedInvite = value; } },
    });
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = options.method || (typeof input === 'string' ? 'GET' : input.method);
      if (url.pathname === '/api/session' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ authenticated: true, user: admin }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.pathname === '/api/tasks' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.pathname === '/api/admin/overview' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          invite_path: path,
          users: [],
          join_requests: [],
          values: { users: 0, photos: 0, blocked: 0, join_requests: 0 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return nativeFetch(input, options);
    };
  }, invitePath);

  await page.goto('/');
  await page.getByRole('button', { name: 'Profil öffnen' }).click();
  await page.getByRole('button', { name: 'Admin-Panel öffnen' }).click();

  const expectedUrl = new URL(invitePath, page.url()).href;
  await expect(page.getByLabel('Einladungslink')).toHaveValue(expectedUrl);
  const layout = await page.evaluate(() => {
    const insideViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth + 1;
    };
    const input = document.getElementById('admin-invite-url');
    const button = document.getElementById('admin-invite-copy');
    return {
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      inputInside: insideViewport(input),
      buttonInside: insideViewport(button),
      inputFontSize: Number.parseFloat(getComputedStyle(input).fontSize),
      buttonHeight: button.getBoundingClientRect().height,
    };
  });
  expect(layout).toMatchObject({
    noHorizontalOverflow: true,
    inputInside: true,
    buttonInside: true,
  });
  expect(layout.inputFontSize).toBeGreaterThanOrEqual(16);
  expect(layout.buttonHeight).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Link kopieren' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedInvite)).toBe(expectedUrl);
  await expect(page.locator('#admin-invite-status')).toHaveText('Einladungslink kopiert.');
});

test('the task picker presents four mobile-friendly choices and a clear exit', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__personalTaskRequests = 0;
    window.fetch = (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path !== '/api/tasks' || options.method !== 'POST') return nativeFetch(input, options);
      window.__personalTaskRequests += 1;
      return Promise.resolve(new Response(JSON.stringify({
        id: 'party-playwright-private',
        text: 'Mach ein Foto mit deinem Lieblingsmenschen.',
        personal: true,
        task_token: 'playwright-private-token',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    };
  });
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Aufgaben');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();

  await page.getByRole('button', { name: 'Aufgabe auswählen' }).click();
  const picker = page.getByRole('dialog', { name: 'Wähle eine Aufgabe' });
  await expect(picker).toBeVisible();
  await expect(page.locator('.challenge-option')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Aufnehmen' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Hochladen' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Vier neue Aufgaben anzeigen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Eigene Aufgabe schreiben' })).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = document.getElementById('challenge-panel').getBoundingClientRect();
    const camera = document.getElementById('challenge-camera').getBoundingClientRect();
    const library = document.getElementById('challenge-library').getBoundingClientRect();
    return {
      panelWidth: panel.width,
      panelHeight: panel.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      actionsShareRow: Math.abs(camera.top - library.top) < 2 && library.left > camera.left,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    };
  });
  expect(layout.panelWidth).toBeGreaterThanOrEqual(layout.viewportWidth - 1);
  expect(layout.panelHeight).toBeGreaterThanOrEqual(layout.viewportHeight - 1);
  expect(layout.actionsShareRow).toBe(true);
  expect(layout.noHorizontalOverflow).toBe(true);

  for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const compactLayout = await page.evaluate(() => {
      const visibleRect = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          inside: rect.left >= 0
            && rect.top >= 0
            && rect.right <= window.innerWidth + 1
            && rect.bottom <= window.innerHeight + 1,
        };
      };
      return {
        refresh: visibleRect('challenge-refresh'),
        custom: visibleRect('challenge-custom-open'),
        close: visibleRect('challenge-cancel'),
        camera: visibleRect('challenge-camera'),
        library: visibleRect('challenge-library'),
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      };
    });
    expect(compactLayout.noHorizontalOverflow).toBe(true);
    for (const [name, control] of Object.entries(compactLayout).filter(([, value]) => typeof value === 'object')) {
      expect(control.inside, `${name} must stay inside ${viewport.width}x${viewport.height}`).toBe(true);
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
  }

  const initialTaskIds = await page.locator('.challenge-option').evaluateAll(
    (options) => options.map((option) => option.dataset.taskId),
  );
  await page.getByRole('button', { name: 'Vier neue Aufgaben anzeigen' }).click();
  await expect(page.locator('.challenge-option')).toHaveCount(4);
  await expect.poll(() => page.locator('.challenge-option').evaluateAll(
    (options) => options.map((option) => option.dataset.taskId),
  )).not.toEqual(initialTaskIds);

  await page.getByRole('button', { name: 'Eigene Aufgabe schreiben' }).click();
  await expect(page.locator('#challenge-custom-form')).toBeVisible();
  await page.getByLabel('Deine eigene Aufgabe').fill('Mach ein Foto mit deinem Lieblingsmenschen.');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.locator('.challenge-option')).toHaveCount(4);
  const personalTask = page.getByRole('button', {
    name: 'Eigene Aufgabe: Mach ein Foto mit deinem Lieblingsmenschen.',
  });
  await expect(personalTask).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__personalTaskRequests)).toBe(1);
  await expect(page.getByRole('button', { name: 'Aufnehmen' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Hochladen' })).toBeEnabled();

  await page.getByRole('button', { name: 'Aufgabenauswahl schließen' }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: 'Aufgabe auswählen' })).toBeVisible();
});

test('personal tasks and several four-task rounds survive offline reloads', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the Service Worker and IndexedDB once in Chromium.');
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const publicTasks = Array.from({ length: 16 }, (_, index) => ({
      id: `cached-${String(index + 1).padStart(2, '0')}`,
      text: `Offline-Aufgabe ${index + 1}`,
      task_token: `cached-token-${index + 1}`,
    }));
    const syncedTasks = [];
    window.__offlineTaskSyncs = 0;
    window.__readTaskState = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('state', 'readonly');
        const stateRequest = transaction.objectStore('state').get('tasks');
        stateRequest.onsuccess = () => {
          resolve(stateRequest.result?.value || null);
          database.close();
        };
        stateRequest.onerror = () => reject(stateRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = options.method || (typeof input === 'string' ? 'GET' : input.method);
      if (url.pathname !== '/api/tasks') return nativeFetch(input, options);
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [...syncedTasks, ...publicTasks] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (method === 'POST' && navigator.onLine !== false) {
        const payload = JSON.parse(options.body);
        const task = {
          id: payload.offline_id,
          text: payload.text,
          personal: true,
          task_token: `synced-token-${payload.offline_id}`,
        };
        syncedTasks.splice(0, syncedTasks.length, task);
        window.__offlineTaskSyncs += 1;
        return Promise.resolve(new Response(JSON.stringify(task), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return nativeFetch(input, options);
    };
  });

  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Offline Tasks');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect.poll(() => page.evaluate(async () => (await window.__readTaskState())?.tasks?.length || 0)).toBe(16);
  await page.waitForFunction(() => navigator.serviceWorker?.controller);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: 'Aufgabe auswählen' }).click();
  const firstCycle = new Set();
  for (let round = 0; round < 4; round++) {
    const ids = await page.locator('.challenge-option').evaluateAll(
      (options) => options.map((option) => option.dataset.taskId),
    );
    ids.forEach((id) => firstCycle.add(id));
    if (round < 3) await page.getByRole('button', { name: 'Vier neue Aufgaben anzeigen' }).click();
  }
  expect(firstCycle.size).toBe(16);

  await page.getByRole('button', { name: 'Eigene Aufgabe schreiben' }).click();
  await page.getByLabel('Deine eigene Aufgabe').fill('Mein persönliches Offline-Motiv');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const localTask = page.getByRole('button', { name: 'Eigene Offline-Aufgabe: Mein persönliches Offline-Motiv' });
  await expect(localTask).toHaveAttribute('aria-pressed', 'true');
  await expect(localTask.locator('.challenge-option-number')).toHaveText('LOKAL');
  const offlineTaskId = await localTask.getAttribute('data-task-id');
  expect(offlineTaskId).toMatch(/^offline-/);

  await page.getByRole('button', { name: 'Aufgabenauswahl schließen' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  const restored = await page.evaluate(async (id) => {
    const state = await window.__readTaskState();
    return state.tasks.find((task) => task.id === id);
  }, offlineTaskId);
  expect(restored).toMatchObject({
    id: offlineTaskId,
    text: 'Mein persönliches Offline-Motiv',
    personal: true,
    pending_sync: true,
  });

  await page.getByRole('button', { name: 'Aufgabe auswählen' }).click();
  const restoredCycle = new Set();
  for (let round = 0; round < 5; round++) {
    const ids = await page.locator('.challenge-option').evaluateAll(
      (options) => options.map((option) => option.dataset.taskId),
    );
    ids.forEach((id) => restoredCycle.add(id));
    if (round < 4) await page.getByRole('button', { name: 'Vier neue Aufgaben anzeigen' }).click();
  }
  expect(restoredCycle.size).toBe(17);
  expect(restoredCycle.has(offlineTaskId)).toBe(true);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(async (id) => {
    const state = await window.__readTaskState();
    const task = state.tasks.find((candidate) => candidate.id === id);
    return Boolean(task?.task_token && !task.pending_sync);
  }, offlineTaskId)).toBe(true);
  expect(await page.evaluate(() => window.__offlineTaskSyncs)).toBe(1);
});

test('the gallery keeps search collapsed and offers a personal quick filter', async ({ page }) => {
  await page.goto('/gallery');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Galerie');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Unser Abend in Bildern.' })).toBeVisible();
  await expect(page.locator('#stream-link')).toHaveCount(0);
  await expect(page.locator('#gallery-toolbar')).toBeHidden();

  await page.getByRole('button', { name: 'Suche öffnen' }).click();
  await expect(page.locator('#gallery-toolbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Von mir' })).toHaveAttribute('aria-pressed', 'false');
  const mineRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/photos' && url.searchParams.get('mine') === '1';
  });
  await page.getByRole('button', { name: 'Von mir' }).click();
  await expect(page.getByRole('button', { name: 'Von mir' })).toHaveAttribute('aria-pressed', 'true');
  await mineRequest;
});

test('the gallery renders a compact first page before lazily loading the rest', async ({ page }) => {
  const thumbnail = await readFile(new URL('../../static/party.jpg', import.meta.url));
  const photos = Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    created_at: new Date(Date.UTC(2026, 8, 5, 20, 0, 0) - index * 1000).toISOString(),
    width: 900,
    height: 1200,
    author: { name: `Gast ${index + 1}` },
    interactions: { reactions: [], comments_count: 0 },
  }));
  await page.addInitScript((galleryPhotos) => {
    const nativeFetch = window.fetch.bind(window);
    window.__galleryListingRequests = [];
    window.__releaseGalleryFirstPage = () => {};
    window.__releaseGalleryNextPage = () => {};
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = options.method || input?.method || 'GET';
      if (url.pathname !== '/api/photos' || method !== 'GET') return nativeFetch(input, options);
      window.__galleryListingRequests.push(url.toString());
      if (!url.searchParams.has('cursor')) {
        return new Promise((resolve) => {
          window.__releaseGalleryFirstPage = () => resolve(new Response(JSON.stringify({
            photos: galleryPhotos.slice(0, 12), next_cursor: 'next-page',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });
      }
      return new Promise((resolve) => {
        window.__releaseGalleryNextPage = () => resolve(new Response(JSON.stringify({
          photos: galleryPhotos.slice(12), next_cursor: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      });
    };
  }, photos);

  await page.route('**/api/photos/*/thumb', (route) => route.fulfill({
    status: 200,
    contentType: 'image/jpeg',
    body: thumbnail,
  }));
  await page.goto('/gallery');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Lazy Galerie');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();

  await expect(page.locator('#gallery-loading')).toBeVisible();
  await expect(page.locator('#gallery-skeleton span').first()).toBeVisible();
  await page.evaluate(() => window.__releaseGalleryFirstPage());
  await expect(page.locator('#photo-grid .photo-tile')).toHaveCount(12);
  const loadingModes = await page.locator('#photo-grid img').evaluateAll(
    (images) => images.map((image) => image.loading),
  );
  const eagerCount = await page.evaluate(
    () => matchMedia('(pointer: coarse)').matches ? 4 : 6,
  );
  expect(loadingModes.filter((mode) => mode === 'eager')).toHaveLength(eagerCount);
  expect(loadingModes.filter((mode) => mode === 'lazy')).toHaveLength(12 - eagerCount);
  const firstRequest = await page.evaluate(() => window.__galleryListingRequests[0]);
  expect(new URL(firstRequest).searchParams.get('limit')).toBe('12');
  await page.locator('#load-more').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(
    () => window.__galleryListingRequests.some((url) => new URL(url).searchParams.has('cursor')),
  )).toBe(true);
  await expect(page.getByRole('button', { name: 'Weitere Fotos werden geladen …' })).toBeVisible();
  await page.evaluate(() => window.__releaseGalleryNextPage());
  await expect(page.locator('#photo-grid .photo-tile')).toHaveCount(20);
  await expect(page.locator('#load-more')).toBeHidden();
});

test('a long press starts gallery selection and taps add more photos', async ({ page }) => {
  const thumbnail = await readFile(new URL('../../static/party.jpg', import.meta.url));
  const galleryPhotos = Array.from({ length: 3 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    created_at: new Date(Date.UTC(2026, 8, 5, 21, index)).toISOString(),
    width: 900,
    height: 1200,
    author: { name: `Gast ${index + 1}` },
    interactions: { reactions: [], comments_count: 0 },
  }));
  await page.addInitScript((photos) => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = options.method || input?.method || 'GET';
      if (url.pathname === '/api/photos' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ photos, next_cursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (/^\/api\/photos\/[^/]+\/display$/.test(url.pathname) && method === 'GET') {
        return nativeFetch('/static/party.jpg');
      }
      return nativeFetch(input, options);
    };
  }, galleryPhotos);
  await page.route('**/api/photos/*/thumb', (route) => route.fulfill({
    status: 200,
    contentType: 'image/jpeg',
    body: thumbnail,
  }));
  await page.route('**/api/gallery/archive?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/zip',
    headers: { 'Content-Disposition': 'attachment; filename="FotoVibe-Fotos.zip"' },
    body: Buffer.from('archive'),
  }));

  await page.goto('/gallery');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Auswahl');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  const tiles = page.locator('#photo-grid .photo-tile');
  await expect(tiles).toHaveCount(3);

  await tiles.first().dispatchEvent('pointerdown', {
    pointerId: 7, pointerType: 'touch', button: 0, clientX: 20, clientY: 20, pressure: 0.5,
  });
  await page.waitForTimeout(520);
  await tiles.first().dispatchEvent('pointerup', {
    pointerId: 7, pointerType: 'touch', button: 0, clientX: 20, clientY: 20, pressure: 0,
  });
  await expect(page.locator('#photo-grid')).toHaveClass(/is-selecting/);
  await expect(tiles.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#gallery-selection-count')).toHaveText('1 Foto ausgewählt');

  await tiles.nth(1).click();
  await expect(tiles.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#gallery-selection-count')).toHaveText('2 Fotos ausgewählt');
  await expect(page.getByRole('button', { name: 'Auswahl sichern' })).toBeEnabled();

  await page.setViewportSize({ width: 320, height: 568 });
  const compactActions = await page.evaluate(() => {
    const bar = document.getElementById('gallery-actionbar').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#gallery-actionbar button:not([hidden])')]
      .map((button) => button.getBoundingClientRect());
    return {
      barInside: bar.left >= 0 && bar.right <= innerWidth && bar.top >= 0 && bar.bottom <= innerHeight,
      buttonsAreTouchable: buttons.every((button) => button.height >= 44 && button.width >= 44),
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    };
  });
  expect(compactActions).toEqual({
    barInside: true,
    buttonsAreTouchable: true,
    noHorizontalOverflow: true,
  });

  const archiveDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Auswahl sichern' }).click();
  const download = await archiveDownload;
  const requestedIds = new URL(download.url()).searchParams.get('ids').split(',');
  expect(requestedIds).toHaveLength(2);
  expect(download.suggestedFilename()).toBe('FotoVibe-Fotos.zip');
  await download.cancel();

  await page.getByRole('button', { name: 'Alle wählen' }).click();
  await expect(page.locator('#gallery-selection-count')).toHaveText('3 Fotos ausgewählt');
  await expect.poll(() => tiles.evaluateAll(
    (buttons) => buttons.map((button) => button.getAttribute('aria-pressed')),
  )).toEqual(['true', 'true', 'true']);

  await page.evaluate(() => {
    window.__sharedGalleryFiles = 0;
    Object.defineProperty(navigator, 'canShare', { value: ({ files }) => files?.length > 0, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: ({ files }) => {
        window.__sharedGalleryFiles = files.length;
        return Promise.resolve();
      },
      configurable: true,
    });
  });
  await page.getByRole('button', { name: 'Auswahl sichern' }).click();
  await expect(page.getByRole('button', { name: 'Jetzt sichern' })).toBeVisible();
  await page.getByRole('button', { name: 'Jetzt sichern' }).click();
  await expect.poll(() => page.evaluate(() => window.__sharedGalleryFiles)).toBe(3);

  await page.getByRole('button', { name: 'Auswahl beenden' }).click();
  await expect(page.locator('#gallery-selection-summary')).toBeHidden();
  await expect(tiles.first()).not.toHaveAttribute('aria-pressed');
});

test('Chromium opens the camera shell with the fake webcam', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'The deterministic fake-camera flags are Chromium-specific.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Kamera');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.getByRole('button', { name: /Foto aufnehmen/ }).first().click();

  await expect(page.locator('#camera-view')).toBeVisible();
  await expect(page.locator('#camera-video')).toBeVisible();
  await expect(page.locator('#shutter')).toBeEnabled();
  if (testInfo.project.name === 'desktop-chromium') {
    await expect(page.getByRole('button', { name: 'Display-Blitz einschalten' })).toBeVisible();
  }
});

test('an offline photo survives reload and uploads when the connection returns', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the Service Worker and IndexedDB once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Offline Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await page.getByRole('button', { name: 'Aufgabe auswählen' }).click();
  await expect(page.locator('.challenge-option')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Aufnehmen' })).toBeDisabled();
  await page.locator('.challenge-option').first().click();
  await expect(page.getByRole('button', { name: 'Aufnehmen' })).toBeEnabled();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.waitForTimeout(250);

  await context.setOffline(true);
  await expect(page.locator('#queue-control')).toBeVisible();
  const photo = await readFile(new URL('../../static/party.jpg', import.meta.url));
  await page.locator('#library-input').setInputFiles({
    name: 'offline.jpg', mimeType: 'image/jpeg', buffer: photo,
  });
  await expect(page.locator('#review')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Später hochladen' })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Foto hochladen' })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('button', { name: 'Später hochladen' })).toBeVisible();
  await page.getByRole('button', { name: 'Später hochladen' }).click();
  await expect(page.locator('#queue-notice')).toHaveText('Eingereiht · 1 / 25');
  await expect(page.locator('#local-cache')).toContainText('1 / 25 vorgemerkt');
  await page.locator('#local-cache').click();
  await expect(page.locator('#queue-menu')).toBeVisible();
  await expect(page.locator('#queue-control')).toBeVisible();
  await page.locator('#queue-menu .queue-delete-action').click();
  await expect(page.locator('#queue-menu')).toBeVisible();
  await expect(page.locator('#queue-menu')).toContainText('Behalten');
  await page.locator('#queue-menu').getByRole('button', { name: 'Behalten' }).click();
  await page.locator('#queue-menu .queue-detail-trigger').click();
  await expect(page.locator('#queue-detail')).toBeVisible();
  await expect(page.locator('#queue-detail-image')).toBeVisible();
  await expect(page.locator('#queue-detail-task')).toBeVisible();
  await expect(page.locator('#queue-detail-task-text')).not.toHaveText('');
  await page.keyboard.press('Escape');
  await expect(page.locator('#queue-detail')).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await page.getByRole('button', { name: 'Aufgabe auswählen' }).click();
  await expect(page.locator('.challenge-option')).toHaveCount(4);
  await page.locator('.challenge-option').first().click();
  await expect(page.getByRole('button', { name: 'Aufnehmen' })).toBeEnabled();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#local-cache')).toBeHidden();
});

test('an offline guest can inspect and remove a queued photo', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the local queue once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Queue Detail');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const photo = await readFile(new URL('../../static/party.jpg', import.meta.url));
  await page.locator('#library-input').setInputFiles({
    name: 'remove-me.jpg', mimeType: 'image/jpeg', buffer: photo,
  });
  await page.getByRole('button', { name: 'Später hochladen' }).click();
  await page.locator('#local-cache').click();
  await page.getByRole('button', { name: 'Vorgemerktes Foto groß anzeigen' }).first().click();
  await page.getByRole('button', { name: 'Foto aus der Queue löschen' }).click();
  await expect(page.getByText('Wirklich löschen?')).toBeVisible();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(page.locator('#queue-detail')).toBeHidden();
  await expect(page.locator('#local-cache')).toBeHidden();
  await expect(page.locator('#queue-control')).toBeVisible();
});

test('an old failed queue entry gets a fresh server photo ID before upload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the IndexedDB migration once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Legacy Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.evaluate(async () => {
    const blob = await fetch('/static/party.jpg').then((response) => response.blob());
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      transaction.objectStore('outbox').put({
        id: 'old-local-photo-key', blob, name: 'legacy.jpg', type: 'image/jpeg', size: blob.size,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'error', attempts: 1,
        uploadId: 'old-local-photo-key', nextAttemptAt: 0,
        lastError: 'Bitte genau ein Foto hochladen.', progress: 0,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#local-cache')).toBeHidden();
});

test('an automatic legacy repair runs only once when the server still rejects it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the one-shot queue repair once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Reparaturschutz');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  });
  let requests = 0;
  await page.route('**/api/photos', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    requests += 1;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Bitte genau ein Foto auswählen.' }),
    });
  });
  await page.evaluate(async () => {
    const blob = await fetch('/static/party.jpg').then((response) => response.blob());
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      transaction.objectStore('outbox').put({
        id: 'one-shot-repair', uploadId: 'old-local-key', blob, name: 'legacy.jpg',
        type: 'image/jpeg', size: blob.size, createdAt: Date.now(), updatedAt: Date.now(),
        status: 'error', attempts: 1, nextAttemptAt: 0,
        lastError: 'Bitte genau ein Foto auswählen.', progress: 0,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('offline'));
  });

  await expect(page.locator('#queue-button')).toHaveAttribute('data-state', 'error');
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
});

test('a full offline queue of 25 task photos drains with its metadata intact', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the maximum outbox size once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Volle Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  const marker = await page.evaluate(async () => {
    const task = (await fetch('/api/tasks').then((response) => response.json())).tasks[0];
    const blob = await fetch('/static/party.jpg').then((response) => response.blob());
    const marker = Date.now();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      for (let index = 0; index < 25; index++) {
        outbox.put({
          id: `batch-${index}`,
          blob,
          name: `offline-${index}.jpg`,
          type: 'image/jpeg',
          size: blob.size,
          task,
          clientMetadata: {
            source: 'camera',
            captured_at: marker + index,
            queued_at: marker + index,
            task_id: task.id,
          },
          createdAt: marker + index,
          updatedAt: marker + index,
          status: 'queued',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: '',
          progress: 0,
        });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('online'));
    return marker;
  });

  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 30_000 });
  const uploaded = await page.evaluate(async (queuedAt) => {
    const result = await fetch('/api/photos').then((response) => response.json());
    return result.photos.filter((photo) => photo.metadata?.capture?.queued_at >= queuedAt);
  }, marker);
  expect(uploaded).toHaveLength(25);
  expect(new Set(uploaded.map((photo) => photo.id)).size).toBe(25);
  expect(uploaded.every((photo) => photo.metadata.task?.id && photo.metadata.capture?.source === 'camera')).toBe(true);
});

test('the page starts two queued uploads at a time', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Checks the page queue scheduler once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Parallel Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    window.__uploadActivity = { active: 0, maximum: 0 };
    window.XMLHttpRequest = class FakeUploadRequest {
      constructor() {
        this.upload = {};
        this.status = 0;
        this.responseText = '';
      }

      open() {}

      setRequestHeader() {}

      getResponseHeader() { return null; }

      send(body) {
        if (!(body instanceof Blob)) throw new Error('Expected one raw photo Blob.');
        window.__uploadActivity.active += 1;
        window.__uploadActivity.maximum = Math.max(
          window.__uploadActivity.maximum,
          window.__uploadActivity.active,
        );
        this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
        setTimeout(() => {
          window.__uploadActivity.active -= 1;
          this.status = 201;
          this.responseText = '{}';
          this.onload();
        }, 200);
      }
    };

    const blob = await fetch('/static/party.jpg').then((response) => response.blob());
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      for (let index = 0; index < 4; index++) {
        outbox.put({
          id: `parallel-${index}`, blob, name: `parallel-${index}.jpg`, type: 'image/jpeg',
          size: blob.size, createdAt: Date.now() + index, updatedAt: Date.now() + index,
          status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: '', progress: 0,
        });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('online'));
  });

  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 10_000 });
  expect(await page.evaluate(() => window.__uploadActivity.maximum)).toBe(2);
});

test('a broken local preview shows a calm placeholder and can still be removed', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises an unreadable local Blob once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Vorschau');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await context.setOffline(true);
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      transaction.objectStore('outbox').put({
        id: crypto.randomUUID(),
        blob: new Blob(['kein-bild'], { type: 'image/jpeg' }),
        name: 'nicht-lesbar.jpg', type: 'image/jpeg', size: 9,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', attempts: 0,
        nextAttemptAt: 0, lastError: '', progress: 0,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('offline'));
  });

  await page.locator('#local-cache').click();
  await expect(page.locator('.queue-thumbnail-placeholder')).toBeVisible();
  await page.getByRole('button', { name: /Vorschau nicht verfügbar/ }).click();
  await expect(page.locator('#queue-detail-image-unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Foto aus der Queue löschen' }).click();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(page.locator('#queue-detail')).toBeHidden();
});

test('WebKit stores photo bytes offline and uploads them as a raw photo body', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit', 'Covers the Safari offline photo path once in WebKit.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Safari Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  const photo = await readFile(new URL('../../static/party.jpg', import.meta.url));
  await page.locator('#library-input').setInputFiles({
    name: 'safari-offline.jpg', mimeType: 'image/jpeg', buffer: photo,
  });
  await expect(page.getByRole('button', { name: 'Foto hochladen' })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('button', { name: 'Später hochladen' })).toBeVisible();
  await page.getByRole('button', { name: 'Später hochladen' }).click();
  await expect(page.locator('#local-cache')).toContainText('1 / 25 vorgemerkt');
  const stored = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const entry = await new Promise((resolve, reject) => {
      const request = database.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result[0]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return {
      hasBytes: entry.bytes instanceof ArrayBuffer && entry.bytes.byteLength > 0,
      hasBlob: 'blob' in entry,
      queuedAt: entry.clientMetadata.queued_at,
    };
  });
  expect(stored).toMatchObject({ hasBytes: true, hasBlob: false });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 15_000 });
  const uploaded = await page.evaluate(async (queuedAt) => {
    const result = await fetch('/api/photos').then((response) => response.json());
    return result.photos.find((photo) => photo.metadata?.capture?.queued_at === queuedAt);
  }, stored.queuedAt);
  expect(uploaded?.id).toMatch(/^[0-9a-f-]{36}$/);
});

test('the front-camera preview mirrors only the preview and keeps the action focused', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || testInfo.project.name !== 'desktop-chromium', 'Uses the deterministic front camera once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Spiegelung');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.getByRole('button', { name: /Foto aufnehmen/ }).first().click();
  await expect(page.locator('#shutter')).toBeEnabled();
  await page.locator('#shutter').click();
  await expect(page.locator('#preview')).toHaveClass(/is-mirrored/);
  await expect(page.locator('#discard')).toHaveText('');
  await expect(page.locator('#discard')).toHaveAttribute('aria-label', 'Zurück zur Kamera');
  await expect(page.locator('#file-info')).toHaveCount(0);
  await expect(page.locator('#preview-status')).toHaveCount(0);
  const centered = await page.locator('#send').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) < 1;
  });
  expect(centered).toBe(true);
});
