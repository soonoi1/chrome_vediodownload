const params = new URLSearchParams(location.search);
const initialUrl = params.get("url") || "";
const sourceUrl = document.querySelector("#sourceUrl");
const stateText = document.querySelector("#stateText");
const variantsNode = document.querySelector("#variants");
const progressBar = document.querySelector("#progressBar");
const statsNode = document.querySelector("#stats");
const startBtn = document.querySelector("#startBtn");
const cancelBtn = document.querySelector("#cancelBtn");
const logNode = document.querySelector("#log");

const state = {
  root: null,
  selectedVariantUrl: "",
  selectedVariantLabel: "",
  abortController: null,
  running: false
};

sourceUrl.textContent = initialUrl || "缺少 HLS 地址";
startBtn.addEventListener("click", () => void startDownload());
cancelBtn.addEventListener("click", () => {
  state.abortController?.abort();
  appendLog("正在取消...");
});

void init();

async function init() {
  try {
    if (!initialUrl) {
      throw new Error("Missing HLS URL.");
    }

    setState("正在读取清单...");
    const root = await loadPlaylist(initialUrl);
    state.root = root;

    if (root.variants.length) {
      renderVariants(root.variants);
      setState(`发现 ${root.variants.length} 个清晰度。`);
      appendLog("请选择清晰度，然后开始下载。");
    } else {
      renderSinglePlaylist(root);
      setState(`发现 ${root.segments.length} 个分片。`);
      appendLog(root.live ? "这是直播或未结束清单，将下载当前快照分片。" : "清单已就绪。");
    }

    startBtn.disabled = false;
  } catch (error) {
    showError(error);
  }
}

function renderVariants(variants) {
  variantsNode.replaceChildren();
  const sorted = variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  state.selectedVariantUrl = sorted[0].url;
  state.selectedVariantLabel = variantLabel(sorted[0]);

  for (const variant of sorted) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "variant";
    button.textContent = variantLabel(variant);
    button.classList.toggle("selected", variant.url === state.selectedVariantUrl);
    button.addEventListener("click", () => {
      state.selectedVariantUrl = variant.url;
      state.selectedVariantLabel = variantLabel(variant);
      for (const node of variantsNode.querySelectorAll(".variant")) {
        node.classList.toggle("selected", node === button);
      }
    });
    variantsNode.append(button);
  }
}

function renderSinglePlaylist(playlist) {
  variantsNode.replaceChildren();
  const badge = document.createElement("strong");
  badge.textContent = `${playlist.segments.length} segments`;
  variantsNode.append(badge);
}

async function startDownload() {
  if (state.running) {
    return;
  }

  state.running = true;
  startBtn.disabled = true;
  cancelBtn.disabled = false;
  logNode.textContent = "";
  progressBar.style.width = "0%";
  state.abortController = new AbortController();

  try {
    let playlist = state.root;
    if (state.selectedVariantUrl) {
      setState(`正在读取 ${state.selectedVariantLabel} 清单...`);
      playlist = await resolveMediaPlaylist(state.selectedVariantUrl, 0);
    }

    if (playlist.encrypted) {
      throw new Error("检测到加密 HLS。此工具不破解 DRM 或加密分片。");
    }

    if (!playlist.segments.length) {
      throw new Error("清单里没有可下载分片。");
    }

    const items = buildDownloadItems(playlist);
    const extension = playlist.isFmp4 ? "mp4" : "ts";
    const outputName = outputFilename(extension);
    const sink = await createOutputSink(outputName, extension);

    appendLog(`输出文件: ${outputName}`);
    appendLog(`分片数量: ${items.length}`);
    appendLog(`并发下载: 6`);
    setState("正在下载分片...");

    await downloadItems(items, sink, state.abortController.signal);
    await sink.close();

    progressBar.style.width = "100%";
    setState("下载完成。");
    appendLog("完成。");
  } catch (error) {
    if (state.abortController?.signal.aborted) {
      setState("已取消。");
      appendLog("下载已取消。");
    } else {
      showError(error);
    }
  } finally {
    state.running = false;
    cancelBtn.disabled = true;
    startBtn.disabled = false;
  }
}

