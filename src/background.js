const MAX_ITEMS_PER_TAB = 100;
const STORE_KEY = "mediaCatcherTabs";

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "flv",
  "avi",
  "wmv",
  "mpg",
  "mpeg",
  "3gp"
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "flac",
  "weba"
]);

const SEGMENT_EXTENSIONS = new Set([
  "ts",
  "m2ts",
  "m4s",
  "cmfv",
  "cmfa"
]);

const YOUTUBE_TRANSIENT_PARAMS = new Set([
  "alr",
  "cpn",
  "range",
  "rbuf",
  "rn"
]);

let hydrated = false;
let persistTimer = null;
const mediaByTab = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0) {
      return;
    }

    const classified = classifyUrl(details.url);
    if (!classified) {
      return;
    }

    void recordCandidate({
      tabId: details.tabId,
      url: details.url,
      kind: classified.kind,
      ext: classified.ext,
      source: "network",
      resourceType: details.type,
      createdAt: Date.now(),
      lastSeen: Date.now()
    });
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "object", "other"]
  }
);

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || !details.responseHeaders) {
      return;
    }

    const headers = readHeaders(details.responseHeaders);
    const classified = classifyResponse(details.url, headers, details.type);
    if (!classified) {
      return;
    }

    void recordCandidate({
      tabId: details.tabId,
      url: details.url,
      kind: classified.kind,
      ext: classified.ext,
      source: "network",
      resourceType: details.type,
      mime: headers.contentType || "",
      size: headers.totalLength || headers.contentLength || null,
      filename: inferFilename(details.url, classified.kind, headers.contentDisposition),
      createdAt: Date.now(),
      lastSeen: Date.now()
    });
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "object", "other"]
  },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener(tabId => {
  mediaByTab.delete(String(tabId));
  schedulePersist();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      if (!message || typeof message.type !== "string") {
        sendResponse({ ok: false, error: "Unknown message." });
        return;
      }

      if (message.type === "MEDIA_CATCHER_CONTENT_CANDIDATES") {
        const tabId = sender.tab?.id;
        if (typeof tabId !== "number" || tabId < 0) {
          sendResponse({ ok: true, count: 0 });
          return;
        }

        let count = 0;
        for (const candidate of message.candidates || []) {
          const saved = await recordCandidate({
            ...candidate,
            tabId,
            pageUrl: candidate.pageUrl || message.pageUrl || sender.url || sender.tab?.url || "",
            pageTitle: candidate.pageTitle || message.pageTitle || sender.tab?.title || "",
            source: candidate.source || "page",
            frameId: sender.frameId,
            createdAt: Date.now(),
            lastSeen: Date.now()
          });
          if (saved) {
            count += 1;
          }
        }

        sendResponse({ ok: true, count });
        return;
      }

      if (message.type === "MEDIA_CATCHER_GET_TAB") {
        await hydrateStore();
        const tabId = String(message.tabId);
        const items = prepareTabItems(Array.from(mediaByTab.get(tabId)?.values() || []));
        items.sort(sortDisplayItems);
        sendResponse({ ok: true, items });
        return;
      }

      if (message.type === "MEDIA_CATCHER_CLEAR_TAB") {
        await hydrateStore();
        mediaByTab.delete(String(message.tabId));
        schedulePersist();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "MEDIA_CATCHER_CAPTURE_VISIBLE_THUMBNAIL") {
        const thumbnail = await captureVisibleThumbnail(sender.tab?.windowId, message.rect || {});
        sendResponse({ ok: Boolean(thumbnail), thumbnail });
        return;
      }

      if (message.type === "MEDIA_CATCHER_DOWNLOAD_DIRECT") {
        const id = await downloadDirect(message.item);
        sendResponse({ ok: true, downloadId: id });
        return;
      }

      if (message.type === "MEDIA_CATCHER_OPEN_DOWNLOADER") {
        const tab = await openDownloader(message.item);
        sendResponse({ ok: true, tabId: tab?.id || null });
        return;
      }

      if (message.type === "MEDIA_CATCHER_MERGE_DASH") {
        const result = await mergeDashTracks(message.item);
        sendResponse({ ok: true, ...result });
        return;
      }

      if (message.type === "MEDIA_CATCHER_FETCH_TEXT") {
        const data = await fetchText(message.url);
        sendResponse({ ok: true, ...data });
        return;
      }

      sendResponse({ ok: false, error: `Unsupported message: ${message.type}` });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});

