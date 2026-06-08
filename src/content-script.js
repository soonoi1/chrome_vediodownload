(() => {
  if (globalThis.__mediaCatcherContentScript) {
    return;
  }
  globalThis.__mediaCatcherContentScript = true;

  const MEDIA_PATTERN = /\.(m3u8|mpd|mp4|m4v|mov|webm|mkv|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i;
  const SCAN_LIMIT = 80;
  let scanTimer = null;
  const thumbnailCache = new WeakMap();
  const pendingThumbnails = new WeakSet();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MEDIA_CATCHER_SCAN_PAGE") {
      const candidates = scanPage();
      sendCandidates(candidates, "manual", response => {
        sendResponse({
          ok: true,
          count: response?.count ?? candidates.length,
          candidates
        });
      });
      return true;
    }

    return false;
  });

  setTimeout(() => sendCandidates(scanPage(), "initial"), 600);
  setTimeout(() => sendCandidates(scanPage(), "settled"), 2500);
  window.addEventListener("load", () => scheduleScan("load"), { once: true });
  document.addEventListener("loadedmetadata", event => {
    if (event.target instanceof HTMLMediaElement) {
      scheduleScan("metadata");
    }
  }, true);
  document.addEventListener("play", event => {
    if (event.target instanceof HTMLMediaElement) {
      scheduleScan("play");
    }
  }, true);

  const observer = new MutationObserver(() => scheduleScan("mutation"));
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "href"]
    });
  }

  function scheduleScan(reason) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      sendCandidates(scanPage(), reason);
    }, 900);
  }

  function scanPage() {
    const candidates = [];
    const seen = new Set();

    const add = (url, meta = {}) => {
      const candidate = makeCandidate(url, meta);
      if (!candidate || seen.has(candidate.url)) {
        return;
      }
      seen.add(candidate.url);
      candidates.push(candidate);
    };

    for (const media of document.querySelectorAll("video,audio")) {
      add(media.currentSrc, mediaMeta(media, "element"));
      add(media.src, mediaMeta(media, "element"));
      for (const source of media.querySelectorAll("source")) {
        add(source.src, mediaMeta(media, "source", source.type));
      }
    }

    for (const source of document.querySelectorAll("source[src]")) {
      add(source.src, { source: "source", mime: source.type || "" });
    }

    for (const link of document.querySelectorAll("a[href]")) {
      const href = link.href;
      if (MEDIA_PATTERN.test(href)) {
        add(href, {
          source: "link",
          filename: (link.getAttribute("download") || link.textContent || "").trim()
        });
      }
    }

    for (const entry of performance.getEntriesByType("resource")) {
      if (MEDIA_PATTERN.test(entry.name)) {
        add(entry.name, {
          source: "performance"
        });
      }
    }

    return candidates.slice(0, SCAN_LIMIT);
  }

  function mediaMeta(media, source, mime = "") {
    const thumbnail = captureThumbnail(media) || thumbnailCache.get(media) || "";
    if (!thumbnail && media instanceof HTMLVideoElement) {
      requestVisibleThumbnail(media);
    }

    return {
      source,
      mime,
      label: mediaLabel(media),
      thumbnail,
      width: media.videoWidth || null,
      height: media.videoHeight || null,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      kindHint: media.tagName.toLowerCase() === "audio" ? "audio" : "video"
    };
  }

  function makeCandidate(rawUrl, meta) {
    if (!rawUrl) {
      return null;
    }

    const absolute = normalizeUrl(rawUrl);
    if (!absolute) {
      return null;
    }

    const classified = classifyUrl(absolute, meta.kindHint);
    if (!classified) {
      return null;
    }

    return {
      url: absolute,
      kind: classified.kind,
      ext: classified.ext,
      source: meta.source || "page",
      pageUrl: location.href,
      pageTitle: document.title || "",
      filename: meta.filename || meta.label || "",
      thumbnail: meta.thumbnail || "",
      mime: meta.mime || "",
      width: meta.width || null,
      height: meta.height || null,
      duration: meta.duration || null
    };
  }

  function normalizeUrl(rawUrl) {
    if (String(rawUrl).startsWith("blob:")) {
      return rawUrl;
    }

    try {
      const url = new URL(rawUrl, location.href);
      url.hash = "";
      if (!/^https?:$/.test(url.protocol)) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function classifyUrl(url, kindHint = "video") {
    if (url.startsWith("blob:")) {
      return { kind: "blob", ext: "" };
    }

    const ext = extensionFromUrl(url);
    const lower = url.toLowerCase();

    if (ext === "m3u8" || lower.includes(".m3u8")) {
      return { kind: "hls", ext: "m3u8" };
    }
    if (ext === "mpd" || lower.includes(".mpd")) {
      return { kind: "dash", ext: "mpd" };
    }
    if (["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"].includes(ext)) {
      return { kind: "audio", ext };
    }
    if (["mp4", "m4v", "mov", "webm", "mkv", "flv", "avi", "wmv", "mpg", "mpeg", "3gp"].includes(ext)) {
      return { kind: "video", ext };
    }

    if (kindHint === "audio" || kindHint === "video") {
      return { kind: kindHint, ext: "" };
    }

    return null;
  }

  function extensionFromUrl(rawUrl) {
    try {
      const file = new URL(rawUrl, location.href).pathname.split("/").pop() || "";
      const match = /\.([a-z0-9]{2,5})$/i.exec(file);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function sendCandidates(candidates, reason, done = null) {
    if (!candidates.length) {
      done?.({ ok: true, count: 0 });
      return Promise.resolve({ ok: true, count: 0 });
    }

    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        {
          type: "MEDIA_CATCHER_CONTENT_CANDIDATES",
          reason,
          pageUrl: location.href,
          pageTitle: document.title || "",
          candidates
        },
        response => {
          void chrome.runtime.lastError;
          const result = response || { ok: true, count: candidates.length };
          done?.(result);
          resolve(result);
        }
      );
    });
  }

  function isUsefulVideo(media) {
    if (!(media instanceof HTMLVideoElement)) {
      return false;
    }
    const rect = media.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 90 && media.offsetParent !== null;
  }

  function mediaLabel(media) {
    return [
      media.getAttribute("title"),
      media.getAttribute("aria-label"),
      media.closest("[title]")?.getAttribute("title"),
      document.querySelector('meta[property="og:title"]')?.content,
      document.title
    ].find(value => value && String(value).trim()) || "";
  }

  function captureThumbnail(media) {
    if (!(media instanceof HTMLVideoElement) || !media.videoWidth || !media.videoHeight || media.readyState < 2) {
      return "";
    }

    try {
      const width = 160;
      const height = Math.max(1, Math.round((media.videoHeight / media.videoWidth) * width));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.min(120, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return "";
      }

      const drawHeight = Math.min(height, canvas.height);
      const offsetY = Math.max(0, (canvas.height - drawHeight) / 2);
      ctx.fillStyle = "#111820";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(media, 0, offsetY, width, drawHeight);
      return canvas.toDataURL("image/jpeg", 0.68);
    } catch {
      return "";
    }
  }

  async function requestVisibleThumbnail(media) {
    if (!(media instanceof HTMLVideoElement) || pendingThumbnails.has(media) || !isUsefulVideo(media)) {
      return;
    }

    const rect = media.getBoundingClientRect();
    pendingThumbnails.add(media);

    try {
      const response = await sendRuntimeMessage({
        type: "MEDIA_CATCHER_CAPTURE_VISIBLE_THUMBNAIL",
        rect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1
        }
      });

      if (response.ok && response.thumbnail) {
        thumbnailCache.set(media, response.thumbnail);
        sendCandidates(scanPage(), "thumbnail");
      }
    } catch {
      // Some pages or browser states do not allow visible-tab capture.
    } finally {
      pendingThumbnails.delete(media);
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response || { ok: false, error: "No response." });
      });
    });
  }
})();
