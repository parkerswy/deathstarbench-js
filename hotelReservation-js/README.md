# hotelReservation-js

Plain JavaScript / Node.js port of the Go `hotelReservation/` benchmark.

## Layout

- `src/cmd/*.js`: service entrypoints
- `src/services/*/server.js`: service implementations
- `src/seeds/*.js`: Mongo seeders ported from the Go `cmd/*/db.go` files
- `proto/*/*.proto`: copied gRPC contracts

## Run locally

Install dependencies:

```bash
npm install
```

Start the full stack:

```bash
docker compose -f hotelReservation-js/docker-compose.yml up --build
```

Start an individual process from this directory:

```bash
node src/cmd/frontend.js
```

## Tests

All commands below run from `hotelReservation-js/` unless noted.

Install dependencies first:

```bash
npm install
```

Run the fast local test suite:

```bash
npm test
```

This starts the real JS service/frontend code in-process and backs it with
in-memory MongoDB and memcached doubles. It also loads the differential test
file, but those live-stack checks are skipped unless `DIFF_GO_URL` and
`DIFF_JS_URL` are set.

Run individual layers while debugging:

```bash
node --test test/seeds.test.js        # seed data parity
node --test test/grpcInterop.test.js  # gRPC/protobuf wire checks
node --test test/services.test.js     # service behavior through real gRPC
node --test test/frontend.test.js     # full in-process HTTP frontend stack
npm run test:diff                     # skips unless DIFF_GO_URL and DIFF_JS_URL are set
```

Run the JS-vs-Go differential test against two live stacks:

```bash
cd ..

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
volumes can duplicate seeded rows and make count-based endpoints diverge. The
Go stack publishes its frontend on `5002`; the JS stack publishes its frontend
on `5003`. The overrides unpublish Consul and Jaeger host ports so the two
stacks can run beside other DeathStarBench services. The Go override also
renames the few services that use fixed `container_name` values in the original
Compose file.

Run the differential command against fresh stacks if you want the cold-cache
`/hotels` availability case to stay meaningful. Avoid manually calling
`/hotels` before `npm run test:diff`. The readiness checks use `/user` for this
reason. The test runner also retries transient startup errors such as
`ECONNRESET` while the Compose services finish registering.

Clean up the differential stacks:

```bash
cd ..

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

More detail on what each layer covers is in [`test/README.md`](test/README.md).

## Notes

- HTTP handlers intentionally read inputs from query parameters for both `GET` and `POST` requests to match the existing Go frontend and `wrk2` scripts.
- The Mongo seeders are intentionally rerun on every process start to mirror the current Go commands.
- Tracing is currently implemented in compatibility mode: the span names and call sites are preserved in the code structure, but there is no full Jaeger exporter wired up yet.
