# Infra

One-off setup that lives outside the app.

## S3 CORS

Uploads happen directly from the browser via presigned URLs, so the bucket
needs a CORS policy that allows any deployment origin — not just production.

Two files, same rules, different shape:

- **`s3-cors.json`** — wrapped as `{ "CORSRules": [...] }`. Use with the AWS CLI / SDK.
- **`s3-cors-console.json`** — just the array `[...]`. Paste into the AWS Console's CORS editor.

### Via AWS Console

1. S3 → Buckets → `cozytrack` → Permissions tab
2. Scroll to **Cross-origin resource sharing (CORS)** → Edit
3. Paste the contents of `s3-cors-console.json` (starts with `[`, ends with `]`)
4. Save changes

### Via AWS CLI

```bash
aws s3api put-bucket-cors \
  --bucket cozytrack \
  --region us-west-2 \
  --cors-configuration file://infra/s3-cors.json
```

Read it back to confirm:

```bash
aws s3api get-bucket-cors --bucket cozytrack --region us-west-2
```

### What's allowed

- `http://localhost:3000` / `127.0.0.1:3000` and `http://localhost:3001` / `127.0.0.1:3001` — local dev (the `npm run dev` script binds to 3001; 3000 is kept for ad-hoc runs)
- `https://cozytrack.vercel.app` / `https://cozytrack-w8fm.vercel.app` — production aliases
- `https://*.vercel.app` — every preview/branch URL Vercel generates

Methods: `GET`, `PUT`, `POST`, `HEAD`
Exposed: `ETag`, `x-amz-checksum-crc32`

The wildcard on `*.vercel.app` is what unblocks preview deploys — each PR gets
a fresh hostname like `cozytrack-nibqouh6j-pashas-projects-a7a6c140.vercel.app`
and without the wildcard every preview was rejected by CORS.
