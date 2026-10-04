import { FACILITY_TYPES, DISTRICTS, type AccessPoint, type AccessPointDraft } from '../types/point';
import {
  OCCUPIED_LEVELS,
  type Inspection,
  type InspectionConclusion,
  type OccupiedLevel,
} from '../types/inspection';
import { RECTIFY_STATUSES, type RectifyPlan, type RectifyStatus } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import type {
  BatchSource,
  MergePlan,
  MergeReport,
  OfflineBatch,
  PointConflict,
  RectifyVerdict,
  ValidationIssue,
} from '../types/batch';
import { addDays, makeId, toPlain } from './format';
import { judgeInspection, judgeSegment } from './routeCheck';
import { LEDGER_BATCH_ID, POINT_COMPARE_FIELDS } from './batchConstants';

/** 离线点位输入：台账草稿形状，code 作为匹配台账的身份键 */
export type OfflinePointInput = AccessPointDraft;

/** 离线核验输入：pointId 与 pointCode 二选一，优先 pointCode 匹配台账点位 */
export interface OfflineInspectionInput {
  pointId?: string;
  pointCode?: string;
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  conclusion?: InspectionConclusion;
  problem: string;
}

/** 离线整改输入：pointId 与 pointCode 二选一 */
export interface OfflineRectifyInput {
  pointId?: string;
  pointCode?: string;
  requirement: string;
  unit?: string;
  deadline: string;
  recheckDate?: string;
  status?: RectifyStatus;
}

/** 离线批次载荷（核验员离线登记后带回内网合并） */
export interface OfflineBatchPayload {
  code: string;
  registrar?: string;
  note?: string;
  points?: OfflinePointInput[];
  inspections?: OfflineInspectionInput[];
  rectifies?: OfflineRectifyInput[];
}

/** 合并前的台账全量数据 */
export interface CurrentData {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  routes: RouteSegment[];
}

/** 校验载荷，返回问题清单（空数组表示通过） */
export function validatePayload(payload: OfflineBatchPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!payload || typeof payload !== 'object') {
    issues.push({ kind: 'batch', index: -1, field: 'payload', message: '批次载荷必须是 JSON 对象' });
    return issues;
  }
  if (!payload.code || !String(payload.code).trim()) {
    issues.push({ kind: 'batch', index: -1, field: 'code', message: '批次编号不能为空' });
  }

  (payload.points ?? []).forEach((p, i) => {
    if (!p.code || !String(p.code).trim())
      issues.push({ kind: 'point', index: i, field: 'code', message: '点位编号不能为空' });
    if (!p.name || !String(p.name).trim())
      issues.push({ kind: 'point', index: i, field: 'name', message: '点位名称不能为空' });
    if (!FACILITY_TYPES.includes(p.facilityType))
      issues.push({ kind: 'point', index: i, field: 'facilityType', message: `设施类型非法：${p.facilityType}` });
    if (!DISTRICTS.includes(p.district as (typeof DISTRICTS)[number]))
      issues.push({ kind: 'point', index: i, field: 'district', message: `行政区非法：${p.district}` });
    const lng = Number(p.lng);
    const lat = Number(p.lat);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180)
      issues.push({ kind: 'point', index: i, field: 'lng', message: '经度非法（应在 -180~180 之间）' });
    if (!Number.isFinite(lat) || lat < -90 || lat > 90)
      issues.push({ kind: 'point', index: i, field: 'lat', message: '纬度非法（应在 -90~90 之间）' });
  });

  (payload.inspections ?? []).forEach((ins, i) => {
    if (!ins.pointId && !ins.pointCode)
      issues.push({ kind: 'inspection', index: i, field: 'point', message: '核验记录必须指定点位（pointId 或 pointCode）' });
    if (!ins.date || !String(ins.date).trim())
      issues.push({ kind: 'inspection', index: i, field: 'date', message: '核验日期不能为空' });
    if (!ins.inspector || !String(ins.inspector).trim())
      issues.push({ kind: 'inspection', index: i, field: 'inspector', message: '核验人不能为空' });
    const slope = Number(ins.slope);
    const width = Number(ins.clearWidth);
    if (!Number.isFinite(slope) || slope < 0 || slope > 100)
      issues.push({ kind: 'inspection', index: i, field: 'slope', message: '坡度非法（应在 0~100 之间）' });
    if (!Number.isFinite(width) || width < 0 || width > 500)
      issues.push({ kind: 'inspection', index: i, field: 'clearWidth', message: '净宽非法（应在 0~500 之间）' });
    if (!OCCUPIED_LEVELS.includes(ins.occupied))
      issues.push({ kind: 'inspection', index: i, field: 'occupied', message: `占用情况非法：${ins.occupied}` });
  });

  (payload.rectifies ?? []).forEach((r, i) => {
    if (!r.pointId && !r.pointCode)
      issues.push({ kind: 'rectify', index: i, field: 'point', message: '整改记录必须指定点位（pointId 或 pointCode）' });
    if (!r.requirement || !String(r.requirement).trim())
      issues.push({ kind: 'rectify', index: i, field: 'requirement', message: '整改要求不能为空' });
    if (!r.deadline || !String(r.deadline).trim())
      issues.push({ kind: 'rectify', index: i, field: 'deadline', message: '整改期限不能为空' });
    if (r.status && !RECTIFY_STATUSES.includes(r.status))
      issues.push({ kind: 'rectify', index: i, field: 'status', message: `整改状态非法：${r.status}` });
  });

  return issues;
}

