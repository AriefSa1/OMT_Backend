const snapshotService = require('./snapshotService');

class AnalyticsService {
  // Dashboard reads persisted snapshots only. External services are called by syncService.
  async getDashboardOverview(storeId = null, period = 'real_time') {
    return snapshotService.getDashboardOverview(storeId, period);
  }
}

module.exports = new AnalyticsService();
