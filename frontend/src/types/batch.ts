/** 离线批次：核验员在外网登记，回到内网后整体合并 */

/** 点位的台账属性（以台账为准，现场实测值不进该结构） */
export interface BatchPoint {
  /** 点位编号，与台账编号一致时按既有点位合并 */
  code: string;
  name?: string;
  facilityType?: string;
  lng?: number;
  lat?: number;
  district?: string;
  location?: string;
  builtYear?: number;
  maintainUnit?: string;
  /** 现场最后修改时间 ISO，用于判定双方是否都改过 */
  updatedAt?: string;
  /**
   * 离线端标记：现场与台账分别改过同一点位（客户端已检测到分叉）。
   * 合并时直接列入待核对，不再仅凭 syncedAt 推断台账侧是否变更。
   */
  bothChanged?: boolean;
}

/** 离线核验记录（实测值） */
export interface BatchInspection {
  /** 目标点位编号（按编号关联，不直接信任内网 id） */
  code: string;
  date: string;
  inspector: string;
  slope?: number;
  clearWidth?: number;
  hasHandrail?: boolean;
  tactileContinuous?: boolean;
  occupied?: string;
  /** 离线端给出的结论，留空时由内网按阈值重判 */
  conclusion?: string;
  problem?: string;
  clientId?: string;
}

/** 离线整改跟踪 */
export interface BatchRectify {
  /** 目标点位编号 */
  code: string;
  requirement?: string;
  unit?: string;
  deadline?: string;
  recheckDate?: string;
  status?: string;
  /** 现场最后更新时间 ISO，与复检日期一起取更晚的有效值 */
  updatedAt?: string;
  clientId?: string;
}

/** 离线批次文件结构 */
export interface OfflineBatch {
  /** 批次号，同一批次重复合并会被拒绝 */
  batchId: string;
  /** 离线端导出版本 */
  formatVersion?: number;
  /** 核验员 */
  inspector?: string;
  /** 导出时间 ISO */
  exportedAt?: string;
  /**
   * 离线端最近一次与内网同步的时间 ISO。
   * 台账属性在该时间之后又被内网改过、且现场也改过 → 双方都改过，列待核对。
   */
  syncedAt?: string;
  points?: BatchPoint[];
  inspections?: BatchInspection[];
  rectifies?: BatchRectify[];
}

export type BatchEntityKind = '点位' | '核验' | '整改';
export type BatchMergeStatus = '已合并' | '失败';

/** 批次合并登记（batches 表） */
export interface BatchRecord {
  id: string;
  batchId: string;
  inspector: string;
  exportedAt: string;
  mergedAt: string;
  status: BatchMergeStatus;
  /** 失败原因（校验失败时记录，批次内容仍保留在输入框供重试） */
  message: string;
  pointCount: number;
  inspectionCount: number;
  rectifyCount: number;
  /** 本次产生的待核对条目数 */
  conflictCount: number;
}

/** 属性差异（待核对） */
export interface FieldDiff {
  field: string;
  fieldLabel: string;
  /** 台账值（内网当前值） */
  ledger: string;
  /** 现场值（离线批次带来的值） */
  site: string;
}

/** 点位属性双方都改过的待核对条目（conflicts 表） */
export interface PendingConflict {
  id: string;
  batchId: string;
  pointId: string;
  code: string;
  pointName: string;
  /** [{ field, fieldLabel, ledger, field }] 台账值 / 现场值 */
  fields: FieldDiff[];
  detectedAt: string;
  resolved: boolean;
}

/** 合并结果统计 */
export interface MergeStats {
  pointsAdded: number;
  pointsUpdated: number;
  conflicts: number;
  inspectionsAdded: number;
  inspectionsDeduped: number;
  rectifiesAdded: number;
  rectifiesUpdated: number;
  /** 核验结论触发自动补建的整改条目数（含在 rectifiesAdded 内） */
  rectifiesAutoCreated: number;
  /** 点位 / 核验变化后重算的整改条目数 */
  rectifiesRecomputed: number;
  /** 受点位坐标变化影响、重算长度与判定的路段数 */
  routesRecomputed: number;
  affectedPointIds: string[];
}
