const snapshotService = require('./snapshotService');

class AnalyticsService {
  // Dashboard reads persisted snapshots only. External services are called by syncService.
  async getDashboardOverview() {
    return snapshotService.getDashboardOverview();
  }
}

module.exports = new AnalyticsService();
