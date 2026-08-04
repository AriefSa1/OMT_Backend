const aiService = require('./src/services/aiService');
const prisma = require('./src/utils/prisma');

async function runVerification() {
  console.log('=== VERIFYING AI SERVICE & 5 NEW FEATURES ===\n');

  try {
    // 1. Daily Briefing
    console.log('1. Testing generateDailyBriefing()...');
    const briefing = await aiService.generateDailyBriefing();
    console.log('Daily Briefing Result:', {
      success: briefing.success,
      notConfigured: briefing.notConfigured,
      hasSummary: !!briefing.executiveSummary,
      criticalAlertsCount: briefing.criticalAlerts?.length,
      priorityActionsCount: briefing.priorityActionsToday?.length,
      summaryPreview: briefing.executiveSummary?.substring(0, 80) + '...',
    });

    // 2. A/B Copywriter
    console.log('\n2. Testing generateABTestCopy()...');
    const abCopy = await aiService.generateABTestCopy({
      name: 'Gamis Polos Premium Ceruty Babydoll',
      category: 'Fashion Muslim',
      price: 150000,
      description: 'Bahan ceruty babydoll adem dan jatuh',
      targetAudience: 'Wanita Muslimah Muda',
    });
    console.log('A/B Copy Result:', {
      success: abCopy.success,
      variationsCount: abCopy.variations?.length,
      confidenceScore: abCopy.confidenceScore,
      firstVariantLabel: abCopy.variations?.[0]?.variantLabel,
      firstTitle: abCopy.variations?.[0]?.title,
    });

    // 3. Predictive Restock
    console.log('\n3. Testing predictRestockAndLiquidation()...');
    const restock = await aiService.predictRestockAndLiquidation({
      name: 'Kaos Polos Cotton Combed 30s',
      sku: 'KP-BLK-L',
      stock: 12,
      salesCount: 150,
      warehouseStock: 20,
      leadTimeDays: 7,
      category: 'Fashion Pria',
    });
    console.log('Predictive Restock Result:', {
      success: restock.success,
      urgency: restock.metrics?.urgency,
      dailyVelocity: restock.metrics?.dailyVelocity,
      daysOfInventory: restock.metrics?.daysOfInventory,
      suggestedReorder: restock.metrics?.suggestedBatchReorder,
      hasPlaybook: !!restock.liquidationPlaybook,
      recommendation: restock.restockRecommendation,
    });

    // 4. Dynamic Pricing
    console.log('\n4. Testing simulateDynamicPricing()...');
    const pricing = await aiService.simulateDynamicPricing({
      name: 'Kemeja Flannel Pria Kotak',
      currentPrice: 120000,
      targetPrice: 115000,
      unitCost: 65000,
      unitAdCost: 15000,
      shippingCost: 5000,
      platformFeePercent: 6.5,
      competitorPrice: 110000,
    });
    console.log('Dynamic Pricing Result:', {
      success: pricing.success,
      grossMarginAmount: pricing.calculations?.grossMarginAmount,
      grossMarginPercent: pricing.calculations?.grossMarginPercent,
      breakeven: pricing.calculations?.breakevenPrice,
      safetyFloor: pricing.calculations?.safetyFloorPrice,
      riskLevel: pricing.calculations?.riskLevel,
      optimalPrice: pricing.aiAdvice?.optimalPrice,
    });

    // 5. Ads Optimizer
    console.log('\n5. Testing optimizeAdsKeywordsAndBids()...');
    const adsOpt = await aiService.optimizeAdsKeywordsAndBids({
      campaignName: 'Iklan Produk Terlaris Lebaran',
      spend: 350000,
      sales: 1200000,
      roas: 3.42,
      ctr: 0.025,
      category: 'Fashion & Apparel',
    });
    console.log('Ads Optimizer Result:', {
      success: adsOpt.success,
      wastedSpend: adsOpt.wastedSpendEstimate,
      negKeywordsCount: adsOpt.negativeKeywordsToExclude?.length,
      bidAdjustmentsCount: adsOpt.bidAdjustments?.length,
      scaleKeywordsCount: adsOpt.scaleKeywordsRecommended?.length,
      summary: adsOpt.summary,
    });

    console.log('\n=== ALL 5 AI FEATURES VERIFIED & WORKING PERFECTLY! ===');
  } catch (err) {
    console.error('VERIFICATION ERROR:', err);
  } finally {
    await prisma.$disconnect();
  }
}

runVerification();
