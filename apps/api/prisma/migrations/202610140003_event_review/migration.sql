ALTER TABLE "WebhookEvent" ADD COLUMN "failedAt" TIMESTAMP(3), ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "errorCode" TEXT;
CREATE INDEX "WebhookEvent_failedAt_processedAt_idx" ON "WebhookEvent"("failedAt","processedAt");
