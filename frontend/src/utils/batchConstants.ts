/**
 * 批次身份常量。
 * 台账批次（ledger）承载历史数据与交互式登记数据，是「台账为准」的权威来源；
 * 离线导入批次各自保留独立身份，合并后继续参与统计。
 */
export const LEDGER_BATCH_ID = 'batch-ledger';

/** 点位属性比对字段（code 是身份标识，不参与比对） */
export const POINT_COMPARE_FIELDS = [
  'name',
  'facilityType',
  'lng',
  'lat',
  'district',
  'location',
  'builtYear',
  'maintainUnit',
] as const;
