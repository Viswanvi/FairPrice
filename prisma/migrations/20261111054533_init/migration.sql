-- CreateEnum
CREATE TYPE "Goal" AS ENUM ('revenue', 'reach');

-- CreateEnum
CREATE TYPE "PriceTableStatus" AS ENUM ('draft', 'approved', 'superseded');

-- CreateEnum
CREATE TYPE "OrderDecision" AS ENUM ('MATCH', 'TRAVELER', 'MISMATCH', 'UNCLEAR', 'NOT_PAYPAL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'VOIDED', 'DECLINED', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "sellers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_url" TEXT,
    "description" TEXT,
    "base_cents" INTEGER NOT NULL,
    "min_cents" INTEGER NOT NULL,
    "max_discount_pct" INTEGER NOT NULL,
    "goal" "Goal" NOT NULL,
    "require_paypal" BOOLEAN NOT NULL DEFAULT true,
    "audience_profile" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tables" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PriceTableStatus" NOT NULL DEFAULT 'draft',
    "rows" JSONB NOT NULL,
    "formula_rows" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "price_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "price_table_id" TEXT NOT NULL,
    "paypal_order_id" TEXT,
    "authorization_id" TEXT,
    "capture_id" TEXT,
    "shown_country" TEXT,
    "shown_cents" INTEGER NOT NULL,
    "payer_country" TEXT,
    "payment_type" TEXT,
    "eligible_cents" INTEGER,
    "charged_cents" INTEGER,
    "offer_cents" INTEGER,
    "decision" "OrderDecision",
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "previous_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "verified" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "order_id" TEXT,
    "step" TEXT NOT NULL,
    "request_id" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_seller_id_idx" ON "products"("seller_id");

-- CreateIndex
CREATE INDEX "price_tables_product_id_status_idx" ON "price_tables"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "price_tables_product_id_version_key" ON "price_tables"("product_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "orders_paypal_order_id_key" ON "orders"("paypal_order_id");

-- CreateIndex
CREATE INDEX "orders_product_id_created_at_idx" ON "orders"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_order_id_idx" ON "audit_log"("order_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tables" ADD CONSTRAINT "price_tables_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_table_id_fkey" FOREIGN KEY ("price_table_id") REFERENCES "price_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_previous_order_id_fkey" FOREIGN KEY ("previous_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
