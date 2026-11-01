# real estate

For art class.

One shared 256 × 256 canvas. Each visitor gets a colour and can paint over anyone. The footer shows how much of the canvas is currently yours.

- `web/`: Vite + TypeScript frontend (Cloudflare Pages)
- `worker/`: Worker + one SQLite Durable Object (state, persistence, WebSockets)
- `shared/`: protocol, brush, colours

```sh
npm install
cp worker/.dev.vars.example worker/.dev.vars
npm run dev:worker    # :8787
npm run dev:web       # :5173

npm run typecheck
npm test
npm run deploy:worker
npm run deploy:web    # needs VITE_WS_URL (see web/.env.example)
npm run reset         # needs API_URL + ADMIN_TOKEN
```
