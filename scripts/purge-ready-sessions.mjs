#!/usr/bin/env node

import { PrismaClient } from "@prisma/client";
import {
  loadEnv,
  parsePositiveInteger,
  readOptionValue,
} from "./script-utils.mjs";

function usage() {
  console.log(`Usage: node scripts/purge-ready-sessions.mjs [options]

Purges DB-backed ready sessions by calling /api/ingest/sessions/:id/purge-files.
Dry-run by default.

Options:
  --yes                 Actually call purge endpoints. Without this, only prints.
  --base-url <url>      App base URL. Can also use COZYTRACK_PURGE_BASE_URL.
  --api-key <key>       Ingest API key. Can also use COZYTRACK_API_KEY.
  --session-id <id>     Limit to a specific session. Repeatable.
  --limit <n>           Limit number of sessions processed.
  --help                Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    yes: false,
    baseUrl: process.env.COZYTRACK_PURGE_BASE_URL,
    apiKey: process.env.COZYTRACK_API_KEY,
    sessionIds: [],
    limit: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--base-url") {
      options.baseUrl = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--api-key") {
      options.apiKey = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--session-id") {
      options.sessionIds.push(readOptionValue(argv, i, arg));
      i += 1;
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

function normalizeBaseUrl(value) {
  if (!value) {
    return undefined;
  }
  return value.replace(/\/+$/, "");
}

function trackSummary(tracks) {
  const unpurged = tracks.filter((track) => !track.s3PurgedAt).length;
  return `${tracks.length} tracks (${unpurged} unpurged)`;
}

async function purgeSession({ baseUrl, apiKey, sessionId }) {
  const response = await fetch(
    `${baseUrl}/api/ingest/sessions/${encodeURIComponent(
      sessionId,
    )}/purge-files`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
      },
    },
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${
        typeof body.error === "string" ? body.error : response.statusText
      }`,
    );
  }

  return body;
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const prisma = new PrismaClient();
  try {
    const where = {
      status: "ready",
      tracks: { some: { s3PurgedAt: null } },
    };

    if (options.sessionIds.length > 0) {
      where.id = { in: options.sessionIds };
    }

    const sessions = await prisma.session.findMany({
      where,
      include: {
        tracks: {
          select: {
            s3PurgedAt: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
      take: options.limit,
    });

    if (sessions.length === 0) {
      console.log("No ready sessions with unpurged tracks found.");
      return;
    }

    console.log(
      `${options.yes ? "Purging" : "Dry run:"} ${sessions.length} ready session(s).`,
    );
    for (const session of sessions) {
      console.log(
        `- ${session.id}: ${session.name} — ${trackSummary(session.tracks)}`,
      );
    }

    if (!options.yes) {
      console.log("\nNo changes made. Rerun with --yes to purge.");
      return;
    }

    const baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!baseUrl) {
      throw new Error(
        "--base-url or COZYTRACK_PURGE_BASE_URL is required with --yes",
      );
    }
    if (!options.apiKey) {
      throw new Error("--api-key or COZYTRACK_API_KEY is required with --yes");
    }

    let totalDeletedObjects = 0;
    let totalPurgedTracks = 0;

    for (const session of sessions) {
      const result = await purgeSession({
        baseUrl,
        apiKey: options.apiKey,
        sessionId: session.id,
      });
      totalDeletedObjects += result.deletedObjects ?? 0;
      totalPurgedTracks += result.purgedTracks ?? 0;
      console.log(
        `Purged ${session.id}: ${result.deletedObjects ?? 0} objects, ${
          result.purgedTracks ?? 0
        } tracks stamped`,
      );
    }

    console.log(
      `Done. Deleted ${totalDeletedObjects} object(s), stamped ${totalPurgedTracks} track(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
