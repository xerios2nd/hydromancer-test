# @local/hydromancer

Framework-free client for the [Hydromancer API](https://docs.hydromancer.xyz/llms.txt), built for realtime charts with historical data. It covers what the chart uses: candles, `l2Book`, TP/SL trigger orders and perp position snapshots. The root `CLAUDE.md` rules apply here too.

## Layering

Layers only depend downward: streams → rest/ws/cache → codec/parse → util/errors. `vite.ts` runs Node-side and must not use relative imports (see its file header).

## API facts the code depends on

- **Endpoints:** REST is `POST <base>/info` with `Authorization: Bearer <key>`. The WebSocket is `<base>/ws?token=<key>`, and data starts only after the server's `connected` frame. Base URLs: `https://api.hydromancer.xyz`, `https://api-testnet.hydromancer.xyz`.
- **Browsers:** the key must never reach a browser (`token` would be public). The app uses the Vite proxy in `vite.ts`, and the client gets `baseUrl`/`restUrl`/`wsUrl` set to same-origin paths without `apiKey`.
- **Pings:** the server pings every 60s and expects `{"type":"pong"}`.
- **`seq`:** per subscription, starts at 1 and resets on every connection. A jump means messages were lost.
- **Rate limits:**
  - REST has a per-minute weight budget (`candleSnapshot` = 20). A 429 carries `Retry-After` and `retryAfterSecs` in the body.
  - Some endpoints have separate windows: `tpslBook` 10 per 5 min; snapshot-style endpoints 5 per 10 min (we assume `perpSnapshots` is one of them); see `DEFAULT_WINDOW_LIMITS`.
  - The WebSocket reports `message_rate_limit` errors.
- **Candles:** `candleSnapshot` returns at most 5000 per request. `[startTime, endTime)` is inclusive, then exclusive. `q` is `null` before 2025-08-01.
- **TP/SL sync recipe:** buffer `tpslUpdates`, fetch `tpslBook` and note its `height`, apply buffered updates with `height >` snapshot height, then apply live updates. Orders are immutable (add/remove only).
- **perpSnapshots:**
  - Single-market responses are `zstd(msgpack([id, market, positions, addresses]))` sent with `Content-Encoding: zstd`, so they may arrive already decompressed.
  - Multi-market responses use `[count u32]([len u32][blob])*`, little-endian.
  - A liquidation price of `0` means none.

## Design decisions (keep unless asked)

- **No session resume or replay.** After every reconnect, streams repair their state over REST: candles backfill from the newest candle, the TP/SL mirror resnapshots, and `l2Book` needs nothing.
- **Handshake and ack fallbacks.** If `connected` never arrives within `handshakeTimeoutMs` (3s), subscribing proceeds anyway. A subscribe without an ack after `ackTimeoutMs` (10s) counts as active. This avoids stalling against server builds that don't echo.
- **Auth failures are final.** An `AuthenticationError` (REST 401 or a WebSocket "Invalid API key") puts the connection in `failed` and stops reconnecting. With `validateApiKey: true`, `connect()` checks the key over REST first.
- **Errors.**
  - Everything the library raises or reports is a `HydromancerError` subclass. Stream `onError` receives one, or `undefined` once it clears.
  - Aborts are not errors: rethrow the signal's reason and check `isAbortError`.
- **Parsing is lenient per item and strict per payload.** Unknown fields and frame types are ignored, as the docs require. One bad item is dropped, but a payload of the wrong shape throws `DecodeError`.
- **Caching is best-effort.**
  - Always go through `cacheGet`/`cacheSet`, which swallow storage failures.
  - Only immutable data is cached: candle chunks that ended more than `finalityGraceMs` ago, and position snapshots keyed by snapshot id.
  - Cache keys carry a version (`hydromancer:candles:v1:…`). Bump it when the stored shape changes.
- **Positions are column-oriented** (typed arrays per field) because markets can hold 100k+ positions.

## Conventions

- **TypeScript:** the target lib is ES2022, so `Array#toSorted` doesn't exist. Use `sortByTime` from `util.ts`; it holds the single justified `no-array-sort` disable.
- **Lint:** oxlint runs with `--deny-warnings`. Write sequential async work as recursion (as in `RestClient.#request`, `InfoApi.#page` and `WindowLimiter.acquire`) or `Promise.all`, not `await` in a loop.
- **Comments:** comments state the protocol fact or invariant behind the code, with a docs link where one exists. Keep that style.
- **Exports:** new public API goes in `index.ts` with its types exported alongside.

## Tests

- **Unit tests:** `pnpm exec vitest run packages/hydromancer` runs them all, offline. They use `vi.useFakeTimers()` with `FakeWebSocket` and `fakeFetch` from `test/fakes.ts`. Drive server behaviour with `ws.handshake()`, `ws.receive(frame)` and `ws.drop()`, and build binary fixtures with `msgpack`, `zstd` and `frame`.
- **Live tests:** `pnpm test:live` runs `live.test.ts` against the real API. It needs `HYDROMANCER_API_KEY` in `.env` and spends one `tpslBook` and one `perpSnapshots` request. It's skipped unless `HYDROMANCER_LIVE=1`, which the script sets. Run it after changing a decoder or parser.
