# Cozytrack

Cozytrack is a self-hosted podcast recording studio built for local-first audio capture. Each participant records their own microphone in the browser, hears the room through LiveKit, and uploads separate WebM/Opus tracks to S3-compatible storage for later mixing.

The product goal is simple: make it obvious what people are recording before the session is over. The longer feature roadmap and issue-backed planning live in [docs/FEATURES.md](docs/FEATURES.md).

## What Works Today

- Host sign-in with a single operator password.
- Host-created recording sessions and a dashboard of past sessions.
- Guest invite links scoped to one session.
- Live audio preview through LiveKit.
- Local microphone recording through RecordRTC.
- VU meters, clipping indicators, mic monitoring, built-in mic warnings, and a mobile-browser warning.
- Host-controlled start/stop; guests follow the host's recording lifecycle.
- Chunked direct-to-S3 uploads through presigned URLs, plus browser-local recording backup for retry/recovery.
- Session finalization once all tracks are complete, with per-track downloads.
- External ingest endpoints for downstream tools such as podline's `sd ct-ingest`.
- Cleanup scripts for processed sessions and orphaned S3 prefixes.

## Architecture

```text
Browser
  Local mic -> RecordRTC -> IndexedDB backup -> presigned S3 uploads
  Live preview <-> LiveKit room
  Studio UI <-> Next.js API routes

Next.js app
  Auth cookies and invite tokens
  LiveKit token minting
  Session, track, upload, finalize, recovery, and ingest APIs

Storage and services
  PostgreSQL: session and track metadata
  S3 or MinIO: WebM/Opus recording objects and chunk backups
  LiveKit + Redis: live audio room infrastructure
```

Recording audio does not need to pass through the app server. The server authorizes uploads, stores metadata, and can attempt recovery from already-uploaded objects if a browser exits at the wrong time.

## Tech Stack

- **Next.js 15** with App Router and TypeScript
- **React 19**
- **LiveKit** for live room audio
- **RecordRTC** for browser-local recording
- **PostgreSQL** with **Prisma**
- **S3-compatible storage**: AWS S3 in production or MinIO locally
- **Tailwind CSS**
- **Docker Compose** for local LiveKit, Redis, Postgres, MinIO, and tooling

## Quick Start

### Prerequisites

- Node.js 20.19+ or 22.12+
- Docker and Docker Compose
- An AWS S3 bucket only when you are not using the default local MinIO flow

### Local Setup

```bash
git clone <repo-url>
cd cozytrack
npm install
cp .env.example .env.local
```

Set these required values in `.env.local`:

```env
AUTH_SECRET=<32+ character random string>
HOST_PASSWORD=<12+ character host password>
```

Generate them with commands like:

```bash
openssl rand -hex 32
openssl rand -hex 24
```

Start the fully local stack:

```bash
npm run dev:local
```

`dev:local` starts Docker services with the local MinIO profile, creates the bucket, pushes the Prisma schema, and starts Next.js on port `3001`. It always overrides storage settings to use local MinIO, even if `.env.local` contains cloud-backed S3 values.

