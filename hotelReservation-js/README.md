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

## Notes

- HTTP handlers intentionally read inputs from query parameters for both `GET` and `POST` requests to match the existing Go frontend and `wrk2` scripts.
- The Mongo seeders are intentionally rerun on every process start to mirror the current Go commands.
- Tracing is currently implemented in compatibility mode: the span names and call sites are preserved in the code structure, but there is no full Jaeger exporter wired up yet.
