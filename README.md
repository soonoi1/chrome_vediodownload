# Media Catcher

一个 Chrome Manifest V3 视频下载扩展原型，目标是提供接近 IDM 的网页媒体嗅探体验：自动捕获页面里的直接视频、音频链接，以及常见的非加密 HLS (`.m3u8`) 流，并提供下载入口。

## 能做什么

- 捕获网络请求中的 `mp4`、`webm`、`mov`、`mp3`、`m4a` 等直接媒体文件。
- 捕获页面 `<video>`、`<audio>`、`<source>`、下载链接和 Performance 资源列表中的媒体 URL。
- 捕获 HLS `.m3u8` 清单，打开独立下载页后解析多清晰度 Variant Playlist。
- 对未加密 HLS 分片进行并发下载，并按顺序合并为 `.ts` 或 fMP4 `.mp4` 文件。
- 对 YouTube / DASH 的音视频分轨进行识别；启动本地 FFmpeg 助手后，可把已捕获的音频轨和视频轨合并为 `.mp4`。

## 明确边界

- 不破解 DRM，例如 Widevine、FairPlay、PlayReady。
- 不绕过登录、付费墙、地区限制或网站权限。
- 不保证下载所有网站。很多平台使用 DRM、一次性签名、专用播放器、服务端鉴权或动态分片策略，浏览器扩展只能下载当前浏览器会话中已经合法可访问的非 DRM 媒体资源。
- 加密 HLS (`#EXT-X-KEY` 非 `NONE`) 会被识别并拒绝合并下载。
- YouTube 等站点通常使用 DASH/MSE，音频和视频分轨传输。当前版本通过本地 FFmpeg 助手合并已捕获的非 DRM 音视频轨，不破解 DRM、不绕过付费或权限限制。

## 安装

1. 打开 Chrome。
2. 进入 `chrome://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本目录：`C:\UE5matehuman\dowloadweb`。

## 使用

1. 打开包含视频的网页。
2. 播放视频几秒，让浏览器产生真实媒体请求。
3. 点击浏览器工具栏里的 Media Catcher，查看捕获列表。
4. 捕获列表会显示视频缩略图、网页/视频标题、真实文件名、尺寸、时长和来源。缩略图来自当前可见视频窗口的截图裁剪，所以视频需要在屏幕上可见。
5. 对直接媒体文件点击“下载”；对 HLS 项点击“合并下载”，在新页面选择清晰度并开始下载。
6. 对 YouTube / DASH 项，先启动本地助手，然后点击 `DASH MP4` 项的“合并下载”。

很多网站会先给播放器一个 `blob:` 临时地址，真实 MP4/HLS 请求要等播放后才出现。如果列表里只有 `Blob` 或没有候选，继续播放几秒后点击“重新扫描”。

## YouTube / DASH 合并下载

这一步需要本机安装 FFmpeg，并启动本地助手服务。

1. 安装 FFmpeg，并确保 `ffmpeg.exe` 在 `PATH` 中，或设置 `FFMPEG_PATH` 环境变量。
2. 启动助手：

```powershell
node .\native-helper\server.js
```

默认输出目录是当前用户的 `Downloads`。可以用环境变量修改：

```powershell
$env:MEDIA_CATCHER_OUTPUT="D:\Videos"
node .\native-helper\server.js
```

助手启动后，回到 YouTube 页面播放视频几秒，打开扩展并点“重新扫描”。当列表出现 `DASH MP4` 项时，点击“合并下载”即可调用 FFmpeg 输出完整 MP4。

## 本地测试

扩展安装后，可以启动本仓库内置的测试服务做快速验证：

```powershell
node .\scripts\test-server.js
```

然后：

1. 在 Chrome 地址栏打开 `http://127.0.0.1:8765/test-page/`。
2. 播放页面里的视频几秒。
3. 点击 Media Catcher 扩展图标，应看到一个直接 MP4 候选。
4. 页面里的公开 HLS 测试流链接也会被捕获，可用“合并下载”验证 HLS 下载页。

## 自检和打包

```powershell
.\scripts\validate-extension.ps1
.\scripts\package-extension.ps1
```

打包产物会生成到 `dist/media-catcher-chrome-0.1.0.zip`。

## 文件说明

- `manifest.json`：扩展配置与权限。
- `src/background.js`：网络请求嗅探、候选资源存储、下载调度。
- `src/content-script.js`：扫描页面 DOM、媒体元素和 Performance 资源。
- `src/popup.html` / `src/popup.css` / `src/popup.js`：扩展弹窗。
- `src/downloader.html` / `src/downloader.css` / `src/downloader.js`：HLS 清单解析、分片并发下载、顺序合并。
- `native-helper/server.js`：本地 FFmpeg 合并助手，用于 DASH 音视频轨合并。
- `test-page/index.html`：Chrome 本地加载后的验证页面。
- `scripts/validate-extension.ps1`：检查必需文件、JSON 和 JS 语法。
- `scripts/package-extension.ps1`：生成 Chrome 可加载的 zip 包。

## 下一步可增强

- 增加合并进度、取消任务和历史记录。
- 增加下载历史、域名规则、资源过滤和最小大小阈值设置。
- 增加失败分片重试、速度统计和暂停/恢复。
- 为 Firefox 做兼容适配。
