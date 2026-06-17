# hotelReservation-js tests

These tests verify that the JavaScript port behaves like the original Go
`hotelReservation/` benchmark. The suite is split into fast in-process parity
checks and an opt-in live differential check against two Docker Compose stacks.

## Fast local tests

From `hotelReservation-js/`:

```bash
npm install
npm test
```

`npm test` runs every `test/*.test.js` file. The differential test file is
included, but it skips unless both `DIFF_GO_URL` and `DIFF_JS_URL` are set.

Run one layer at a time while debugging:

```bash
node --test test/seeds.test.js
node --test test/grpcInterop.test.js
node --test test/services.test.js
node --test test/frontend.test.js
node --test test/differential.test.js
```

The gRPC and frontend tests bind temporary local ports. In restricted
sandboxes, those commands may need permission to listen on loopback.

## What the local tests cover

`seeds.test.js` pins the canonical Mongo seed data:

- user hash formulas and username shape
- geo/rate/profile/recommendation/reservation/review/attraction document counts
- known Go quirks, such as missing cinema seed data and profile/geo coordinate
  drift for hotel 3

`grpcInterop.test.js` checks protobuf/gRPC behavior:

- `float` fields truncate to float32 on the wire
- `double` fields preserve precision
- nested and repeated messages round-trip with the expected camelCase fields

`services.test.js` starts real service implementations in-process and drives
them through the real gRPC client path with in-memory MongoDB, memcached, and
Consul doubles. It covers service-level behavior such as:

- cache keys and cache hit/miss behavior
- rate sorting and whole-inventory miss behavior
- recommendation modes and tie handling
- reservation capacity checks, per-night writes, cache updates, multi-night
  rejection, first-hotel-only behavior, negative room counts, and a controlled
  concurrent cold-cache oversell case
- search, review, attraction, and user service behavior

`frontend.test.js` starts the full JS stack in-process and drives the public
HTTP routes:

- `/user`
- `/hotels`
- `/recommendations`
- `/review`
- `/restaurants`
- `/museums`
- `/cinema`
- `/reservation`

It checks validation messages, GeoJSON response shape, auth-result quirks, and
reservation side effects visible through the in-memory database.

## Differential Test

`differential.test.js` is the live Go-vs-JS oracle. It sends identical HTTP
requests to a Go stack and a JS stack, then compares status codes and response
bodies. GeoJSON feature order is normalized because profile lookups can fan out
concurrently.

From the repository root:

```bash
cat > /tmp/hotel-go-diff.override.yml <<'YAML'
services:
  frontend:
    ports:
      - "5002:5000"
  consul:
    ports: !reset []
  jaeger:
    ports: !reset []
  review:
    container_name: hotel_go_diff_review
  attractions:
    container_name: hotel_go_diff_attractions
  memcached-review:
    container_name: hotel_go_diff_review_mmc
YAML

cat > /tmp/hotel-js-diff.override.yml <<'YAML'
services:
  frontend:
    ports: !override
      - "5003:5000"
  consul:
    ports: !reset []
  jaeger:
    ports: !reset []
YAML

docker compose -p hotel-go-diff \
  -f hotelReservation/docker-compose.yml \
  -f /tmp/hotel-go-diff.override.yml \
  down -v --remove-orphans

docker compose -p hotel-js-diff \
  -f hotelReservation-js/docker-compose.yml \
  -f /tmp/hotel-js-diff.override.yml \
  down -v --remove-orphans

docker compose -p hotel-go-diff \
  -f hotelReservation/docker-compose.yml \
  -f /tmp/hotel-go-diff.override.yml \
  up -d --build

docker compose -p hotel-js-diff \
  -f hotelReservation-js/docker-compose.yml \
  -f /tmp/hotel-js-diff.override.yml \
  up -d --build

until curl -fsS 'http://127.0.0.1:5002/user?username=Cornell_30&password=0000000000' >/dev/null 2>&1; do
  sleep 1
done
until curl -fsS 'http://127.0.0.1:5003/user?username=Cornell_30&password=0000000000' >/dev/null 2>&1; do
  sleep 1
done

cd hotelReservation-js

DIFF_GO_URL=http://127.0.0.1:5002 \
DIFF_JS_URL=http://127.0.0.1:5003 \
npm run test:diff
```

The `down -v` commands make the run start from fresh MongoDB and memcached
state. This matters because the service seeders run on startup; reusing old
volumes can duplicate seeded rows and make count-based endpoints diverge. Avoid
calling `/hotels` manually before the test run because that warms reservation
availability cache entries. The readiness checks above use `/user` for that
reason. The differential test also retries transient startup failures such as
`ECONNRESET` while services finish registering.

Clean up from the repository root:

```bash
docker compose -p hotel-go-diff \
  -f hotelReservation/docker-compose.yml \
  -f /tmp/hotel-go-diff.override.yml \
  down -v

docker compose -p hotel-js-diff \
  -f hotelReservation-js/docker-compose.yml \
  -f /tmp/hotel-js-diff.override.yml \
  down -v
```

This cleanup only removes the isolated `hotel-go-diff` and `hotel-js-diff`
projects. If `docker ps` still shows containers under project
`hotelreservation-js`, those are from the default JS stack, not the differential
stack. Stop them from the repository root with:

```bash
docker compose -p hotelreservation-js \
  -f hotelReservation-js/docker-compose.yml \
  down -v
```

## Troubleshooting

- `differential ... skipped`: set both `DIFF_GO_URL` and `DIFF_JS_URL`.
- Port conflicts on `5002` or `5003`: change the frontend port mappings in the
  override files and update the corresponding `DIFF_*_URL`.
- Stale counts or reservation results: run `docker compose ... down -v` for
  both diff projects and start fresh stacks.