Open [http://localhost:3001](http://localhost:3001), sign in with `HOST_PASSWORD`, then create a session.

The MinIO console is available at [http://localhost:9001](http://localhost:9001) with the `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` values from `.env.local` or `.env.example`.

### Local Reset

Use this when you want a clean local slate:

```bash
npm run reset:local
```

This starts local Docker services if needed, resets the Prisma database, and empties the configured local/dev/test bucket. The reset script refuses to run unless `S3_BUCKET_NAME` contains `dev`, `local`, or `test`.

To reset everything and immediately start the app:

```bash
npm run init:local
```

## Cloud-Backed S3 Development

The example environment targets local MinIO:

```env
S3_BUCKET_NAME=cozytrack-local
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
```

To test against real AWS S3:

1. Set `S3_BUCKET_NAME` to your dev bucket.
2. Clear `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE`.
3. Replace the local fake AWS credentials with real credentials, or remove them and rely on your local AWS profile.
4. Start services and the app:

   ```bash
   docker compose up -d
   npm run db:push
   npm run dev
   ```

`npm run dev` checks AWS auth before starting when no custom S3 endpoint is configured. Reauthenticate with `aws login` if the current AWS session is expired.

Bucket CORS setup for real S3 lives in [infra/README.md](infra/README.md).

## Recording Flow

1. The host signs in at `/signin`.
2. The host creates a session from `/` or opens one from `/dashboard`.
3. The host can generate a guest invite link from the studio or session detail view.
4. A guest opens `/join/<token>`, enters their name, and receives a session-scoped cookie.
5. Participants join `/studio/<sessionId>` and select a microphone.
6. Cozytrack shows local and remote levels, warns on built-in mics, and lets participants monitor their own mic.
7. The host starts recording. Guests receive the start event through the transport layer and begin recording locally.
8. Each browser uploads chunks while recording and writes a browser-local backup.
9. The host stops recording, then clicks **Finish recording**.
10. `POST /api/sessions/:id/finalize` marks the session ready once every track is complete.

Finalize is idempotent. If uploads are still pending, it returns `409` with the pending tracks and the studio keeps polling. During finalize, the server also attempts best-effort recovery for stuck tracks by checking for final `recording.webm` objects or stitching uploaded chunks.

## Auth Model

Cozytrack is intentionally locked down:

- **Host**: signs in with `HOST_PASSWORD`, can create sessions, see the dashboard, download tracks, and mint invite links. The host cookie lasts 7 days.
- **Guest**: joins through a signed invite URL, gets a cookie scoped to one session, and can access only that studio/session metadata path. Invite tokens expire after 48 hours; guest sessions last 12 hours.
- **Recording upload token**: short-lived, track-scoped token used so active recordings can finish upload if cookies age out mid-session.
- **Ingest API key**: `/api/ingest/*` is separate from host/guest cookies and is gated by `COZYTRACK_API_KEY`, except for local development requests from loopback addresses.

Tokens are HS256 JWTs signed with `AUTH_SECRET`. The long-term auth direction is podflow-as-IdP; the JWT primitive is expected to remain while the issuer changes.

## External Ingest And Cleanup

Downstream processors can discover and download ready sessions through `/api/ingest/*` with:

```http
X-API-Key: <COZYTRACK_API_KEY>
```

After a session has been processed, raw recording files can be purged:

```http
POST /api/ingest/sessions/:id/purge-files
X-API-Key: <COZYTRACK_API_KEY>
```

`npm run test:browser` starts the local Docker services, provisions a local
MinIO bucket, pushes the Prisma schema, starts Next.js on port 3101, signs in
as the host with test-only credentials, records with Chromium's fake
microphone, and verifies a complete track row plus a non-empty
`recording.webm` object in MinIO.

Use dry-run cleanup scripts before deleting anything:

```bash
npm run purge:ready -- --base-url https://<app-host>
npm run purge:orphans
```

`purge:ready` finds ready DB sessions with unpurged tracks and calls the purge endpoint when rerun with `--yes`. `purge:orphans` compares S3 `sessions/<id>/` prefixes against DB session rows and deletes only S3-only prefixes when rerun with `--yes`. For bucket names that do not include `dev`, `local`, or `test`, orphan deletion also requires `--allow-production-bucket`.

Both scripts load `.env` and `.env.local`. `purge:ready` needs DB access plus `COZYTRACK_API_KEY` and `--base-url` or `COZYTRACK_PURGE_BASE_URL` when using `--yes`. `purge:orphans` needs DB access plus the S3 environment variables.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | Runtime PostgreSQL connection string. | `postgresql://cozytrack:cozytrack@localhost:5433/cozytrack` |
| `DIRECT_DATABASE_URL` | Direct PostgreSQL connection for Prisma migrations and schema pushes. Locally this can match `DATABASE_URL`. | `postgresql://cozytrack:cozytrack@localhost:5433/cozytrack` |
| `LIVEKIT_API_KEY` | LiveKit API key. | `devkey` |
| `LIVEKIT_API_SECRET` | LiveKit API secret. | `cozytrack-local-livekit-secret-32` |
| `LIVEKIT_URL` | Server-side LiveKit URL. | `ws://localhost:7880` |
| `NEXT_PUBLIC_LIVEKIT_URL` | Client-side LiveKit URL. | `ws://localhost:7880` |
| `AWS_ACCESS_KEY_ID` | AWS-compatible access key. Defaults to local MinIO credentials. | `minioadmin` |
| `AWS_SECRET_ACCESS_KEY` | AWS-compatible secret key. Defaults to local MinIO credentials. | `minioadmin` |
| `AWS_REGION` | S3 signing region. `npm run dev:local` uses `LOCAL_AWS_REGION` instead. | `us-east-1` |
| `LOCAL_AWS_REGION` | Local-only signing region override for `npm run dev:local`. | `us-east-1` |
| `S3_BUCKET_NAME` | S3-compatible bucket for recordings. | `cozytrack-local` |
| `S3_ENDPOINT` | Optional S3-compatible endpoint. Set for MinIO; leave empty for AWS S3. | `http://localhost:9000` |
| `S3_FORCE_PATH_STYLE` | Forces path-style S3 URLs for MinIO and other local endpoints. | `true` |
| `LOCAL_S3_BUCKET_NAME` | Optional local-only bucket override used by `npm run dev:local`. | `cozytrack-local` |
| `MINIO_ROOT_USER` | Local MinIO console/API user. | `minioadmin` |
| `MINIO_ROOT_PASSWORD` | Local MinIO console/API password. | `minioadmin` |
| `MINIO_API_CORS_ALLOW_ORIGIN` | Comma-separated origins allowed by local MinIO. | local app/test origins |
| `AUTH_SECRET` | 32+ character secret for host, guest, invite, and upload JWTs. | required |
| `HOST_PASSWORD` | Host sign-in password. Minimum 12 characters. | required |
| `COZYTRACK_API_KEY` | Shared secret checked against `X-API-Key` on `/api/ingest/*`. | required outside loopback dev |

## Testing

Fast validation:

```bash
npm test
npm run typecheck
```

Run integration tests when local Postgres and S3-compatible storage are available:

```bash
COZYTRACK_INTEGRATION_TEST=1 npm run test:integration
```

Browser recording smoke test:

```bash
npx playwright install chromium
npm run test:browser
```

`npm run test:browser` starts local Docker services, provisions MinIO, pushes the Prisma schema, starts Next.js on port `3101`, signs in as the host with test-only credentials, records with Chromium's fake microphone, and verifies a complete track row plus a non-empty `recording.webm` object in MinIO.

## Project Map

```text
src/app/
  api/auth/                 Host sign-in, sign-out, invite acceptance, current principal
  api/sessions/             Session CRUD, invite minting, finalization
  api/upload/               Presign and completion endpoints for recording uploads
  api/tracks/               Browser-facing track download
  api/ingest/               External-consumer session and track APIs
  api/admin/                Recovery-oriented admin endpoint
  dashboard/                Host session list
  join/[token]/             Guest invite acceptance
  session/[id]/             Host session detail and track downloads
  signin/                   Host sign-in page
  studio/[id]/              Recording studio

src/lib/
  auth.ts                   Host, guest, invite, and upload JWT helpers
  recorder.ts               RecordRTC wrapper
  recording-backup*.ts      Browser backup and retry upload support
  recovery.ts               Server-side stuck-track recovery
  s3.ts                     S3/MinIO client and object-key helpers
  transport/                LiveKit-backed transport abstraction
  upload.ts                 Client upload helpers

prisma/schema.prisma        Session and Track models
scripts/                    Local dev, reset, smoke test, and cleanup scripts
infra/                      S3 CORS setup files
docs/FEATURES.md            Roadmap and feature specs
```

## Deployment Notes

- `npm run build` builds the app locally.
- `npm run vercel-build` runs `prisma migrate deploy` only for Vercel production builds, then builds Next.js.
- Production S3 buckets need the CORS policy documented in [infra/README.md](infra/README.md).
- Production must set `AUTH_SECRET`, `HOST_PASSWORD`, `COZYTRACK_API_KEY`, `DATABASE_URL`, `DIRECT_DATABASE_URL`, LiveKit credentials, and S3 credentials.
