# Media Catcher

一个 Chrome Manifest V3 视频下载扩展原型，目标是提供接近 IDM 的网页媒体嗅探体验：自动捕获页面里的直接视频、音频链接，以及常见的非加密 HLS (`.m3u8`) 流，并提供下载入口。

## 能做什么

- 捕获网络请求中的 `mp4`、`webm`、`mov`、`mp3`、`m4a` 等直接媒体文件。
- 捕获页面 `<video>`、`<audio>`、`<source>`、下载链接和 Performance 资源列表中的媒体 URL。
- 捕获 HLS `.m3u8` 清单，打开独立下载页后解析多清晰度 Variant Playlist。
- 对未加密 HLS 分片进行并发下载，并按顺序合并为 `.ts` 或 fMP4 `.mp4` 文件。
- 对 DASH `.mpd` 清单进行发现和复制，方便后续交给专用工具处理。

## 明确边界

- 不破解 DRM，例如 Widevine、FairPlay、PlayReady。
- 不绕过登录、付费墙、地区限制或网站权限。
- 不保证下载所有网站。很多平台使用 DRM、一次性签名、专用播放器、服务端鉴权或动态分片策略，浏览器扩展只能下载当前浏览器会话中已经合法可访问的非 DRM 媒体资源。
- 加密 HLS (`#EXT-X-KEY` 非 `NONE`) 会被识别并拒绝合并下载。

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

很多网站会先给播放器一个 `blob:` 临时地址，真实 MP4/HLS 请求要等播放后才出现。如果列表里只有 `Blob` 或没有候选，继续播放几秒后点击“重新扫描”。

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
- `test-page/index.html`：Chrome 本地加载后的验证页面。
- `scripts/validate-extension.ps1`：检查必需文件、JSON 和 JS 语法。
- `scripts/package-extension.ps1`：生成 Chrome 可加载的 zip 包。

## 下一步可增强

- 增加 DASH 音视频轨道合并，需要引入 muxer 或 FFmpeg/WASM。
- 增加下载历史、域名规则、资源过滤和最小大小阈值设置。
- 增加失败分片重试、速度统计和暂停/恢复。
- 为 Firefox 做兼容适配。