async function recordCandidate(candidate) {
  if (!candidate || !candidate.url || typeof candidate.tabId !== "number") {
    return false;
  }

  if (isIgnoredMediaUrl(candidate.url)) {
    return false;
  }

  if (!isRecordableScheme(candidate.url)) {
    return false;
  }

  const enriched = await enrichWithTabInfo(candidate);
  const classified = classifyUrl(enriched.url) || classifyKind(enriched.kind);
  if (!classified && enriched.kind !== "blob") {
    return false;
  }

  await hydrateStore();

  const tabKey = String(candidate.tabId);
  let tabMedia = mediaByTab.get(tabKey);
  if (!tabMedia) {
    tabMedia = new Map();
    mediaByTab.set(tabKey, tabMedia);
  }

  const kind = classified.kind || enriched.kind;
  const canonicalUrl = canonicalMediaUrl(enriched.url, kind);
  const normalized = normalizeCandidate({
    ...enriched,
    url: canonicalUrl,
    kind,
    ext: enriched.ext || classified.ext || "",
    id: makeId(canonicalUrl, kind)
  });

  const old = tabMedia.get(normalized.id);
  tabMedia.set(normalized.id, mergeCandidate(old, normalized));

  trimTab(tabMedia);
  schedulePersist();
  return true;
}

function normalizeCandidate(candidate) {
  const kind = candidate.kind || "video";
  const canonicalUrl = canonicalMediaUrl(candidate.url, kind);
  const urlFilename = inferFilename(canonicalUrl, kind);
  const displayName = buildDisplayName(candidate, urlFilename, kind);
  const filename = buildDownloadFilename(candidate, displayName, urlFilename, kind);
  const size = inferMediaSize(candidate.size, canonicalUrl);
  const mime = candidate.mime || inferMimeParam(canonicalUrl);

  return {
    id: candidate.id,
    tabId: candidate.tabId,
    frameId: candidate.frameId ?? null,
    url: canonicalUrl,
    pageUrl: candidate.pageUrl || "",
    pageTitle: candidate.pageTitle || "",
    displayName,
    filename,
    thumbnail: validThumbnail(candidate.thumbnail) ? candidate.thumbnail : "",
    kind,
    ext: candidate.ext || extensionFromUrl(candidate.url) || mimeToExtension(mime) || "",
    trackType: candidate.trackType || inferTrackType(candidate.url, mime),
    mime,
    size,
    width: Number.isFinite(candidate.width) ? candidate.width : null,
    height: Number.isFinite(candidate.height) ? candidate.height : null,
    duration: Number.isFinite(candidate.duration) ? candidate.duration : null,
    bitrate: Number.isFinite(candidate.bitrate) ? candidate.bitrate : inferNumberParam(canonicalUrl, "bitrate"),
    itag: candidate.itag || inferTextParam(canonicalUrl, "itag"),
    qualityLabel: candidate.qualityLabel || "",
    resourceType: candidate.resourceType || "",
    source: candidate.source || "network",
    firstSeen: candidate.firstSeen || Date.now(),
    lastSeen: candidate.lastSeen || Date.now()
  };
}

function mergeCandidate(old, next) {
  if (!old) {
    return next;
  }

  return {
    ...old,
    ...next,
    pageUrl: next.pageUrl || old.pageUrl || "",
    pageTitle: betterTitle(next.pageTitle, old.pageTitle),
    displayName: betterTitle(next.displayName, old.displayName),
    filename: betterFilename(next.filename, old.filename),
    mime: next.mime || old.mime || "",
    trackType: next.trackType || old.trackType || "",
    size: betterSize(next.size, old.size),
    thumbnail: next.thumbnail || old.thumbnail || "",
    width: next.width || old.width || null,
    height: next.height || old.height || null,
    duration: next.duration || old.duration || null,
    bitrate: next.bitrate || old.bitrate || null,
    itag: next.itag || old.itag || "",
    qualityLabel: next.qualityLabel || old.qualityLabel || "",
    resourceType: next.resourceType || old.resourceType || "",
    firstSeen: old.firstSeen || next.firstSeen || Date.now(),
    lastSeen: Date.now(),
    source: mergeSource(old.source, next.source)
  };
}

