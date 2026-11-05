# pr-manager

AI PR specialist service: content pipeline state, VK metrics, Telegram recommendations, cadence control.

Stack: TypeScript/Express on Node 24 (`type: module`, NodeNext), SQLite via better-sqlite3, Vitest for tests, Biome 2.6.4 for lint/format. Listens on `127.0.0.1:8789` (`PORT` env overrides).

## Commands

```sh
npm ci          # install
npm run dev     # dev server (tsx)
npm run build   # tsc -> dist/
npm start       # node dist/server.js
npm test        # vitest run
npx tsc --noEmit  # typecheck
npx biome ci .    # lint + format check
```

## Endpoints

- `GET /health` - service status with per-subsystem `last_success`/`last_error` (stub until item_08)
- `GET /state/summary` - pipeline state summary (stub)
- `POST /audit/run` - profile audit trigger (501 stub)

`.devin/` and the roadmap are private working documents of the dev cycle and are not published (gitignored).
