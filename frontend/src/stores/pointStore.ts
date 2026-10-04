import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import type { BatchRecord, MergeStats, OfflineBatch, PendingConflict } from '../types/batch';
import { mergeBatch, parseBatch, recordBatchFailure, resolveConflict } from '../utils/batchMerge';
import { makeId, toPlain, todayStr } from '../utils/format';

interface PointState {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  batches: BatchRecord[];
  conflicts: PendingConflict[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (draft: InspectionDraft) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
  /** 解析 + 合并离线批次；失败时整批撤回并登记失败记录，异常抛出供界面提示重试 */
  importBatch: (raw: string) => Promise<{ batch: OfflineBatch; stats: MergeStats }>;
  /** 处理待核对：保留台账值或采用现场值 */
  resolveConflict: (id: string, pick: 'ledger' | 'site') => Promise<void>;
  loadBatches: () => Promise<void>;
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  inspections: [],
  rectifies: [],
  batches: [],
  conflicts: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [points, inspections, rectifies, conflicts] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
        db.conflicts.toArray(),
      ]);
      set({
        points: points.sort((a, b) => a.code.localeCompare(b.code)),
        inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
        rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
        conflicts: conflicts.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1)),
        loading: false,
        loaded: true,
      });
      void get().loadBatches();
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const point: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
    });
    await db.points.put(point);
    set((s) => ({ points: [...s.points, point].sort((a, b) => a.code.localeCompare(b.code)) }));
    return point;
  },

  addInspection: async (draft) => {
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: new Date().toISOString(),
    });
    await db.inspections.put(inspection);
    set((s) => ({
      inspections: [inspection, ...s.inspections].sort((a, b) => (a.date < b.date ? 1 : -1)),
    }));
    // 结论为不合格时自动生成整改条目，形成闭环
    if (inspection.conclusion === '不合格') {
      const exists = get().rectifies.some(
        (r) => r.pointId === inspection.pointId && r.status !== '已整改',
      );
      if (!exists) {
        await get().addRectify({
          pointId: inspection.pointId,
          requirement: `按 ${inspection.date} 核验结论整改：${inspection.problem || '坡度、净宽或占用问题'}`,
          unit: '待指派责任单位',
          deadline: todayStr(),
          recheckDate: '',
          status: '待整改',
        });
      }
    }
    return inspection;
  },

  addRectify: async (draft) => {
    const now = new Date().toISOString();
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: now,
      updatedAt: now,
    });
    await db.rectifies.put(plan);
    set((s) => ({
      rectifies: [...s.rectifies, plan].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain({ ...patch, updatedAt: new Date().toISOString() });
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r)),
    }));
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),

  importBatch: async (raw) => {
    // 先在事务外做严格校验，失败内容保留在界面，允许修正后重试
    const batch = parseBatch(raw);
    try {
      const stats = await mergeBatch(batch);
      // 合并成功后整体刷新，总览 / 清单 / 路线立即消费新数据
      await get().load();
      return { batch, stats };
    } catch (e) {
      // 事务回滚 → 整批撤回；登记失败记录，批次可重试
      const message = e instanceof Error ? e.message : String(e);
      await recordBatchFailure(batch, message);
      await get().loadBatches();
      throw e;
    }
  },

  resolveConflict: async (id, pick) => {
    await resolveConflict(id, pick);
    // 点位 / 路线可能已变，整体刷新
    await get().load();
  },

  loadBatches: async () => {
    const [batches, conflicts] = await Promise.all([
      db.batches.toArray(),
      db.conflicts.toArray(),
    ]);
    set({
      batches: batches.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1)),
      conflicts: conflicts.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1)),
    });
  },
}));
