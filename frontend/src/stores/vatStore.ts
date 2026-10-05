/**
 * 调漆间状态管理（Zustand）
 * 维护调漆缸台账与对账挂起单：
 * 髹涂组领用按缸里当下余量扣减，容量用满排队等下一缸；
 * 缸结皮作废后未涂道次退回待涂；两边按缸号对账，对不上的挂起等人定。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat } from '@/types/coat';
import { PAINT_TYPE_LABEL } from '@/types/coat';
import type { Vat, VatBook, VatDraft } from '@/types/vat';
import { buildVatBook, VAT_STATE_LABEL } from '@/types/vat';
import type { ReconItem } from '@/types/recon';
import { useCoatStore } from './coatStore';

/** 领用结果：成功 / 余量不足已排队 / 失败 */
export type DrawResult =
  | { kind: 'ok'; vatNo: string }
  | { kind: 'queued'; vatNo: string; shortage: number }
  | { kind: 'error'; message: string };

interface VatStoreState {
  vats: Vat[];
  recons: ReconItem[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadVats: () => Promise<void>;
  loadRecons: () => Promise<void>;
  vatById: (id: string) => Vat | undefined;
  /** 某缸当下账本（容量 / 已领 / 退回 / 余量），自道次领用记录派生 */
  bookOf: (vatId: string) => VatBook | null;
  createVat: (draft: VatDraft) => Promise<Vat>;
  /** 结皮作废：未涂道次退回待涂，涂完的照旧，调漆间台账不动；返回退回道次数 */
  scrapVat: (id: string) => Promise<number>;
  /** 髹涂组领用：余量够则扣减，不够则排队等下一缸并写明还差几道 */
  drawForCoat: (coatId: string, vatId: string, drawCoats: number) => Promise<DrawResult>;
  /** 无缸可领时直接排队 */
  queueCoat: (coatId: string, drawCoats: number) => Promise<void>;
  /** 等漆队列：排队中的待涂道次 */
  waitingCoats: () => Coat[];
  /** 按缸号对账：对不上的生成挂起单（幂等），返回新建挂起单数 */
  runRecon: () => Promise<number>;
  /** 人工定夺核销挂起单 */
  resolveRecon: (id: string, resolvedBy: string, note: string) => Promise<void>;
  pendingRecons: () => ReconItem[];
}

export const useVatStore = create<VatStoreState>((set, get) => ({
  vats: [],
  recons: [],
  loading: false,
  ready: false,
  error: '',

  async loadVats() {
    set({ loading: true });
    try {
      const vats = await db.vats.toArray();
      vats.sort((a, b) => a.vatNo.localeCompare(b.vatNo));
      set({ vats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '调漆缸读取失败' });
    }
  },

  async loadRecons() {
    try {
      const recons = await db.recons.toArray();
      recons.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ recons });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '对账记录读取失败' });
    }
  },

  vatById(id) {
    return get().vats.find((vat) => vat.id === id);
  },

  bookOf(vatId) {
    const vat = get().vatById(vatId);
    if (!vat) return null;
    return buildVatBook(vat, useCoatStore.getState().coats);
  },

  async createVat(draft) {
    const now = Date.now();
    const row: Vat = { ...draft, id: createId('vat'), createdAt: now, updatedAt: now };
    await db.vats.put(row);
    await get().loadVats();
    return row;
  },

  async scrapVat(id) {
    const vat = get().vatById(id);
    if (!vat || vat.state === 'scrapped') return 0;
    const now = Date.now();
    // 没涂完（待涂）且领过这缸的道次退回待涂；涂完的照旧留着
    const returned = useCoatStore
      .getState()
      .coats.filter((coat) => coat.vatId === id && coat.drawState === 'valid' && coat.state === 'todo');
    await db.transaction('rw', [db.vats, db.coats], async () => {
      // 调漆间那本不动：仅状态置为已作废，容量与配方保持原样
      await db.vats.update(id, { state: 'scrapped', updatedAt: now } as never);
      await db.coats.bulkPut(
        returned.map((coat) => ({ ...coat, drawState: 'returned' as const, updatedAt: now })),
      );
    });
    await Promise.all([get().loadVats(), useCoatStore.getState().loadCoats()]);
    return returned.length;
  },

  async drawForCoat(coatId, vatId, drawCoats) {
    const coat = useCoatStore.getState().coats.find((item) => item.id === coatId);
    if (!coat) return { kind: 'error', message: '道次不存在' };
    if (coat.state !== 'todo') return { kind: 'error', message: '只有待涂道次可以领用漆缸' };
    const vat = get().vatById(vatId);
    if (!vat) return { kind: 'error', message: '调漆缸不存在' };
    if (vat.state !== 'inUse') {
      return { kind: 'error', message: `缸 ${vat.vatNo} ${VAT_STATE_LABEL[vat.state]}，不可领用` };
    }
    if (vat.paintType !== coat.paintType) {
      return {
        kind: 'error',
        message: `漆种不符：道次用${PAINT_TYPE_LABEL[coat.paintType]}，该缸是${PAINT_TYPE_LABEL[vat.paintType]}`,
      };
    }
    const need = Math.max(1, Math.floor(drawCoats));
    const book = buildVatBook(vat, useCoatStore.getState().coats);
    const now = Date.now();
    if (book.remainingCoats >= need) {
      // 按缸里当下余量扣
      await db.transaction('rw', [db.vats, db.coats], async () => {
        await db.coats.update(coatId, {
          vatId,
          drawCoats: need,
          drawState: 'valid',
          awaitVat: false,
          shortageCoats: 0,
          updatedAt: now,
        } as never);
        // 容量用满自动结缸
        if (book.remainingCoats - need === 0) {
          await db.vats.update(vatId, { state: 'usedUp', updatedAt: now } as never);
        }
      });
      await Promise.all([get().loadVats(), useCoatStore.getState().loadCoats()]);
      return { kind: 'ok', vatNo: vat.vatNo };
    }
    // 容量用满：排队等下一缸，写明还差几道
    const shortage = need - book.remainingCoats;
    await db.coats.update(coatId, {
      vatId: null,
      drawCoats: need,
      drawState: 'valid',
      awaitVat: true,
      shortageCoats: shortage,
      updatedAt: now,
    } as never);
    await useCoatStore.getState().loadCoats();
    return { kind: 'queued', vatNo: vat.vatNo, shortage };
  },

  async queueCoat(coatId, drawCoats) {
    const need = Math.max(1, Math.floor(drawCoats));
    await db.coats.update(coatId, {
      vatId: null,
      drawCoats: need,
      drawState: 'valid',
      awaitVat: true,
      shortageCoats: need,
      updatedAt: Date.now(),
    } as never);
    await useCoatStore.getState().loadCoats();
  },

  waitingCoats() {
    return useCoatStore
      .getState()
      .coats.filter((coat) => coat.awaitVat && coat.state === 'todo')
      .sort((a, b) => a.updatedAt - b.updatedAt);
  },

  async runRecon() {
    const coats = useCoatStore.getState().coats;
    const now = Date.now();
    const pending = get().recons.filter((item) => item.state === 'pending');
    const updates: ReconItem[] = [];
    const creates: ReconItem[] = [];
    get().vats.forEach((vat) => {
      const book = buildVatBook(vat, coats);
      const reasons: string[] = [];
      if (book.drawnCoats > vat.capacityCoats) {
        reasons.push(`髹涂组账领用 ${book.drawnCoats} 道，超出调漆间账容量 ${vat.capacityCoats} 道`);
      }
      if (vat.state === 'usedUp' && book.drawnCoats !== vat.capacityCoats) {
        reasons.push(`缸已报用完，但领用 ${book.drawnCoats} 道 ≠ 容量 ${vat.capacityCoats} 道`);
      }
      if (reasons.length === 0) return;
      const reason = reasons.join('；');
      const existing = pending.find((item) => item.vatId === vat.id);
      if (existing) {
        // 同一缸已有挂起单：只刷新账目快照，不重复挂单
        updates.push({
          ...existing,
          capacityCoats: vat.capacityCoats,
          drawnCoats: book.drawnCoats,
          returnedCoats: book.returnedCoats,
          reason,
          updatedAt: now,
        });
      } else {
        creates.push({
          id: createId('recon'),
          vatId: vat.id,
          vatNo: vat.vatNo,
          capacityCoats: vat.capacityCoats,
          drawnCoats: book.drawnCoats,
          returnedCoats: book.returnedCoats,
          reason,
          state: 'pending',
          resolvedBy: '',
          resolvedAt: null,
          resolveNote: '',
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    if (updates.length > 0) await db.recons.bulkPut(updates);
    if (creates.length > 0) await db.recons.bulkPut(creates);
    await get().loadRecons();
    return creates.length;
  },

  async resolveRecon(id, resolvedBy, note) {
    await db.recons.update(id, {
      state: 'resolved',
      resolvedBy,
      resolvedAt: new Date().toISOString(),
      resolveNote: note,
      updatedAt: Date.now(),
    } as never);
    await get().loadRecons();
  },

  pendingRecons() {
    return get().recons.filter((item) => item.state === 'pending');
  },
}));
