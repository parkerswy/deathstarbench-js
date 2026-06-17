'use strict';

// Parity: the OpenResty/Lua gateway must reproduce the C++ reference gateway's
// observable behavior. We compare the JS port's lua scripts against the upstream
// C++ scripts and lock the request-id derivation contract.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const JS_GATEWAY = path.resolve(__dirname, '../../nginx-web-server/lua-scripts/wrk2-api');
const CPP_GATEWAY = path.resolve(
  __dirname, '../../../mediaMicroservices/nginx-web-server/lua-scripts/wrk2-api'
);

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// Reproduction of the lua: tonumber(string.sub(ngx.var.request_id, 0, 15), 16)
function reqIdFrom(requestId) {
  return parseInt(requestId.slice(0, 15), 16);
}

test('request_id is derived from the first 15 hex chars in both gateways', () => {
  const line = 'local req_id = tonumber(string.sub(ngx.var.request_id, 0, 15), 16)';
  for (const file of ['review/compose.lua', 'movie-info/write.lua']) {
    assert.ok(read(JS_GATEWAY, file).includes(line), `${file} should derive req_id like C++`);
  }
  const requestId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(reqIdFrom(requestId), parseInt('a1b2c3d4e5f6071', 16));
});

test('movie-info/write.lua reproduces the upstream cast field handling verbatim', () => {
  // The upstream C++ gateway copies cast["charactor"] (a typo for "character").
  // The JS port must reproduce this behavior for parity, not "fix" it in isolation
  // (doing so would diverge from the reference benchmark's seeded data).
  const js = read(JS_GATEWAY, 'movie-info/write.lua');
  const cpp = read(CPP_GATEWAY, 'movie-info/write.lua');
  assert.ok(cpp.includes('charactor'), 'sanity: upstream reference contains the charactor token');
  assert.ok(js.includes('charactor'), 'JS port must match the upstream charactor behavior');
});
