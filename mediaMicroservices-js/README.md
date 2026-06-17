# mediaMicroservices-js

Plain JavaScript / Node.js port of the C++ `mediaMicroservices/` benchmark.
The OpenResty/Lua HTTP gateway and the framed/binary Thrift interface are kept
compatible with the existing workload and setup scripts.

## Layout

- `src/cmd/*.js`: one entrypoint per Thrift service
- `src/services/*.js`: translated handler behavior
- `src/lib/*.js`: Thrift, cache, persistence, precise `i64`, and tracing helpers
- `gen-nodejs/`: generated Node Thrift bindings
- `gen-lua/` and `nginx-web-server/`: unchanged gateway-facing assets

`npm run generate` regenerates Node bindings and applies a small post-generation
fix for declared exception serialization in the generated Promise server path.

All Thrift `i64` values are converted through `node-int64`, `BigInt`, and
MongoDB `Long`; application logic does not use imprecise JavaScript numbers
for request IDs, review IDs, user IDs, cast/plot IDs, or timestamps.

## Run

Install dependencies for local execution:

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
python -m pip install aiohttp
```

From the repository root, start the standard write-workload stack:

```bash
cd mediaMicroservices-js
docker compose up --build
```

This stack publishes its Jaeger UI at `http://localhost:16687` by default so
it can run beside `hotelReservation-js`. Override that port when needed:

```bash
MEDIA_JAEGER_UI_PORT=16688 docker compose up --build
```

Thrift service clients retry dependency connections continuously by default so
containers may start or restart in any order. Set `THRIFT_MAX_CONNECT_ATTEMPTS`
or `THRIFT_CONNECT_TIMEOUT_MS` on services only when bounded retries are needed.

The existing setup and workload scripts continue to target
`http://localhost:8080/wrk2-api/...`. From `mediaMicroservices-js/`:

```bash
python3 scripts/write_movie_info.py -c ../mediaMicroservices/datasets/tmdb/casts.json \
  -m ../mediaMicroservices/datasets/tmdb/movies.json --server_address http://localhost:8080
scripts/register_users.sh

cd ../wrk2
./wrk -D exp -t <num-threads> -c <num-conns> -d <duration> -L \
  -s ../mediaMicroservices-js/wrk2/scripts/media-microservices/compose-review.lua \
  http://localhost:8080/wrk2-api/review/compose -R <reqs-per-sec>
```

For the compose-review workload alone, page metadata is unnecessary. To seed
only the TMDB movie-title mappings used by `wrk2`:

```bash
python3 scripts/write_movie_info.py \
  -m ../mediaMicroservices/datasets/tmdb/movies.json \
  --server_address http://localhost:8080 --register-movies-only
```

The seeder limits concurrent setup requests and can be rerun after a partial
setup; duplicate insert-only writes are reported and skipped by the service.

`PageService` is translated for Thrift API parity but is not routed by the
original gateway. Start its optional container when testing direct Thrift
page reads:

```bash
docker compose --profile page up --build
```

With that profile active, `PageService` accepts framed/binary Thrift requests
directly at `localhost:10013`; no new HTTP gateway route is added.

## Tests

All commands below run from `mediaMicroservices-js/`.

Install dependencies first:

```bash
npm install
```

Run the fast local tests:

```bash
npm test              # unit tests with in-memory Redis/Mongo/Memcached fakes
npm run test:parity   # datastore-free checks pinned to C++ behavior
npm run test:wire     # local Thrift server/client wire checks
npm run test:coverage # unit + parity through c8 coverage thresholds
```

Run integration tests against real MongoDB, Redis, and Memcached:

```bash
npm run itest:up
npm run test:integration
npm run itest:down
```

`npm run test:integration` sets `MEDIA_IT=1` and
`MEDIA_CONFIG_PATH=config/service-config.test.json` for you. Use
`npm run itest:down` after the run to stop containers and remove test volumes.

Run the JS-vs-C++ differential test:

```bash
cat > /tmp/media-cpp-diff.override.yml <<'YAML'
services:
  page-service:
    image: yg397/media-microservices
    hostname: page-service
    entrypoint: PageService
    ports:
      - "10013:9090"
    depends_on:
      - movie-info-service
      - movie-review-service
      - cast-info-service
      - plot-service
    restart: always
YAML

cat > /tmp/media-js-diff.override.yml <<'YAML'
services:
  nginx-web-server:
    ports: !override
      - "18080:8080"
  movie-review-mongodb:
    ports: !override []
  page-service:
    ports: !override
      - "11013:9090"
YAML

cd ../mediaMicroservices
docker compose -p media-cpp-diff \
  -f docker-compose.yml \
  -f /tmp/media-cpp-diff.override.yml \
  up -d --scale dns-media=0

cd ../mediaMicroservices-js
docker compose -p media-js-diff \
  -f docker-compose.yml \
  -f /tmp/media-js-diff.override.yml \
  --profile page up -d --build

DIFF_CPP_URL=http://localhost:8080 \
DIFF_JS_URL=http://localhost:18080 \
DIFF_CPP_PAGE_ADDR=127.0.0.1:10013 \
DIFF_JS_PAGE_ADDR=127.0.0.1:11013 \
npm run test:diff

docker compose -p media-js-diff \
  -f docker-compose.yml \
  -f /tmp/media-js-diff.override.yml \
  --profile page down -v

cd ../mediaMicroservices
docker compose -p media-cpp-diff \
  -f docker-compose.yml \
  -f /tmp/media-cpp-diff.override.yml \
  down -v
```

The C++ compose file does not publish `PageService`, so the override exposes it
on `10013`. The JS override moves the JS gateway to `18080` and its
`PageService` to `11013` so both stacks can run on one machine. `dns-media` is
disabled for this test because Docker Desktop on macOS can block its host
mount; the containers still resolve each other through the Compose network.

More detail on what each layer covers is in [`test/README.md`](test/README.md).

## Notes

- The gateway still emits its existing OpenTracing spans. Node service span
  boundaries and carrier arguments are retained in compatibility mode, without
  a Node Jaeger exporter, matching `hotelReservation-js`.
- The default stack runs the same twelve services exercised by the documented
  media review workload; `PageService` is the optional thirteenth service.
