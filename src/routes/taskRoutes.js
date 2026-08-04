const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { listTasks, createTask, updateTask } = require('../controllers/taskController');

const router = express.Router();
router.use(authMiddleware);
router.get('/', listTasks);
router.post('/', createTask);
router.patch('/:id', updateTask);

module.exports = router;
