# socialNetwork-js

Plain JavaScript / Node.js port of the C++ `socialNetwork/` benchmark.

The default single-machine Docker Compose application keeps the original
framed/binary Thrift API, service hostnames, OpenResty/Lua gateway, web pages,
media frontend, and wrk2 routes compatible with the original benchmark.

## Layout

- `src/cmd/*.js`: one entrypoint per Thrift service
- `src/services/*.js`: translated handler behavior
- `src/lib/*.js`: Thrift, cache, persistence, precise `i64`, and tracing helpers
- `gen-nodejs/`: generated Node Thrift bindings
- `gen-lua/`, `nginx-web-server/`, and `media-frontend/`: gateway-facing assets

## Run

Install dependencies for local tests:

```bash
npm install
```

Regenerate Node bindings after editing `social_network.thrift`:

```bash
npm run generate
```

Start the default stack:

```bash
docker compose up --build
```

The stack publishes Nginx at `http://localhost:8080`, the media frontend at
`http://localhost:8081`, and Jaeger at `http://localhost:16686`. Override the
Jaeger host port when needed:

```bash
SOCIAL_JAEGER_UI_PORT=16688 docker compose up --build
```

Initialize the social graph from this directory:

```bash
python3 scripts/init_social_graph.py --graph=socfb-Reed98 --limit=200
```

`--limit` is the number of concurrent HTTP requests. It does not cap the graph
size; `socfb-Reed98` still loads the full dataset.

Example smoke checks:

```bash
curl -X POST http://localhost:8080/wrk2-api/user/register \
  -d first_name=A -d last_name=B -d username=username_1000001 \
  -d password=password_1000001 -d user_id=1000001

curl -X POST http://localhost:8080/wrk2-api/user/register \
  -d first_name=C -d last_name=D -d username=username_1000002 \
  -d password=password_1000002 -d user_id=1000002

curl -X POST http://localhost:8080/wrk2-api/user/follow \
  -d user_name=username_1000002 -d followee_name=username_1000001

curl -X POST http://localhost:8080/wrk2-api/post/compose \
  -d username=username_1000001 -d user_id=1000001 \
  -d text='hello @username_1000002 http://example' \
  -d media_ids='[]' -d media_types='[]' -d post_type=0

curl 'http://localhost:8080/wrk2-api/user-timeline/read?user_id=1000001&start=0&stop=10'
curl 'http://localhost:8080/wrk2-api/home-timeline/read?user_id=1000002&start=0&stop=10'
```

## Tests

All commands below run from `socialNetwork-js/`.

Install dependencies first:

```bash
npm install
```

Run the fast local test suite:

```bash
npm test
npm run test:coverage
```

This runs the service parity tests, value-domain tests, local Thrift wire test,
and the differential test file. The differential test is skipped unless
`DIFF_CPP_URL` and `DIFF_JS_URL` are set.

`npm run test:coverage` runs the service and Thrift wire layers with Node's
built-in coverage checks over `src/services/**/*.js` and pure shared logic in
`src/lib/{i64,idGenerator,errors}.js`.

Run individual layers while debugging:

```bash
node --test test/services.test.js
node --test test/thriftInterop.test.js
npm run test:coverage # services + shared logic coverage thresholds
npm run test:diff       # skips unless DIFF_CPP_URL and DIFF_JS_URL are set
```

Run the JS-vs-C++ differential test against two live stacks:

```bash
cd ../socialNetwork
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

DIFF_CPP_URL=http://localhost:28080 \
DIFF_JS_URL=http://localhost:28082 \
npm run test:diff
```

The overrides use conflict-free local ports so the social differential stacks
can coexist with other benchmark stacks that may already own `8080`, `18080`,
or `16686`. They also move the exposed `post-storage-service` Thrift ports,
which both compose files publish by default.

Clean up the differential stacks:

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

More detail on what each layer covers is in [`test/README.md`](test/README.md).

## Scope

This port targets default app parity. TLS Compose, Redis sharding, swarm,
OpenShift, Helm, and the RabbitMQ `WriteHomeTimelineService` deployment path are
not translated in this pass.

Node service tracing preserves span boundaries and carrier arguments in
compatibility mode, matching the existing JavaScript ports; the OpenResty
gateway still uses the original tracing integration.
