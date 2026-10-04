import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { OfflineBatch, PointConflict } from '../types/batch';
import {
  buildMergePlan,
  createBatchRecord,
  type OfflineBatchPayload,
} from '../utils/batchMerge';
import { toPlain } from '../utils/format';

interface BatchState {
  batches: OfflineBatch[];
  conflicts: PointConflict[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  /** 导入离线批次：校验失败整批撤回（不写业务数据），成功则事务化合并 */
  importBatch: (payload: OfflineBatchPayload) => Promise<{ batch: OfflineBatch; report: import('../types/batch').MergeReport }>;
  /** 失败批次重试：用暂存的原始载荷重新校验合并 */
  retryBatch: (batchId: string) => Promise<{ batch: OfflineBatch; report: import('../types/batch').MergeReport }>;
  /** 标记待核对冲突已处理 */
  resolveConflict: (conflictId: string) => Promise<void>;
}

export const useBatchStore = create<BatchState>((set, get) => ({
  batches: [],
  conflicts: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [batches, conflicts] = await Promise.all([
        db.batches.toArray(),
        db.conflicts.toArray(),
      ]);
      set({
        batches: batches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        conflicts: conflicts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  importBatch: async (payload) => {
    const batch = createBatchRecord(payload);
    // 先登记批次（pending），业务数据零写入
    await db.batches.put(batch);
    try {
      const current = {
        points: await db.points.toArray(),
        inspections: await db.inspections.toArray(),
        rectifies: await db.rectifies.toArray(),
        routes: await db.routes.toArray(),
      };
      const plan = buildMergePlan(payload, current, batch.id);
      const now = new Date().toISOString();
      await db.transaction(
        'rw',
        [db.points, db.inspections, db.rectifies, db.routes, db.batches, db.conflicts],
        async () => {
          if (plan.newPoints.length) await db.points.bulkPut(toPlain(plan.newPoints));
          if (plan.newInspections.length) await db.inspections.bulkPut(toPlain(plan.newInspections));
          if (plan.newRectifies.length) await db.rectifies.bulkPut(toPlain(plan.newRectifies));
          for (const u of plan.updatedRectifies) {
            await db.rectifies.update(u.id, toPlain(u.patch));
          }
          for (const seg of plan.recalculatedSegments) {
            await db.routes.update(seg.id, toPlain(seg.patch));
          }
          if (plan.conflicts.length) await db.conflicts.bulkPut(toPlain(plan.conflicts));
          await db.batches.update(batch.id, { status: 'merged', mergedAt: now, failReason: '' });
        },
      );
      const merged: OfflineBatch = { ...batch, status: 'merged', mergedAt: now };
      set((s) => ({
        batches: [merged, ...s.batches.filter((b) => b.id !== batch.id)],
        conflicts: [...plan.conflicts, ...s.conflicts],
      }));
      return { batch: merged, report: plan.report };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await db.batches.update(batch.id, { status: 'failed', failReason: reason });
      set((s) => ({
        batches: s.batches.map((b) => (b.id === batch.id ? { ...b, status: 'failed', failReason: reason } : b)),
      }));
      const err = new Error(reason) as Error & { batchId?: string };
      err.batchId = batch.id;
      throw err;
    }
  },

  retryBatch: async (batchId) => {
    const existing = get().batches.find((b) => b.id === batchId);
    if (!existing) throw new Error('未找到批次记录');
    if (!existing.rawInput) throw new Error('该批次未暂存原始载荷，无法重试');
    const payload = JSON.parse(existing.rawInput) as OfflineBatchPayload;
    // 重置为 pending 后重新走导入流程
    await db.batches.update(batchId, { status: 'pending', failReason: '' });
    set((s) => ({
      batches: s.batches.map((b) => (b.id === batchId ? { ...b, status: 'pending', failReason: '' } : b)),
    }));
    try {
      const current = {
        points: await db.points.toArray(),
        inspections: await db.inspections.toArray(),
        rectifies: await db.rectifies.toArray(),
        routes: await db.routes.toArray(),
      };
      const plan = buildMergePlan(payload, current, batchId);
      const now = new Date().toISOString();
      await db.transaction(
        'rw',
        [db.points, db.inspections, db.rectifies, db.routes, db.batches, db.conflicts],
        async () => {
          if (plan.newPoints.length) await db.points.bulkPut(toPlain(plan.newPoints));
          if (plan.newInspections.length) await db.inspections.bulkPut(toPlain(plan.newInspections));
          if (plan.newRectifies.length) await db.rectifies.bulkPut(toPlain(plan.newRectifies));
          for (const u of plan.updatedRectifies) {
            await db.rectifies.update(u.id, toPlain(u.patch));
          }
          for (const seg of plan.recalculatedSegments) {
            await db.routes.update(seg.id, toPlain(seg.patch));
          }
          if (plan.conflicts.length) await db.conflicts.bulkPut(toPlain(plan.conflicts));
          await db.batches.update(batchId, { status: 'merged', mergedAt: now, failReason: '' });
        },
      );
      const merged: OfflineBatch = { ...existing, status: 'merged', mergedAt: now, failReason: '' };
      set((s) => ({
        batches: s.batches.map((b) => (b.id === batchId ? merged : b)),
        conflicts: [...plan.conflicts, ...s.conflicts],
      }));
      return { batch: merged, report: plan.report };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await db.batches.update(batchId, { status: 'failed', failReason: reason });
      set((s) => ({
        batches: s.batches.map((b) => (b.id === batchId ? { ...b, status: 'failed', failReason: reason } : b)),
      }));
      const err = new Error(reason) as Error & { batchId?: string };
      err.batchId = batchId;
      throw err;
    }
  },

  resolveConflict: async (conflictId) => {
    await db.conflicts.update(conflictId, { status: 'resolved' });
    set((s) => ({
      conflicts: s.conflicts.map((c) => (c.id === conflictId ? { ...c, status: 'resolved' } : c)),
    }));
  },
}));