/** 取对象的部分字段快照（仅保留有定义的字段） */
function pickFields<T extends object, K extends keyof T>(obj: T, fields: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

/** 整改记录的裁定时间戳：更新时间与复检日期取更晚者 */
function rectifyRecency(r: RectifyPlan): number {
  const upd = r.updatedAt || r.createdAt || '';
  const updMs = upd ? new Date(upd).getTime() : 0;
  const recheckMs = r.recheckDate ? new Date(`${r.recheckDate}T00:00:00`).getTime() : 0;
  return Math.max(Number.isFinite(updMs) ? updMs : 0, Number.isFinite(recheckMs) ? recheckMs : 0);
}

/**
 * 整改状态裁定：按更新时间与复检日期取更晚的有效值。
 * 状态必须是合法枚举；胜者状态非法时退回败者，再非法则默认待整改。
 */
export function resolveRectifyStatus(ledger: RectifyPlan, field: RectifyPlan): RectifyVerdict {
  const ledgerMs = rectifyRecency(ledger);
  const fieldMs = rectifyRecency(field);
  const fieldWins = fieldMs > ledgerMs;
  const winner = fieldWins ? field : ledger;
  const loser = fieldWins ? ledger : field;
  const status: RectifyStatus = RECTIFY_STATUSES.includes(winner.status)
    ? winner.status
    : RECTIFY_STATUSES.includes(loser.status)
      ? loser.status
      : '待整改';
  return {
    status,
    recheckDate: winner.recheckDate || loser.recheckDate || '',
    requirement: fieldWins ? field.requirement : ledger.requirement,
  };
}

/** 构造批次记录（初始 pending，由 store 在合并成功/失败后回写状态） */
export function createBatchRecord(payload: OfflineBatchPayload, source: BatchSource = 'offline'): OfflineBatch {
  const now = new Date().toISOString();
  return {
    id: makeId('batch'),
    code: String(payload.code).trim(),
    source,
    status: 'pending',
    registrar: payload.registrar?.trim() || '未署名核验员',
    note: payload.note?.trim() || '',
    rawInput: JSON.stringify(payload),
    failReason: '',
    createdAt: now,
    mergedAt: '',
  };
}

/**
 * 纯合并计划：校验 + 冲突裁定 + 去重 + 整改状态裁定 + 路线判定重算。
 * 不触碰数据库，提交阶段由 store 事务化落库。
 */
export function buildMergePlan(
  payload: OfflineBatchPayload,
  current: CurrentData,
  batchId: string,
): MergePlan {
  const issues = validatePayload(payload);
  if (issues.length) {
    throw new Error(`校验失败：${issues.map((i) => i.message).join('；')}`);
  }

  const now = new Date().toISOString();
  const pointsByCode = new Map<string, AccessPoint>();
  const pointsById = new Map<string, AccessPoint>();
  for (const p of current.points) {
    pointsByCode.set(p.code, p);
    pointsById.set(p.id, p);
  }

  const newPoints: AccessPoint[] = [];
  const conflicts: PointConflict[] = [];

  const resolvePoint = (ref: { pointId?: string; pointCode?: string }): AccessPoint | undefined => {
    if (ref.pointCode) return pointsByCode.get(ref.pointCode);
    if (ref.pointId) return pointsById.get(ref.pointId);
    return undefined;
  };

  // 1. 点位：台账为准，双方都改过列待核对，不用现场值覆盖
  for (const op of payload.points ?? []) {
    const existing = pointsByCode.get(op.code);
    if (!existing) {
      const point: AccessPoint = toPlain({
        ...op,
        id: makeId('pt'),
        createdAt: now,
        updatedAt: now,
        batchId,
      });
      newPoints.push(point);
      pointsByCode.set(point.code, point);
      pointsById.set(point.id, point);
      continue;
    }
    const diffFields = POINT_COMPARE_FIELDS.filter((f) => {
      const ov = op[f as keyof OfflinePointInput];
      const ev = existing[f as keyof AccessPoint];
      return ov !== undefined && ov !== ev;
    });
    if (diffFields.length === 0) continue;
    // 台账点位在创建后被编辑过 → 双方都改过 → 待核对；台账为准不覆盖
    if (existing.updatedAt > existing.createdAt) {
      conflicts.push({
        id: makeId('conf'),
        batchId,
        pointId: existing.id,
        pointCode: existing.code,
        pointName: existing.name,
        fieldValues: pickFields(op, diffFields),
        ledgerValues: pickFields(existing, diffFields),
        status: 'pending',
        createdAt: now,
      });
    }
  }

  // 2. 核验：同一人同日去重
  const newInspections: Inspection[] = [];
  let inspectionsDeduped = 0;
  const seenInspectionKeys = new Set<string>();
  for (const ins of current.inspections) {
    seenInspectionKeys.add(`${ins.pointId}|${ins.inspector}|${ins.date}`);
  }
  for (const oi of payload.inspections ?? []) {
    const point = resolvePoint(oi);
    if (!point) continue;
    const key = `${point.id}|${String(oi.inspector).trim()}|${oi.date}`;
    if (seenInspectionKeys.has(key)) {
      inspectionsDeduped += 1;
      continue;
    }
    seenInspectionKeys.add(key);
    const judged = judgeInspection({
      slope: Number(oi.slope),
      clearWidth: Number(oi.clearWidth),
      hasHandrail: oi.hasHandrail,
      tactileContinuous: oi.tactileContinuous,
      occupied: oi.occupied,
    });
    newInspections.push(
      toPlain({
        pointId: point.id,
        date: oi.date,
        inspector: String(oi.inspector).trim(),
        slope: Number(oi.slope),
        clearWidth: Number(oi.clearWidth),
        hasHandrail: oi.hasHandrail,
        tactileContinuous: oi.tactileContinuous,
        occupied: oi.occupied,
        conclusion: oi.conclusion || judged.conclusion,
        problem: String(oi.problem || '').trim(),
        id: makeId('ins'),
        createdAt: now,
        batchId,
      }),
    );
  }

  // 3. 整改：按更新时间与复检日期取更晚的有效值
  const newRectifies: RectifyPlan[] = [];
  const updatedRectifies: { id: string; patch: Partial<RectifyPlan> }[] = [];
  for (const or of payload.rectifies ?? []) {
    const point = resolvePoint(or);
    if (!point) continue;
    const requirement = String(or.requirement).trim();
    const existing = current.rectifies.find((r) => r.pointId === point.id && r.requirement === requirement);
    if (!existing) {
      newRectifies.push(
        toPlain({
          pointId: point.id,
          requirement,
          unit: or.unit?.trim() || point.maintainUnit || '待指派责任单位',
          deadline: or.deadline,
          recheckDate: or.recheckDate || '',
          status: or.status || '待整改',
          id: makeId('rct'),
          createdAt: now,
          updatedAt: now,
          batchId,
        }),
      );
      continue;
    }
    const fieldPlan: RectifyPlan = {
      ...existing,
      status: or.status || existing.status,
      recheckDate: or.recheckDate || existing.recheckDate,
      requirement,
      // 现场未提供更新时间：以复检日期作为 status 的裁定时间，不用合并时间（now）抢占
      updatedAt: or.recheckDate || existing.updatedAt,
    };
    const verdict = resolveRectifyStatus(existing, fieldPlan);
    const patch: Partial<RectifyPlan> = {};
    if (verdict.status !== existing.status) patch.status = verdict.status;
    if (verdict.recheckDate !== existing.recheckDate) patch.recheckDate = verdict.recheckDate;
    if (verdict.requirement !== existing.requirement) patch.requirement = verdict.requirement;
    if (Object.keys(patch).length) {
      patch.updatedAt = now;
      updatedRectifies.push({ id: existing.id, patch });
    }
  }

  // 3.1 闭环：新增不合格核验自动补建整改条目（点位或核验一变，相关整改重算）
  const existingPending = new Set(
    [...current.rectifies, ...newRectifies]
      .filter((r) => r.status !== '已整改')
      .map((r) => r.pointId),
  );
  for (const ins of newInspections) {
    if (ins.conclusion !== '不合格') continue;
    if (existingPending.has(ins.pointId)) continue;
    existingPending.add(ins.pointId);
    const point = pointsById.get(ins.pointId);
    newRectifies.push(
      toPlain({
        pointId: ins.pointId,
        requirement: `按 ${ins.date} 核验结论整改：${ins.problem || '坡度、净宽或占用问题'}`,
        unit: point?.maintainUnit || '待指派责任单位',
        deadline: addDays(ins.date, 30),
        recheckDate: '',
        status: '待整改',
        id: makeId('rct'),
        createdAt: now,
        updatedAt: now,
        batchId,
      }),
    );
  }

  // 4. 路线判定重算：逐段重新判定轮椅通行性
  const recalculatedSegments: { id: string; patch: { length: number; wheelchairPassable: boolean } }[] = [];
  for (const seg of current.routes) {
    const passable = judgeSegment(seg).passable;
    if (passable !== seg.wheelchairPassable) {
      recalculatedSegments.push({ id: seg.id, patch: { length: seg.length, wheelchairPassable: passable } });
    }
  }

  const report: MergeReport = {
    batchCode: String(payload.code).trim(),
    pointsTotal: payload.points?.length ?? 0,
    pointsNew: newPoints.length,
    pointsConflict: conflicts.length,
    inspectionsTotal: payload.inspections?.length ?? 0,
    inspectionsNew: newInspections.length,
    inspectionsDeduped,
    rectifiesTotal: payload.rectifies?.length ?? 0,
    rectifiesNew: newRectifies.length,
    rectifiesUpdated: updatedRectifies.length,
    routesRecalculated: recalculatedSegments.length,
  };

  return {
    newPoints,
    conflicts,
    newInspections,
    newRectifies,
    updatedRectifies,
    recalculatedSegments,
    report,
  };
}

export { LEDGER_BATCH_ID };
