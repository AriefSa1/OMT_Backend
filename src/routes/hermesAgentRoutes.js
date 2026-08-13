const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  getStatus,
  chat,
  validateAnalysis,
  analyze,
  listMemories,
  getMemory,
  saveFeedback,
  createAction,
  updateAction,
  deleteAction,
  evaluateAction,
} = require('../controllers/hermesAgentController');

const router = express.Router();

router.use(authMiddleware);

router.get('/status', getStatus);
router.post('/chat', chat);
router.post('/analyze/validate', validateAnalysis);
router.post('/analyze', analyze);
router.get('/memories', listMemories);
router.get('/memories/:id', getMemory);
router.post('/analyze/:id/feedback', saveFeedback);
router.post('/analyze/:id/actions', createAction);
router.patch('/actions/:id', updateAction);
router.delete('/actions/:id', deleteAction);
router.post('/actions/:id/evaluate', evaluateAction);

module.exports = router;
