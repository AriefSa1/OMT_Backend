const snapshotService = require('./snapshotService');

class AnalyticsService {
  // Dashboard reads persisted snapshots only. External services are called by syncService.
  async getDashboardOverview(storeId = null) {
    return snapshotService.getDashboardOverview(storeId);
  }
}

module.exports = new AnalyticsService();
