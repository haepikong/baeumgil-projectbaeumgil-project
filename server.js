const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = __dirname;
const sessions = new Map();
const eventClients = new Set();
const projectFiles = [
  'index.html',
  'server.js',
  'package.json',
  'README.md',
  '__preview-bridge.js',
  'ai-images/happy-bean-mascot.png',
  'ai-images/student-bean-mascot.png',
  'ai-images/teacher-bean-mascot.png'
];
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function createProjectZip() {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of projectFiles) {
    const name = Buffer.from(file.replaceAll(path.sep, '/'));
    const data = await fsp.readFile(path.join(root, file));
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(projectFiles.length, 8);
  end.writeUInt16LE(projectFiles.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function getSnapshot() {
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function publishSnapshot() {
  const event = `data: ${JSON.stringify(getSnapshot())}\n\n`;
  for (const client of eventClients) client.write(event);
}

function readJson(request, response) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 200_000) {
        sendJson(response, 413, { error: 'Payload too large' });
        request.destroy();
        reject(new Error('Payload too large'));
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && requestUrl.pathname === '/api/student-activity') {
    return sendJson(response, 200, getSnapshot());
  }

  if (request.method === 'GET' && requestUrl.pathname === '/download-project.zip') {
    try {
      const archive = await createProjectZip();
      response.writeHead(200, {
        'Content-Disposition': 'attachment; filename="baeumgil-project.zip"',
        'Content-Length': archive.length,
        'Content-Type': 'application/zip'
      });
      return response.end(archive);
    } catch {
      return sendJson(response, 500, { error: 'Could not create project archive' });
    }
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/activity-events') {
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8'
    });
    response.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
    eventClients.add(response);
    request.on('close', () => eventClients.delete(response));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/student-activity') {
    let body;
    try {
      body = await readJson(request, response);
    } catch {
      return;
    }
    const classCode = String(body.classCode || '').trim().slice(0, 40);
    const course = String(body.course || '').trim().slice(0, 80);
    const studentNumber = String(body.number || '').trim().slice(0, 20);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!classCode || !course || !studentNumber || !name) {
      return sendJson(response, 400, { error: 'Student details are required' });
    }

    const key = [classCode, course, studentNumber].join('|');
    const session = {
      key,
      classCode,
      course,
      number: studentNumber,
      name,
      unit: String(body.unit || '').trim().slice(0, 120),
      progress: String(body.progress || '').trim().slice(0, 80),
      active: Boolean(body.active),
      messages: Array.isArray(body.messages)
        ? body.messages.slice(-30).map(message => ({
          role: message.role === 'user' ? 'user' : 'bot',
          text: String(message.text || '').slice(0, 1200),
          at: Number(message.at) || Date.now()
        }))
        : [],
      questions: Array.isArray(body.questions)
        ? body.questions.slice(-20).map(question => ({
          text: String(question.text || '').slice(0, 1200),
          unit: String(question.unit || '').slice(0, 120),
          status: question.status === 'answered' ? 'answered' : 'pending',
          reply: String(question.reply || '').slice(0, 1200),
          createdAt: String(question.createdAt || '')
        }))
        : [],
      updatedAt: Date.now()
    };

    sessions.set(key, session);
    publishSnapshot();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return sendJson(response, 400, { error: 'Invalid path' });
  }
  const filePath = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Not found');
    }
    response.writeHead(200, {
      'Content-Length': stats.size,
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).pipe(response);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Baeumgil server listening on ${port}`);
});
