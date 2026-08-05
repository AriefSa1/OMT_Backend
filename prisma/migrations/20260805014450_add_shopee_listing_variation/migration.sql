-- CreateTable
CREATE TABLE "ShopeeListingVariation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopeeItemId" TEXT NOT NULL,
    "shopeeModelId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "variationSku" TEXT NOT NULL DEFAULT '',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "dataAsOf" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShopeeListingVariation_shopeeItemId_fkey" FOREIGN KEY ("shopeeItemId") REFERENCES "ShopeeProduct" ("shopeeItemId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShopeeListingVariation_variationSku_idx" ON "ShopeeListingVariation"("variationSku");

-- CreateIndex
CREATE INDEX "ShopeeListingVariation_storeId_idx" ON "ShopeeListingVariation"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeListingVariation_shopeeItemId_shopeeModelId_key" ON "ShopeeListingVariation"("shopeeItemId", "shopeeModelId");
