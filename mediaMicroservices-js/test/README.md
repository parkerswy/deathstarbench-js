# Tests

These tests verify that the JavaScript port behaves like the C++/Thrift reference
in `../../mediaMicroservices`. They are organized into five focused targets.

## 1. Unit tests (`test/*.test.js`)

Fast, hermetic handler tests using `node:test` and the in-memory fakes in
[`helpers.js`](helpers.js) (`MemoryCache`, `MemoryRedis`, `MemoryCollection`,
`recordingClient`). Every service handler and its edge cases (cache hit vs. Mongo
fallback, ordering, duplicate/incomplete/error paths, the compose-review fan-in
gate) are covered here.

```bash
npm test                 # run the unit layer
npm run test:coverage    # unit + parity with c8 coverage thresholds
```

Coverage is scoped (see the `c8` block in `package.json`) to `src/services/**`
plus the pure logic in `src/lib/{i64,idGenerator,errors}.js`.

## 2. Parity tests (`test/parity/*.test.js`)

Datastore-free tests that pin behavior to the C++ reference: the unique-id bit
layout and 2018 epoch, JWT payload shape, SHA-256 password hashing, exact
`ServiceException` messages and error codes, rating-average math, Thrift wire
round-trips for nested structs (`Review`/`MovieInfo`/`Page`), and gateway
request-id derivation. The files include reference-source notes pointing back to
`mediaMicroservices/src` or the upstream lua gateway.

```bash
npm run test:parity
```

## 3. Wire tests (`test/wire/*.test.js`)

Loopback Thrift server/client tests that bind `127.0.0.1` and verify generated
bindings preserve precise `i64` values and declared exceptions over framed/binary
transport. These are separate from `npm test` so the default unit target remains
usable in sandboxes that deny local listeners.

```bash
npm run test:wire
```

## 4. Differential tests (`test/differential.test.js`)

Live-stack comparison against the original C++ benchmark. The test drives the
same OpenResty gateway writes against both stacks, then reads each resulting page
through direct framed/binary Thrift `PageService` clients and normalizes
per-stack generated IDs/timestamps before comparing the response.

It auto-skips unless all endpoints are provided:

```bash
DIFF_CPP_URL=http://localhost:8080 \
DIFF_JS_URL=http://localhost:18080 \
DIFF_CPP_PAGE_ADDR=127.0.0.1:10013 \
DIFF_JS_PAGE_ADDR=127.0.0.1:11013 \
npm run test:diff
```

The stock C++ compose file does not publish `PageService`; add it with a small
compose override. The JS compose file defines it behind the `page` profile, so
run that profile and remap its host port when both stacks run on one machine.

## 5. Integration tests (`test/integration/*.integration.test.js`)

Prove the semantics the mocks cannot: real Memcached `add`/`increment` atomicity
for the compose-review gate, real Redis sorted-set ordering, real Mongo
`$position:0` ordering / `$slice` projection, cache backfill, and a real Thrift
server+client through an actual handler. They are **skipped unless `MEDIA_IT=1`**.

```bash
npm run itest:up          # docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration  # MEDIA_IT=1 + config/service-config.test.json
npm run itest:down        # tear down and remove volumes
```

A single Mongo/Redis/Memcached instance (ports 27018/6380/11212) backs every
service; per-service isolation comes from distinct database names mapped in
`config/service-config.test.json`.
