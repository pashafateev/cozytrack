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
│  │              │  │  recording)  │  │  to S3-compatible │  │
│  │  Audio/Video  │  │  WebM/Opus   │  │  presigned URLs)  │  │
│  │  Preview      │  │              │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │              │
└─────────┼─────────────────┼────────────────────┼──────────────┘
          │                 │                    │
          ▼                 │                    ▼
┌──────────────────┐        │          ┌──────────────────┐
│   LiveKit Server │        │          │ S3-compatible   │
│   (WebRTC SFU)   │        │          │ storage          │
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

1. **Local-first recording**: Each participant records their own microphone locally using RecordRTC. Audio never passes through the server — it goes straight from the browser to S3-compatible storage.
2. **Live preview via WebRTC**: LiveKit provides real-time audio/video preview between participants so everyone can hear each other during recording.
3. **Crash-safe uploads**: Audio is chunked every 5 seconds and uploaded to S3-compatible storage via presigned URLs. If the browser crashes, you only lose the last few seconds.
4. **No transcoding needed**: Each track is stored as a separate WebM/Opus file. Download individual tracks and mix in your DAW.

## Tech Stack

- **Next.js 15** (App Router, TypeScript) — Frontend + API
- **LiveKit** — WebRTC rooms for live audio/video preview
- **RecordRTC** — Local browser audio recording
- **S3-compatible storage** — Audio file storage via AWS S3 in production or MinIO for fully local dev
- **PostgreSQL** — Session and track metadata
- **Prisma** — Database ORM
- **Tailwind CSS** — Styling
- **Docker Compose** — Local dev services (LiveKit, Postgres, Redis, MinIO)

## Quick Start

### Prerequisites

- Node.js 20.19+ (or Node.js 22.12+)
- Docker & Docker Compose
- AWS account with S3 bucket configured only if you are not using the default local MinIO flow

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
   ```

   Edit `.env` and set `AUTH_SECRET` and `HOST_PASSWORD`. The storage defaults already point at local MinIO.

3. **Start the fully local dev stack:**

   ```bash
   npm run dev:local
   ```

   This starts Docker services with the local MinIO profile enabled, creates the MinIO bucket, pushes the Prisma schema, and starts Next.js on port 3001. `dev:local` always overrides storage settings to use local MinIO, even if `.env` contains cloud-backed S3 values.

4. **Open** [http://localhost:3001](http://localhost:3001)

### Cloud-backed S3 Dev

The default `.env.example` uses local MinIO:

```env
S3_BUCKET_NAME=cozytrack-local
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
```

To use a real AWS S3 bucket during local development:

1. Set `S3_BUCKET_NAME` to your dev bucket.
2. Clear `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE`.
3. Replace the local fake AWS credentials with real credentials, or remove them and rely on your local AWS profile.
4. Start services and the app:

   ```bash
   docker compose up -d
   npm run db:push
   npm run dev
   ```

`npm run dev` checks AWS auth up front when no custom S3 endpoint is configured and fails fast if the current AWS session is expired. Reauthenticate with `aws login` and rerun the command if needed.

The local MinIO console is available after `npm run dev:local` at [http://localhost:9001](http://localhost:9001) with the `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` values from `.env`.

### Local Reset

Use this when you want a clean local slate:

```bash
npm run reset:local
```

This will:
- start local Docker services if needed, enabling MinIO only when the configured S3 endpoint is local
- reset the local Prisma database
- empty the configured local MinIO bucket, or fully empty an AWS-backed dev bucket including versioned objects and delete markers

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
docker-compose.yml             # LiveKit + Postgres + Redis, plus opt-in MinIO
livekit.yaml                   # LiveKit server config
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://cozytrack:cozytrack@localhost:5433/cozytrack` |
| `DIRECT_DATABASE_URL` | Direct PostgreSQL connection for Prisma migrations and schema pushes. Locally this can match `DATABASE_URL`; `npm run dev:local` fills it from `DATABASE_URL` if omitted. | `postgresql://cozytrack:cozytrack@localhost:5433/cozytrack` |
| `LIVEKIT_API_KEY` | LiveKit API key | `devkey` |
| `LIVEKIT_API_SECRET` | LiveKit API secret | `cozytrack-local-livekit-secret-32` |
| `LIVEKIT_URL` | LiveKit server URL (server-side) | `ws://localhost:7880` |
| `NEXT_PUBLIC_LIVEKIT_URL` | LiveKit server URL (client-side) | `ws://localhost:7880` |
| `AWS_ACCESS_KEY_ID` | AWS-compatible access key. Defaults to local MinIO credentials. | `minioadmin` |
| `AWS_SECRET_ACCESS_KEY` | AWS-compatible secret key. Defaults to local MinIO credentials. | `minioadmin` |
| `AWS_REGION` | S3 signing region. `npm run dev:local` ignores this and uses `LOCAL_AWS_REGION` instead. | `us-east-1` |
| `LOCAL_AWS_REGION` | Optional local-only signing region override for `npm run dev:local`. | `us-east-1` |
| `S3_BUCKET_NAME` | S3-compatible bucket for recordings | `cozytrack-local` |
| `S3_ENDPOINT` | Optional S3-compatible endpoint. Set to local MinIO for fully local dev; leave empty for AWS S3. | `http://localhost:9000` |
| `S3_FORCE_PATH_STYLE` | Forces path-style S3 URLs for MinIO and other local endpoints. | `true` |
| `MINIO_ROOT_USER` | Local MinIO console and API user. | `minioadmin` |
| `MINIO_ROOT_PASSWORD` | Local MinIO console and API password. | `minioadmin` |
| `MINIO_API_CORS_ALLOW_ORIGIN` | Comma-separated origins allowed by local MinIO. | `http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001` |
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

