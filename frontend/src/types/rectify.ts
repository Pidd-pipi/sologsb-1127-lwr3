/** 整改状态 */
export type RectifyStatus = '待整改' | '已整改' | '复发';

export const RECTIFY_STATUSES: RectifyStatus[] = ['待整改', '已整改', '复发'];

/** 整改跟踪条目 */
export interface RectifyPlan {
  id: string;
  pointId: string;
  /** 整改要求 */
  requirement: string;
  /** 责任单位 */
  unit: string;
  /** 整改期限 YYYY-MM-DD */
  deadline: string;
  /** 复检日期 YYYY-MM-DD，未复检为空字符串 */
  recheckDate: string;
  status: RectifyStatus;
  createdAt: string;
  /** 最近一次状态/内容更新时间（与复检日期共同决定整改状态裁定） */
  updatedAt: string;
  /** 批次身份：台账批次或离线导入批次 id */
  batchId: string;
}

export type RectifyPlanDraft = Omit<RectifyPlan, 'id' | 'createdAt' | 'updatedAt' | 'batchId'>;

/** 按状态与期限分组后的清单结构 */
export interface RectifyGroup {
  key: string;
  title: string;
  items: RectifyPlan[];
}