function withBorrowedThumbnails(items) {
  const sources = items.filter(item => item.thumbnail && item.kind !== "audio");
  if (!sources.length) {
    return items;
  }

  return items.map(item => {
    if (item.thumbnail || item.kind === "audio") {
      return item;
    }

    const source = sources
      .map(candidate => ({
        candidate,
        score: thumbnailScore(item, candidate)
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate;

    return source ? { ...item, thumbnail: source.thumbnail } : item;
  });
}

function thumbnailScore(item, source) {
  let score = 0;
  if (item.pageUrl && source.pageUrl && item.pageUrl === source.pageUrl) {
    score += 50;
  }
  if (item.pageTitle && source.pageTitle && item.pageTitle === source.pageTitle) {
    score += 16;
  }
  if (item.width && source.width) {
    score += Math.max(0, 20 - Math.abs(item.width - source.width) / 40);
  }
  if (item.height && source.height) {
    score += Math.max(0, 20 - Math.abs(item.height - source.height) / 24);
  }
  if (item.duration && source.duration) {
    score += Math.max(0, 20 - Math.abs(item.duration - source.duration));
  }
  if (!item.width && !item.height && item.pageUrl && source.pageUrl && item.pageUrl === source.pageUrl) {
    score += 8;
  }
  return score;
}

function prepareTabItems(items) {
  const filtered = items.filter(item => !isIgnoredMediaUrl(item.url));
  const withThumbs = withBorrowedThumbnails(filtered);
  const mux = buildDashMuxItem(withThumbs);
  const visible = displayItems(withThumbs, mux);
  const pending = mux ? null : buildDashPendingItem(withThumbs);
  if (mux) {
    return [mux, ...visible];
  }
  if (pending) {
    return [pending, ...visible];
  }
  return visible;
}

function displayItems(items, mux) {
  return items.filter(item => {
    if (item.kind === "dash_track") {
      return false;
    }
    if (mux && samePage(item, mux) && (item.kind === "blob" || item.kind === "dash" || item.kind === "audio")) {
      return false;
    }
    if (isYouTubePage(item.pageUrl) && item.kind === "audio") {
      return false;
    }
    return true;
  });
}

function buildDashMuxItem(items) {
  const tracks = items.filter(item => item.kind === "dash_track" && isSupportedScheme(item.url));
  const video = tracks
    .filter(item => item.trackType === "video" || item.mime.startsWith("video/"))
    .sort(sortTrackQuality)[0];
  const audio = tracks
    .filter(item => item.trackType === "audio" || item.mime.startsWith("audio/"))
    .sort(sortTrackQuality)[0];

  if (!video || !audio) {
    return null;
  }

  const base = video.pageTitle || audio.pageTitle || "video";
  const displayName = cleanTitle(base) || "DASH video";
  const thumbnail = video.thumbnail || bestThumbnail(items, video.pageUrl || audio.pageUrl) || audio.thumbnail || "";
  const container = isMp4CompatibleTrack(video) && isMp4CompatibleTrack(audio) ? "mp4" : "mkv";
  return {
    id: `dash_mux_${video.id}_${audio.id}`,
    tabId: video.tabId || audio.tabId,
    frameId: video.frameId ?? audio.frameId ?? null,
    url: video.url,
    audioUrl: audio.url,
    videoUrl: video.url,
    pageUrl: video.pageUrl || audio.pageUrl || "",
    pageTitle: video.pageTitle || audio.pageTitle || "",
    displayName,
    filename: cleanFilename(`${displayName}.${container}`),
    thumbnail,
    kind: "dash_mux",
    ext: container,
    container,
    mime: container === "mp4" ? "video/mp4" : "video/x-matroska",
    size: (video.size || 0) + (audio.size || 0) || null,
    width: video.width || null,
    height: video.height || null,
    duration: video.duration || audio.duration || null,
    resourceType: "dash",
    source: "dash-mux",
    firstSeen: Math.min(video.firstSeen || Date.now(), audio.firstSeen || Date.now()),
    lastSeen: Math.max(video.lastSeen || 0, audio.lastSeen || 0),
    videoTrack: video,
    audioTrack: audio
  };
}

function buildDashPendingItem(items) {
  const tracks = items.filter(item => item.kind === "dash_track" && isSupportedScheme(item.url));
  if (!tracks.length) {
    return null;
  }

  const video = tracks.find(item => item.trackType === "video" || item.mime.startsWith("video/"));
  const audio = tracks.find(item => item.trackType === "audio" || item.mime.startsWith("audio/"));
  const anchor = (video || audio || tracks[0]);
  const base = anchor.pageTitle || "DASH video";
  const displayName = cleanTitle(base) || "DASH video";
  const missing = [
    video ? "" : "video",
    audio ? "" : "audio"
  ].filter(Boolean);

  return {
    id: `dash_pending_${anchor.tabId || "tab"}_${hashString(anchor.pageUrl || anchor.url)}`,
    tabId: anchor.tabId,
    frameId: anchor.frameId ?? null,
    url: anchor.url,
    pageUrl: anchor.pageUrl || "",
    pageTitle: anchor.pageTitle || "",
    displayName,
    filename: cleanFilename(`${displayName}.mp4`),
    thumbnail: bestThumbnail(items, anchor.pageUrl) || anchor.thumbnail || "",
    kind: "dash_pending",
    ext: "mp4",
    mime: "video/mp4",
    size: null,
    width: video?.width || null,
    height: video?.height || null,
    duration: video?.duration || audio?.duration || null,
    missingTracks: missing,
    resourceType: "dash",
    source: "dash-pending",
    firstSeen: Math.min(...tracks.map(item => item.firstSeen || Date.now())),
    lastSeen: Math.max(...tracks.map(item => item.lastSeen || 0))
  };
}

function sortTrackQuality(left, right) {
  const scoreDiff = trackScore(right) - trackScore(left);
  if (scoreDiff) {
    return scoreDiff;
  }
  return (right.lastSeen || 0) - (left.lastSeen || 0);
}

function sortDisplayItems(left, right) {
  const rankDiff = displayRank(left) - displayRank(right);
  if (rankDiff) {
    return rankDiff;
  }
  return (right.lastSeen || 0) - (left.lastSeen || 0);
}

function displayRank(item) {
  if (item.kind === "dash_mux") {
    return 0;
  }
  if (item.kind === "dash_pending") {
    return 1;
  }
  return 10;
}

function trackScore(item) {
  const pixels = (item.width || 0) * (item.height || 0);
  const bitrate = item.bitrate || 0;
  const size = item.size || 0;
  const containerBonus = isMp4CompatibleTrack(item) ? 1_000_000_000_000 : 0;
  if (item.trackType === "video" || item.mime.startsWith("video/")) {
    return containerBonus + pixels * 1000 + bitrate + Math.round(size / 1024);
  }
  return containerBonus + bitrate * 10 + Math.round(size / 1024);
}

function bestThumbnail(items, pageUrl = "") {
  return items
    .filter(item => item.thumbnail && item.kind !== "audio")
    .map(item => ({
      item,
      score: (pageUrl && item.pageUrl === pageUrl ? 100 : 0) + (item.kind === "blob" ? 20 : 0) + (item.kind === "video" ? 10 : 0)
    }))
    .sort((a, b) => b.score - a.score)[0]?.item.thumbnail || "";
}

function samePage(left, right) {
  return Boolean(left?.pageUrl && right?.pageUrl && left.pageUrl === right.pageUrl);
}

function classifyUrl(rawUrl) {
  if (isIgnoredMediaUrl(rawUrl)) {
    return null;
  }

  if (!isSupportedScheme(rawUrl)) {
    if (rawUrl?.startsWith("blob:")) {
      return { kind: "blob", ext: "" };
    }
    return null;
  }

  const youtubeTrack = classifyYouTubeDashTrack(rawUrl, "");
  if (youtubeTrack) {
    return youtubeTrack;
  }

  const ext = extensionFromUrl(rawUrl);
  const lower = rawUrl.toLowerCase();

  if (ext === "m3u8" || lower.includes(".m3u8")) {
    return { kind: "hls", ext: "m3u8" };
  }

  if (ext === "mpd" || lower.includes(".mpd")) {
    return { kind: "dash", ext: "mpd" };
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    return { kind: "video", ext };
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    return { kind: "audio", ext };
  }

  if (SEGMENT_EXTENSIONS.has(ext)) {
    return null;
  }

  return null;
}

function classifyKind(kind) {
  if (["video", "audio", "hls", "dash", "dash_track", "blob"].includes(kind)) {
    return { kind, ext: "" };
  }
  return null;
}

function classifyResponse(rawUrl, responseInfo, resourceType, fallbackLength = null) {
  if (isIgnoredMediaUrl(rawUrl)) {
    return null;
  }

  const ext = extensionFromUrl(rawUrl);
  const headers = typeof responseInfo === "object" && responseInfo
    ? responseInfo
    : { contentType: responseInfo || "", contentLength: fallbackLength };
  const contentType = headers.contentType || "";
  const contentLength = headers.contentLength || null;
  const totalLength = headers.totalLength || contentLength || null;
  const mime = String(contentType || "").toLowerCase().split(";")[0].trim();
  const youtubeTrack = classifyYouTubeDashTrack(rawUrl, mime);
  if (youtubeTrack) {
    return youtubeTrack;
  }

  if (mime.includes("mpegurl") || mime.includes("x-mpegurl") || mime === "application/vnd.apple.mpegurl") {
    return { kind: "hls", ext: "m3u8" };
  }

  if (mime.includes("dash+xml")) {
    return { kind: "dash", ext: "mpd" };
  }

  if (mime === "application/iso.segment") {
    return null;
  }

  if (mime.includes("mp4")) {
    if (isLikelySmallSegment(ext, mime, resourceType, contentLength)) {
      return null;
    }
    return { kind: "video", ext: ext || "mp4" };
  }

  if (mime.startsWith("video/")) {
    if (isLikelySmallSegment(ext, mime, resourceType, contentLength)) {
      return null;
    }
    return { kind: "video", ext: ext || mimeToExtension(mime) };
  }

  if (mime.startsWith("audio/")) {
    if (isLikelySmallSegment(ext, mime, resourceType, contentLength)) {
      return null;
    }
    return { kind: "audio", ext: ext || mimeToExtension(mime) };
  }

  const byUrl = classifyUrl(rawUrl);
  if (byUrl) {
    return byUrl;
  }

  const dispositionExt = extensionFromDisposition(headers.contentDisposition);
  if (VIDEO_EXTENSIONS.has(dispositionExt)) {
    return { kind: "video", ext: dispositionExt };
  }
  if (AUDIO_EXTENSIONS.has(dispositionExt)) {
    return { kind: "audio", ext: dispositionExt };
  }

  if (mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "") {
    if (looksLikeVideoUrl(rawUrl) && totalLength && totalLength >= 256 * 1024) {
      return { kind: "video", ext: ext || dispositionExt || "mp4" };
    }

    if (resourceType === "media" && totalLength && totalLength >= 512 * 1024) {
      return { kind: "video", ext: ext || dispositionExt || "mp4" };
    }

    if (headers.contentRange && totalLength && totalLength >= 3 * 1024 * 1024 && looksLikeMediaRequest(rawUrl, resourceType)) {
      return { kind: "video", ext: ext || dispositionExt || "mp4" };
    }
  }

  return null;
}

function isLikelySmallSegment(ext, mime, resourceType, contentLength) {
  if (!SEGMENT_EXTENSIONS.has(ext) && !mime.includes("mp2t")) {
    return false;
  }

  if (resourceType === "media" && contentLength && contentLength > 25 * 1024 * 1024) {
    return false;
  }

  return true;
}

function readHeaders(headers) {
  const data = {
    contentType: "",
    contentLength: null,
    totalLength: null,
    contentDisposition: "",
    contentRange: "",
    acceptRanges: ""
  };

  for (const header of headers) {
    const name = String(header.name || "").toLowerCase();
    const value = header.value || "";
    if (name === "content-type") {
      data.contentType = value;
    }
    if (name === "content-length") {
      const parsed = Number(value);
      data.contentLength = Number.isFinite(parsed) ? parsed : null;
    }
    if (name === "content-range") {
      data.contentRange = value;
      data.totalLength = totalLengthFromContentRange(value);
    }
    if (name === "accept-ranges") {
      data.acceptRanges = value;
    }
    if (name === "content-disposition") {
      data.contentDisposition = value;
    }
  }

  return data;
}

async function captureVisibleThumbnail(windowId, rect) {
  if (typeof windowId !== "number") {
    return "";
  }

  if (!globalThis.createImageBitmap || !globalThis.OffscreenCanvas) {
    return "";
  }

  const normalized = normalizeCaptureRect(rect);
  if (!normalized) {
    return "";
  }

  const screenshotUrl = await captureVisibleTab(windowId);
  if (!screenshotUrl) {
    return "";
  }

  const blob = await (await fetch(screenshotUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const source = clampCaptureRect(normalized, bitmap.width, bitmap.height);
  if (!source) {
    bitmap.close?.();
    return "";
  }

  const outputWidth = 160;
  const outputHeight = Math.max(1, Math.round((source.height / source.width) * outputWidth));
  const canvas = new OffscreenCanvas(outputWidth, Math.min(120, outputHeight));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return "";
  }

  ctx.fillStyle = "#111820";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const drawHeight = Math.min(outputHeight, canvas.height);
  const offsetY = Math.max(0, (canvas.height - drawHeight) / 2);
  ctx.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, offsetY, outputWidth, drawHeight);
  bitmap.close?.();

  const outBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: 0.72
  });
  return arrayBufferToDataUrl(await outBlob.arrayBuffer(), "image/jpeg");
}

function captureVisibleTab(windowId) {
  return new Promise(resolve => {
    try {
      chrome.tabs.captureVisibleTab(
        windowId,
        {
          format: "jpeg",
          quality: 72
        },
        dataUrl => {
          if (chrome.runtime.lastError) {
            resolve("");
            return;
          }
          resolve(dataUrl || "");
        }
      );
    } catch {
      resolve("");
    }
  });
}

function normalizeCaptureRect(rect) {
  const ratio = Number(rect.devicePixelRatio) || 1;
  const viewportWidth = Number(rect.viewportWidth) || 0;
  const viewportHeight = Number(rect.viewportHeight) || 0;
  const x = Math.max(0, Number(rect.x) || 0);
  const y = Math.max(0, Number(rect.y) || 0);
  const right = Math.min(viewportWidth || Number.MAX_SAFE_INTEGER, x + (Number(rect.width) || 0));
  const bottom = Math.min(viewportHeight || Number.MAX_SAFE_INTEGER, y + (Number(rect.height) || 0));
  const width = right - x;
  const height = bottom - y;

  if (width < 48 || height < 36) {
    return null;
  }

  return {
    x: Math.round(x * ratio),
    y: Math.round(y * ratio),
    width: Math.round(width * ratio),
    height: Math.round(height * ratio)
  };
}

function clampCaptureRect(rect, maxWidth, maxHeight) {
  const x = Math.max(0, Math.min(maxWidth - 1, rect.x));
  const y = Math.max(0, Math.min(maxHeight - 1, rect.y));
  const width = Math.max(1, Math.min(rect.width, maxWidth - x));
  const height = Math.max(1, Math.min(rect.height, maxHeight - y));

  if (width < 24 || height < 18) {
    return null;
  }

  return { x, y, width, height };
}

function arrayBufferToDataUrl(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function totalLengthFromContentRange(value) {
  const match = /\/(\d+)\s*$/i.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extensionFromDisposition(disposition) {
  const filename = filenameFromDisposition(disposition);
  return extensionFromFilename(filename);
}

function looksLikeMediaRequest(rawUrl, resourceType) {
  return resourceType === "media" || looksLikeVideoUrl(rawUrl) || looksLikeAudioUrl(rawUrl);
}

function looksLikeVideoUrl(rawUrl) {
  const text = decodeMaybe(rawUrl).toLowerCase();
  return /(^|[?&/_=-])(video|media|play|stream|vod|xvod|mp4|m3u8|hls|dash|mse|source|movie|clip|aweme|feed|sns-video|videoplayback)([?&/_=-]|$)/i.test(text);
}

function looksLikeAudioUrl(rawUrl) {
  const text = decodeMaybe(rawUrl).toLowerCase();
  return /(^|[?&/_=-])(audio|music|sound|mp3|m4a|aac|opus)([?&/_=-]|$)/i.test(text);
}

function isIgnoredMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.toLowerCase();
    if ((host === "youtube.com" || host.endsWith(".youtube.com")) && path.endsWith(".mp3")) {
      return true;
    }
    if ((host === "youtube.com" || host.endsWith(".youtube.com")) && /\/s\/desktop\/.*\/(no_input|success|error|click|hover)\.mp3$/i.test(path)) {
      return true;
    }
    if ((host === "youtube.com" || host.endsWith(".youtube.com")) && /\/sounds\/.*\.mp3$/i.test(path)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function classifyYouTubeDashTrack(rawUrl, mime) {
  try {
    const url = new URL(rawUrl);
    if (!isYouTubeVideoplaybackUrl(url)) {
      return null;
    }

    const normalizedMime = mime || inferMimeParam(rawUrl);
    const trackType = inferTrackType(rawUrl, normalizedMime);
    return {
      kind: "dash_track",
      ext: mimeToExtension(normalizedMime) || (trackType === "audio" ? "m4a" : "mp4"),
      trackType
    };
  } catch {
    return null;
  }
}

function inferTrackType(rawUrl, mime = "") {
  const lowerMime = String(mime || "").toLowerCase();
  if (lowerMime.startsWith("audio/") || lowerMime.includes("audio")) {
    return "audio";
  }
  if (lowerMime.startsWith("video/") || lowerMime.includes("video")) {
    return "video";
  }

  try {
    const url = new URL(rawUrl);
    const mimeParam = decodeURIComponent(url.searchParams.get("mime") || "").toLowerCase();
    if (mimeParam.startsWith("audio/") || mimeParam.includes("audio")) {
      return "audio";
    }
    if (mimeParam.startsWith("video/") || mimeParam.includes("video")) {
      return "video";
    }
  } catch {
    // Ignore malformed URLs.
  }

  return "";
}

function inferMimeParam(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl).searchParams.get("mime") || "").toLowerCase();
  } catch {
    return "";
  }
}

function isMp4CompatibleTrack(item) {
  const mime = String(item?.mime || inferMimeParam(item?.url || "") || "").toLowerCase();
  return mime.includes("mp4") || mime.includes("mp4a") || mime.includes("avc1") || mime.includes("h264");
}

function decodeMaybe(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

async function downloadDirect(item) {
  if (!item?.url) {
    throw new Error("Missing download URL.");
  }

  if (item.kind === "dash_track") {
    throw new Error("This is a DASH audio/video track, not a complete video. It needs muxing with a dedicated tool.");
  }

  if (item.kind === "dash_pending") {
    throw new Error("The DASH video is not ready yet. Play the video a little longer and rescan.");
  }

  if (item.kind === "blob") {
    throw new Error("Blob URLs cannot be downloaded directly. Keep the page open and wait for the real media request.");
  }

  const filename = cleanFilename(item.filename || inferFilename(item.url, item.kind));
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: item.url,
        filename,
        saveAs: true,
        conflictAction: "uniquify"
      },
      id => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(id);
      }
    );
  });
}

