import { db } from '../db';
import { DISTRICTS, FACILITY_TYPES, type AccessPoint } from '../types/point';
import type { Inspection, InspectionConclusion, OccupiedLevel } from '../types/inspection';
import type { RectifyPlan, RectifyStatus } from '../types/rectify';
import { judgeInspection, judgeSegment } from './routeCheck';
import { segmentLength } from './geo';
import { makeId, todayStr } from './format';
import type {
  BatchInspection,
  BatchPoint,
  BatchRectify,
  FieldDiff,
  MergeStats,
  OfflineBatch,
  PendingConflict,
} from '../types/batch';

/** 校验失败：整批撤回（事务回滚），错误信息回传给界面，允许修正后重试 */
export class BatchValidationError extends Error {}

/** 点位属性的台账字段元信息（以台账为准，现场值仅在台账没动过时才回填） */
const POINT_FIELDS: { key: keyof AccessPoint; label: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'facilityType', label: '设施类型' },
  { key: 'lng', label: '经度' },
  { key: 'lat', label: '纬度' },
  { key: 'district', label: '行政区' },
  { key: 'location', label: '所在道路或建筑' },
  { key: 'builtYear', label: '建成年代' },
  { key: 'maintainUnit', label: '养护单位' },
];

const CONCLUSIONS: InspectionConclusion[] = ['合格', '限期整改', '不合格'];
const RECTIFY_STATUS: RectifyStatus[] = ['待整改', '已整改', '复发'];
const OCCUPIED: OccupiedLevel[] = ['无', '临时占用', '长期占用'];
const FACILITY_TYPE_SET = new Set<string>(FACILITY_TYPES);
const DISTRICT_SET = new Set<string>(DISTRICTS);

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function fmt(v: unknown): string {
  return isBlank(v) ? '—' : String(v);
}

/** 严格校验日期字符串 YYYY-MM-DD */
function assertDate(value: unknown, ctx: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BatchValidationError(`${ctx}：日期必须为 YYYY-MM-DD 格式（实际：${fmt(value)}）`);
  }
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new BatchValidationError(`${ctx}：${value} 不是有效日期`);
  }
  return value;
}

/**
 * 解析离线批次文件（JSON）。
 * 结构 / 枚举 / 必填 / 批内重复校验失败都抛 BatchValidationError，调用方应允许重试。
 */
