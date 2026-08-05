const prisma = require('../utils/prisma');
const { sortTasksByPriority } = require('../utils/taskOrdering');

const TASK_STATUS = ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'];

function toTask(task) {
  return {
    ...task,
    events: task.events || [],
  };
}

class TaskService {
  async list({ status = '', search = '', limit = 100 } = {}) {
    const where = {
      ...(TASK_STATUS.includes(status) ? { status } : {}),
      ...(search ? { OR: [{ title: { contains: String(search) } }, { description: { contains: String(search) } }] } : {}),
    };
    const tasks = await prisma.optimizationTask.findMany({
      where,
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 100, 1), 200),
    });
    return sortTasksByPriority(tasks).map(toTask);
  }

  async create({ recommendationId, type, title, description, source, entityType, entityId, priority = 'MEDIUM' }, actor = null) {
    const safeRecommendationId = String(recommendationId || '').trim();
    if (!safeRecommendationId || !title || !description) {
      const error = new Error('Informasi rekomendasi belum lengkap untuk membuat tugas.');
      error.code = 'TASK_VALIDATION';
      throw error;
    }
    const existing = await prisma.optimizationTask.findFirst({
      where: { recommendationId: safeRecommendationId, status: { in: ['PROPOSED', 'APPROVED', 'IN_PROGRESS'] } },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (existing) return { task: toTask(existing), duplicate: true };

    const task = await prisma.optimizationTask.create({
      data: {
        recommendationId: safeRecommendationId,
        type: String(type || 'GENERAL_REVIEW'),
        title: String(title).trim(),
        description: String(description).trim(),
        source: String(source || 'SYSTEM'),
        entityType: String(entityType || 'PRODUCT'),
        entityId: entityId ? String(entityId) : null,
        priority: ['LOW', 'MEDIUM', 'HIGH'].includes(priority) ? priority : 'MEDIUM',
        status: 'PROPOSED',
        createdById: actor?.id || null,
        createdByName: actor?.name || null,
        updatedById: actor?.id || null,
        updatedByName: actor?.name || null,
        events: {
          create: {
            status: 'PROPOSED',
            note: 'Tugas dibuat dari rekomendasi. Tidak ada perubahan otomatis ke Seller Center.',
            actorId: actor?.id || null,
            actorName: actor?.name || null,
          },
        },
      },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    return { task: toTask(task), duplicate: false };
  }

  async updateStatus(taskId, status, note, actor = null) {
    if (!TASK_STATUS.includes(status)) {
      const error = new Error('Status tugas tidak valid.');
      error.code = 'TASK_STATUS';
      throw error;
    }
    const task = await prisma.optimizationTask.update({
      where: { id: String(taskId) },
      data: {
        status,
        updatedById: actor?.id || null,
        updatedByName: actor?.name || null,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        events: {
          create: {
            status,
            note: note ? String(note).trim() : null,
            actorId: actor?.id || null,
            actorName: actor?.name || null,
          },
        },
      },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    return toTask(task);
  }
}

module.exports = new TaskService();
module.exports.TASK_STATUS = TASK_STATUS;
