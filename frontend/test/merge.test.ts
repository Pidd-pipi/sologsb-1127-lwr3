declare const process: any;
import { buildMergePlan, validatePayload, resolveRectifyStatus, type OfflineBatchPayload } from '../src/utils/batchMerge';
import type { AccessPoint } from '../src/types/point';
import type { Inspection } from '../src/types/inspection';
import type { RectifyPlan } from '../src/types/rectify';
import type { RouteSegment } from '../src/types/route';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; console.error('  FAIL:', msg); }
}

const now = new Date().toISOString();
const ledgerPoint: AccessPoint = {
  id: 'pt-1', code: 'WZ-001', name: '台账点位', facilityType: '缘石坡道',
  lng: 116.4, lat: 39.9, district: '东城区', location: '老路',
  builtYear: 2010, maintainUnit: '养护一所', createdAt: now, updatedAt: now, batchId: 'batch-ledger',
};
const ledgerPointEdited: AccessPoint = {
  ...ledgerPoint, id: 'pt-2', code: 'WZ-002', name: '已编辑点位',
  updatedAt: new Date(Date.now() + 100000).toISOString(),
};
const ledgerInspection: Inspection = {
  id: 'ins-1', pointId: 'pt-1', date: '2025-03-12', inspector: '督导员 李维',
  slope: 3, clearWidth: 150, hasHandrail: true, tactileContinuous: true,
  occupied: '无', conclusion: '合格', problem: '', createdAt: now, batchId: 'batch-ledger',
};
const past = '2025-01-15T00:00:00.000Z';
const ledgerRectify: RectifyPlan = {
  id: 'rct-1', pointId: 'pt-1', requirement: '整改A', unit: '养护一所',
  deadline: '2025-04-01', recheckDate: '', status: '待整改',
  createdAt: past, updatedAt: past, batchId: 'batch-ledger',
};
const ledgerRoute: RouteSegment = {
  id: 'rts-1', routeName: '路线1', fromPointId: 'pt-1', toPointId: 'pt-2',
  length: 100, obstacleCount: 0, stepCount: 0, curbHeight: 2,
  wheelchairPassable: true, order: 1, createdAt: now, batchId: 'batch-ledger',
};

const current = {
  points: [ledgerPoint, ledgerPointEdited],
  inspections: [ledgerInspection],
  rectifies: [ledgerRectify],
  routes: [ledgerRoute],
};

console.log('--- 场景1: 新点位 + 台账点位(未编辑)字段差异 → 台账为准 ---');
{
  const payload: OfflineBatchPayload = {
    code: 'B1',
    points: [
      { code: 'WZ-001', name: '现场改名', facilityType: '缘石坡道', lng: 116.5, lat: 39.9, district: '东城区', location: '老路', builtYear: 2010, maintainUnit: '养护一所' },
      { code: 'WZ-003', name: '全新点位', facilityType: '盲道', lng: 116.6, lat: 39.9, district: '西城区', location: '新路', builtYear: 2021, maintainUnit: '养护二所' },
    ],
  };
  const plan = buildMergePlan(payload, current, 'batch-1');
  assert(plan.newPoints.length === 1, '新增 1 个点位');
  assert(plan.newPoints[0].code === 'WZ-003', '新增点位是 WZ-003');
  assert(plan.conflicts.length === 0, '未编辑台账点位不产生待核对');
  assert(plan.report.pointsNew === 1, '报告新增点位 1');
}

console.log('--- 场景2: 台账点位已编辑 + 现场也改 → 待核对 ---');
{
  const payload: OfflineBatchPayload = {
    code: 'B2',
    points: [
      { code: 'WZ-002', name: '现场又改名', facilityType: '缘石坡道', lng: 116.4, lat: 39.9, district: '东城区', location: '老路', builtYear: 2010, maintainUnit: '养护一所' },
    ],
  };
  const plan = buildMergePlan(payload, current, 'batch-2');
  assert(plan.conflicts.length === 1, '产生 1 条待核对');
  assert(plan.conflicts[0].pointCode === 'WZ-002', '待核对点位 WZ-002');
  assert(plan.conflicts[0].status === 'pending', '待核对状态 pending');
  assert(plan.report.pointsConflict === 1, '报告待核对 1');
}

