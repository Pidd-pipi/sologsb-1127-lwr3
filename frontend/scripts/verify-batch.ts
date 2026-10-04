/**
 * 离线批次合并端到端验证。
 * 运行：node --import tsx --require ./scripts/_setup-fake-idb.cjs scripts/verify-batch.ts
 */
import assert from 'node:assert/strict';
import { db, ensureSeed } from '../src/db';
import { parseBatch, mergeBatch, BatchValidationError, recordBatchFailure, resolveConflict } from '../src/utils/batchMerge';
import { segmentLength } from '../src/utils/geo';

async function snapshot() {
  const [points, inspections, rectifies, routes, batches, conflicts] = await Promise.all([
    db.points.toArray(),
    db.inspections.toArray(),
    db.rectifies.toArray(),
    db.routes.toArray(),
    db.batches.toArray(),
    db.conflicts.toArray(),
  ]);
  return { points, inspections, rectifies, routes, batches, conflicts };
}

async function main() {
  await ensureSeed();
  const before = await snapshot();
  assert.equal(before.points.length, 8, '种子点位 8 个');
  assert.equal(before.inspections.length, 8, '种子核验 8 条');
  assert.equal(before.rectifies.length, 4, '种子整改 4 条');
  assert.equal(before.routes.length, 1, '种子路段 1 条');

  // ---------- 1. 校验失败 → 整批撤回 + 失败登记，可重试 ----------
  const bad = JSON.stringify({
    batchId: 'BAD-1',
    points: [{ code: 'WZ-BAD', facilityType: '滑梯' }],
    inspections: [],
    rectifies: [],
  });
  await assert.rejects(
    async () => {
      const parsed = parseBatch(bad);
      await recordBatchFailure(parsed, '（不会执行：解析即失败）');
      await mergeBatch(parsed);
    },
    (e: unknown) => e instanceof BatchValidationError,
    '非法枚举应校验失败',
  );
  let snap = await snapshot();
  assert.equal(snap.points.length, 8, '失败后点位数不变（整批撤回）');
  // 页面流程在 catch 中登记失败批次（登记时批次已通过解析；此处记录等价的失败登记）
  await recordBatchFailure(
    { batchId: 'BAD-1', points: [{ code: 'WZ-BAD' }], inspections: [], rectifies: [] },
    '点位 #1（WZ-BAD）设施类型不在台账枚举：滑梯',
  );
  snap = await snapshot();
  assert.equal(snap.batches.length, 1);
  assert.equal(snap.batches[0].status, '失败');
  assert.ok(snap.batches[0].message.length > 0, '失败原因保留');

  // 修正批次后用新批次号重试 → 成功
  const fixed = JSON.stringify({
    batchId: 'BAD-1-FIXED',
    points: [{ code: 'WZ-BAD', name: '补录点位', facilityType: '盲道', district: '东城区' }],
    inspections: [],
    rectifies: [],
  });
  const fixedStats = await mergeBatch(parseBatch(fixed));
  assert.equal(fixedStats.pointsAdded, 1, '重试成功：新增 1 点位');

  // ---------- 2. 主批次：一次贴入点位 / 核验 / 整改 ----------
  const today = new Date().toISOString().slice(0, 10);
  const batch = {
    batchId: 'OFF-MAIN-1',
    inspector: '督导员 李维',
    exportedAt: new Date().toISOString(),
    syncedAt: new Date(Date.now() + 86400000).toISOString(),
    points: [
      // 全新点位
      {
        code: 'WZ-NEW-1',
        name: '广渠门坡道',
        facilityType: '轮椅坡道',
        lng: 116.4385,
        lat: 39.8933,
        district: '东城区',
        builtYear: 2022,
        maintainUnit: '市政道路养护二所',
        updatedAt: new Date().toISOString(),
      },
      // 台账已有、台账未动 → 回填养护单位
      { code: 'WZ-2024-001', maintainUnit: '市政道路养护二所', updatedAt: new Date().toISOString() },
      // 双方都改过 → 待核对，台账值保留
      {
        code: 'WZ-2024-004',
        name: '现场改名不应覆盖',
        bothChanged: true,
        updatedAt: new Date().toISOString(),
      },
    ],
    inspections: [
      // 新点位合格核验
      {
        code: 'WZ-NEW-1',
        date: today,
        inspector: '督导员 李维',
        slope: 3.1,
        clearWidth: 140,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
      },
      // pt-1002 最新核验合格 → 自动关闭其待整改
      {
        code: 'WZ-2024-002',
        date: today,
        inspector: '督导员 王岚',
        slope: 2,
        clearWidth: 132,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
      },
      // pt-1007 现场复检合格核验 → 与现场整改「已整改」一致，自动关闭且不再补建
      {
        code: 'WZ-2024-007',
        date: today,
        inspector: '督导员 王岚',
        slope: 4.4,
        clearWidth: 122,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
      },
      // 与种子记录同人同日重复（pt-1001 / 2025-03-12 / 李维）→ 去重
      {
        code: 'WZ-2024-001',
        date: '2025-03-12',
        inspector: '督导员 李维',
        slope: 9,
        clearWidth: 80,
        occupied: '无',
      },
      // 批次内同人同日两条 → 校验阶段直接失败
    ],
    rectifies: [
      // pt-1007：现场更新更晚且已整改 → 采用现场值
      {
        code: 'WZ-2024-007',
        status: '已整改',
        recheckDate: today,
        requirement: '现场复测达标',
        updatedAt: new Date().toISOString(),
      },
      // pt-1004：现场时间更早 → 保留台账（待整改，期限 18 天后）
      {
        code: 'WZ-2024-004',
        status: '已整改',
        recheckDate: '2020-01-01',
        updatedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      },
    ],
  };

  const stats = await mergeBatch(parseBatch(JSON.stringify(batch)));
  assert.equal(stats.pointsAdded, 1, '新增点位 1');
  assert.equal(stats.pointsUpdated, 1, '回填点位 1（pt-1001 养护单位）');
  assert.equal(stats.conflicts, 1, '双方修改 → 1 条待核对');
  assert.equal(stats.inspectionsAdded, 3, '新增核验 3');
  assert.equal(stats.inspectionsDeduped, 1, '同人同日去重 1');
  assert.ok(stats.rectifiesUpdated >= 1, '整改更新（pt-1007）');
  assert.ok(stats.rectifiesRecomputed >= 1, '整改重算');

  snap = await snapshot();

  // 点位断言
  const p1001 = snap.points.find((p) => p.code === 'WZ-2024-001')!;
  assert.equal(p1001.maintainUnit, '市政道路养护二所', '台账未动 → 现场值回填');
  assert.ok(p1001.batchId, '旧点位补上批次身份');
  const p1004 = snap.points.find((p) => p.code === 'WZ-2024-004')!;
  assert.notEqual(p1004.name, '现场改名不应覆盖', '冲突点不用现场值覆盖台账');
  const newPoint = snap.points.find((p) => p.code === 'WZ-NEW-1')!;
  assert.equal(newPoint.batchId, 'OFF-MAIN-1');

  // 待核对断言
  assert.equal(snap.conflicts.filter((c) => !c.resolved).length, 1);
  assert.equal(snap.conflicts[0].pointId, p1004.id);
  assert.deepEqual(
    snap.conflicts[0].fields.map((f) => f.field),
    ['name'],
  );

  // 核验断言：总数 = 8 种子 + 3
  assert.equal(snap.inspections.length, 11, '核验总数 8+3（重复的 1 条被去重）');
  const deduped = snap.inspections.find(
    (i) => i.pointId === p1001.id && i.date === '2025-03-12',
  )!;
  assert.equal(deduped.slope, 3.2, '去重保留旧记录值，不被现场值覆盖');
  assert.ok(deduped.batchId, '旧核验补上批次身份');

  // 整改断言
  const r1007all = snap.rectifies.filter((r) => r.pointId === 'pt-1007');
  assert.ok(r1007all.some((r) => r.status === '已整改'), '现场更晚 → 采用现场已整改');
  assert.ok(
    !r1007all.some((r) => r.status !== '已整改'),
    '同批次带回合格复检核验 → 不再补建待整改',
  );
  const r1004 = snap.rectifies.find((r) => r.pointId === 'pt-1004')!;
  assert.equal(r1004.status, '待整改', '现场更早 → 保留台账状态');
  const r1002 = snap.rectifies.find((r) => r.pointId === 'pt-1002')!;
  assert.equal(r1002.status, '已整改', '最新核验合格 → 自动关闭待整改');
  assert.ok(r1002.recheckDate, '自动关闭时回填复检日期');

  // 路线断言（pt-1001/pt-1002 都被触碰，长度按端点真实坐标重算）
  assert.equal(snap.routes.length, 1);
  const p1001After = snap.points.find((p) => p.id === 'pt-1001')!;
  const p1002After = snap.points.find((p) => p.id === 'pt-1002')!;
  assert.ok(
    Math.abs(
      snap.routes[0].length -
        segmentLength({ lng: p1001After.lng, lat: p1001After.lat }, { lng: p1002After.lng, lat: p1002After.lat }),
    ) < 1e-6,
    '路段长度按最新端点坐标重算',
  );

  // 批次登记
  const mergedBatch = snap.batches.find((b) => b.batchId === 'OFF-MAIN-1')!;
  assert.equal(mergedBatch.status, '已合并');
  assert.equal(mergedBatch.conflictCount, 1);

  // ---------- 3. 同批次重复合并 → 拒绝 ----------
  await assert.rejects(
    async () => mergeBatch(parseBatch(JSON.stringify(batch))),
    (e: unknown) => e instanceof BatchValidationError,
    '重复批次应拒绝',
  );
  const afterDup = await snapshot();
  assert.equal(afterDup.inspections.length, 11, '拒绝重复后核验数不变');

  // ---------- 4. 引用完整性校验 ----------
  await assert.rejects(
    async () =>
      mergeBatch(
        parseBatch(
          JSON.stringify({
            batchId: 'OFF-ORPHAN',
            points: [],
            inspections: [
              { code: 'WZ-404', date: today, inspector: 'x', slope: 1, clearWidth: 1, occupied: '无' },
            ],
            rectifies: [],
          }),
        ),
      ),
    /不存在的点位编号/,
  );

  // ---------- 5. 待核对处理：采用现场值 → 写回台账并重算 ----------
  const conflictId = snap.conflicts[0].id;
  await resolveConflict(conflictId, 'site');
  snap = await snapshot();
  const p1004After = snap.points.find((p) => p.id === p1004.id)!;
  assert.equal(p1004After.name, '现场改名不应覆盖', '采用现场值后台账被更新');
  assert.equal(snap.conflicts.find((c) => c.id === conflictId)!.resolved, true);

  // ---------- 6. 最新核验不合格且无在跟整改 → 自动补建 ----------
  await mergeBatch(
    parseBatch(
      JSON.stringify({
        batchId: 'OFF-FAIL-OPEN',
        points: [],
        inspections: [
          {
            // 新点位先登记再不合格核验
            code: 'WZ-NEW-2',
            date: today,
            inspector: '督导员 陈默',
            slope: 12,
            clearWidth: 70,
            occupied: '长期占用',
          },
        ],
        rectifies: [],
      }),
    ),
  ).then(
    () => {
      throw new Error('引用了不存在点位本应失败');
    },
    () => undefined,
  );
  // 正确做法：点位 + 不合格核验一起进批次
  const failStats = await mergeBatch(
    parseBatch(
      JSON.stringify({
        batchId: 'OFF-FAIL-OPEN-2',
        points: [{ code: 'WZ-NEW-2', name: '新发问题点', facilityType: '盲道', district: '丰台区' }],
        inspections: [
          {
            code: 'WZ-NEW-2',
            date: today,
            inspector: '督导员 陈默',
            slope: 12,
            clearWidth: 70,
            occupied: '长期占用',
          },
        ],
        rectifies: [],
      }),
    ),
  );
  assert.equal(failStats.rectifiesAutoCreated, 1, '不合格核验自动补建整改');
  snap = await snapshot();
  const new2 = snap.points.find((p) => p.code === 'WZ-NEW-2')!;
  assert.ok(
    snap.rectifies.some((r) => r.pointId === new2.id && r.status === '待整改'),
    '新点位存在待整改条目',
  );

  // ---------- 7. 坐标变化触发路线重算（改 pt-1001 坐标 → 路段长度 / 判定重算） ----------
  const lenBefore = (await db.routes.toArray())[0].length;
  await mergeBatch(
    parseBatch(
      JSON.stringify({
        batchId: 'OFF-COORD',
        syncedAt: new Date(Date.now() + 86400000).toISOString(),
        points: [{ code: 'WZ-2024-001', lat: 39.95, lng: 116.42, updatedAt: new Date().toISOString() }],
        inspections: [],
        rectifies: [],
      }),
    ),
  );
  const routeAfter = (await db.routes.toArray())[0];
  assert.ok(Math.abs(routeAfter.length - lenBefore) > 100, '坐标大变 → 路段长度重算');

  console.log('\n✅ 全部验证通过：');
  console.log('  - 校验失败整批撤回、失败登记、修正后重试');
  console.log('  - 点位/核验/整改一次合并；点位以台账为准、双方修改列待核对');
  console.log('  - 同人同日去重且旧记录补批次身份');
  console.log('  - 整改按更新时间/复检日期取更晚有效值；核验变化驱动整改重算');
  console.log('  - 坐标变化驱动路线长度与通行判定重算');
  console.log('  - 重复批次拒绝；引用完整性校验；待核对人工取舍');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