async function openDownloader(item) {
  if (!item?.url) {
    throw new Error("Missing HLS URL.");
  }

  const params = new URLSearchParams({
    url: item.url,
    title: item.pageTitle || item.filename || "video",
    pageUrl: item.pageUrl || "",
    filename: item.filename || ""
  });

  return new Promise((resolve, reject) => {
    chrome.tabs.create(
      {
        url: chrome.runtime.getURL(`src/downloader.html?${params}`)
      },
      tab => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      }
    );
  });
}

async function mergeDashTracks(item) {
  if (!item?.videoUrl || !item?.audioUrl) {
    throw new Error("Missing DASH audio/video tracks.");
  }

  const response = await fetch("http://127.0.0.1:17382/merge", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      videoUrl: item.videoUrl,
      audioUrl: item.audioUrl,
      filename: item.filename || "video.mp4",
      container: item.container || item.ext || "mp4",
      referer: item.pageUrl || "",
      userAgent: navigator.userAgent || "Mozilla/5.0"
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Local helper failed to merge DASH tracks.");
  }

  return data;
}

async function fetchText(url) {
  if (!isSupportedScheme(url)) {
    throw new Error("Only http/https URLs are supported.");
  }

  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching manifest.`);
  }

  return {
    text: await response.text(),
    finalUrl: response.url,
    contentType: response.headers.get("content-type") || ""
  };
}

async function hydrateStore() {
  if (hydrated) {
    return;
  }

  hydrated = true;
  const area = storageArea();
  if (!area) {
    return;
  }

  const stored = await storageGet(area, STORE_KEY);
  const raw = stored?.[STORE_KEY] || {};
  for (const [tabId, items] of Object.entries(raw)) {
    const tabMedia = new Map();
    for (const item of items || []) {
      if (item?.id && item?.url) {
        tabMedia.set(item.id, item);
      }
    }
    if (tabMedia.size) {
      mediaByTab.set(tabId, tabMedia);
    }
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistStore();
  }, 250);
}

async function persistStore() {
  const area = storageArea();
  if (!area) {
    return;
  }

  const serializable = {};
  for (const [tabId, items] of mediaByTab.entries()) {
    serializable[tabId] = Array.from(items.values());
  }

  await storageSet(area, { [STORE_KEY]: serializable });
}

function storageArea() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

function storageGet(area, key) {
  return new Promise(resolve => {
    try {
      area.get(key, result => resolve(result || {}));
    } catch {
      resolve({});
    }
  });
}

function storageSet(area, value) {
  return new Promise(resolve => {
    try {
      area.set(value, () => resolve());
    } catch {
      resolve();
    }
  });
}

function trimTab(tabMedia) {
  if (tabMedia.size <= MAX_ITEMS_PER_TAB) {
    return;
  }

  const items = Array.from(tabMedia.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  tabMedia.clear();
  for (const item of items.slice(0, MAX_ITEMS_PER_TAB)) {
    tabMedia.set(item.id, item);
  }
}

function mergeSource(left, right) {
  if (!left) {
    return right || "network";
  }
  if (!right || left === right) {
    return left;
  }
  return `${left}+${right}`;
}

function isSupportedScheme(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ""));
}

function isRecordableScheme(rawUrl) {
  return isSupportedScheme(rawUrl) || /^blob:/i.test(String(rawUrl || ""));
}

function withoutHash(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
}

function canonicalMediaUrl(rawUrl, kind = "") {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    url.hash = "";
    if (kind === "dash_track" && isYouTubeVideoplaybackUrl(url)) {
      for (const param of YOUTUBE_TRANSIENT_PARAMS) {
        url.searchParams.delete(param);
      }
      return url.href;
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

function isYouTubeVideoplaybackUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  return /(^|\.)googlevideo\.com$/i.test(url.hostname) && url.pathname.includes("videoplayback");
}

function isYouTubePage(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function inferMediaSize(size, rawUrl) {
  const explicit = Number(size);
  const fromUrl = inferNumberParam(rawUrl, "clen") || inferNumberParam(rawUrl, "contentLength");
  const candidates = [explicit, fromUrl].filter(Number.isFinite);
  if (!candidates.length) {
    return null;
  }
  return Math.max(...candidates);
}

function inferNumberParam(rawUrl, name) {
  try {
    const value = new URL(rawUrl).searchParams.get(name);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inferTextParam(rawUrl, name) {
  try {
    return new URL(rawUrl).searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function extensionFromUrl(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname;
    const file = path.split("/").pop() || "";
    const match = /\.([a-z0-9]{2,5})$/i.exec(file);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function inferFilename(rawUrl, kind, contentDisposition = "") {
  const fromDisposition = filenameFromDisposition(contentDisposition);
  if (fromDisposition) {
    return cleanFilename(fromDisposition);
  }

  try {
    const url = new URL(rawUrl);
    const rawName = decodeURIComponent((url.pathname.split("/").pop() || "").trim());
    if (rawName && rawName.includes(".")) {
      return cleanFilename(rawName);
    }

    const ext = extensionFromUrl(rawUrl) || defaultExtension(kind);
    const host = url.hostname.replace(/^www\./, "");
    return cleanFilename(`${host}-${kind || "media"}.${ext}`);
  } catch {
    return cleanFilename(`download.${defaultExtension(kind)}`);
  }
}

async function enrichWithTabInfo(candidate) {
  if (candidate.pageTitle && candidate.pageUrl) {
    return candidate;
  }

  try {
    const tab = await getTab(candidate.tabId);
    return {
      ...candidate,
      pageTitle: candidate.pageTitle || tab?.title || "",
      pageUrl: candidate.pageUrl || tab?.url || ""
    };
  } catch {
    return candidate;
  }
}

function getTab(tabId) {
  return new Promise(resolve => {
    try {
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function buildDisplayName(candidate, urlFilename, kind) {
  const explicit = baseName(candidate.filename || "");
  if (explicit && !looksGeneratedName(explicit)) {
    return cleanTitle(explicit);
  }

  const title = cleanTitle(candidate.pageTitle || "");
  const detail = mediaSuffix(candidate);
  if (title) {
    return detail ? `${title} ${detail}` : title;
  }

  const urlBase = baseName(urlFilename || "");
  if (urlBase) {
    return cleanTitle(urlBase);
  }

  return `${labelKind(kind)} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
}

