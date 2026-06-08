const state = {
  tab: null,
  items: []
};

const pageTitle = document.querySelector("#pageTitle");
const countBadge = document.querySelector("#countBadge");
const statusNode = document.querySelector("#status");
const itemsNode = document.querySelector("#items");
const template = document.querySelector("#itemTemplate");
const scanBtn = document.querySelector("#scanBtn");
const clearBtn = document.querySelector("#clearBtn");

document.addEventListener("DOMContentLoaded", init);
scanBtn.addEventListener("click", () => scanAndRefresh());
clearBtn.addEventListener("click", () => clearCurrentTab());

async function init() {
  try {
    const [tab] = await tabsQuery({ active: true, currentWindow: true });
    state.tab = tab;
    pageTitle.textContent = tab?.title || tab?.url || "当前页面";
    await scanAndRefresh();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function scanAndRefresh() {
  if (!state.tab?.id) {
    return;
  }

  scanBtn.disabled = true;
  setStatus("正在扫描页面和已捕获的网络请求...");

  try {
    await sendTabMessage(state.tab.id, { type: "MEDIA_CATCHER_SCAN_PAGE" });
  } catch {
    // Pages such as chrome:// cannot receive content scripts.
  }

  await refreshItems();
  setTimeout(() => {
    void refreshItems();
  }, 900);
  scanBtn.disabled = false;
}

async function refreshItems() {
  const response = await sendRuntimeMessage({
    type: "MEDIA_CATCHER_GET_TAB",
    tabId: state.tab.id
  });

  if (!response.ok) {
    throw new Error(response.error || "读取捕获结果失败。");
  }

  state.items = response.items || [];
  render();
}

async function clearCurrentTab() {
  if (!state.tab?.id) {
    return;
  }

  await sendRuntimeMessage({
    type: "MEDIA_CATCHER_CLEAR_TAB",
    tabId: state.tab.id
  });
  state.items = [];
  render();
}

function render() {
  countBadge.textContent = String(state.items.length);
  itemsNode.replaceChildren();

  if (!state.items.length) {
    setStatus("还没有捕获到媒体。先播放页面中的视频，再点重新扫描。");
    return;
  }

  setStatus(statusTextForItems(state.items), hasDashTracks(state.items));

  for (const item of state.items) {
    const fragment = template.content.cloneNode(true);
    const title = fragment.querySelector(".item-title");
    const meta = fragment.querySelector(".item-meta");
    const thumb = fragment.querySelector(".item-thumb");
    const thumbImg = fragment.querySelector(".item-thumb img");
    const thumbLabel = fragment.querySelector(".item-thumb span");
    const primary = fragment.querySelector('[data-action="primary"]');
    const copy = fragment.querySelector('[data-action="copy"]');

    renderThumbnail(item, thumb, thumbImg, thumbLabel);
    title.textContent = item.displayName || item.pageTitle || item.filename || fallbackTitle(item);
    meta.innerHTML = [
      `<span class="kind">${escapeHtml(labelKind(item.kind))}</span>`,
      escapeHtml(hostFromUrl(item.url)),
      escapeHtml(sizeLabel(item)),
      escapeHtml(detailLabel(item)),
      escapeHtml(filenameLabel(item))
    ].filter(Boolean).join(" · ");

    if (item.kind === "hls") {
      primary.textContent = "合并下载";
      primary.addEventListener("click", () => openDownloader(item));
    } else if (item.kind === "dash_mux") {
      primary.textContent = "合并下载";
      primary.addEventListener("click", () => mergeDash(item));
    } else if (item.kind === "dash_track") {
      primary.textContent = "复制分轨";
      primary.addEventListener("click", () => copyUrl(item.url));
    } else if (item.kind === "dash") {
      primary.textContent = "复制 MPD";
      primary.addEventListener("click", () => copyUrl(item.url));
    } else if (item.kind === "blob") {
      primary.textContent = "等待真实链接";
      primary.disabled = true;
    } else {
      primary.textContent = "下载";
      primary.addEventListener("click", () => downloadDirect(item));
    }

    copy.addEventListener("click", () => copyUrl(item.url));
    itemsNode.append(fragment);
  }
}

function renderThumbnail(item, thumb, img, label) {
  label.textContent = labelKind(item.kind).toUpperCase();
  if (item.thumbnail && /^data:image\//i.test(item.thumbnail)) {
    img.src = item.thumbnail;
    thumb.classList.add("has-image");
    return;
  }

  img.removeAttribute("src");
  thumb.classList.remove("has-image");
}

async function downloadDirect(item) {
  setStatus("正在交给浏览器下载管理器...");
  const response = await sendRuntimeMessage({
    type: "MEDIA_CATCHER_DOWNLOAD_DIRECT",
    item
  });

  if (!response.ok) {
    setStatus(response.error || "下载启动失败。", true);
    return;
  }

  setStatus("下载已创建。");
}

async function openDownloader(item) {
  const response = await sendRuntimeMessage({
    type: "MEDIA_CATCHER_OPEN_DOWNLOADER",
    item
  });

  if (!response.ok) {
    setStatus(response.error || "无法打开 HLS 下载页。", true);
  }
}

async function mergeDash(item) {
  setStatus("正在调用本地助手合并 DASH 音视频...");
  const response = await sendRuntimeMessage({
    type: "MEDIA_CATCHER_MERGE_DASH",
    item
  });

  if (!response.ok) {
    setStatus(response.error || "DASH 合并失败。请先启动本地助手。", true);
    return;
  }

  setStatus(`合并完成：${response.output || item.filename}`);
}

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    setStatus("链接已复制。");
  } catch {
    setStatus("复制失败，浏览器拒绝了剪贴板访问。", true);
  }
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
  if (kind === "audio") {
    return "Audio";
  }
  if (kind === "blob") {
    return "Blob";
  }
  return "Video";
}

function statusTextForItems(items) {
  if (items.some(item => item.kind === "dash_mux")) {
    return "已捕获 DASH 音视频轨，可通过本地助手合并下载。";
  }
  if (hasDashTracks(items)) {
    return "检测到 DASH 分轨。等待同时捕获音频轨和视频轨后可合并下载。";
  }
  return `已捕获 ${items.length} 个候选资源。`;
}

function hasDashTracks(items) {
  return items.some(item => item.kind === "dash_track");
}

function sizeLabel(item) {
  if (!item.size) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = item.size;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function detailLabel(item) {
  const parts = [];
  if (item.width && item.height) {
    parts.push(`${item.width}x${item.height}`);
  }
  if (item.duration) {
    parts.push(formatDuration(item.duration));
  }
  if (item.source) {
    parts.push(item.source);
  }
  return parts.join(" · ");
}

function filenameLabel(item) {
  if (!item.filename || item.filename === item.displayName) {
    return "";
  }
  return item.filename;
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  const mins = Math.floor(whole / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function fallbackTitle(item) {
  try {
    return new URL(item.url).pathname.split("/").pop() || item.url;
  } catch {
    return item.url;
  }
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function setStatus(text, warn = false) {
  statusNode.textContent = text;
  statusNode.classList.toggle("warn", warn);
}

function tabsQuery(query) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(query, tabs => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs);
    });
  });
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

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