console.log('--- 场景3: 同一人同日核验去重 ---');
{
  const payload: OfflineBatchPayload = {
    code: 'B3',
    inspections: [
      { pointCode: 'WZ-001', date: '2025-03-12', inspector: '督导员 李维', slope: 3, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '' },
      { pointCode: 'WZ-001', date: '2025-03-13', inspector: '督导员 李维', slope: 3, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', problem: '' },
    ],
  };
  const plan = buildMergePlan(payload, current, 'batch-3');
  assert(plan.newInspections.length === 1, '去重后新增 1 条');
  assert(plan.newInspections[0].date === '2025-03-13', '保留 03-13 那条');
  assert(plan.report.inspectionsDeduped === 1, '报告去重 1');
}

console.log('--- 场景4: 整改状态按更新时间/复检日期取更晚有效值 ---');
{
  const payload: OfflineBatchPayload = {
    code: 'B4',
    rectifies: [
      { pointCode: 'WZ-001', requirement: '整改A', unit: '养护一所', deadline: '2025-04-01', recheckDate: '2025-09-20', status: '已整改' },
    ],
  };
  const plan = buildMergePlan(payload, current, 'batch-4');
  assert(plan.updatedRectifies.length === 1, '更新 1 条整改');
  assert(plan.updatedRectifies[0].patch.status === '已整改', '状态裁定为已整改');
  assert(plan.updatedRectifies[0].patch.recheckDate === '2025-09-20', '复检日期 2025-09-20');
  assert(plan.report.rectifiesUpdated === 1, '报告更新整改 1');
}

console.log('--- 场景5: 校验失败抛错 ---');
{
  const payload: OfflineBatchPayload = {
    code: '',
    points: [
      { code: '', name: '', facilityType: '盲道', lng: 200, lat: 39.9, district: '东城区', location: '', builtYear: 2020, maintainUnit: '养护一所' },
    ],
  };
  const issues = validatePayload(payload);
  assert(issues.length > 0, '校验返回问题清单');
  try {
    buildMergePlan(payload, current, 'batch-5');
    assert(false, '应抛错');
  } catch (e) {
    assert(String((e as Error).message).includes('校验失败'), '抛校验失败错误');
  }
}

console.log('--- 场景6: 不合格核验自动补建整改 ---');
{
  const payload: OfflineBatchPayload = {
    code: 'B6',
    inspections: [
      { pointCode: 'WZ-002', date: '2025-10-01', inspector: '督导员 王岚', slope: 9, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', problem: '严重不合格' },
    ],
  };
  const plan = buildMergePlan(payload, current, 'batch-6');
  assert(plan.newInspections.length === 1, '新增 1 条核验');
  assert(plan.newInspections[0].conclusion === '不合格', '结论不合格');
  assert(plan.newRectifies.length === 1, '自动补建 1 条整改');
  assert(plan.newRectifies[0].status === '待整改', '补建整改为待整改');
}

console.log('--- 场景7: 路线判定重算（台阶>0 → 不可通行） ---');
{
  const seg: RouteSegment = { ...ledgerRoute, stepCount: 2, wheelchairPassable: true };
  const plan = buildMergePlan({ code: 'B7' }, { ...current, routes: [seg] }, 'batch-7');
  assert(plan.recalculatedSegments.length === 1, '重算 1 段');
  assert(plan.recalculatedSegments[0].patch.wheelchairPassable === false, '重算为不可通行');
}

console.log('--- 场景8: resolveRectifyStatus 边界 ---');
{
  const a: RectifyPlan = { ...ledgerRectify, status: '待整改', recheckDate: '2025-01-01', updatedAt: '2025-01-01T00:00:00.000Z' };
  const b: RectifyPlan = { ...ledgerRectify, status: '已整改', recheckDate: '2025-09-01', updatedAt: '2025-09-01T00:00:00.000Z' };
  const v = resolveRectifyStatus(a, b);
  assert(v.status === '已整改', '更晚的已整改胜出');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
