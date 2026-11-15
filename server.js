const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// A local server for development: serves public/ by default, or the folder given (`node server.js dist` serves the
// built site, as it will be hosted).
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, process.argv[2] ?? 'public');

// Browser builds of npm dependencies, served from node_modules
const VENDOR_FILES = {
  '/vendor/planck.min.js': path.join(__dirname, 'node_modules', 'planck', 'dist', 'planck.min.js'),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filePath = VENDOR_FILES[urlPath] ?? path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

  if (!VENDOR_FILES[urlPath] && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Ramp designer running at http://localhost:${PORT}`);
});
