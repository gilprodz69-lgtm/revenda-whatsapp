ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
CREATE TABLE "Category" (
  "id" TEXT NOT NULL PRIMARY KEY, "sourceKey" TEXT, "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '', "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "Category_sourceKey_key" ON "Category"("sourceKey");
CREATE TABLE "SmmProvider" (
  "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "url" TEXT NOT NULL,
  "encryptedApiKey" TEXT NOT NULL, "currency" TEXT NOT NULL DEFAULT 'USD',
  "active" BOOLEAN NOT NULL DEFAULT true, "requestsPerMinute" INTEGER NOT NULL DEFAULT 60,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SmmProvider_name_key" ON "SmmProvider"("name");
ALTER TABLE "Product" ALTER COLUMN "externalId" DROP NOT NULL, ALTER COLUMN "providerKey" DROP NOT NULL;
ALTER TABLE "Product"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PARTNER', ADD COLUMN "categoryId" TEXT,
  ADD COLUMN "smmProviderId" TEXT, ADD COLUMN "smmServiceId" TEXT, ADD COLUMN "smmType" TEXT,
  ADD COLUMN "supplierRate" DECIMAL(18,8), ADD COLUMN "costCurrency" TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN "priceBasis" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "minQuantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supportsRefill" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "supportsCancel" BOOLEAN NOT NULL DEFAULT false;
INSERT INTO "Category" ("id","sourceKey","name","sortOrder")
  SELECT 'partner-' || "key", 'partner:' || "key", "name", "sortOrder" FROM "Provider";
UPDATE "Product" SET "categoryId" = 'partner-' || "providerKey";
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_smmProviderId_fkey" FOREIGN KEY ("smmProviderId") REFERENCES "SmmProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Product_smmProviderId_smmServiceId_key" ON "Product"("smmProviderId","smmServiceId");
CREATE INDEX "Product_categoryId_active_visible_idx" ON "Product"("categoryId","active","visible");
ALTER TABLE "Order" ALTER COLUMN "exchangeRateId" DROP NOT NULL, ALTER COLUMN "usdBrl" DROP NOT NULL;
ALTER TABLE "Order"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PARTNER', ADD COLUMN "estimatedCostBrl" DECIMAL(18,4),
  ADD COLUMN "actualCostBrl" DECIMAL(18,4), ADD COLUMN "refundedBrl" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "smmProviderId" TEXT, ADD COLUMN "smmOrderId" TEXT, ADD COLUMN "smmState" TEXT,
  ADD COLUMN "smmRemains" INTEGER, ADD COLUMN "lastSmmPollAt" TIMESTAMP(3),
  ADD COLUMN "encryptedSmmRequest" TEXT, ADD COLUMN "smmRefillId" TEXT, ADD COLUMN "smmRefillState" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_smmProviderId_fkey" FOREIGN KEY ("smmProviderId") REFERENCES "SmmProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Order_smmProviderId_smmOrderId_key" ON "Order"("smmProviderId","smmOrderId");
ALTER TABLE "OrderItem" ADD COLUMN "priceBasis" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Product" ADD CONSTRAINT product_source_valid CHECK (
  "source" IN ('PARTNER','SMM') AND "priceBasis" IN (1,1000) AND "minQuantity">0 AND
  ("source" <> 'SMM' OR ("smmProviderId" IS NOT NULL AND "smmServiceId" IS NOT NULL AND "supplierRate" >= 0 AND "costCurrency" IN ('USD','BRL')))
);
ALTER TABLE "Order" ADD CONSTRAINT order_source_valid CHECK (
  "refundedBrl">=0 AND "refundedBrl"<="totalBrl" AND
  (("source"='PARTNER' AND "usdBrl" IS NOT NULL AND "exchangeRateId" IS NOT NULL) OR
   ("source"='SMM' AND "smmProviderId" IS NOT NULL AND "encryptedSmmRequest" IS NOT NULL AND "estimatedCostBrl">=0 AND
    (("requestBody"->>'currency'='USD' AND "usdBrl" IS NOT NULL AND "exchangeRateId" IS NOT NULL) OR
     ("requestBody"->>'currency'='BRL' AND "usdBrl" IS NULL AND "exchangeRateId" IS NULL))))
);
ALTER TABLE "OrderItem" ADD CONSTRAINT order_price_basis_valid CHECK ("priceBasis" IN (1,1000));
CREATE OR REPLACE FUNCTION protect_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."externalOrderId" IS DISTINCT FROM OLD."externalOrderId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."requestBody" IS DISTINCT FROM OLD."requestBody" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."instanceName" IS DISTINCT FROM OLD."instanceName" OR NEW."totalBrl" IS DISTINCT FROM OLD."totalBrl" OR NEW."usdBrl" IS DISTINCT FROM OLD."usdBrl" OR NEW."exchangeRateId" IS DISTINCT FROM OLD."exchangeRateId" OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."smmProviderId" IS DISTINCT FROM OLD."smmProviderId" OR NEW."encryptedSmmRequest" IS DISTINCT FROM OLD."encryptedSmmRequest" OR NEW."estimatedCostBrl" IS DISTINCT FROM OLD."estimatedCostBrl" OR (OLD."smmOrderId" IS NOT NULL AND NEW."smmOrderId" IS DISTINCT FROM OLD."smmOrderId") THEN RAISE EXCEPTION 'Order identity and price snapshots are immutable'; END IF;
 RETURN NEW;
END;
$$;
