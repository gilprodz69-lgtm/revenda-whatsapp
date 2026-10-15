ALTER TABLE "Product" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN "displayName" TEXT;
CREATE INDEX "Product_archivedAt_idx" ON "Product"("archivedAt");
