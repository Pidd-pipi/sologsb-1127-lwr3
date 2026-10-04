import type { OfflineBatch } from '../types/batch';
import { addDays, todayStr } from './format';

/**
 * 生成一份「核验员离线登记」的演示批次。
 * 覆盖：新点位、台账未动时回填、双方都改过待核对、同人同日去重、
 * 整改按更新时间取更晚有效值、最新核验合格自动关闭整改、坐标变化触发路线重算。
 *
 * syncedAt 取当前时间之后，保证既有台账记录的 updatedAt（建库时间早于现在）
 * 都被视为「同步后台账没动过」，从而能演示非冲突回填；而 pt-1004 现场与台账
 * 同时改（通过把 syncedAt 设得很早来模拟）。
 */
export function buildSampleBatch(): OfflineBatch {
  const today = todayStr();
  return {
    batchId: `OFF-${today.split('-').join('')}-01`,
    formatVersion: 1,
    inspector: '督导员 李维',
    exportedAt: new Date().toISOString(),
    // 设为遥远未来：除显式冲突点外，台账属性都算「同步后没动」，现场值直接回填
    syncedAt: addDays(today, 1),
    points: [
      {
        // 台账中没有的全新点位
        code: 'WZ-2026-X01',
        name: '广渠门内大街轮椅坡道',
        facilityType: '轮椅坡道',
        lng: 116.4385,
        lat: 39.8933,
        district: '东城区',
        location: '广渠门内大街 21 号路口',
        builtYear: 2022,
        maintainUnit: '市政道路养护二所',
        updatedAt: new Date().toISOString(),
      },
      {
        // 台账已有，台账同步后没动 → 现场维护单位回填
        code: 'WZ-2024-001',
        maintainUnit: '市政道路养护二所',
        updatedAt: new Date().toISOString(),
      },
      {
        // 双方都改过 → 列待核对，保留台账值（现场改名与坐标差异不覆盖台账）
        code: 'WZ-2024-004',
        name: '朝阳公园南门轮椅坡道（现场复核改名）',
        lng: 116.4749,
        updatedAt: new Date().toISOString(),
        bothChanged: true,
      },
    ],
    inspections: [
      {
        // 新点位首次核验：合格
        code: 'WZ-2026-X01',
        date: today,
        inspector: '督导员 李维',
        slope: 3.1,
        clearWidth: 140,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        problem: '',
      },
      {
        // 对 pt-1002（限期整改）复检合格 → 应自动关闭其待整改条目
        code: 'WZ-2024-002',
        date: today,
        inspector: '督导员 王岚',
        slope: 2.0,
        clearWidth: 132,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        problem: '路口断开盲道已补齐',
      },
      {
        // pt-1007 现场复检合格，与现场整改「已整改」闭环
        code: 'WZ-2024-007',
        date: addDays(today, -1),
        inspector: '督导员 王岚',
        slope: 4.4,
        clearWidth: 122,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        problem: '商铺货架已清退，坡道重做后复测达标',
      },
      {
        // 与种子数据同人同日重复（pt-1001 / 2025-03-12 / 督导员 李维）→ 去重
        code: 'WZ-2024-001',
        date: '2025-03-12',
        inspector: '督导员 李维',
        slope: 3.4,
        clearWidth: 148,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        problem: '重复登记的一次核验，应被去重',
      },
    ],
    rectifies: [
      {
        // pt-1004：现场更新时间更早 → 保留台账有效值
        code: 'WZ-2024-004',
        status: '已整改',
        recheckDate: addDays(today, -2),
        requirement: '现场已划设禁停区并复测净宽 125cm',
        updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      },
      {
        // pt-1007：现场更新时间最新（带复检日期）→ 采用现场「已整改」
        code: 'WZ-2024-007',
        status: '已整改',
        recheckDate: addDays(today, -1),
        requirement: '商铺货架已清退，坡道重做完成，复测净宽 122cm、坡度 4.4%',
        unit: '市政道路养护一所',
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}

/** 一份故意校验失败的批次（枚举非法 + 引用不存在点位），用于演示整批撤回与重试 */
export function buildInvalidBatch(): OfflineBatch {
  return {
    batchId: `OFF-BAD-${Date.now().toString(36)}`,
    formatVersion: 1,
    inspector: '督导员 测试',
    exportedAt: new Date().toISOString(),
    syncedAt: '',
    points: [
      {
        code: 'WZ-2026-BAD',
        name: '非法设施类型点位',
        facilityType: '滑梯',
        district: '东城区',
        updatedAt: new Date().toISOString(),
      },
    ],
    inspections: [
      {
        code: 'WZ-9999-NOT-EXIST',
        date: todayStr(),
        inspector: '督导员 测试',
        slope: 2,
        clearWidth: 140,
        occupied: '无',
      },
    ],
    rectifies: [],
  };
}
