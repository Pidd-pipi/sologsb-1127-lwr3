import type { AccessPoint } from './point';
import type { Inspection } from './inspection';
import type { RectifyPlan, RectifyStatus } from './rectify';

/** 批次状态 */
export type BatchStatus = 'pending' | 'merged' | 'failed' | 'withdrawn';

/** 批次来源：离线登记 / 台账（历史补录或交互式登记） */
export type BatchSource = 'offline' | 'ledger';

/**
 * 离线登记批次：核验员在现场离线录入，回到内网后整体合并进台账。
 * 合并前以批次为单位暂存，校验失败则整批撤回、可重试。
 */
export interface OfflineBatch {
  id: string;
  /** 批次编号，例 BATCH-2025-001 */
  code: string;
  source: BatchSource;
  status: BatchStatus;
  /** 登记人 / 核验员 */
  registrar: string;
  note: string;
  /** 离线登记的原始载荷（JSON 字符串），用于失败后重试 */
  rawInput: string;
  /** 失败原因（status=failed 时有值） */
  failReason: string;
  createdAt: string;
  mergedAt: string;
}

/** 点位属性冲突（台账与现场都改过同一属性），列入待核对，不用现场值覆盖 */
export interface PointConflict {
  id: string;
  batchId: string;
  /** 台账点位 id */
  pointId: string;
  pointCode: string;
  pointName: string;
  /** 现场（离线）主张的属性值 */
  fieldValues: Partial<AccessPoint>;
  /** 台账当前值快照 */
  ledgerValues: Partial<AccessPoint>;
  status: 'pending' | 'resolved';
  createdAt: string;
}

/** 合并后的整改条目（用于回写） */
export type MergedRectify = RectifyPlan;

/** 整改状态裁定结果 */
export interface RectifyVerdict {
  status: RectifyStatus;
  recheckDate: string;
  requirement: string;
}

/** 校验错误：定位到批次内第几条记录的哪个字段 */
export interface ValidationIssue {
  kind: 'point' | 'inspection' | 'rectify' | 'batch';
  index: number;
  field: string;
  message: string;
}

/** 合并统计报告 */
export interface MergeReport {
  batchCode: string;
  pointsTotal: number;
  pointsNew: number;
  pointsConflict: number;
  inspectionsTotal: number;
  inspectionsNew: number;
  inspectionsDeduped: number;
  rectifiesTotal: number;
  rectifiesNew: number;
  rectifiesUpdated: number;
  routesRecalculated: number;
}

/** 纯合并计划：由 merge 引擎产出，提交阶段事务化落库 */
export interface MergePlan {
  newPoints: AccessPoint[];
  conflicts: PointConflict[];
  newInspections: Inspection[];
  newRectifies: RectifyPlan[];
  updatedRectifies: { id: string; patch: Partial<RectifyPlan> }[];
  recalculatedSegments: { id: string; patch: { length: number; wheelchairPassable: boolean } }[];
  report: MergeReport;
}
