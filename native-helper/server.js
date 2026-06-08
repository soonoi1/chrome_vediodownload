const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = "127.0.0.1";
const port = Number(process.env.MEDIA_CATCHER_PORT || 17382);
const outputDir = process.env.MEDIA_CATCHER_OUTPUT || path.join(os.homedir(), "Downloads");

const server = http.createServer(async (request, response) => {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    const ffmpeg = await findFfmpeg();
    json(response, 200, {
      ok: true,
      ffmpeg: Boolean(ffmpeg),
      outputDir
    });
    return;
  }

  if (request.method === "POST" && request.url === "/merge") {
    try {
      const body = await readJson(request);
      const result = await mergeDash(body);
      json(response, 200, {
        ok: true,
        ...result
      });
    } catch (error) {
      json(response, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  json(response, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(port, host, () => {
  console.log(`Media Catcher helper: http://${host}:${port}`);
  console.log(`Output directory: ${outputDir}`);
});

async function mergeDash(body) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new Error("FFmpeg was not found. Install FFmpeg and make sure ffmpeg.exe is in PATH.");
  }

  const videoUrl = requireHttpUrl(body.videoUrl, "videoUrl");
  const audioUrl = requireHttpUrl(body.audioUrl, "audioUrl");
  const container = body.container === "mkv" ? "mkv" : "mp4";
  const filename = withExtension(cleanFilename(body.filename || `video.${container}`), container);
  const output = uniquePath(path.join(outputDir, filename));

  fs.mkdirSync(path.dirname(output), {
    recursive: true
  });

  const args = [
    "-hide_banner",
    "-y",
    "-user_agent",
    body.userAgent || "Mozilla/5.0",
    "-headers",
    headersArg(body.referer),
    "-i",
    videoUrl,
    "-user_agent",
    body.userAgent || "Mozilla/5.0",
    "-headers",
    headersArg(body.referer),
    "-i",
    audioUrl,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy"
  ];

  if (container === "mp4") {
    args.push("-movflags", "+faststart");
  }

  args.push(output);

  await run(ffmpeg, args);
  return {
    output
  };
}

function headersArg(referer) {
  const lines = [];
  if (referer) {
    lines.push(`Referer: ${referer}`);
  }
  lines.push("Origin: https://www.youtube.com");
  return `${lines.join("\r\n")}\r\n`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true
    });
    let stderr = "";

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}.`));
    });
  });
}

async function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  const candidates = [
    "ffmpeg",
    "ffmpeg.exe",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"
  ];

  for (const candidate of candidates) {
    if (await commandWorks(candidate)) {
      return candidate;
    }
  }

  return "";
}

function commandWorks(command) {
  return new Promise(resolve => {
    const child = spawn(command, ["-version"], {
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0));
  });
}

function requireHttpUrl(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new Error(`Invalid ${name}.`);
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", chunk => {
      raw += chunk;
      if (raw.length > 3 * 1024 * 1024) {
        request.destroy();
        reject(new Error("Request is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function uniquePath(file) {
  if (!fs.existsSync(file)) {
    return file;
  }

  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let index = 1; index < 1000; index += 1) {
    const next = path.join(dir, `${base} (${index})${ext}`);
    if (!fs.existsSync(next)) {
      return next;
    }
  }

  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function cleanFilename(name) {
  return String(name || "video.mp4")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150) || "video.mp4";
}

function withExtension(filename, ext) {
  const cleanExt = ext === "mkv" ? "mkv" : "mp4";
  return filename.replace(/\.(webm|mkv|mov|m4a|mp3|mp4)$/i, "") + `.${cleanExt}`;
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}