function buildDownloadFilename(candidate, displayName, urlFilename, kind) {
  const explicit = candidate.filename || "";
  const explicitBase = baseName(explicit);
  const explicitExt = extensionFromFilename(explicit);
  if (explicitBase && explicitExt && !looksGeneratedName(explicitBase)) {
    return cleanFilename(explicit);
  }

  const ext = explicitExt || extensionFromFilename(urlFilename) || extensionFromUrl(candidate.url) || defaultExtension(kind);
  return cleanFilename(`${displayName || labelKind(kind)}.${ext}`);
}

function betterTitle(left, right) {
  const a = cleanTitle(left || "");
  const b = cleanTitle(right || "");
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (looksGeneratedName(baseName(a)) && !looksGeneratedName(baseName(b))) {
    return b;
  }
  if (!looksGeneratedName(baseName(a)) && looksGeneratedName(baseName(b))) {
    return a;
  }
  return a.length >= b.length ? a : b;
}

function betterFilename(left, right) {
  const leftBase = baseName(left || "");
  const rightBase = baseName(right || "");
  if (!leftBase) {
    return right || "";
  }
  if (!rightBase) {
    return left || "";
  }
  if (looksGeneratedName(leftBase) && !looksGeneratedName(rightBase)) {
    return right;
  }
  return left;
}

