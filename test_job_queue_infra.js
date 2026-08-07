/**
 * Regression test: verify the async job queue infrastructure is wired correctly.
 * - SyncJob model exists in schema
 * - jobQueueService exports required methods
 * - syncQueueController exports required handlers
 * - syncRoutes includes async endpoints
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 1. Schema has SyncJob model
const schema = fs.readFileSync(path.join(__dirname, 'prisma', 'schema.prisma'), 'utf8');
assert.match(schema, /model SyncJob \{/, 'SyncJob model harus ada di schema Prisma');
assert.match(schema, /@@index\(\[status, createdAt\]\)/, 'SyncJob harus punya index pada (status, createdAt)');

// 2. jobQueueService exports required methods
const jobQueueService = require('./src/services/jobQueueService');
assert.strictEqual(typeof jobQueueService.enqueue, 'function', 'jobQueueService.enqueue harus ada');
assert.strictEqual(typeof jobQueueService.processNext, 'function', 'jobQueueService.processNext harus ada');
assert.strictEqual(typeof jobQueueService.start, 'function', 'jobQueueService.start harus ada');
assert.strictEqual(typeof jobQueueService.stop, 'function', 'jobQueueService.stop harus ada');
assert.strictEqual(typeof jobQueueService.getJob, 'function', 'jobQueueService.getJob harus ada');
assert.strictEqual(typeof jobQueueService.listJobs, 'function', 'jobQueueService.listJobs harus ada');

// 3. syncQueueController exports required handlers
const syncQueueController = require('./src/controllers/syncQueueController');
assert.strictEqual(typeof syncQueueController.getJobs, 'function', 'getJobs handler harus ada');
assert.strictEqual(typeof syncQueueController.getJob, 'function', 'getJob handler harus ada');
assert.strictEqual(typeof syncQueueController.runAsync, 'function', 'runAsync handler harus ada');

// 4. syncRoutes includes async endpoints
const syncRoutes = fs.readFileSync(path.join(__dirname, 'src', 'routes', 'syncRoutes.js'), 'utf8');
assert.match(syncRoutes, /run-async/, 'syncRoutes harus ada endpoint /run-async');
assert.match(syncRoutes, /\/jobs/, 'syncRoutes harus ada endpoint /jobs');

// 5. server.js starts job queue worker
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
assert.match(serverSrc, /jobQueueService\.start/, 'server.js harus memulai jobQueueService');
assert.match(serverSrc, /jobQueueService\.stop/, 'server.js harus mematikan jobQueueService pada shutdown');

// 6. syncCron enqueues jobs instead of running sync synchronously
const cronSrc = fs.readFileSync(path.join(__dirname, 'src', 'cron', 'syncCron.js'), 'utf8');
assert.match(cronSrc, /enqueue/, 'syncCron harus memakai jobQueueService.enqueue');
assert.doesNotMatch(cronSrc, /syncAll/, 'syncCron tidak boleh memanggil syncService.syncAll secara langsung');

console.log('job queue infrastructure regression checks passed');
