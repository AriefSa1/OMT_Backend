-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ANALYST',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StoreSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeName" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "cookieString" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "csrfToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShopeeProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopeeItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "stock" INTEGER NOT NULL,
    "salesCount" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "addToCart" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'Uncategorized',
    "l2CategoryId" TEXT,
    "l3CategoryId" TEXT,
    "l2CategoryName" TEXT,
    "l3CategoryName" TEXT,
    "imageUrl" TEXT,
    "rating" REAL NOT NULL DEFAULT 0,
    "unitCost" REAL,
    "unitAdCost" REAL,
    "shippingCost" REAL,
    "platformFeePercent" REAL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShopeeOrderSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "gmv" REAL NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "conversionRate" REAL NOT NULL,
    "averageOrderValue" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ShopeeAdsData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spend" REAL NOT NULL,
    "sales" REAL NOT NULL,
    "roas" REAL NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "ctr" REAL NOT NULL,
    "rawSpend" REAL NOT NULL DEFAULT 0,
    "rawSales" REAL NOT NULL DEFAULT 0,
    "rawVoucherSpend" REAL NOT NULL DEFAULT 0,
    "rawVoucherSales" REAL NOT NULL DEFAULT 0,
    "amountDivisor" INTEGER NOT NULL DEFAULT 100000,
    "voucherSpend" REAL NOT NULL DEFAULT 0,
    "voucherSales" REAL NOT NULL DEFAULT 0,
    "dataAsOf" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ShopeeAdsCampaignSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "dailyBudget" REAL NOT NULL DEFAULT 0,
    "spend" REAL NOT NULL DEFAULT 0,
    "sales" REAL NOT NULL DEFAULT 0,
    "rawSpend" REAL NOT NULL DEFAULT 0,
    "rawSales" REAL NOT NULL DEFAULT 0,
    "rawDailyBudget" REAL NOT NULL DEFAULT 0,
    "amountDivisor" INTEGER NOT NULL DEFAULT 100000,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "ctr" REAL NOT NULL DEFAULT 0,
    "roas" REAL NOT NULL DEFAULT 0,
    "voucherSpend" REAL NOT NULL DEFAULT 0,
    "voucherSales" REAL NOT NULL DEFAULT 0,
    "rawVoucherSpend" REAL NOT NULL DEFAULT 0,
    "rawVoucherSales" REAL NOT NULL DEFAULT 0,
    "dataAsOf" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductMetricSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopeeItemId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Uncategorized',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "ctr" REAL NOT NULL DEFAULT 0,
    "bounceRate" REAL NOT NULL DEFAULT 0,
    "addToCartBuyers" INTEGER NOT NULL DEFAULT 0,
    "addToCartUnits" INTEGER NOT NULL DEFAULT 0,
    "confirmedOrders" INTEGER NOT NULL DEFAULT 0,
    "confirmedUnits" INTEGER NOT NULL DEFAULT 0,
    "confirmedBuyers" INTEGER NOT NULL DEFAULT 0,
    "confirmedSales" REAL NOT NULL DEFAULT 0,
    "conversionRate" REAL NOT NULL DEFAULT 0,
    "dataAsOf" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WarehouseLocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "ownerName" TEXT,
    "ownerEmail" TEXT,
    "teamId" INTEGER,
    "racksCount" INTEGER NOT NULL DEFAULT 0,
    "racks" TEXT,
    "lastUpdated" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WarehouseItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "totalStock" INTEGER NOT NULL,
    "reservedStock" INTEGER NOT NULL,
    "availableStock" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "location" TEXT NOT NULL DEFAULT 'UNASSIGNED',
    "warehouseId" INTEGER,
    "warehouseName" TEXT,
    "warehouseLocation" TEXT,
    "stockSource" TEXT NOT NULL DEFAULT 'WAREHOUSE_API',
    "teamId" INTEGER,
    "teamName" TEXT,
    "teamCode" TEXT,
    "productType" TEXT NOT NULL DEFAULT 'general',
    "priceMin" REAL,
    "priceMax" REAL,
    "category" TEXT,
    "refId" TEXT,
    "desc" TEXT,
    "bundleCount" INTEGER,
    "isPriority" BOOLEAN NOT NULL DEFAULT false,
    "isCrossLocked" BOOLEAN NOT NULL DEFAULT false,
    "rawProductId" INTEGER,
    "rawVariationId" INTEGER,
    "lastUpdated" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WarehouseStockSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalStock" INTEGER NOT NULL DEFAULT 0,
    "reservedStock" INTEGER NOT NULL DEFAULT 0,
    "availableStock" INTEGER NOT NULL DEFAULT 0,
    "warehouseId" INTEGER,
    "warehouseName" TEXT,
    "teamId" INTEGER,
    "teamName" TEXT,
    "productType" TEXT DEFAULT 'general',
    "source" TEXT NOT NULL DEFAULT 'WAREHOUSE_API',
    "dataAsOf" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "productId" INTEGER,
    "productName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previousStock" INTEGER,
    "currentStock" INTEGER,
    "reference" TEXT,
    "source" TEXT NOT NULL DEFAULT 'PDC_GUDANG',
    "note" TEXT,
    "warehouseId" INTEGER,
    "warehouseName" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StockReconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "warehouseId" INTEGER,
    "warehouseName" TEXT,
    "shopeeStock" INTEGER NOT NULL,
    "warehouseStock" INTEGER NOT NULL,
    "variance" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncJobLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncRunLock" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OptimizationTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recommendationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "entityType" TEXT NOT NULL DEFAULT 'PRODUCT',
    "entityId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "OptimizationTaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OptimizationTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OptimizationTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "StoreSession_storeId_key" ON "StoreSession"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeProduct_shopeeItemId_key" ON "ShopeeProduct"("shopeeItemId");