export function parseBatch(raw: string): OfflineBatch {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BatchValidationError('批次文件不是合法 JSON，请检查导出内容');
  }
  if (typeof data !== 'object' || data === null) {
    throw new BatchValidationError('批次文件结构为空');
  }
  const b = data as Partial<OfflineBatch>;
  if (isBlank(b.batchId) || typeof b.batchId !== 'string') {
    throw new BatchValidationError('缺少批次号 batchId');
  }

  const points = (b.points ?? []) as BatchPoint[];
  const inspections = (b.inspections ?? []) as BatchInspection[];
  const rectifies = (b.rectifies ?? []) as BatchRectify[];
  if (!Array.isArray(points) || !Array.isArray(inspections) || !Array.isArray(rectifies)) {
    throw new BatchValidationError('points / inspections / rectifies 必须是数组');
  }
  if (points.length + inspections.length + rectifies.length === 0) {
    throw new BatchValidationError('批次为空：没有任何点位、核验或整改数据');
  }

  const codes = new Set<string>();
  points.forEach((p, i) => {
    const ctx = `点位 #${i + 1}`;
    if (isBlank(p.code)) throw new BatchValidationError(`${ctx} 缺少点位编号 code`);
    if (codes.has(p.code)) throw new BatchValidationError(`${ctx} 编号 ${p.code} 在批次内重复`);
    codes.add(p.code);
    if (!isBlank(p.facilityType) && !FACILITY_TYPE_SET.has(String(p.facilityType))) {
      throw new BatchValidationError(`${ctx}（${p.code}）设施类型不在台账枚举：${fmt(p.facilityType)}`);
    }
    if (!isBlank(p.district) && !DISTRICT_SET.has(String(p.district))) {
      throw new BatchValidationError(`${ctx}（${p.code}）行政区不在台账枚举：${fmt(p.district)}`);
    }
    if (!isBlank(p.lng)) {
      if (typeof p.lng !== 'number' || Number.isNaN(p.lng) || p.lng < -180 || p.lng > 180) {
        throw new BatchValidationError(`${ctx}（${p.code}）经度非法：${fmt(p.lng)}`);
      }
    }
    if (!isBlank(p.lat)) {
      if (typeof p.lat !== 'number' || Number.isNaN(p.lat) || p.lat < -90 || p.lat > 90) {
        throw new BatchValidationError(`${ctx}（${p.code}）纬度非法：${fmt(p.lat)}`);
      }
    }
    if (!isBlank(p.builtYear) && (!Number.isInteger(p.builtYear) || p.builtYear! < 1900 || p.builtYear! > 2100)) {
      throw new BatchValidationError(`${ctx}（${p.code}）建成年代非法：${fmt(p.builtYear)}`);
    }
  });

  const dedupKeys = new Set<string>();
  inspections.forEach((ins, i) => {
    const ctx = `核验 #${i + 1}`;
    if (isBlank(ins.code)) throw new BatchValidationError(`${ctx} 缺少点位编号 code`);
    assertDate(ins.date, `${ctx}（${ins.code}）核验日期`);
    if (isBlank(ins.inspector)) throw new BatchValidationError(`${ctx}（${ins.code}）缺少核验人`);
    if (!isBlank(ins.occupied) && !OCCUPIED.includes(ins.occupied as OccupiedLevel)) {
      throw new BatchValidationError(`${ctx}（${ins.code}）占用情况非法：${fmt(ins.occupied)}`);
    }
    if (!isBlank(ins.conclusion) && !CONCLUSIONS.includes(ins.conclusion as InspectionConclusion)) {
      throw new BatchValidationError(`${ctx}（${ins.code}）核验结论非法：${fmt(ins.conclusion)}`);
    }
    for (const k of ['slope', 'clearWidth'] as const) {
      if (!isBlank(ins[k]) && (typeof ins[k] !== 'number' || Number.isNaN(ins[k]))) {
        throw new BatchValidationError(`${ctx}（${ins.code}）${k === 'slope' ? '坡度' : '净宽'}必须是数字`);
      }
    }
    // 同一人同日同点位在批次内只允许一条
    const key = `${ins.code}|${ins.date}|${ins.inspector.trim()}`;
    if (dedupKeys.has(key)) {
      throw new BatchValidationError(
        `${ctx}：同一核验人「${ins.inspector}」在 ${ins.date} 对 ${ins.code} 的核验在批次内重复`,
      );
    }
    dedupKeys.add(key);
  });

  rectifies.forEach((r, i) => {
    const ctx = `整改 #${i + 1}`;
    if (isBlank(r.code)) throw new BatchValidationError(`${ctx} 缺少点位编号 code`);
    if (!isBlank(r.status) && !RECTIFY_STATUS.includes(r.status as RectifyStatus)) {
      throw new BatchValidationError(`${ctx}（${r.code}）整改状态非法：${fmt(r.status)}`);
    }
    if (!isBlank(r.deadline)) assertDate(r.deadline, `${ctx}（${r.code}）整改期限`);
    if (!isBlank(r.recheckDate)) assertDate(r.recheckDate, `${ctx}（${r.code}）复检日期`);
    if (isBlank(r.status) && isBlank(r.requirement) && isBlank(r.recheckDate) && isBlank(r.deadline)) {
      throw new BatchValidationError(`${ctx}（${r.code}）整改条目没有任何可合并内容`);
    }
  });

  return {
    batchId: b.batchId!.trim(),
    formatVersion: b.formatVersion,
    inspector: typeof b.inspector === 'string' ? b.inspector : '',
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
    syncedAt: typeof b.syncedAt === 'string' ? b.syncedAt : '',
    points,
    inspections,
    rectifies,
  };
}

