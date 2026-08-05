const STATUS_RANK = {
  IN_PROGRESS: 0,
  APPROVED: 1,
  PROPOSED: 2,
  COMPLETED: 3,
  SKIPPED: 4,
};

const PRIORITY_RANK = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

function sortTasksByPriority(tasks = []) {
  return [...tasks].sort((left, right) => {
    const leftClosed = ['COMPLETED', 'SKIPPED'].includes(left.status) ? 1 : 0;
    const rightClosed = ['COMPLETED', 'SKIPPED'].includes(right.status) ? 1 : 0;

    return leftClosed - rightClosed
      || (PRIORITY_RANK[left.priority] ?? 99) - (PRIORITY_RANK[right.priority] ?? 99)
      || (STATUS_RANK[left.status] ?? 99) - (STATUS_RANK[right.status] ?? 99)
      || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

module.exports = { sortTasksByPriority };
