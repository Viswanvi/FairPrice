# FairPrice

FairPrice lets sellers of digital products charge an AI-recommended fair price in every
country. PayPal confirms the buyer's account country before any money is captured, so
sellers are protected from VPN abuse and buyers are never overcharged.

Built for the PayPal AI Hackathon 2026. Sandbox only.

> Work in progress. Full README (hosted link, sandbox test buyers, AI tools used,
> architecture) arrives in Phase 14.

## Local setup

```bash
npm install
cp .env.example .env         # fill in the values; never commit it
docker compose up -d db      # or point DATABASE_URL at a Render Postgres URL
npm run db:migrate
npm run dev
```

## Stack

Next.js (App Router) + TypeScript + Tailwind · PostgreSQL via Prisma · Zod · Vitest and
Playwright · AG Grid Community · PayPal REST API (sandbox) and JavaScript SDK · Anthropic
API · hosted on Render.

## License

[MIT](LICENSE)
