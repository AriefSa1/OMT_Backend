const taskService = require('../services/taskService');
const snapshotService = require('../services/snapshotService');

async function listTasks(req, res) {
  try {
    const [tasks, actionSnapshot] = await Promise.all([
      taskService.list(req.query),
      snapshotService.getActionSnapshot(),
    ]);
    return res.json({ success: true, tasks, recommendations: actionSnapshot.recommendations, sources: actionSnapshot.sources });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Tugas tidak dapat dimuat.' });
  }
}

async function createTask(req, res) {
  try {
    const result = await taskService.create(req.body, req.user);
    return res.status(result.duplicate ? 200 : 201).json({ success: true, ...result });
  } catch (err) {
    return res.status(err.code === 'TASK_VALIDATION' ? 400 : 500).json({ success: false, error: err.message });
  }
}

async function updateTask(req, res) {
  try {
    const task = await taskService.updateStatus(req.params.id, req.body.status, req.body.note, req.user);
    return res.json({ success: true, task });
  } catch (err) {
    const status = err.code === 'TASK_STATUS' ? 400 : err.code === 'P2025' ? 404 : 500;
    return res.status(status).json({ success: false, error: status === 404 ? 'Tugas tidak ditemukan.' : err.message });
  }
}

module.exports = { listTasks, createTask, updateTask };
