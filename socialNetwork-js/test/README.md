# socialNetwork-js tests

These tests check the JavaScript port against the original C++ social network
benchmark at three levels:

- `services.test.js`: fast handler-level parity tests with in-memory fakes for
  MongoDB, Redis, and Memcached.
- `thriftInterop.test.js`: a local framed/binary Thrift server/client check for
  `i64` values and declared exceptions.
- `differential.test.js`: an opt-in end-to-end comparison between a live C++
  stack and a live JS stack through the OpenResty/Lua gateway.

## Fast local tests

From `socialNetwork-js/`:

```bash
npm install
npm test
npm run test:coverage
```

`npm test` runs all `test/*.test.js` files. The differential test is included
but skipped unless both stack URLs are supplied.

`npm run test:coverage` uses Node's built-in test coverage for
`services.test.js` and `thriftInterop.test.js`. Coverage is scoped to
`src/services/**/*.js` plus `src/lib/{i64,idGenerator,errors}.js`, with global
thresholds of 90% lines, 90% functions, and 80% branches.

Run individual files while debugging:

```bash
node --test test/services.test.js
node --test test/thriftInterop.test.js
node --test test/differential.test.js
```

`thriftInterop.test.js` binds a temporary local `127.0.0.1` port. If a sandbox
or local firewall blocks loopback listeners, run it in an environment that
allows local server sockets.

## What the local tests cover

`services.test.js` pins:

- deterministic signed `i64` ID layout and large `i64` round-trips;
- Mongo document schemas and Memcached/Redis key formats;
- JWT payload shape and cache-hit behavior;
- C++-compatible `ServiceException` codes and messages for negative paths;
- post storage ordering across cache and Mongo reads;
- social graph follow/unfollow, username-based follow paths, and cold Redis
  backfill from Mongo;
- user/home timeline ordering, invalid ranges, and fanout dedup behavior;
- text, URL, mention, media, creator, and post-type parity.

`thriftInterop.test.js` starts a real local Thrift server and verifies that the
generated Node bindings preserve large `i64` values and declared exceptions over
framed/binary Thrift.

## Differential test

The differential test drives identical HTTP requests through two full stacks:

- original C++ stack: `socialNetwork/`;
- JavaScript stack: `socialNetwork-js/`.

It registers deterministic user IDs, creates a follow graph, composes posts,
then reads user/home timelines from both stacks. It normalizes fields that are
expected to differ per stack, such as generated post IDs, timestamps, request
IDs, and random shortened URL suffixes.

### Run against already-running stacks

If you start the stacks with the one-machine commands below, the C++ gateway is
reachable at `http://localhost:28080` and the JS gateway is reachable at
`http://localhost:28082`:

```bash
DIFF_CPP_URL=http://localhost:28080 \
DIFF_JS_URL=http://localhost:28082 \
npm run test:diff
```

Use different hosts or ports when the stacks run elsewhere.

### Start both stacks on one machine

From the repository root:

```bash
cd socialNetwork
cat >/tmp/social-cpp-diff.override.yml <<'YAML'
services:
  nginx-thrift:
    ports: !override
      - "28080:8080"
  media-frontend:
    ports: !override
      - "28081:8080"
  post-storage-service:
    ports: !override
      - "20002:9090"
  jaeger-agent:
    ports: !override
      - "16689:16686"
YAML

docker compose -p social-cpp-diff \
  -f docker-compose.yml \
  -f /tmp/social-cpp-diff.override.yml \
  up -d

cd ../socialNetwork-js
cat >/tmp/social-js-diff.override.yml <<'YAML'
services:
  nginx-thrift:
    ports: !override
      - "28082:8080"
  media-frontend:
    ports: !override
      - "28083:8080"
  post-storage-service:
    ports: !override
      - "21002:9090"
  jaeger-agent:
    ports: !override
      - "16690:16686"
YAML

docker compose -p social-js-diff \
  -f docker-compose.yml \
  -f /tmp/social-js-diff.override.yml \
  up -d --build
```

Then run:

```bash
DIFF_CPP_URL=http://localhost:28080 \
DIFF_JS_URL=http://localhost:28082 \
npm run test:diff
```

Clean up:

```bash
docker compose -p social-js-diff \
  -f docker-compose.yml \
  -f /tmp/social-js-diff.override.yml \
  down -v

cd ../socialNetwork
docker compose -p social-cpp-diff \
  -f docker-compose.yml \
  -f /tmp/social-cpp-diff.override.yml \
  down -v
```

## Troubleshooting

- `differential ... skipped`: set both `DIFF_CPP_URL` and `DIFF_JS_URL`.
- `fetch failed`, `ECONNREFUSED`, or HTTP status mismatch: one gateway is not
  reachable at the supplied URL, or the wrong stack is bound to that port.
- Docker port conflicts on `8080`, `8081`, `10002`, `16686`, or `18080`: use
  the C++ and JS overrides above, or choose another free pair of gateway ports.
  `18080` is commonly already occupied when the media microservices diff stack
  is running.
- Timeline count/order failures after repeated runs: rerun against clean stacks
  with `docker compose ... down -v` so old Mongo/Redis state cannot collide with
  the differential setup.
