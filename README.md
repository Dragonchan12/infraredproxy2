# Controlled Proxy (Next.js)

A controlled proxy viewer that only fetches allowlisted domains, logs all requests, and enforces rate limits. Built with Next.js and deployable on Vercel.

## Features
- Allowlist-only outbound requests
- Private IP / localhost blocking
- Audit logging (console + optional file)
- Rate limiting per IP
- HTML rewriting so assets load through the proxy
- Sandboxed iframe preview UI

## Quick start

```bash
cd controlled-proxy
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000` and enter an allowlisted URL.

## Configuration

- `PROXY_WHITELIST`: Comma-separated hostnames. Example: `example.com,static.example.com`.
- `PROXY_WHITELIST_ENABLED`: Set to `false` to disable the whitelist. Defaults to `true`.
- `RATE_LIMIT_WINDOW_MS`: Window size in milliseconds. Default `60000`.
- `RATE_LIMIT_MAX`: Max requests per window per IP. Default `60`.
- `AUDIT_LOG_PATH`: Optional local file path for JSONL audit logs.

## Deployment (Vercel)

1. Push the `controlled-proxy` folder to GitHub.
2. Import the repo in Vercel.
3. Set environment variables in Vercel:
   - `PROXY_WHITELIST`
   - `RATE_LIMIT_WINDOW_MS`
   - `RATE_LIMIT_MAX`
   - Optional: `AUDIT_LOG_PATH` (not recommended on Vercel)

## Notes
- Rate limits and audit logs are in-memory on Vercel serverless. For durable storage, integrate a managed store (e.g., Redis or a logging service).
- The iframe is sandboxed so scripts cannot access your app origin. Some sites may not work fully.
# infraredproxy2