function betterSize(left, right) {
  const a = Number(left) || 0;
  const b = Number(right) || 0;
  const best = Math.max(a, b);
  return best || null;
}

function mediaSuffix(candidate) {
  const parts = [];
  if (candidate.width && candidate.height) {
    parts.push(`${candidate.width}x${candidate.height}`);
  }
  if (candidate.duration) {
    const whole = Math.round(candidate.duration);
    const mins = Math.floor(whole / 60);
    const secs = String(whole % 60).padStart(2, "0");
    parts.push(`${mins}-${secs}`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s*[-_|]\s*(Google Chrome|Chrome|小红书|抖音|TikTok|YouTube|哔哩哔哩|Bilibili)\s*$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
}

function baseName(filename) {
  const cleaned = cleanFilename(filename || "");
  return cleaned.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
}

function extensionFromFilename(filename) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(String(filename || ""));
  return match ? match[1].toLowerCase() : "";
}

function looksGeneratedName(value) {
  const text = String(value || "").trim();
  if (!text) {
    return true;
  }
  if (/^(video|audio|download|blob|media|index|master|playlist|manifest|v\d+|chunk|segment)([-_\d]*)?$/i.test(text)) {
    return true;
  }
  if (/^[a-f0-9]{16,}$/i.test(text)) {
    return true;
  }
  if (/^[a-z0-9_-]{24,}$/i.test(text) && !/[\u4e00-\u9fff\s]/.test(text)) {
    return true;
  }
  if (/^[a-z0-9_-]+_\d{2,4}$/i.test(text) && text.length > 18) {
    return true;
  }
  return false;
}

function labelKind(kind) {
  if (kind === "hls") {
    return "HLS";
  }
  if (kind === "dash") {
    return "DASH";
  }
  if (kind === "dash_track") {
    return "DASH Track";
  }
  if (kind === "dash_mux") {
    return "DASH MP4";
  }
  if (kind === "dash_pending") {
    return "DASH";
  }
  if (kind === "audio") {
    return "Audio";
  }
  if (kind === "blob") {
    return "Blob";
  }
  if (!kind || kind === "unknown") {
    return "Unknown";
  }
  return "Video";
}

function normalizeComparableUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.href;
  } catch {
    return String(rawUrl);
  }
}