-- CreateIndex
CREATE INDEX "ShopeeProduct_storeId_category_idx" ON "ShopeeProduct"("storeId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeOrderSummary_storeId_date_key" ON "ShopeeOrderSummary"("storeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeAdsData_storeId_date_key" ON "ShopeeAdsData"("storeId", "date");

-- CreateIndex
CREATE INDEX "ShopeeAdsCampaignSnapshot_storeId_date_idx" ON "ShopeeAdsCampaignSnapshot"("storeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeAdsCampaignSnapshot_storeId_campaignId_date_key" ON "ShopeeAdsCampaignSnapshot"("storeId", "campaignId", "date");

-- CreateIndex
CREATE INDEX "ProductMetricSnapshot_storeId_date_idx" ON "ProductMetricSnapshot"("storeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMetricSnapshot_storeId_shopeeItemId_date_key" ON "ProductMetricSnapshot"("storeId", "shopeeItemId", "date");

-- CreateIndex
CREATE INDEX "WarehouseItem_productType_idx" ON "WarehouseItem"("productType");

-- CreateIndex
CREATE INDEX "WarehouseItem_teamId_idx" ON "WarehouseItem"("teamId");

-- CreateIndex
CREATE INDEX "WarehouseItem_warehouseId_idx" ON "WarehouseItem"("warehouseId");

-- CreateIndex
CREATE INDEX "WarehouseItem_rawVariationId_idx" ON "WarehouseItem"("rawVariationId");

-- CreateIndex
CREATE INDEX "WarehouseItem_sku_warehouseId_idx" ON "WarehouseItem"("sku", "warehouseId");

-- CreateIndex
CREATE INDEX "WarehouseItem_rawVariationId_warehouseId_idx" ON "WarehouseItem"("rawVariationId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseItem_sku_warehouseId_key" ON "WarehouseItem"("sku", "warehouseId");

-- CreateIndex
CREATE INDEX "WarehouseStockSnapshot_date_idx" ON "WarehouseStockSnapshot"("date");

-- CreateIndex
CREATE INDEX "WarehouseStockSnapshot_productType_idx" ON "WarehouseStockSnapshot"("productType");

-- CreateIndex
CREATE INDEX "WarehouseStockSnapshot_warehouseId_idx" ON "WarehouseStockSnapshot"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseStockSnapshot_sku_warehouseId_date_key" ON "WarehouseStockSnapshot"("sku", "warehouseId", "date");

-- CreateIndex
CREATE INDEX "StockMovement_sku_idx" ON "StockMovement"("sku");

-- CreateIndex
CREATE INDEX "StockMovement_timestamp_idx" ON "StockMovement"("timestamp");

-- CreateIndex
CREATE INDEX "StockMovement_type_idx" ON "StockMovement"("type");

-- CreateIndex
CREATE INDEX "StockReconciliation_sku_warehouseId_checkedAt_idx" ON "StockReconciliation"("sku", "warehouseId", "checkedAt");

-- CreateIndex
CREATE INDEX "SyncRunLock_expiresAt_idx" ON "SyncRunLock"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");

-- CreateIndex
CREATE INDEX "OptimizationTask_status_priority_idx" ON "OptimizationTask"("status", "priority");

-- CreateIndex
CREATE INDEX "OptimizationTask_entityType_entityId_idx" ON "OptimizationTask"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "OptimizationTask_recommendationId_idx" ON "OptimizationTask"("recommendationId");

-- CreateIndex
CREATE INDEX "OptimizationTaskEvent_taskId_createdAt_idx" ON "OptimizationTaskEvent"("taskId", "createdAt");

