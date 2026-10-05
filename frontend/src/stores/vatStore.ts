/**
 * 调漆缸状态管理（Zustand）
 * 调漆间按缸登记漆种、配方与容量；髹涂组按缸领用道次并扣减余量。
 * 缸结皮作废后，没涂完的道次退回待涂，涂完的照旧留着，调漆间那本不动。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat } from '@/types/coat';
import type { Vat, VatDraft } from '@/types/vat';
import { LEGACY_VAT_ID } from '@/types/vat';
import { computeReconciliation, computeVatRemaining, computeVatUsage, type VatRecon } from '@/utils/vat';

interface VatStoreState {
  vats: Vat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadVats: () => Promise<void>;
  vatById: (id: string | null) => Vat | undefined;
  /** 在用缸（排除历史缸），按调制日期倒序 */
  activeVats: () => Vat[];
  createVat: (draft: VatDraft) => Promise<Vat>;
  updateVat: (id: string, patch: Partial<Vat>) => Promise<void>;
  removeVat: (id: string) => Promise<void>;
  /** 缸结皮作废：没涂完、领过这缸的道次退回待涂，涂完的照旧留着；调漆间那本不动 */
  voidVat: (id: string) => Promise<{ returned: number }>;
  /** 某缸已用道次合计 */
  vatUsageOf: (vatId: string, coats: Coat[]) => number;
  /** 某缸当下余量（历史缸返回 null） */
  vatRemainingOf: (vatId: string, coats: Coat[]) => number | null;
  /** 按缸号对账：超扣 / 孤儿道次 / 排队道次，对不上的挂起 */
  reconciliation: (coats: Coat[]) => VatRecon;
}

export const useVatStore = create<VatStoreState>((set, get) => ({
  vats: [],
  loading: false,
  ready: false,
  error: '',

  async loadVats() {
    set({ loading: true });
    try {
      const vats = await db.vats.orderBy('mixedAt').reverse().toArray();
      set({ vats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '调漆缸读取失败' });
    }
  },

  vatById(id) {
    if (!id) return undefined;
    return get().vats.find((vat) => vat.id === id);
  },

  activeVats() {
    return get()
      .vats.filter((vat) => vat.state === 'active' && vat.id !== LEGACY_VAT_ID)
      .sort((a, b) => b.mixedAt.localeCompare(a.mixedAt));
  },

  async createVat(draft) {
    const now = Date.now();
    const row: Vat = { ...draft, id: createId('vat'), createdAt: now, updatedAt: now };
    await db.vats.put(row);
    await get().loadVats();
    return row;
  },

  async updateVat(id, patch) {
    await db.vats.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadVats();
  },

  async removeVat(id) {
    await db.vats.delete(id);
    await get().loadVats();
  },

  async voidVat(id) {
    const vat = get().vats.find((item) => item.id === id);
    if (!vat) return { returned: 0 };
    const now = Date.now();
    // 调漆间那本不动：缸记录保留，仅标记作废；涂完的道次保留缸号与用量
    const affected = await db.coats.where('vatId').equals(id).toArray();
    const returned = affected.filter((coat) => coat.state !== 'done');
    if (returned.length > 0) {
      await db.coats.bulkPut(
        returned.map((coat) => ({
          ...coat,
          state: 'todo' as const,
          vatId: null,
          vatPending: false,
          updatedAt: now,
        })),
      );
    }
    await db.vats.update(id, { state: 'void', updatedAt: now } as never);
    await get().loadVats();
    return { returned: returned.length };
  },

  vatUsageOf(vatId, coats) {
    return computeVatUsage(coats, vatId);
  },

  vatRemainingOf(vatId, coats) {
    const vat = get().vats.find((item) => item.id === vatId);
    if (!vat) return null;
    return computeVatRemaining(vat, coats);
  },

  reconciliation(coats) {
    return computeReconciliation(get().vats, coats);
  },
}));