async function resolveMediaPlaylist(url, depth) {
  if (depth > 4) {
    throw new Error("HLS 清单嵌套过深。");
  }

  const playlist = await loadPlaylist(url);
  if (playlist.variants.length) {
    const best = playlist.variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    return resolveMediaPlaylist(best.url, depth + 1);
  }
  return playlist;
}

async function loadPlaylist(url) {
  const fetched = await fetchText(url);
  const playlist = parseM3u8(fetched.text, fetched.finalUrl || url);
  playlist.sourceUrl = fetched.finalUrl || url;
  return playlist;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      text: await response.text(),
      finalUrl: response.url,
      contentType: response.headers.get("content-type") || ""
    };
  } catch (firstError) {
    const response = await sendRuntimeMessage({
      type: "MEDIA_CATCHER_FETCH_TEXT",
      url
    });
    if (!response.ok) {
      throw new Error(response.error || firstError.message || "无法读取清单。");
    }
    return response;
  }
}

function parseM3u8(text, baseUrl) {
  if (!/^#EXTM3U/m.test(text)) {
    throw new Error("这不是有效的 M3U8 清单。");
  }

  const lines = text.replace(/\r/g, "").split("\n").map(line => line.trim());
  const variants = [];
  const segments = [];
  let pendingVariant = null;
  let pendingByteRange = null;
  let lastByteEnd = 0;
  let initSegment = null;
  let encrypted = false;
  let encryption = null;
  let live = true;

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (pendingVariant && !line.startsWith("#")) {
      variants.push({
        ...pendingVariant,
        url: resolveUrl(line, baseUrl)
      });
      pendingVariant = null;
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = parseAttributeList(line.slice(line.indexOf(":") + 1));
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
      const method = String(attrs.METHOD || "").toUpperCase();
      if (method && method !== "NONE") {
        encrypted = true;
        encryption = attrs;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
      if (attrs.URI) {
        initSegment = {
          url: resolveUrl(attrs.URI, baseUrl),
          range: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, () => lastByteEnd, value => { lastByteEnd = value; }) : null
        };
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const raw = line.slice(line.indexOf(":") + 1).trim();
      pendingByteRange = parseByteRange(raw, () => lastByteEnd, value => { lastByteEnd = value; });
      continue;
    }

    if (line.startsWith("#EXT-X-ENDLIST")) {
      live = false;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    segments.push({
      url: resolveUrl(line, baseUrl),
      range: pendingByteRange
    });
    pendingByteRange = null;
  }

  const isFmp4 = Boolean(initSegment) || segments.some(segment => /\.(m4s|mp4|cmfv|cmfa)(?:[?#]|$)/i.test(segment.url));

  return {
    baseUrl,
    variants,
    segments,
    initSegment,
    encrypted,
    encryption,
    live,
    isFmp4
  };
}

function parseAttributeList(raw) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match = pattern.exec(raw);
  while (match) {
    const key = match[1].toUpperCase();
    let value = match[2] || "";
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs[key] = value;
    match = pattern.exec(raw);
  }

  if (attrs.BANDWIDTH) {
    attrs.bandwidth = Number(attrs.BANDWIDTH) || 0;
  }
  if (attrs.RESOLUTION) {
    attrs.resolution = attrs.RESOLUTION;
  }

  return attrs;
}

function parseByteRange(raw, getLastEnd, setLastEnd) {
  const [lengthRaw, offsetRaw] = String(raw).split("@");
  const length = Number(lengthRaw);
  const start = offsetRaw === undefined ? getLastEnd() : Number(offsetRaw);
  if (!Number.isFinite(length) || !Number.isFinite(start)) {
    return null;
  }
  const end = start + length - 1;
  setLastEnd(end + 1);
  return { start, end };
}

function buildDownloadItems(playlist) {
  const items = [];
  if (playlist.initSegment) {
    items.push({
      ...playlist.initSegment,
      role: "init"
    });
  }

  playlist.segments.forEach((segment, index) => {
    items.push({
      ...segment,
      role: "segment",
      index
    });
  });

  return items;
}

async function downloadItems(items, sink, signal) {
  const concurrency = Math.min(6, items.length);
  const results = new Array(items.length);
  let nextFetchIndex = 0;
  let nextWriteIndex = 0;
  let completed = 0;
  let bytes = 0;
  let drainLock = Promise.resolve();

  const drain = () => {
    drainLock = drainLock.then(async () => {
      while (results[nextWriteIndex]) {
        const chunk = results[nextWriteIndex];
        results[nextWriteIndex] = null;
        await sink.write(chunk);
        nextWriteIndex += 1;
      }
    });
    return drainLock;
  };

  const worker = async () => {
    while (!signal.aborted) {
      const current = nextFetchIndex;
      nextFetchIndex += 1;
      if (current >= items.length) {
        return;
      }

      const chunk = await fetchBytes(items[current], signal);
      results[current] = chunk;
      completed += 1;
      bytes += chunk.byteLength;
      updateProgress(completed, items.length, bytes);
      await drain();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  await drainLock;

  if (signal.aborted) {
    throw new Error("Canceled.");
  }
}

async function fetchBytes(item, signal) {
  const headers = {};
  if (item.range) {
    headers.Range = `bytes=${item.range.start}-${item.range.end}`;
  }

  const response = await fetch(item.url, {
    cache: "no-store",
    credentials: "include",
    headers,
    redirect: "follow",
    signal
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while downloading segment.`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function createOutputSink(filename, extension) {
  if (globalThis.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: extension === "mp4" ? "MP4 video" : "MPEG-TS video",
            accept: {
              [extension === "mp4" ? "video/mp4" : "video/mp2t"]: [`.${extension}`]
            }
          }
        ]
      });
      const writable = await handle.createWritable();
      return {
        async write(chunk) {
          await writable.write(chunk);
        },
        async close() {
          await writable.close();
        }
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      appendLog("文件选择器不可用，改用浏览器内存下载。");
    }
  }

  const chunks = [];
  return {
    async write(chunk) {
      chunks.push(chunk);
    },
    async close() {
      const blob = new Blob(chunks, {
        type: extension === "mp4" ? "video/mp4" : "video/mp2t"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  };
}

function updateProgress(completed, total, bytes) {
  const percent = Math.round((completed / total) * 100);
  progressBar.style.width = `${percent}%`;
  statsNode.textContent = `${completed}/${total} 分片 · ${formatBytes(bytes)}`;
}

function variantLabel(variant) {
  const bits = [];
  if (variant.resolution) {
    bits.push(variant.resolution);
  }
  if (variant.bandwidth) {
    bits.push(`${Math.round(variant.bandwidth / 1000)} kbps`);
  }
  return bits.join(" · ") || "Auto";
}

function outputFilename(extension) {
  const explicit = params.get("filename") || "";
  const title = params.get("title") || explicit || "video";
  const base = explicit && !/\.m3u8$/i.test(explicit) ? explicit : title;
  const cleaned = cleanFilename(base).replace(/\.(m3u8|mpd|mp4|ts)$/i, "");
  return `${cleaned || "video"}.${extension}`;
}

function cleanFilename(name) {
  return String(name || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 140) || "video";
}

function resolveUrl(url, baseUrl) {
  return new URL(url, baseUrl).href;
}

function setState(text) {
  stateText.textContent = text;
  stateText.classList.remove("error");
}

function showError(error) {
  const message = error?.message || String(error);
  stateText.textContent = message;
  stateText.classList.add("error");
  appendLog(`错误: ${message}`);
}

function appendLog(text) {
  const time = new Date().toLocaleTimeString();
  logNode.textContent += `[${time}] ${text}\n`;
  logNode.scrollTop = logNode.scrollHeight;
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
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