## Ingest cleanup

After a downstream processor has downloaded and processed a ready session, it can purge raw recording files:

```http
POST /api/ingest/sessions/:id/purge-files
X-API-Key: <COZYTRACK_API_KEY>
```

The purge deletes all S3 objects under `sessions/<id>/` and stamps `s3PurgedAt` on that session's tracks. Repeated calls for already-purged sessions are safe. Browser and ingest track download endpoints return `410 Gone` for purged tracks.

For historical cleanup, use dry-run scripts first:

```sh
npm run purge:ready -- --base-url https://<app-host>
npm run purge:orphans
```

`purge:ready` finds ready DB sessions with unpurged tracks and calls the purge endpoint when rerun with `--yes`. `purge:orphans` compares `sessions/<id>/` S3 prefixes against DB `Session.id` rows and deletes only S3-only prefixes when rerun with `--yes`. For bucket names that do not include `dev`, `local`, or `test`, orphan deletion also requires `--allow-production-bucket`.

Both scripts load `.env` and `.env.local`. `purge:ready` needs DB access for discovery plus `COZYTRACK_API_KEY` and `--base-url`/`COZYTRACK_PURGE_BASE_URL` when using `--yes`. `purge:orphans` needs DB access plus the S3 env vars.

## Finishing a recording

When a recorder is done capturing in the studio:

1. Click **Stop Recording** to flush the local recorder and drain any in-flight chunk uploads.
2. Click **Finish recording**. The studio polls `POST /api/sessions/:id/finalize` once a second for up to 30 seconds.
   - `409` with `{ pending: [...] }` means at least one track is still uploading. The UI surfaces the pending participant and keeps polling.
   - `200` flips the session to `status = "ready"`, stamps `finalizedAt`, and shows the session ID with a copy button plus the ingest hint `sd ct-ingest <id>`.
   - On a 30-second timeout the UI offers a Retry button.

Calling `POST /api/sessions/:id/finalize` on an already-ready session is idempotent — it returns the same payload without re-stamping `finalizedAt`.
