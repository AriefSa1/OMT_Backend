-- AlterTable
ALTER TABLE "ShopeeOrderSummary" ADD COLUMN "cancelledOrders" INTEGER;
ALTER TABLE "ShopeeOrderSummary" ADD COLUMN "cancelledSales" REAL;
ALTER TABLE "ShopeeOrderSummary" ADD COLUMN "returnRefundOrders" INTEGER;
ALTER TABLE "ShopeeOrderSummary" ADD COLUMN "returnRefundSales" REAL;
