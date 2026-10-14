ALTER TABLE "Wallet" ADD CONSTRAINT wallet_nonnegative CHECK (available >= 0 AND reserved >= 0);
ALTER TABLE "Order" ADD CONSTRAINT order_positive_total CHECK ("totalBrl" > 0 AND "usdBrl" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT order_quantity_positive CHECK (quantity > 0 AND "unitSaleBrl" > 0 AND "unitCostUsd" >= 0);
ALTER TABLE "Payment" ADD CONSTRAINT payment_amount_positive CHECK ("amountBrl" > 0);
ALTER TABLE "ExchangeRate" ADD CONSTRAINT exchange_positive CHECK ("usdBrl" > 0 AND "expiresAt" > "observedAt");
ALTER TABLE "Product" ADD CONSTRAINT product_price_rules CHECK ("costUsd" >= 0 AND "catalogPriceUsd" >= 0 AND stock >= 0 AND "maxQuantity" >= 0 AND "markupPercent" >= 0 AND "fixedMargin" >= 0 AND "roundingStep" >= 0.01 AND "volumeDiscountPercent" >= 0 AND "volumeDiscountPercent" < 100 AND "volumeMinQuantity" >= 2 AND ("manualPrice" IS NULL OR "manualPrice">0) AND ("promoPrice" IS NULL OR "promoPrice">0));
CREATE FUNCTION immutable_financial_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial ledger/audit records are immutable'; END;
$$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE FUNCTION protect_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."externalOrderId" IS DISTINCT FROM OLD."externalOrderId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."requestBody" IS DISTINCT FROM OLD."requestBody" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."instanceName" IS DISTINCT FROM OLD."instanceName" OR NEW."totalBrl" IS DISTINCT FROM OLD."totalBrl" OR NEW."usdBrl" IS DISTINCT FROM OLD."usdBrl" OR NEW."exchangeRateId" IS DISTINCT FROM OLD."exchangeRateId" THEN RAISE EXCEPTION 'Order identity and price snapshots are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_identity_immutable BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION protect_order_identity();
CREATE FUNCTION protect_payment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."gateway" IS DISTINCT FROM OLD."gateway" OR NEW."amountBrl" IS DISTINCT FROM OLD."amountBrl" OR NEW."encryptedRequestBody" IS DISTINCT FROM OLD."encryptedRequestBody" THEN RAISE EXCEPTION 'Payment identity and request are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payment_identity_immutable BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION protect_payment_identity();
