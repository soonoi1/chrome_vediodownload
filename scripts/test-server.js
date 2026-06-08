const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8765);
const host = "127.0.0.1";

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl; charset=utf-8",
  ".mp4": "video/mp4",
  ".ts": "video/mp2t"
};

const server = http.createServer((request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.resolve(root, safePath || "test-page/index.html");

    if (!target.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const stat = fs.existsSync(target) ? fs.statSync(target) : null;
    const file = stat?.isDirectory() ? path.join(target, "index.html") : target;

    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": types[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store"
    });
    fs.createReadStream(file).pipe(response);
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});

server.listen(port, host, () => {
  console.log(`Media Catcher test server: http://${host}:${port}/test-page/`);
});
