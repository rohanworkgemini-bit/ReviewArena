# ReviewArena

A blind review comparison system where users vote on AI-generated reviews without knowing which model produced them. Built as a full-stack prototype with Next.js, Drizzle ORM, and PostgreSQL (Neon).

## Features

- **Blind Comparison** — Two reviews shown side-by-side, model names hidden
- **Voting** — Vote A, B, or Tie; model names revealed after voting
- **Leaderboard** — Models ranked by score (wins = 1 point, ties = 0.5 each)

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **Database:** PostgreSQL (Neon serverless)
- **ORM:** Drizzle ORM

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up the database

Create a `.env` file with your Neon database URL:

```
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
```

### 3. Push the schema and seed data

```bash
npx drizzle-kit push
npx tsx src/db/seed.ts
```

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/comparison` | Returns a random blind comparison |
| POST | `/api/vote` | Records a vote, returns model names |
| GET | `/api/leaderboard` | Returns ranked models by score |

## Project Structure

```
src/
├── app/
│   ├── page.tsx                 # Arena (voting page)
│   ├── leaderboard/page.tsx     # Leaderboard page
│   └── api/
│       ├── comparison/route.ts  # GET /api/comparison
│       ├── vote/route.ts        # POST /api/vote
│       └── leaderboard/route.ts # GET /api/leaderboard
├── db/
│   ├── schema.ts                # Database tables & relations
│   ├── index.ts                 # DB connection
│   └── seed.ts                  # Seed script
└── utils/
    └── queries.ts               # Database query functions
```

## Database Schema

- **models** — AI models (GPT-4, Claude 3 Opus, Gemini 1.5 Pro)
- **reviews** — Review texts, each belonging to a model
- **comparisons** — Pairs of reviews for side-by-side voting
- **votes** — Recorded votes with winner/loser and tie flag
