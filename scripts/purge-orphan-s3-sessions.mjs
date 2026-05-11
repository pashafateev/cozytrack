#!/usr/bin/env node

import { PrismaClient } from "@prisma/client";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  loadEnv,
  parsePositiveInteger,
  readOptionValue,
} from "./script-utils.mjs";

const DB_LOOKUP_BATCH_SIZE = 500;

function usage() {
  console.log(`Usage: node scripts/purge-orphan-s3-sessions.mjs [options]

Deletes S3 session prefixes that have no matching Session row in the DB.
Dry-run by default.

Options:
  --yes                       Actually delete objects. Without this, only prints.
  --allow-production-bucket   Allow deletion when bucket name lacks dev/local/test.
  --limit <n>                 Limit number of orphan prefixes deleted.
  --help                      Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    yes: false,
    allowProductionBucket: false,
    limit: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--allow-production-bucket") {
      options.allowProductionBucket = true;
    } else if (arg === "--limit") {
      options.limit = parsePositiveInteger(readOptionValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function booleanEnv(value) {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function buildS3ClientConfig() {
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  const forcePathStyle =
    booleanEnv(process.env.S3_FORCE_PATH_STYLE) ?? Boolean(endpoint);
  const config = {
    region: process.env.AWS_REGION,
  };

  if (endpoint) {
    config.endpoint = endpoint;
  }
  if (forcePathStyle) {
    config.forcePathStyle = true;
  }

  return config;
}

function isProtectedBucketName(bucket) {
  return !/(^|[.-])(dev|local|test)([.-]|$)/i.test(bucket);
}

function sessionIdFromPrefix(prefix) {
  const match = prefix.match(/^sessions\/([^/]+)\/$/);
  return match?.[1];
}

async function listSessionPrefixes({ s3, bucket }) {
  const prefixes = [];
  let continuationToken;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "sessions/",
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );

    for (const commonPrefix of response.CommonPrefixes ?? []) {
      if (commonPrefix.Prefix) {
        prefixes.push(commonPrefix.Prefix);
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return prefixes;
}

async function getExistingSessionIds({ prisma, sessionIds }) {
  const existingSessionIds = new Set();

  for (let index = 0; index < sessionIds.length; index += DB_LOOKUP_BATCH_SIZE) {
    const batch = sessionIds.slice(index, index + DB_LOOKUP_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }

    const rows = await prisma.session.findMany({
      where: { id: { in: batch } },
      select: { id: true },
    });
    for (const row of rows) {
      existingSessionIds.add(row.id);
    }
  }

  return existingSessionIds;
}

async function deletePrefix({ s3, bucket, prefix }) {
  let continuationToken;
  let deletedObjects = 0;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const keys = (response.Contents ?? [])
      .map((object) => object.Key)
      .filter(Boolean);

    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      if (batch.length === 0) {
        continue;
      }

      const deleteResponse = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );

      if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
        const failedKeys = deleteResponse.Errors.map((error) => error.Key)
          .filter(Boolean)
          .join(", ");
        throw new Error(
          `Failed to delete objects under ${prefix}${
            failedKeys ? `: ${failedKeys}` : ""
          }`,
        );
      }

      deletedObjects += batch.length;
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return deletedObjects;
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME is required");
  }
  if (!process.env.AWS_REGION) {
    throw new Error("AWS_REGION is required");
  }
  if (
    options.yes &&
    isProtectedBucketName(bucket) &&
    !options.allowProductionBucket
  ) {
    throw new Error(
      `Refusing to delete from bucket '${bucket}' without --allow-production-bucket`,
    );
  }

  const prisma = new PrismaClient();
  const s3 = new S3Client(buildS3ClientConfig());

  try {
    const prefixes = await listSessionPrefixes({ s3, bucket });
    const sessionIds = prefixes.map(sessionIdFromPrefix).filter(Boolean);
    const existingSessionIds = await getExistingSessionIds({
      prisma,
      sessionIds,
    });
    const orphanPrefixes = prefixes
      .filter((prefix) => {
        const sessionId = sessionIdFromPrefix(prefix);
        return sessionId && !existingSessionIds.has(sessionId);
      })
      .slice(0, options.limit);

    if (orphanPrefixes.length === 0) {
      console.log("No orphan S3 session prefixes found.");
      return;
    }

    console.log(
      `${options.yes ? "Deleting" : "Dry run:"} ${orphanPrefixes.length} orphan S3 session prefix(es) from s3://${bucket}.`,
    );
    for (const prefix of orphanPrefixes) {
      console.log(`- ${prefix}`);
    }

    if (!options.yes) {
      console.log("\nNo changes made. Rerun with --yes to delete.");
      return;
    }

    let totalDeletedObjects = 0;
    for (const prefix of orphanPrefixes) {
      const deletedObjects = await deletePrefix({ s3, bucket, prefix });
      totalDeletedObjects += deletedObjects;
      console.log(`Deleted ${prefix}: ${deletedObjects} object(s)`);
    }

    console.log(`Done. Deleted ${totalDeletedObjects} object(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
