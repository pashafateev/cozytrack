-- AlterTable
ALTER TABLE "Session" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'recording',
ADD COLUMN "finalizedAt" TIMESTAMP(3);
