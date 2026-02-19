// ==UserScript==
// @name         yt-watch-later-tools
// @namespace    https://github.com/jadenjsj/yt-watch-later-tools
// @version      0.1.0
// @description  Remove the last N videos from your Watch Later playlist using YouTube internal endpoints.
// @homepageURL  https://github.com/jadenjsj/yt-watch-later-tools
// @supportURL   https://github.com/jadenjsj/yt-watch-later-tools/issues
// @updateURL    https://raw.githubusercontent.com/jadenjsj/yt-watch-later-tools/main/yt-watch-later-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/jadenjsj/yt-watch-later-tools/main/yt-watch-later-tools.user.js
// @license      MIT
// @match        https://www.youtube.com/playlist?list=WL*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STATE = {
    running: false,
    shouldStop: false,
  };

  const DEFAULT_N = 100;
  const STORAGE_KEY = 'wl_remove_last_n';
  const ADVANCED_STORAGE_KEY = 'wl_remove_last_n_advanced';
  const PANEL_ID = 'wl-remove-last-n-panel';
  const LAUNCHER_ID = 'wl-remove-last-n-launcher';
  const WL_OLDEST_SORT_ORDER = 2; // Derived from HAR: ACTION_SET_PLAYLIST_VIDEO_ORDER
  const WL_PARAMS = 'CAFAAQ%3D%3D';
  const API_STATUS_SUCCEEDED = 'STATUS_SUCCEEDED';
  const ADVANCED_DEFAULTS = {
    scanPageThrottleMs: 50,
    deleteThrottleMs: 50,
    sortVerifyMaxAttempts: 6,
    sortVerifyPollMs: 350,
    batchDeleteCount: 1,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  }

  function sanitizeAdvancedSettings(raw) {
    return {
      scanPageThrottleMs: clampInt(raw?.scanPageThrottleMs, ADVANCED_DEFAULTS.scanPageThrottleMs, 0, 10000),
      deleteThrottleMs: clampInt(raw?.deleteThrottleMs, ADVANCED_DEFAULTS.deleteThrottleMs, 0, 10000),
      sortVerifyMaxAttempts: clampInt(raw?.sortVerifyMaxAttempts, ADVANCED_DEFAULTS.sortVerifyMaxAttempts, 1, 30),
      sortVerifyPollMs: clampInt(raw?.sortVerifyPollMs, ADVANCED_DEFAULTS.sortVerifyPollMs, 0, 10000),
      batchDeleteCount: clampInt(raw?.batchDeleteCount, ADVANCED_DEFAULTS.batchDeleteCount, 1, 50),
    };
  }

  function loadAdvancedSettings() {
    const fallback = { ...ADVANCED_DEFAULTS };
    try {
      const raw = localStorage.getItem(ADVANCED_STORAGE_KEY);
      if (!raw) return fallback;
      return sanitizeAdvancedSettings(JSON.parse(raw));
    } catch {
      return fallback;
    }
  }

  function saveAdvancedSettings(settings) {
    const sanitized = sanitizeAdvancedSettings(settings);
    localStorage.setItem(ADVANCED_STORAGE_KEY, JSON.stringify(sanitized));
    return sanitized;
  }

  function isWatchLaterPage(urlString = location.href) {
    const url = new URL(urlString, location.origin);
    return url.pathname === '/playlist' && url.searchParams.get('list') === 'WL';
  }

  function getCookie(name) {
    const parts = document.cookie.split(';').map((x) => x.trim());
    const key = `${name}=`;
    for (const part of parts) {
      if (part.startsWith(key)) {
        return decodeURIComponent(part.slice(key.length));
      }
    }
    return '';
  }

  async function sha1Hex(input) {
    const enc = new TextEncoder();
    const data = enc.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function buildAuthHeader(origin) {
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID') || getCookie('__Secure-1PAPISID');
    if (!sapisid) {
      throw new Error('Missing SAPISID/3PAPISID cookie. Are you logged in to YouTube?');
    }

    const now = Math.floor(Date.now() / 1000);
    const input = `${now} ${sapisid} ${origin}`;
    const hash = await sha1Hex(input);
    return `SAPISIDHASH ${now}_${hash}`;
  }

  function getYtcfgValue(key) {
    if (window.ytcfg && typeof window.ytcfg.get === 'function') {
      return window.ytcfg.get(key);
    }
    return undefined;
  }

  function getApiKey() {
    const key = getYtcfgValue('INNERTUBE_API_KEY');
    if (!key || typeof key !== 'string') {
      throw new Error('Failed to get INNERTUBE_API_KEY from page config.');
    }
    return key;
  }

  function getClientContext() {
    const clientVersion = getYtcfgValue('INNERTUBE_CLIENT_VERSION');
    const hl = getYtcfgValue('HL') || 'en';
    const gl = getYtcfgValue('GL') || 'US';
    const visitorData = getYtcfgValue('VISITOR_DATA');

    if (!clientVersion) {
      throw new Error('Failed to get INNERTUBE_CLIENT_VERSION from page config.');
    }

    const ctx = {
      client: {
        clientName: 'WEB',
        clientVersion,
        hl,
        gl,
      },
    };

    if (visitorData) {
      ctx.client.visitorData = visitorData;
    }

    return ctx;
  }

  function safeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function pickTitle(titleObj) {
    if (!titleObj || typeof titleObj !== 'object') {
      return '';
    }
    if (typeof titleObj.simpleText === 'string') {
      return safeText(titleObj.simpleText);
    }
    if (Array.isArray(titleObj.runs)) {
      return safeText(titleObj.runs.map((r) => r?.text || '').join(''));
    }
    return '';
  }

  function extractEntriesAndContinuation(json, options = {}) {
    const includeRawRenderer = !!options.includeRawRenderer;
    const entries = [];
    const seenSetIds = new Set();
    const continuationTokens = [];
    const seenContinuationTokens = new Set();
    const seenNodes = new Set();

    function pushToken(token) {
      if (typeof token !== 'string' || !token) {
        return;
      }
      if (seenContinuationTokens.has(token)) {
        return;
      }
      seenContinuationTokens.add(token);
      continuationTokens.push(token);
    }

    function tokenFromContinuationItem(item) {
      return (
        item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        item?.continuationItemRenderer?.button?.buttonRenderer?.command?.continuationCommand?.token ||
        null
      );
    }

    function pushEntryFromRenderer(r) {
      const videoId = typeof r.videoId === 'string' ? r.videoId : '';
      const title = pickTitle(r.title);
      const menuItems = r?.menu?.menuRenderer?.items || [];

      for (const item of menuItems) {
        const endpoint = item?.menuServiceItemRenderer?.serviceEndpoint;
        const actions = endpoint?.playlistEditEndpoint?.actions;
        if (!Array.isArray(actions)) continue;
        for (const action of actions) {
          if (action?.action === 'ACTION_REMOVE_VIDEO' && typeof action.setVideoId === 'string') {
            if (!seenSetIds.has(action.setVideoId)) {
              seenSetIds.add(action.setVideoId);
              entries.push({
                setVideoId: action.setVideoId,
                videoId,
                title,
                channelName: safeText((r.shortBylineText?.runs || []).map((run) => run?.text || '').join('')),
                channelId:
                  (r.shortBylineText?.runs || []).find((run) => run?.navigationEndpoint?.browseEndpoint?.browseId)?.navigationEndpoint
                    ?.browseEndpoint?.browseId || '',
                publishedTimeText: pickTitle(r.publishedTimeText),
                lengthText:
                  pickTitle(r.lengthText) ||
                  pickTitle(
                    (r.thumbnailOverlays || []).find((ov) => ov?.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer?.text
                  ),
                isPlayable: r.isPlayable !== false && !r.unplayableText,
                unavailableReason: pickTitle(r.unplayableText),
                thumbnails: (r.thumbnail?.thumbnails || []).map((t) => ({
                  url: t?.url || '',
                  width: t?.width || null,
                  height: t?.height || null,
                })),
                badges: (r.badges || [])
                  .map((b) => safeText(b?.metadataBadgeRenderer?.label || pickTitle(b?.metadataBadgeRenderer?.label) || ''))
                  .filter(Boolean),
                ...(includeRawRenderer ? { rawRenderer: r } : {}),
              });
            }
            return;
          }
        }
      }
    }

    function consumeItemArray(items) {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item?.playlistVideoRenderer) {
          pushEntryFromRenderer(item.playlistVideoRenderer);
          continue;
        }
        const token = tokenFromContinuationItem(item);
        if (token) {
          pushToken(token);
        }
      }
    }

    function visit(node) {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (seenNodes.has(node)) {
        return;
      }
      seenNodes.add(node);

      if (node.playlistVideoListRenderer && typeof node.playlistVideoListRenderer === 'object') {
        consumeItemArray(node.playlistVideoListRenderer.contents);
        const token = node.playlistVideoListRenderer?.continuations?.[0]?.nextContinuationData?.continuation;
        pushToken(token);
      }

      if (node.appendContinuationItemsAction && typeof node.appendContinuationItemsAction === 'object') {
        consumeItemArray(node.appendContinuationItemsAction.continuationItems);
      }

      if (node.reloadContinuationItemsCommand && typeof node.reloadContinuationItemsCommand === 'object') {
        consumeItemArray(node.reloadContinuationItemsCommand.continuationItems);
      }

      // Fallback: collect continuation tokens wherever they appear in the payload.
      pushToken(node?.nextContinuationData?.continuation);
      pushToken(node?.continuationCommand?.token);

      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item);
        }
      } else {
        for (const key of Object.keys(node)) {
          visit(node[key]);
        }
      }
    }

    visit(json);
    return { entries, continuationTokens };
  }

  function getWatchLaterBrowseParamsFromInitialData() {
    const root = window.ytInitialData;
    if (!root || typeof root !== 'object') {
      return null;
    }

    const seenNodes = new Set();
    let found = null;

    function visit(node) {
      if (found || !node || typeof node !== 'object') {
        return;
      }
      if (seenNodes.has(node)) {
        return;
      }
      seenNodes.add(node);

      const endpoint = node?.browseEndpoint;
      if (endpoint?.browseId === 'VLWL' && typeof endpoint?.params === 'string' && endpoint.params) {
        found = endpoint.params;
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item);
          if (found) return;
        }
      } else {
        for (const key of Object.keys(node)) {
          visit(node[key]);
          if (found) return;
        }
      }
    }

    visit(root);
    return found;
  }

  function buildWatchLaterBrowseBody(context) {
    const body = {
      context,
      browseId: 'VLWL',
    };
    const browseParams = getWatchLaterBrowseParamsFromInitialData();
    if (browseParams) {
      body.params = browseParams;
    }
    return body;
  }

  function findFirstObject(root, predicate) {
    const stack = [root];
    const seen = new Set();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (seen.has(node)) continue;
      seen.add(node);
      if (predicate(node)) return node;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i -= 1) {
          stack.push(node[i]);
        }
      } else {
        const keys = Object.keys(node);
        for (let i = keys.length - 1; i >= 0; i -= 1) {
          stack.push(node[keys[i]]);
        }
      }
    }
    return null;
  }

  function extractIntegerFromText(text) {
    const digits = String(text || '').replace(/[^\d]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  function extractPlaylistMetadata(json) {
    const metadataRenderer = json?.metadata?.playlistMetadataRenderer || {};
    const primaryNode = findFirstObject(
      json,
      (node) => typeof node === 'object' && node !== null && typeof node.playlistSidebarPrimaryInfoRenderer === 'object'
    );
    const primary = primaryNode?.playlistSidebarPrimaryInfoRenderer || {};

    const stats = (primary.stats || []).map((s) => pickTitle(s)).filter(Boolean);
    let reportedVideoCount = null;
    for (const stat of stats) {
      if (/video/i.test(stat)) {
        reportedVideoCount = extractIntegerFromText(stat);
        if (reportedVideoCount !== null) break;
      }
    }

    return {
      playlistId: metadataRenderer.playlistId || 'WL',
      title: safeText(metadataRenderer.title || ''),
      description: safeText(metadataRenderer.description || ''),
      stats,
      reportedVideoCount,
      owner: safeText(
        (primary?.owner?.videoOwnerRenderer?.title?.runs || [])
          .map((run) => run?.text || '')
          .join('')
      ),
      lastUpdatedText: pickTitle(primary?.stats?.[2] || null),
    };
  }

  function extractSortState(json) {
    const sortNode = findFirstObject(
      json,
      (node) =>
        typeof node === 'object' &&
        node !== null &&
        typeof node.sortFilterSubMenuRenderer === 'object' &&
        Array.isArray(node.sortFilterSubMenuRenderer.subMenuItems)
    );
    const subMenu = sortNode?.sortFilterSubMenuRenderer;
    if (!subMenu) {
      return null;
    }

    const items = subMenu.subMenuItems.map((item) => {
      const action = (item?.serviceEndpoint?.playlistEditEndpoint?.actions || []).find(
        (a) => a?.action === 'ACTION_SET_PLAYLIST_VIDEO_ORDER'
      );
      const rawOrder = action?.playlistVideoOrder;
      const parsedOrder = Number(rawOrder);
      return {
        title: safeText(item?.title || ''),
        selected: !!item?.selected,
        playlistVideoOrder: Number.isFinite(parsedOrder) ? parsedOrder : null,
      };
    });

    const selectedItem = items.find((item) => item.selected) || null;
    return {
      title: safeText(subMenu.title || ''),
      selectedTitle: selectedItem?.title || '',
      selectedOrder: selectedItem?.playlistVideoOrder ?? null,
      items,
    };
  }

  async function youtubeiRequest(path, body) {
    const origin = location.origin;
    const apiKey = getApiKey();
    const auth = await buildAuthHeader(origin);

    const res = await fetch(`${origin}/youtubei/v1/${path}?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-youtube-client-name': '1',
        'x-youtube-client-version': getYtcfgValue('INNERTUBE_CLIENT_VERSION') || '2.20260101.00.00',
        'x-origin': origin,
        authorization: auth,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      const err = new Error(`youtubei ${path} failed (${res.status}): ${txt.slice(0, 400)}`);
      err.status = res.status;
      err.responseText = txt;
      throw err;
    }

    return res.json();
  }

  function assertEditPlaylistSucceeded(json, actionLabel) {
    const status = safeText(json?.status);
    if (status && status !== API_STATUS_SUCCEEDED) {
      throw new Error(`${actionLabel} failed with API status "${status}".`);
    }
  }

  async function ensureWatchLaterOrderOldest(log, options = {}) {
    const maxAttempts = clampInt(options.sortVerifyMaxAttempts, ADVANCED_DEFAULTS.sortVerifyMaxAttempts, 1, 30);
    const pollMs = clampInt(options.sortVerifyPollMs, ADVANCED_DEFAULTS.sortVerifyPollMs, 0, 10000);
    const context = getClientContext();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (STATE.shouldStop) {
        throw new Error('Stopped by user.');
      }

      const editJson = await setWatchLaterOrderOldest(context);
      const editSortState = extractSortState(editJson);
      if (editSortState?.selectedOrder === WL_OLDEST_SORT_ORDER) {
        if (attempt > 1) {
          log(`Sort verified after ${attempt} attempts: "${editSortState.selectedTitle}" (order=${editSortState.selectedOrder}).`);
        }
        return editSortState;
      }

      const browseJson = await youtubeiRequest('browse', buildWatchLaterBrowseBody(context));
      const browseSortState = extractSortState(browseJson);
      if (browseSortState?.selectedOrder === WL_OLDEST_SORT_ORDER) {
        if (attempt > 1 || !editSortState) {
          log(
            `Sort verified via browse response: "${browseSortState.selectedTitle}" (order=${browseSortState.selectedOrder}).`
          );
        }
        return browseSortState;
      }

      const observed = browseSortState || editSortState;
      const observedTitle = observed?.selectedTitle ? `"${observed.selectedTitle}"` : 'unknown';
      const observedOrder = Number.isFinite(observed?.selectedOrder) ? observed.selectedOrder : 'unknown';
      if (attempt < maxAttempts) {
        log(
          `Sort verify attempt ${attempt}/${maxAttempts}: still ${observedTitle} (order=${observedOrder}). Retrying...`
        );
        await sleep(pollMs);
      }
    }

    throw new Error(
      'Could not verify oldest-first sort. Stop playlist changes from all devices/sessions, reload this page, and retry.'
    );
  }

  async function fetchAllWatchLaterEntries(log, quiet = false, options = {}) {
    const includeRawRenderer = !!options.includeRawRenderer;
    const withMeta = !!options.withMeta;
    const pageThrottleMs = clampInt(options.pageThrottleMs, ADVANCED_DEFAULTS.scanPageThrottleMs, 0, 10000);
    const requireSortOrder = Number.isFinite(Number(options.requireSortOrder))
      ? Number(options.requireSortOrder)
      : null;
    const context = getClientContext();
    const entries = [];
    const seenSetIds = new Set();
    const scanStartedAt = new Date().toISOString();

    const addEntries = (pageEntries) => {
      for (const entry of pageEntries) {
        if (!entry?.setVideoId || seenSetIds.has(entry.setVideoId)) {
          continue;
        }
        seenSetIds.add(entry.setVideoId);
        entries.push(entry);
      }
    };

    let page = 0;
    const tokenQueue = [];
    const seenTokens = new Set();
    let firstPageMetadata = null;
    let firstPageSortState = null;

    const firstJson = await youtubeiRequest('browse', buildWatchLaterBrowseBody(context));
    const firstPage = extractEntriesAndContinuation(firstJson, { includeRawRenderer });
    firstPageMetadata = extractPlaylistMetadata(firstJson);
    firstPageSortState = extractSortState(firstJson);

    if (requireSortOrder !== null && firstPageSortState?.selectedOrder !== requireSortOrder) {
      const observedOrder = Number.isFinite(firstPageSortState?.selectedOrder) ? firstPageSortState.selectedOrder : 'unknown';
      const observedTitle = firstPageSortState?.selectedTitle || 'unknown';
      throw new Error(
        `Sort drift detected while scanning: expected order=${requireSortOrder} but got order=${observedOrder} (${observedTitle}).`
      );
    }

    addEntries(firstPage.entries);
    for (const token of firstPage.continuationTokens) {
      tokenQueue.push(token);
    }
    page += 1;
    if (!quiet) {
      log(`Fetched page ${page}, found ${firstPage.entries.length} entries (${entries.length} unique total).`);
      if (tokenQueue.length > 0) {
        log(`Found ${tokenQueue.length} continuation token(s) on page 1.`);
      }
    }

    while (tokenQueue.length > 0) {
      if (STATE.shouldStop) {
        throw new Error('Stopped by user.');
      }

      const token = tokenQueue.shift();
      if (!token || seenTokens.has(token)) {
        continue;
      }
      seenTokens.add(token);

      const json = await youtubeiRequest('browse', {
        context,
        continuation: token,
      });

      const pageData = extractEntriesAndContinuation(json, { includeRawRenderer });
      const beforeCount = entries.length;
      addEntries(pageData.entries);
      const addedCount = entries.length - beforeCount;
      page += 1;

      if (!quiet) {
        log(
          `Fetched page ${page}, found ${pageData.entries.length} entries (${entries.length} unique total, +${addedCount} unique).`
        );
      }

      for (const nextToken of pageData.continuationTokens) {
        if (!seenTokens.has(nextToken)) {
          tokenQueue.push(nextToken);
        }
      }
      if (pageThrottleMs > 0 && tokenQueue.length > 0) {
        await sleep(pageThrottleMs);
      }
    }

    if (!quiet && entries.length >= 100 && page === 1) {
      log('Warning: only one page fetched and no continuation token was usable.');
    }

    const indexedEntries = entries.map((entry, idx) => ({
      ...entry,
      orderIndex: idx + 1,
    }));

    if (!withMeta) {
      return indexedEntries;
    }

    return {
      entries: indexedEntries,
      playlistMetadata: firstPageMetadata,
      sortState: firstPageSortState,
      scan: {
        startedAt: scanStartedAt,
        finishedAt: new Date().toISOString(),
        pagesFetched: page,
        uniqueEntries: entries.length,
        continuationTokensConsumed: seenTokens.size,
      },
    };
  }

  async function removeFromWatchLater(setVideoId, context = getClientContext()) {
    const json = await youtubeiRequest('browse/edit_playlist', {
      context,
      playlistId: 'WL',
      actions: [
        {
          action: 'ACTION_REMOVE_VIDEO',
          setVideoId,
        },
      ],
      params: WL_PARAMS,
    });
    assertEditPlaylistSucceeded(json, `Remove video (setVideoId=${setVideoId})`);
    return json;
  }

  async function removeFromWatchLaterBatch(setVideoIds, context = getClientContext()) {
    const validIds = Array.isArray(setVideoIds)
      ? setVideoIds.filter((id) => typeof id === 'string' && id)
      : [];
    if (validIds.length === 0) {
      throw new Error('Batch remove requires at least one setVideoId.');
    }

    const actions = validIds.map((setVideoId) => ({
      action: 'ACTION_REMOVE_VIDEO',
      setVideoId,
    }));

    const json = await youtubeiRequest('browse/edit_playlist', {
      context,
      playlistId: 'WL',
      actions,
      params: WL_PARAMS,
    });
    assertEditPlaylistSucceeded(json, `Batch remove (${validIds.length} videos)`);
    return json;
  }

  async function setWatchLaterOrderOldest(context = getClientContext()) {
    const json = await youtubeiRequest('browse/edit_playlist', {
      context,
      playlistId: 'WL',
      actions: [
        {
          action: 'ACTION_SET_PLAYLIST_VIDEO_ORDER',
          playlistVideoOrder: WL_OLDEST_SORT_ORDER,
        },
      ],
      params: WL_PARAMS,
    });
    assertEditPlaylistSucceeded(json, 'Set playlist order to oldest-first');
    return json;
  }

  function formatEntry(entry) {
    return `setVideoId=${entry.setVideoId}, videoId=${entry.videoId || 'unknown'}, title="${safeText(entry.title) || 'unknown'}"`;
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function buildExportPayload(result) {
    return {
      version: '1.7.0',
      exportedAt: new Date().toISOString(),
      sourceUrl: location.href,
      playlistId: 'WL',
      orderSemantics:
        'Entries are exported in the current Watch Later order from head to tail at export time. Delete mode separately forces oldest-first before removal.',
      playlistMetadata: result.playlistMetadata,
      sortState: result.sortState || null,
      scan: result.scan,
      entries: result.entries,
    };
  }

  function saveExportFromScanResult(log, result, filenamePrefix = 'watch-later-backup') {
    const payload = buildExportPayload(result);
    const fileStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${filenamePrefix}-${fileStamp}.json`;
    downloadJson(fileName, payload);
    log(`Export complete. Saved ${result.entries.length} entries to ${fileName}.`);

    const reported = result?.playlistMetadata?.reportedVideoCount;
    if (Number.isFinite(reported) && reported !== result.entries.length) {
      log(
        `Note: YouTube reports ${reported} videos, but ${result.entries.length} entries had extractable playlist data. Private/deleted/unavailable rows can cause this gap.`
      );
    }
  }

  function saveDeletedVideosExport(log, deletedEntries, runMeta) {
    const fileStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `watch-later-deleted-${fileStamp}.json`;
    const payload = {
      version: '1.7.0',
      exportedAt: new Date().toISOString(),
      sourceUrl: location.href,
      playlistId: 'WL',
      run: runMeta,
      deletedEntries,
    };
    downloadJson(fileName, payload);
    log(`Deleted-videos export complete. Saved ${deletedEntries.length} entries to ${fileName}.`);
  }

  function shouldRetryWithRescan(err) {
    if (!err) return false;
    const status = Number(err.status || 0);
    const text = `${err.message || ''}\n${err.responseText || ''}`;
    return status === 409 || /ABORTED|something went wrong/i.test(text);
  }

  function findReplacementEntry(freshEntries, target) {
    if (!Array.isArray(freshEntries)) return null;
    const targetTitle = safeText(target.title);
    const targetChannel = safeText(target.channelName);
    const targetLength = safeText(target.lengthText);
    const targetPublished = safeText(target.publishedTimeText);
    const targetOrder = Number.isFinite(target.orderIndex) ? target.orderIndex : null;

    const ranked = freshEntries
      .map((entry) => {
        let score = 0;
        if (target.videoId && entry.videoId === target.videoId) score += 100;
        if (targetTitle && safeText(entry.title) === targetTitle) score += 40;
        if (targetChannel && safeText(entry.channelName) === targetChannel) score += 20;
        if (targetLength && safeText(entry.lengthText) === targetLength) score += 8;
        if (targetPublished && safeText(entry.publishedTimeText) === targetPublished) score += 6;

        const entryOrder = Number.isFinite(entry.orderIndex) ? entry.orderIndex : null;
        const distance =
          targetOrder !== null && entryOrder !== null ? Math.abs(entryOrder - targetOrder) : Number.POSITIVE_INFINITY;

        return { entry, score, distance };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.distance !== b.distance) {
          return a.distance - b.distance;
        }
        return 0;
      });

    if (ranked.length === 0) {
      return null;
    }
    if (ranked.length > 1) {
      const best = ranked[0];
      const second = ranked[1];
      if (best.score === second.score && best.distance === second.distance) {
        return null;
      }
    }
    return ranked[0].entry;
  }

  function ensureLauncherButton(onOpenPanel) {
    if (!isWatchLaterPage()) {
      document.getElementById(LAUNCHER_ID)?.remove();
      return false;
    }

    if (document.getElementById(LAUNCHER_ID)) {
      return true;
    }

    const host =
      document.querySelector('ytd-masthead #end') ||
      document.querySelector('tp-yt-app-header #end') ||
      document.querySelector('#end');
    if (!host) {
      return false;
    }

    const btn = document.createElement('button');
    btn.id = LAUNCHER_ID;
    btn.type = 'button';
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="margin-right:6px"><path d="M12 4V2.21c0-.45-.54-.67-.85-.35l-2.8 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.32.31.86.09.86-.36V6c3.31 0 6 2.69 6 6 0 .79-.15 1.56-.44 2.25-.15.36-.04.77.23 1.04.51.51 1.37.33 1.64-.34.37-.91.57-1.91.57-2.95 0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-.79.15-1.56.44-2.25.15-.36.04-.77-.23-1.04-.51-.51-1.37-.33-1.64.34C4.2 9.96 4 10.96 4 12c0 4.42 3.58 8 8 8v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V18z"/></svg>WL Tools`;
    btn.title = 'Open Watch Later tools';
    btn.style.cssText = `
      margin-right: 8px;
      height: 36px;
      padding: 0 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 18px;
      background: rgba(255,255,255,0.1);
      color: #f1f1f1;
      cursor: pointer;
      font-family: "YouTube Sans", "Roboto", sans-serif;
      font-size: 14px;
      font-weight: 500;
      letter-spacing: 0.2px;
      transition: background 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(255,255,255,0.2)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(255,255,255,0.1)';
    });
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpenPanel();
    });

    host.prepend(btn);
    return true;
  }

  function createUi() {
    // Inject YouTube-style CSS
    const styleId = 'wl-tools-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        @keyframes wl-panel-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes wl-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        #${PANEL_ID} {
          font-family: "YouTube Sans", "Roboto", sans-serif;
        }
        #${PANEL_ID} * {
          box-sizing: border-box;
        }
        #${PANEL_ID}::-webkit-scrollbar {
          width: 8px;
        }
        #${PANEL_ID}::-webkit-scrollbar-track {
          background: transparent;
        }
        #${PANEL_ID}::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 4px;
        }
        #${PANEL_ID}::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.3);
        }
        #${PANEL_ID} .wl-checkbox {
          -webkit-appearance: none;
          -moz-appearance: none;
          appearance: none;
          width: 18px !important;
          height: 18px !important;
          min-width: 18px;
          min-height: 18px;
          max-width: 18px;
          max-height: 18px;
          margin: 0;
          padding: 0;
          border: 2px solid #717171;
          border-radius: 2px;
          background: transparent;
          cursor: pointer;
          position: relative;
          transition: background 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
        }
        #${PANEL_ID} .wl-checkbox:checked {
          background: #3ea6ff;
          border-color: #3ea6ff;
        }
        #${PANEL_ID} .wl-checkbox:checked::after {
          content: '';
          position: absolute;
          left: 4px;
          top: 0px;
          width: 5px;
          height: 10px;
          border: solid #0f0f0f;
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
        #${PANEL_ID} .wl-checkbox:hover {
          border-color: #aaa;
        }
        #${PANEL_ID} .wl-checkbox:checked:hover {
          background: #65b8ff;
          border-color: #65b8ff;
        }
        #${PANEL_ID} .wl-input {
          width: 100%;
          background: #121212;
          color: #f1f1f1;
          border: 1px solid #3f3f3f;
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 14px;
          font-family: inherit;
          transition: border-color 0.2s, box-shadow 0.2s;
          outline: none;
        }
        #${PANEL_ID} .wl-input:hover {
          border-color: #717171;
        }
        #${PANEL_ID} .wl-input:focus {
          border-color: #3ea6ff;
          box-shadow: 0 0 0 1px #3ea6ff;
        }
        #${PANEL_ID} .wl-input::placeholder {
          color: #717171;
        }
        #${PANEL_ID} .wl-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 10px 16px;
          border: none;
          border-radius: 18px;
          font-family: inherit;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          outline: none;
        }
        #${PANEL_ID} .wl-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        #${PANEL_ID} .wl-btn-primary {
          background: #3ea6ff;
          color: #0f0f0f;
        }
        #${PANEL_ID} .wl-btn-primary:hover:not(:disabled) {
          background: #65b8ff;
        }
        #${PANEL_ID} .wl-btn-primary:active:not(:disabled) {
          background: #2d8fd8;
        }
        #${PANEL_ID} .wl-btn-danger {
          background: #ff4e45;
          color: #fff;
        }
        #${PANEL_ID} .wl-btn-danger:hover:not(:disabled) {
          background: #ff6961;
        }
        #${PANEL_ID} .wl-btn-secondary {
          background: rgba(255,255,255,0.1);
          color: #f1f1f1;
        }
        #${PANEL_ID} .wl-btn-secondary:hover:not(:disabled) {
          background: rgba(255,255,255,0.2);
        }
        #${PANEL_ID} .wl-label {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 0;
          color: #f1f1f1;
          font-size: 14px;
          cursor: pointer;
          transition: color 0.15s;
        }
        #${PANEL_ID} .wl-label:hover {
          color: #fff;
        }
        #${PANEL_ID} .wl-section {
          padding: 12px 0;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        #${PANEL_ID} .wl-section:last-child {
          border-bottom: none;
        }
        #${PANEL_ID} details summary {
          cursor: pointer;
          list-style: none;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 0;
          color: #aaa;
          font-size: 13px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          transition: color 0.15s;
        }
        #${PANEL_ID} details summary:hover {
          color: #f1f1f1;
        }
        #${PANEL_ID} details summary::-webkit-details-marker {
          display: none;
        }
        #${PANEL_ID} details summary::before {
          content: '';
          width: 0;
          height: 0;
          border-left: 5px solid currentColor;
          border-top: 4px solid transparent;
          border-bottom: 4px solid transparent;
          transition: transform 0.2s;
        }
        #${PANEL_ID} details[open] summary::before {
          transform: rotate(90deg);
        }
        #${PANEL_ID} .wl-log {
          font-family: "Roboto Mono", monospace;
          font-size: 11px;
          line-height: 1.5;
          background: #0a0a0a;
          border-radius: 8px;
          padding: 12px;
          max-height: 200px;
          overflow-y: auto;
          color: #aaa;
          white-space: pre-wrap;
          word-break: break-word;
        }
        #${PANEL_ID} .wl-log::-webkit-scrollbar {
          width: 6px;
        }
        #${PANEL_ID} .wl-log::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.15);
          border-radius: 3px;
        }
      `;
      document.head.appendChild(style);
    }

    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;
    wrap.style.cssText = `
      position: fixed;
      top: 56px;
      right: 16px;
      z-index: 999999;
      display: none;
      width: 380px;
      max-height: calc(100vh - 72px);
      overflow-y: auto;
      overscroll-behavior: contain;
      background: #212121;
      color: #f1f1f1;
      padding: 0;
      border-radius: 12px;
      box-shadow: 0 4px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
      animation: wl-panel-in 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    `;

    const savedN = Number(localStorage.getItem(STORAGE_KEY) || DEFAULT_N);
    const savedAdvanced = loadAdvancedSettings();

    wrap.innerHTML = `
      <div style="padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="#3ea6ff">
            <path d="M12 4V2.21c0-.45-.54-.67-.85-.35l-2.8 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.32.31.86.09.86-.36V6c3.31 0 6 2.69 6 6 0 .79-.15 1.56-.44 2.25-.15.36-.04.77.23 1.04.51.51 1.37.33 1.64-.34.37-.91.57-1.91.57-2.95 0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-.79.15-1.56.44-2.25.15-.36.04-.77-.23-1.04-.51-.51-1.37-.33-1.64.34C4.2 9.96 4 10.96 4 12c0 4.42 3.58 8 8 8v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V18z"/>
          </svg>
          <span style="font-size: 16px; font-weight: 500;">Watch Later Tools</span>
        </div>
        <button id="wl-panel-dismiss" class="wl-btn wl-btn-secondary" style="padding: 6px; border-radius: 50%; width: 32px; height: 32px;">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <div style="padding: 4px 20px 16px;">
        <div class="wl-section">
          <p style="margin: 0 0 12px; color: #aaa; font-size: 13px; line-height: 1.5;">
            Remove oldest-added videos from your Watch Later playlist. The script automatically sorts by oldest-first before scanning.
          </p>
          <div style="background: rgba(255, 171, 0, 0.1); border-left: 3px solid #ffab00; padding: 10px 12px; border-radius: 0 8px 8px 0; margin-bottom: 4px;">
            <p style="margin: 0; color: #ffcc4d; font-size: 12px; line-height: 1.4;">
              Don't change sorting for this playlist while running — including from other devices.
            </p>
          </div>
        </div>

        <div class="wl-section">
          <label style="display: block; margin-bottom: 6px; color: #aaa; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">
            Videos to remove
          </label>
          <input id="wl-remove-n-input" type="number" min="1" step="1" value="${Number.isFinite(savedN) && savedN > 0 ? savedN : DEFAULT_N}" class="wl-input" placeholder="Enter count..." />
        </div>

        <div class="wl-section" style="padding-top: 8px;">
          <label class="wl-label">
            <input id="wl-remove-dry-run" type="checkbox" class="wl-checkbox" checked />
            <span>Dry run <span style="color: #aaa; font-size: 12px;">(preview only)</span></span>
          </label>
          <label class="wl-label">
            <input id="wl-export-on-run" type="checkbox" class="wl-checkbox" />
            <span>Export JSON during scan</span>
          </label>
          <label class="wl-label">
            <input id="wl-save-deleted-on-run" type="checkbox" class="wl-checkbox" />
            <span>Save deleted videos to JSON</span>
          </label>
          <label class="wl-label">
            <input id="wl-export-include-raw" type="checkbox" class="wl-checkbox" />
            <span>Include raw renderer data</span>
          </label>
        </div>

        <div class="wl-section" style="padding-bottom: 8px;">
          <details>
            <summary>Advanced Settings</summary>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 8px;">
              <label style="display: block;">
                <span style="display: block; margin-bottom: 6px; color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;">Scan delay (ms)</span>
                <input id="wl-adv-scan-delay" type="number" min="0" step="10" value="${savedAdvanced.scanPageThrottleMs}" class="wl-input" style="padding: 8px 10px; font-size: 13px;" />
              </label>
              <label style="display: block;">
                <span style="display: block; margin-bottom: 6px; color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;">Delete delay (ms)</span>
                <input id="wl-adv-delete-delay" type="number" min="0" step="10" value="${savedAdvanced.deleteThrottleMs}" class="wl-input" style="padding: 8px 10px; font-size: 13px;" />
              </label>
              <label style="display: block;">
                <span style="display: block; margin-bottom: 6px; color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;">Sort verify attempts</span>
                <input id="wl-adv-sort-attempts" type="number" min="1" step="1" value="${savedAdvanced.sortVerifyMaxAttempts}" class="wl-input" style="padding: 8px 10px; font-size: 13px;" />
              </label>
              <label style="display: block;">
                <span style="display: block; margin-bottom: 6px; color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;">Sort poll (ms)</span>
                <input id="wl-adv-sort-poll" type="number" min="0" step="10" value="${savedAdvanced.sortVerifyPollMs}" class="wl-input" style="padding: 8px 10px; font-size: 13px;" />
              </label>
              <label style="display: block; grid-column: 1 / -1;">
                <span style="display: block; margin-bottom: 6px; color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;">Batch delete count</span>
                <input id="wl-adv-batch-count" type="number" min="1" max="50" step="1" value="${savedAdvanced.batchDeleteCount}" class="wl-input" style="padding: 8px 10px; font-size: 13px;" />
              </label>
            </div>
          </details>
        </div>

        <div style="display: flex; gap: 8px; padding: 8px 0 16px;">
          <button id="wl-remove-run" class="wl-btn wl-btn-primary" style="flex: 1;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Run
          </button>
          <button id="wl-remove-stop" class="wl-btn wl-btn-danger" style="flex: 1;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
            Stop
          </button>
          <button id="wl-export-json" class="wl-btn wl-btn-secondary" style="flex: 1;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            Export
          </button>
        </div>

        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500;">Activity Log</span>
          </div>
          <pre id="wl-remove-log" class="wl-log"></pre>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    const logEl = wrap.querySelector('#wl-remove-log');
    const runBtn = wrap.querySelector('#wl-remove-run');
    const stopBtn = wrap.querySelector('#wl-remove-stop');
    const exportBtn = wrap.querySelector('#wl-export-json');
    const dismissBtn = wrap.querySelector('#wl-panel-dismiss');
    const inputEl = wrap.querySelector('#wl-remove-n-input');
    const dryRunEl = wrap.querySelector('#wl-remove-dry-run');
    const exportOnRunEl = wrap.querySelector('#wl-export-on-run');
    const saveDeletedOnRunEl = wrap.querySelector('#wl-save-deleted-on-run');
    const exportIncludeRawEl = wrap.querySelector('#wl-export-include-raw');
    const advScanDelayEl = wrap.querySelector('#wl-adv-scan-delay');
    const advDeleteDelayEl = wrap.querySelector('#wl-adv-delete-delay');
    const advSortAttemptsEl = wrap.querySelector('#wl-adv-sort-attempts');
    const advSortPollEl = wrap.querySelector('#wl-adv-sort-poll');
    const advBatchCountEl = wrap.querySelector('#wl-adv-batch-count');

    const showPanel = () => {
      wrap.style.display = 'block';
    };
    const hidePanel = () => {
      wrap.style.display = 'none';
    };

    const mountLauncherWithRetry = () => {
      let attempts = 0;
      const tryMount = () => {
        if (ensureLauncherButton(showPanel)) {
          return;
        }
        attempts += 1;
        if (attempts < 40) {
          setTimeout(tryMount, 500);
        }
      };
      tryMount();
    };
    mountLauncherWithRetry();

    window.addEventListener(
      'yt-navigate-finish',
      () => {
        if (!isWatchLaterPage()) {
          hidePanel();
          document.getElementById(LAUNCHER_ID)?.remove();
          return;
        }
        mountLauncherWithRetry();
      },
      { passive: true }
    );
    dismissBtn.addEventListener('click', () => {
      hidePanel();
    });

    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logEl.textContent += `${line}\n`;
      logEl.scrollTop = logEl.scrollHeight;
      console.log('[WL Remove Last N]', msg);
    };

    runBtn.addEventListener('click', async () => {
      if (STATE.running) {
        log('Already running.');
        return;
      }

      STATE.running = true;
      STATE.shouldStop = false;

      runBtn.disabled = true;
      exportBtn.disabled = true;
      stopBtn.disabled = false;

      let n = NaN;
      let dryRun = false;
      let exportOnRun = false;
      let includeRawRenderer = false;
      let saveDeletedOnRun = false;
      let advancedSettings = { ...ADVANCED_DEFAULTS };
      const runStartedAt = new Date().toISOString();
      let runCompleted = false;
      let runErrorMessage = '';
      const deletedEntries = [];

      try {
        n = Number(inputEl.value);
        dryRun = !!dryRunEl.checked;
        exportOnRun = !!exportOnRunEl.checked;
        includeRawRenderer = !!exportIncludeRawEl.checked;
        saveDeletedOnRun = !!saveDeletedOnRunEl.checked;
        advancedSettings = saveAdvancedSettings({
          scanPageThrottleMs: Number(advScanDelayEl.value),
          deleteThrottleMs: Number(advDeleteDelayEl.value),
          sortVerifyMaxAttempts: Number(advSortAttemptsEl.value),
          sortVerifyPollMs: Number(advSortPollEl.value),
          batchDeleteCount: Number(advBatchCountEl.value),
        });
        advScanDelayEl.value = String(advancedSettings.scanPageThrottleMs);
        advDeleteDelayEl.value = String(advancedSettings.deleteThrottleMs);
        advSortAttemptsEl.value = String(advancedSettings.sortVerifyMaxAttempts);
        advSortPollEl.value = String(advancedSettings.sortVerifyPollMs);
        advBatchCountEl.value = String(advancedSettings.batchDeleteCount);

        if (!Number.isFinite(n) || n < 1) {
          throw new Error('N must be a positive number.');
        }
        n = Math.floor(n);

        localStorage.setItem(STORAGE_KEY, String(n));

        log(`Scanning Watch Later... target remove count: ${n}.`);
        log(
          `Advanced settings: scanDelay=${advancedSettings.scanPageThrottleMs}ms, deleteDelay=${advancedSettings.deleteThrottleMs}ms, sortVerify=${advancedSettings.sortVerifyMaxAttempts} attempts @ ${advancedSettings.sortVerifyPollMs}ms, batchDelete=${advancedSettings.batchDeleteCount}.`
        );
        log(`Forcing Watch Later sort to oldest-first (playlistVideoOrder=${WL_OLDEST_SORT_ORDER})...`);
        const verifiedSort = await ensureWatchLaterOrderOldest(log, advancedSettings);
        log(
          `Selection rule: delete from the START of oldest-first order (${verifiedSort?.selectedTitle || 'Date added (oldest)'}).`
        );

        const scanResult = await fetchAllWatchLaterEntries(log, false, {
          includeRawRenderer: exportOnRun ? includeRawRenderer : false,
          withMeta: exportOnRun,
          pageThrottleMs: advancedSettings.scanPageThrottleMs,
          requireSortOrder: WL_OLDEST_SORT_ORDER,
        });
        const entries = exportOnRun ? scanResult.entries : scanResult;

        if (entries.length === 0) {
          throw new Error('No playlist entries found.');
        }

        if (exportOnRun) {
          log(`Run export enabled. includeRawRenderer=${includeRawRenderer ? 'yes' : 'no'}.`);
          saveExportFromScanResult(log, scanResult, 'watch-later-backup-pre-delete');
        }

        if (dryRun && saveDeletedOnRun) {
          log('Save-deleted option is ignored in dry run (nothing is deleted).');
        }

        const removeCount = Math.min(n, entries.length);
        const targets = entries.slice(0, removeCount);
        const batchDeleteCount = Math.min(advancedSettings.batchDeleteCount, Math.max(1, removeCount));
        log(`Playlist size detected: ${entries.length}. Oldest ${removeCount} entries selected.`);
        log('Deletion order: from oldest towards newer.');
        log(`Delete execution: batchSize=${batchDeleteCount}, inter-request delay=${advancedSettings.deleteThrottleMs}ms.`);

        if (dryRun) {
          log('Dry run enabled. No deletion performed.');
          log(`First deletion target (oldest): ${formatEntry(targets[0])}`);
          log(`Last deletion target (newer edge): ${formatEntry(targets[targets.length - 1])}`);
          return;
        }

        let removedCount = 0;
        const recordDeleted = (target, modeLabel) => {
          removedCount += 1;
          const modeText = modeLabel ? ` [${modeLabel}]` : '';
          log(
            `Removed ${removedCount}/${targets.length}${modeText}: videoId=${target.videoId || 'unknown'} | title="${safeText(target.title) || 'unknown'}" | setVideoId=${target.setVideoId}`
          );
          deletedEntries.push({
            deleteIndex: removedCount,
            deletedAt: new Date().toISOString(),
            orderIndexAtScan: Number.isFinite(target.orderIndex) ? target.orderIndex : null,
            setVideoId: target.setVideoId,
            videoId: target.videoId || '',
            title: safeText(target.title) || '',
            channelName: safeText(target.channelName) || '',
            publishedTimeText: safeText(target.publishedTimeText) || '',
            lengthText: safeText(target.lengthText) || '',
          });
        };

        const processOneTarget = async (initialTarget) => {
          let target = initialTarget;
          try {
            await removeFromWatchLater(target.setVideoId);
          } catch (err) {
            if (!shouldRetryWithRescan(err)) {
              throw err;
            }

            log(`Delete failed for ${formatEntry(target)}. Rescanning to refresh setVideoId...`);
            const freshEntries = await fetchAllWatchLaterEntries(log, true, {
              pageThrottleMs: advancedSettings.scanPageThrottleMs,
              requireSortOrder: WL_OLDEST_SORT_ORDER,
            });
            const replacement = findReplacementEntry(freshEntries, target);
            if (!replacement) {
              throw new Error(
                `Delete failed and item could not be uniquely matched after rescan. Avoid playlist changes while running (sort/add/remove/reorder from any device/session); duplicate rows can also cause ambiguity. Original: ${formatEntry(target)}`
              );
            }

            target = replacement;
            await removeFromWatchLater(target.setVideoId);
            log(`Recovered with refreshed setVideoId for videoId=${target.videoId || 'unknown'}.`);
          }
          recordDeleted(target, 'single');
        };

        log(batchDeleteCount > 1 ? `Deleting in batches of up to ${batchDeleteCount}...` : 'Deleting...');
        for (let cursor = 0; cursor < targets.length; cursor += batchDeleteCount) {
          if (STATE.shouldStop) {
            throw new Error('Stopped by user.');
          }

          const batchTargets = targets.slice(cursor, cursor + batchDeleteCount);
          if (batchTargets.length > 1) {
            try {
              await removeFromWatchLaterBatch(batchTargets.map((t) => t.setVideoId));
              for (const batchTarget of batchTargets) {
                recordDeleted(batchTarget, 'batch');
              }
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              log(
                `Batch delete request failed for ${batchTargets.length} item(s). Falling back to per-item for this batch. Error: ${errMsg}`
              );
              for (const batchTarget of batchTargets) {
                if (STATE.shouldStop) {
                  throw new Error('Stopped by user.');
                }
                await processOneTarget(batchTarget);
              }
            }
          } else {
            await processOneTarget(batchTargets[0]);
          }

          if (cursor + batchDeleteCount < targets.length) {
            await sleep(advancedSettings.deleteThrottleMs);
          }
        }

        log(`Done. Removed ${targets.length} video(s) from Watch Later.`);
        runCompleted = true;
      } catch (err) {
        runErrorMessage = err && err.message ? err.message : String(err);
        log(`Error: ${runErrorMessage}`);
      } finally {
        if (saveDeletedOnRun && !dryRun) {
          if (deletedEntries.length > 0) {
            try {
              saveDeletedVideosExport(log, deletedEntries, {
                startedAt: runStartedAt,
                finishedAt: new Date().toISOString(),
                requestedDeleteCount: Number.isFinite(n) ? Math.floor(n) : null,
                deletedCount: deletedEntries.length,
                advancedSettings,
                completed: runCompleted,
                error: runErrorMessage || null,
              });
            } catch (exportErr) {
              log(`Error: failed to save deleted-videos export: ${exportErr && exportErr.message ? exportErr.message : String(exportErr)}`);
            }
          } else if (!runCompleted) {
            log('No deleted items to export for this run.');
          }
        }

        STATE.running = false;
        runBtn.disabled = false;
        exportBtn.disabled = false;
        stopBtn.disabled = true;
      }
    });

    exportBtn.addEventListener('click', async () => {
      if (STATE.running) {
        log('Already running.');
        return;
      }

      STATE.running = true;
      STATE.shouldStop = false;

      runBtn.disabled = true;
      exportBtn.disabled = true;
      stopBtn.disabled = false;

      try {
        const includeRawRenderer = !!exportIncludeRawEl.checked;
        const advancedSettings = saveAdvancedSettings({
          scanPageThrottleMs: Number(advScanDelayEl.value),
          deleteThrottleMs: Number(advDeleteDelayEl.value),
          sortVerifyMaxAttempts: Number(advSortAttemptsEl.value),
          sortVerifyPollMs: Number(advSortPollEl.value),
          batchDeleteCount: Number(advBatchCountEl.value),
        });
        advScanDelayEl.value = String(advancedSettings.scanPageThrottleMs);
        advDeleteDelayEl.value = String(advancedSettings.deleteThrottleMs);
        advSortAttemptsEl.value = String(advancedSettings.sortVerifyMaxAttempts);
        advSortPollEl.value = String(advancedSettings.sortVerifyPollMs);
        advBatchCountEl.value = String(advancedSettings.batchDeleteCount);
        log(`Scanning Watch Later for JSON export... includeRawRenderer=${includeRawRenderer ? 'yes' : 'no'}.`);
        const result = await fetchAllWatchLaterEntries(log, false, {
          includeRawRenderer,
          withMeta: true,
          pageThrottleMs: advancedSettings.scanPageThrottleMs,
        });
        saveExportFromScanResult(log, result, 'watch-later-backup');
      } catch (err) {
        log(`Error: ${err && err.message ? err.message : String(err)}`);
      } finally {
        STATE.running = false;
        runBtn.disabled = false;
        exportBtn.disabled = false;
        stopBtn.disabled = true;
      }
    });

    stopBtn.addEventListener('click', () => {
      if (!STATE.running) {
        log('Not running.');
        return;
      }
      STATE.shouldStop = true;
      log('Stop requested. Waiting for current request to finish...');
    });

    stopBtn.disabled = true;
    log('Ready. Start with Dry run checked.');
    log('Tip: script forces oldest-first order before deletion, so it targets oldest-added videos.');
  }

  function init() {
    if (!isWatchLaterPage()) {
      return;
    }

    if (document.getElementById(PANEL_ID)) {
      return;
    }

    createUi();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
