# Cozytrack

Self-hosted podcast recording studio. A Riverside.fm alternative focused on local-first audio recording with optional video preview.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  LiveKit SDK  │  │  RecordRTC   │  │   Upload Client   │  │
│  │ (WebRTC room) │  │ (local mic   │  │ (chunked upload   │  │
│  │              │  │  recording)  │  │  to S3 via        │  │
│  │  Audio/Video  │  │  WebM/Opus   │  │  presigned URLs)  │  │
│  │  Preview      │  │              │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │              │
└─────────┼─────────────────┼────────────────────┼──────────────┘
          │                 │                    │
          ▼                 │                    ▼
┌──────────────────┐        │          ┌──────────────────┐
│   LiveKit Server │        │          │     AWS S3       │
│   (WebRTC SFU)   │        │          │  (audio storage) │
│   Port: 7880     │        │          │                  │
└──────────────────┘        │          └──────────────────┘
                            │
                            ▼
                  ┌──────────────────┐
                  │   Next.js App    │
                  │   (API routes)   │
                  │                  │
                  │  - Token gen     │
                  │  - Presigned URLs│
                  │  - Session CRUD  │
                  └────────┬─────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │    PostgreSQL    │
                  │  (metadata)     │
                  └──────────────────┘
```

### How It Works

1. **Local-first recording**: Each participant records their own microphone locally using RecordRTC. Audio never passes through the server — it goes straight from the browser to S3.
2. **Live preview via WebRTC**: LiveKit provides real-time audio/video preview between participants so everyone can hear each other during recording.
3. **Crash-safe uploads**: Audio is chunked every 5 seconds and uploaded to S3 via presigned URLs. If the browser crashes, you only lose the last few seconds.
4. **No transcoding needed**: Each track is stored as a separate WebM/Opus file. Download individual tracks and mix in your DAW.

## Tech Stack

- **Next.js 15** (App Router, TypeScript) — Frontend + API
- **LiveKit** — WebRTC rooms for live audio/video preview
- **RecordRTC** — Local browser audio recording
- **AWS S3** — Audio file storage
- **PostgreSQL** — Session and track metadata
- **Prisma** — Database ORM
- **Tailwind CSS** — Styling
- **Docker Compose** — Local dev services (LiveKit, Postgres, Redis)

## Quick Start

### Prerequisites

- Node.js 20.19+ (or Node.js 22.12+)
- Docker & Docker Compose
- AWS account with S3 bucket configured

### Setup

1. **Clone and install dependencies:**

   ```bash
   git clone <repo-url>
   cd cozytrack
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
    # Edit .env with your AWS credentials or ensure your local AWS profile is configured
   ```

3. **Start infrastructure:**

   ```bash
   docker compose up -d
   ```

4. **Run database migrations:**

   ```bash
   npx prisma migrate dev --name init
   ```

5. **Start the dev server:**

   ```bash
   npm run dev
   ```

   `npm run dev` now checks local AWS auth up front and fails fast if the current session is expired.
   Reauthenticate with `aws login` and rerun the command if needed.

6. **Open** [http://localhost:3001](http://localhost:3001)

### Local Reset

Use this when you want a clean local slate:

```bash
npm run reset:local
```

This will:
- start local Docker services if needed
- reset the local Prisma database
- fully empty the configured S3 bucket, including versioned objects and delete markers

Safety guard:
- the reset script refuses to run unless `S3_BUCKET_NAME` contains `dev`, `local`, or `test`

To reset everything and immediately start the app:

```bash
npm run init:local
```

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── sessions/          # Session CRUD
│   │   ├── livekit-token/     # LiveKit JWT generation
│   │   ├── upload/            # Presigned URLs + completion
│   │   └── tracks/            # Track download
│   ├── dashboard/             # Session list
│   ├── session/[id]/          # Session detail + track downloads
│   ├── studio/[id]/           # Recording room
│   ├── layout.tsx
│   └── page.tsx               # Landing page
├── lib/
│   ├── db.ts                  # Prisma client singleton
│   ├── livekit.ts             # LiveKit client helper
│   ├── recorder.ts            # CozyRecorder (RecordRTC wrapper)
│   ├── s3.ts                  # S3 client + presigned URL helpers
│   └── upload.ts              # Client-side upload functions
prisma/
│   └── schema.prisma          # Database schema
docker-compose.yml             # LiveKit + Postgres + Redis
livekit.yaml                   # LiveKit server config
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://cozytrack:cozytrack@localhost:5433/cozytrack` |
| `LIVEKIT_API_KEY` | LiveKit API key | `devkey` |
| `LIVEKIT_API_SECRET` | LiveKit API secret | `cozytrack-local-livekit-secret-32` |
| `LIVEKIT_URL` | LiveKit server URL (server-side) | `ws://localhost:7880` |
| `NEXT_PUBLIC_LIVEKIT_URL` | LiveKit server URL (client-side) | `ws://localhost:7880` |
| `AWS_ACCESS_KEY_ID` | Optional AWS access key for local env-based auth | — |
| `AWS_SECRET_ACCESS_KEY` | Optional AWS secret key for local env-based auth | — |
| `AWS_REGION` | AWS region | `us-west-2` |
| `S3_BUCKET_NAME` | S3 bucket for recordings | `cozytrack-dev-pasha` |
| `AUTH_SECRET` | 32+ char secret for signing host + guest session JWTs. Generate with `openssl rand -hex 32`. | — (required) |
| `HOST_PASSWORD` | Plaintext password for host sign-in. **Minimum 12 characters.** Hashed with scrypt at startup. | — (required) |
| `COZYTRACK_API_KEY` | Shared secret checked against the `X-API-Key` header on `/api/ingest/*` (external-consumer endpoints used by tools like podline's `sd ct-ingest`). Browser-facing routes under `/api/sessions*` and `/api/tracks/*` are not gated by this key. Skipped in `NODE_ENV=development` for requests from `127.0.0.1` / `::1`. | — |

## Auth Model (interim)

Strict lockdown: everything requires a valid session. Two principals:

- **Host** — signs in at `/signin` with `HOST_PASSWORD`. Can access any session, create sessions, download tracks, mint invite links. Session cookie lasts 7 days.
- **Guest** — receives an invite link (`/join/<token>`) minted by the host. The cookie is scoped to a single session; the same guest can't access any other session. Invite tokens expire after 48h; guest sessions after 12h.

Both cookies are signed HS256 JWTs (`jose`). Middleware (`src/middleware.ts`) gates every non-public route. Per-route authorization in the API handlers enforces that guests can only touch their own session — this is where the S3 blast radius is capped.

External ingest tools (e.g. podline's `sd ct-ingest`) hit a separate `/api/ingest/*` namespace gated by `COZYTRACK_API_KEY` — outside the host/guest cookie flow.

Long-term plan: this scheme gets replaced by podflow-as-IdP (see `pashafateev/podflow#11`, `pashafateev/cozytrack#36`, `pashafateev/cozytrack#37`). The JWT primitive stays; only the token issuer changes.

## Finishing a recording

When a recorder is done capturing in the studio:

1. Click **Stop Recording** to flush the local recorder and drain any in-flight chunk uploads.
2. Click **Finish recording**. The studio polls `POST /api/sessions/:id/finalize` once a second for up to 30 seconds.
   - `409` with `{ pending: [...] }` means at least one track is still uploading. The UI surfaces the pending participant and keeps polling.
   - `200` flips the session to `status = "ready"`, stamps `finalizedAt`, and shows the session ID with a copy button plus the ingest hint `sd ct-ingest <id>`.
   - On a 30-second timeout the UI offers a Retry button.

Calling `POST /api/sessions/:id/finalize` on an already-ready session is idempotent — it returns the same payload without re-stamping `finalizedAt`.
