-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopeeItemId" TEXT NOT NULL,
    "shopeeModelId" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "mappedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductMappingComponent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "warehouseId" INTEGER NOT NULL DEFAULT 0,
    "quantityPerUnit" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductMappingComponent_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ProductMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProductMapping_storeId_isActive_idx" ON "ProductMapping"("storeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_shopeeItemId_shopeeModelId_key" ON "ProductMapping"("shopeeItemId", "shopeeModelId");

-- CreateIndex
CREATE INDEX "ProductMappingComponent_sku_idx" ON "ProductMappingComponent"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMappingComponent_mappingId_sku_warehouseId_key" ON "ProductMappingComponent"("mappingId", "sku", "warehouseId");