/** 整改条目的有效时间：复检日期（业务事实）优先，其次更新时间，最后期限 */
function rectifyEffectiveTs(updatedAt: string | undefined, recheckDate: string | undefined, deadline: string | undefined): number {
  if (recheckDate) {
    const t = Date.parse(`${recheckDate}T23:59:59`);
    if (!Number.isNaN(t)) return t;
  }
  // 只有更新时间晚于创建时刻才算一次真实更新（种子数据仅含 createdAt）
  if (updatedAt) {
    const t = Date.parse(updatedAt);
    if (!Number.isNaN(t) && t > 0) return t;
  }
  if (deadline) {
    const t = Date.parse(`${deadline}T00:00:00`);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function incomingRectifyLater(br: BatchRectify, target: RectifyPlan): boolean {
  const tIn = rectifyEffectiveTs(br.updatedAt, br.recheckDate, br.deadline);
  const tCur = rectifyEffectiveTs(target.updatedAt, target.recheckDate, target.deadline);
  return tIn > tCur;
}

/**
 * 点位相关整改重算：最新核验不合格且没有在跟条目 → 补建；
 * 最新核验合格 → 自动关闭仍在整改的旧条目（复检日期回填为核验日期）。
 */
function syncRectifiesForPoint(
  pointId: string,
  inspections: Inspection[],
  rectifies: RectifyPlan[],
  now: string,
): { next: RectifyPlan[]; created: number; changed: number } {
  const mine = rectifies.filter((r) => r.pointId === pointId);
  const others = rectifies.filter((r) => r.pointId !== pointId);
  const conclusionRank: Record<InspectionConclusion, number> = {
    不合格: 0,
    限期整改: 1,
    合格: 2,
  };
  // 最新一次核验：日期最新优先；同一天既有合格又有不合格时，问题未消除的结论优先
  const latest = inspections
    .filter((x) => x.pointId === pointId)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return conclusionRank[a.conclusion] - conclusionRank[b.conclusion];
    })[0];

  let created = 0;
  let changed = 0;
  let next = [...mine];

  if (latest && latest.conclusion === '不合格') {
    if (!next.some((r) => r.status !== '已整改')) {
      next.push({
        id: makeId('rct'),
        pointId,
        requirement: `按 ${latest.date} 核验结论整改：${latest.problem || '坡度、净宽或占用问题'}`,
        unit: '待指派责任单位',
        deadline: todayStr(),
        recheckDate: '',
        status: '待整改',
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
  } else if (latest && latest.conclusion === '合格') {
    next = next.map((r) => {
      if (r.status !== '待整改') return r;
      changed += 1;
      return { ...r, status: '已整改', recheckDate: r.recheckDate || latest.date, updatedAt: now };
    });
  }
  return { next: [...others, ...next], created, changed };
}

function emptyStats(): MergeStats {
  return {
    pointsAdded: 0,
    pointsUpdated: 0,
    conflicts: 0,
    inspectionsAdded: 0,
    inspectionsDeduped: 0,
    rectifiesAdded: 0,
    rectifiesUpdated: 0,
    rectifiesAutoCreated: 0,
    rectifiesRecomputed: 0,
    routesRecomputed: 0,
    affectedPointIds: [],
  };
}

/**
 * 合并一个已校验批次。整批在单个 rw 事务内执行：
 * 任一步失败都会随事务回滚撤回整批，不会留下半截数据，修正后可重试。
 */
export async function mergeBatch(batch: OfflineBatch): Promise<MergeStats> {
  const dup = await db.batches.where('batchId').equals(batch.batchId).first();
  if (dup && dup.status === '已合并') {
    throw new BatchValidationError(`批次 ${batch.batchId} 已成功合并过，不能重复导入；请使用新批次号`);
  }

  const stats = emptyStats();
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.points, db.inspections, db.rectifies, db.routes, db.conflicts, db.batches],
    async () => {
      const points = await db.points.toArray();
      const inspections = await db.inspections.toArray();
      let rectifies = await db.rectifies.toArray();
      const routes = await db.routes.toArray();
      const openConflicts = await db.conflicts.filter((c) => !c.resolved).toArray();

      const byCode = new Map<string, AccessPoint>(points.map((p) => [p.code, p]));
      const touched = new Set<string>();

      // ---------- 1. 点位：以台账为准，双方都改过列待核对，不用现场值覆盖 ----------
      for (const bp of batch.points ?? []) {
        const ledger = byCode.get(bp.code);

        if (!ledger) {
          // 台账没有 → 新点位，现场值直接登记
          const point: AccessPoint = {
            id: makeId('pt'),
            code: bp.code,
            name: isBlank(bp.name) ? `新登记点位 ${bp.code}` : String(bp.name),
            facilityType: (isBlank(bp.facilityType)
              ? '缘石坡道'
              : String(bp.facilityType)) as AccessPoint['facilityType'],
            lng: isBlank(bp.lng) ? 116.4183 : Number(bp.lng),
            lat: isBlank(bp.lat) ? 39.9142 : Number(bp.lat),
            district: isBlank(bp.district) ? '东城区' : String(bp.district),
            location: bp.location ? String(bp.location) : '',
            builtYear: isBlank(bp.builtYear) ? new Date().getFullYear() : Number(bp.builtYear),
            maintainUnit: isBlank(bp.maintainUnit) ? '城管委设施科' : String(bp.maintainUnit),
            createdAt: now,
            updatedAt: now,
            batchId: batch.batchId,
          };
          points.push(point);
          byCode.set(point.code, point);
          stats.pointsAdded += 1;
          touched.add(point.id);
          continue;
        }

        // 台账已有该编号：判定双方是否都改过
        const siteChanged = Boolean(bp.updatedAt);
        // 缺 syncedAt 时保守认为台账可能已动过；客户端显式标记 bothChanged 时直接认定双方分叉
        const ledgerChanged = bp.bothChanged === true
          ? true
          : batch.syncedAt
            ? ledger.updatedAt > batch.syncedAt
            : true;

        const diffs: FieldDiff[] = [];
        const batchPoint = bp as unknown as Record<string, unknown>;
        for (const f of POINT_FIELDS) {
          const raw = batchPoint[f.key];
          if (isBlank(raw)) continue;
          const siteVal: string | number = f.key === 'lng' || f.key === 'lat' || f.key === 'builtYear'
            ? Number(raw)
            : String(raw);
          const ledgerVal = ledger[f.key];
          const same =
            typeof siteVal === 'number' && typeof ledgerVal === 'number'
              ? Math.abs(siteVal - ledgerVal) < 1e-9
              : String(siteVal) === String(ledgerVal);
          if (!same) {
            diffs.push({ field: f.key, fieldLabel: f.label, ledger: fmt(ledgerVal), site: fmt(siteVal) });
          }
        }

        if (diffs.length && siteChanged && ledgerChanged) {
          // 双方都改过 → 列待核对，保留台账值，绝不用现场值覆盖
          const already = openConflicts.some(
            (c) => c.pointId === ledger.id && c.fields.some((d) => diffs.some((x) => x.field === d.field)),
          );
          if (!already) {
            const conflictRow: PendingConflict = {
              id: makeId('cfl'),
              batchId: batch.batchId,
              pointId: ledger.id,
              code: ledger.code,
              pointName: ledger.name,
              fields: diffs,
              detectedAt: now,
              resolved: false,
            };
            await db.conflicts.put(conflictRow);
            stats.conflicts += 1;
          }
        } else if (diffs.length && !ledgerChanged) {
          // 仅现场改过、台账自同步后没动 → 回填现场值
          const target = ledger as unknown as Record<string, unknown>;
          for (const d of diffs) {
            const raw = batchPoint[d.field];
            if (d.field === 'lng' || d.field === 'lat' || d.field === 'builtYear') {
              target[d.field] = Number(raw);
            } else {
              target[d.field] = String(raw);
            }
          }
          ledger.updatedAt = now;
          stats.pointsUpdated += 1;
        }
        // 旧记录补上批次身份，继续参与统计
        if (!ledger.batchId) ledger.batchId = batch.batchId;
        touched.add(ledger.id);
      }

      const codeToId = new Map<string, string>();
      byCode.forEach((p, code) => codeToId.set(code, p.id));
      await db.points.bulkPut(points);

      // ---------- 2. 核验：同一人同日去重 ----------
      const seenKeys = new Set(
        inspections.map((i) => `${i.pointId}|${i.date}|${i.inspector.trim()}`),
      );
      const incoming = [...(batch.inspections ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1));

      for (const bi of incoming) {
        const pointId = codeToId.get(bi.code);
        if (!pointId) {
          throw new BatchValidationError(`核验记录引用了批次 / 台账中都不存在的点位编号：${bi.code}`);
        }
        const key = `${pointId}|${bi.date}|${bi.inspector.trim()}`;
        if (seenKeys.has(key)) {
          // 同一人同日核验重复 → 丢弃现场记录，仅给旧记录补批次身份
          stats.inspectionsDeduped += 1;
          const old = inspections.find(
            (i) => i.pointId === pointId && i.date === bi.date && i.inspector.trim() === bi.inspector.trim(),
          );
          if (old && !old.batchId) {
            old.batchId = batch.batchId;
            await db.inspections.put(old);
          }
          touched.add(pointId);
          continue;
        }
        seenKeys.add(key);

        const slope = isBlank(bi.slope) ? 0 : Number(bi.slope);
        const clearWidth = isBlank(bi.clearWidth) ? 0 : Number(bi.clearWidth);
        const occupied = (isBlank(bi.occupied) ? '无' : bi.occupied) as OccupiedLevel;
        const judged = judgeInspection({
          slope,
          clearWidth,
          hasHandrail: bi.hasHandrail ?? true,
          tactileContinuous: bi.tactileContinuous ?? true,
          occupied,
        });
        const conclusion =
          bi.conclusion && CONCLUSIONS.includes(bi.conclusion as InspectionConclusion)
            ? (bi.conclusion as InspectionConclusion)
            : judged.conclusion;

        inspections.push({
          id: makeId('ins'),
          pointId,
          date: bi.date,
          inspector: bi.inspector.trim(),
          slope,
          clearWidth,
          hasHandrail: bi.hasHandrail ?? true,
          tactileContinuous: bi.tactileContinuous ?? true,
          occupied,
          conclusion,
          problem: bi.problem ? String(bi.problem) : '',
          createdAt: now,
          batchId: batch.batchId,
        });
        stats.inspectionsAdded += 1;
        touched.add(pointId);
      }
      await db.inspections.bulkPut(inspections);

      // ---------- 3. 整改：按更新时间与复检日期取更晚的有效值 ----------
      for (const br of batch.rectifies ?? []) {
        const pointId = codeToId.get(br.code);
        if (!pointId) {
          throw new BatchValidationError(`整改记录引用了批次 / 台账中都不存在的点位编号：${br.code}`);
        }
        const target =
          rectifies.find((r) => r.pointId === pointId && r.status !== '已整改') ??
          rectifies.find((r) => r.pointId === pointId);

        if (!target) {
          rectifies.push({
            id: makeId('rct'),
            pointId,
            requirement: br.requirement
              ? String(br.requirement)
              : `离线批次 ${batch.batchId} 登记的整改要求`,
            unit: br.unit ? String(br.unit) : '待指派责任单位',
            deadline: br.deadline ?? todayStr(),
            recheckDate: br.recheckDate ?? '',
            status: (isBlank(br.status) ? '待整改' : br.status) as RectifyStatus,
            createdAt: now,
            updatedAt: br.updatedAt ?? now,
            batchId: batch.batchId,
          });
          stats.rectifiesAdded += 1;
          touched.add(pointId);
          continue;
        }

        if (incomingRectifyLater(br, target)) {
          // 现场更晚 → 逐字段取现场有效值（空值不回清空台账值）
          if (!isBlank(br.status)) target.status = br.status as RectifyStatus;
          if (!isBlank(br.requirement)) target.requirement = String(br.requirement);
          if (!isBlank(br.unit)) target.unit = String(br.unit);
          if (!isBlank(br.deadline)) target.deadline = br.deadline!;
          if (!isBlank(br.recheckDate)) target.recheckDate = br.recheckDate!;
          target.updatedAt = br.updatedAt ?? now;
          stats.rectifiesUpdated += 1;
        }
        // 台账更晚 → 保留台账有效值。无论哪种都给旧记录补批次身份
        if (!target.batchId) target.batchId = batch.batchId;
        touched.add(pointId);
      }

      // ---------- 4. 点位或核验一变，相关整改重算 ----------
      for (const pid of touched) {
        const result = syncRectifiesForPoint(pid, inspections, rectifies, now);
        rectifies = result.next;
        if (result.created) {
          stats.rectifiesAdded += result.created;
          stats.rectifiesAutoCreated += result.created;
        }
      }
      stats.rectifiesRecomputed = rectifies.filter((r) => touched.has(r.pointId)).length;
      await db.rectifies.bulkPut(rectifies);

      // ---------- 5. 点位坐标一变，相关路线长度与通行判定重算 ----------
      const pointById = new Map(points.map((p) => [p.id, p]));
      const nextRoutes = routes.map((seg) => {
        if (!touched.has(seg.fromPointId) && !touched.has(seg.toPointId)) return seg;
        const from = pointById.get(seg.fromPointId);
        const to = pointById.get(seg.toPointId);
        if (!from || !to) return seg;
        const length = segmentLength({ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat });
        const passable = judgeSegment({
          curbHeight: seg.curbHeight,
          stepCount: seg.stepCount,
          obstacleCount: seg.obstacleCount,
        }).passable;
        if (Math.abs(length - seg.length) > 0.05 || passable !== seg.wheelchairPassable) {
          stats.routesRecomputed += 1;
        }
        return { ...seg, length, wheelchairPassable: passable };
      });
      await db.routes.bulkPut(nextRoutes);

      stats.affectedPointIds = [...touched];

      // ---------- 6. 批次登记（成功才落库；失败由调用方登记为「失败」） ----------
      await db.batches.put({
        id: makeId('bat'),
        batchId: batch.batchId,
        inspector: batch.inspector ?? '',
        exportedAt: batch.exportedAt ?? '',
        mergedAt: now,
        status: '已合并',
        message: '',
        pointCount: (batch.points ?? []).length,
        inspectionCount: (batch.inspections ?? []).length,
        rectifyCount: (batch.rectifies ?? []).length,
        conflictCount: stats.conflicts,
      });
    },
  );

  return stats;
}

/** 校验 / 合并失败时登记一条「失败」批次，保留错误信息以便核对后重试 */
export async function recordBatchFailure(batch: OfflineBatch, message: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batches.put({
    id: makeId('bat'),
    batchId: batch.batchId,
    inspector: batch.inspector ?? '',
    exportedAt: batch.exportedAt ?? '',
    mergedAt: now,
    status: '失败',
    message,
    pointCount: (batch.points ?? []).length,
    inspectionCount: (batch.inspections ?? []).length,
    rectifyCount: (batch.rectifies ?? []).length,
    conflictCount: 0,
  });
}

/** 待核对处理：保留台账值（仅标记）或采用现场值（逐字段写回点位） */
export async function resolveConflict(
  conflictId: string,
  pick: 'ledger' | 'site',
): Promise<void> {
  const conflict = await db.conflicts.get(conflictId);
  if (!conflict || conflict.resolved) return;
  const now = new Date().toISOString();
  if (pick === 'site') {
    const point = await db.points.get(conflict.pointId);
    if (point) {
      for (const d of conflict.fields) {
        const target = point as unknown as Record<string, unknown>;
        if (d.field === 'lng' || d.field === 'lat' || d.field === 'builtYear') {
          target[d.field] = Number(d.site);
        } else {
          target[d.field] = d.site;
        }
      }
      point.updatedAt = now;
      await db.points.put(point);
      // 点位属性变化后，相关路段的长度与通行判定一并重算
      const [routes, allPoints] = await Promise.all([db.routes.toArray(), db.points.toArray()]);
      const pointById = new Map(allPoints.map((p) => [p.id, p]));
      const fixed = routes.map((seg) => {
        if (seg.fromPointId !== point.id && seg.toPointId !== point.id) return seg;
        const a = pointById.get(seg.fromPointId);
        const b = pointById.get(seg.toPointId);
        if (!a || !b) return seg;
        return {
          ...seg,
          length: segmentLength({ lng: a.lng, lat: a.lat }, { lng: b.lng, lat: b.lat }),
          wheelchairPassable: judgeSegment({
            curbHeight: seg.curbHeight,
            stepCount: seg.stepCount,
            obstacleCount: seg.obstacleCount,
          }).passable,
        };
      });
      await db.routes.bulkPut(fixed);
    }
  }
  await db.conflicts.update(conflictId, { resolved: true });
}
