const ACTIVE_WAREHOUSES = Object.freeze([
  Object.freeze({ id: 38, name: 'PDC Warehouse' }),
  Object.freeze({ id: 94, name: 'Palem Warehouse' }),
  Object.freeze({ id: 67, name: 'Febri Warehouse' }),
  Object.freeze({ id: 96, name: 'Cemara Warehouse' }),
]);

const ACTIVE_WAREHOUSE_ID_LIST = Object.freeze(ACTIVE_WAREHOUSES.map((warehouse) => warehouse.id));

function isActiveWarehouseId(value) {
  const numericId = Number(value);
  return Number.isFinite(numericId) && ACTIVE_WAREHOUSE_ID_LIST.includes(numericId);
}

module.exports = {
  ACTIVE_WAREHOUSES,
  ACTIVE_WAREHOUSE_ID_LIST,
  isActiveWarehouseId,
};