function validThumbnail(value) {
  return /^data:image\/(jpeg|png|webp);base64,/i.test(String(value || "")) && String(value).length < 180000;
}

function filenameFromDisposition(disposition) {
  if (!disposition) {
    return "";
  }

  const utf = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (utf) {
    try {
      return decodeURIComponent(utf[1].replace(/["']/g, ""));
    } catch {
      return utf[1].replace(/["']/g, "");
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : "";
}

function defaultExtension(kind) {
  if (kind === "audio") {
    return "mp3";
  }
  if (kind === "hls") {
    return "m3u8";
  }
  if (kind === "dash") {
    return "mpd";
  }
  if (kind === "dash_track") {
    return "mp4";
  }
  if (kind === "dash_mux") {
    return "mp4";
  }
  if (kind === "dash_pending") {
    return "mp4";
  }
  return "mp4";
}

function mimeToExtension(mime) {
  if (mime.includes("webm")) {
    return "webm";
  }
  if (mime.includes("ogg")) {
    return "ogg";
  }
  if (mime.includes("mpegurl")) {
    return "m3u8";
  }
  if (mime.includes("mp2t")) {
    return "ts";
  }
  if (mime.startsWith("audio/")) {
    return "m4a";
  }
  return "mp4";
}

function cleanFilename(name) {
  const cleaned = String(name || "download")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");

  return (cleaned || "download").slice(0, 160);
}

function makeId(url, kind) {
  const input = `${kind || "media"}:${canonicalMediaUrl(url, kind)}`;
  return `m_${hashString(input)}`;
}

function hashString(input) {
  let hash = 5381;
  for (let index = 0; index < String(input).length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
