# mermaid-server

Local-first **mermaid diagram editor**: a tabbed Monaco editor with a live
mermaid preview in the browser, backed by a small Node HTTP server that reads and
writes plain files on disk. UI modeled on [mermaid.live](https://mermaid.live),
but file-backed and driven by plain HTTP endpoints.

Everything is bundled from npm — **no CDN, no webfonts, 100% offline**.

## Run

```sh
npm install
npm run build          # SPA → dist/
npm start              # API + dist/ on http://127.0.0.1:8790
```

Dev mode: `npm run dev` (server on :8790 + Vite on :5173, proxying `/api`).

Open the UI as `http://127.0.0.1:8790/?token=<token>`. The token is generated on
first start (or passed via `--token`); the server verifies it, stores it in an
`HttpOnly` cookie and redirects to the token-less URL. Every `/api` route except
`GET /api/health` requires it.

## API

The server is plain HTTP — point any harness at these endpoints and ask it to
wrap them as tools.

`GET /api/health` · `GET /api/state` · `GET /api/browse?dir=` · `GET /api/read?path=` ·
`POST /api/save` · `POST /api/display` · `POST /api/reload` · `POST /api/session` ·
`POST /api/tabs/sync` · `DELETE /api/tabs/:name`

Every response is `{ "result": …, "error": null | { message, code } }`.
Full contract, config resolution and internals: [AGENTS.md](AGENTS.md).

## Notes

- **Loopback only** by default: the API can read and write arbitrary local files.
  It is token-guarded, but don't bind it to a public interface.
- `npm run bundle` builds the single-file server + SPA, and `npm run ship` installs
  it next to the pi extension (source in [`extension/`](extension/), agent-facing
  docs in [AGENTS.md](AGENTS.md)).

## License

MIT
