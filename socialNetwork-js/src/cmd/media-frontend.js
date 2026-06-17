'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const { MongoClient } = require('mongodb');
const { createLogger } = require('../lib/logger');

const logger = createLogger('media-frontend');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function mediaId() {
  return BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString();
}

function extension(filename, contentType) {
  const ext = filename?.split('.').pop();
  if (ext && ext !== filename) {
    return ext;
  }
  const typeExt = contentType?.split('/').pop();
  return typeExt || 'bin';
}

function parseMultipart(body, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType || '')?.[1]?.replace(/^"|"$/g, '');
  if (!boundary) {
    throw new Error('missing multipart boundary');
  }

  const raw = body.toString('latin1');
  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) {
      continue;
    }

    const headers = part.slice(0, separator);
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (!filename) {
      continue;
    }

    const contentTypeHeader = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1];
    let payload = part.slice(separator + 4);
    if (payload.endsWith('\r\n')) {
      payload = payload.slice(0, -2);
    }

    return {
      file: Buffer.from(payload, 'latin1'),
      mediaType: extension(filename, contentTypeHeader)
    };
  }

  throw new Error('missing uploaded file');
}

async function main() {
  const host = process.env.MEDIA_MONGODB_HOST || 'media-mongodb';
  const port = process.env.MEDIA_MONGODB_PORT || '27017';
  const client = new MongoClient(process.env.MEDIA_MONGODB_URI || `mongodb://${host}:${port}`);
  await client.connect();
  const collection = client.db('media').collection('media');
  await collection.createIndex({ filename: 1 }, { unique: true });

  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': '0'
      });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/upload-media') {
        const { file, mediaType } = parseMultipart(await readBody(req), req.headers['content-type']);
        const id = mediaId();
        const filename = `${id}.${mediaType}`;
        await collection.insertOne({
          filename,
          file: file.toString('base64'),
          encoding: 'base64'
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ media_id: id, media_type: mediaType }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/get-media') {
        const filename = url.searchParams.get('filename');
        if (!filename) {
          res.writeHead(400);
          res.end('Incomplete arguments');
          return;
        }

        const media = await collection.findOne({ filename });
        if (!media) {
          res.writeHead(404);
          res.end('Media not found');
          return;
        }

        const mediaType = filename.split('.').pop() || 'jpeg';
        const file = media.encoding === 'base64'
          ? Buffer.from(media.file, 'base64')
          : Buffer.from(media.file || '', 'latin1');
        res.writeHead(200, { 'Content-Type': `image/${mediaType}` });
        res.end(file);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (error) {
      logger.error({ error }, 'media frontend request failed');
      res.writeHead(500);
      res.end(error.message);
    }
  });

  const listenPort = Number(process.env.PORT || 8080);
  server.listen(listenPort, () => {
    logger.info({ port: listenPort }, 'Media frontend listening');
  });
}

main().catch((error) => {
  logger.error({ error }, 'Failed to start media frontend');
  process.exit(1);
});
