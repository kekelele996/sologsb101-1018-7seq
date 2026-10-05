/**
 * 调漆缸余量与排队判定的纯计算工具
 * 不依赖任何 store，vatStore 与 coatStore 共用同一套口径。
 */
import type { Coat } from '@/types/coat';
import type { Vat } from '@/types/vat';
import { LEGACY_VAT_ID } from '@/types/vat';

/** 某缸的已用道次合计（可排除指定道次，编辑场景下避免重复计算）；排队等下一缸的道次不计入 */
export function computeVatUsage(coats: Coat[], vatId: string, excludeCoatId?: string): number {
  return coats
    .filter(
      (coat) => coat.vatId === vatId && coat.id !== excludeCoatId && !coat.vatPending,
    )
    .reduce((sum, coat) => sum + (coat.vatUsage ?? 1), 0);
}

/** 某缸当下余量（容量 − 已用）；历史缸不参与扣减，返回 null */
export function computeVatRemaining(vat: Vat, coats: Coat[], excludeCoatId?: string): number | null {
  if (vat.id === LEGACY_VAT_ID) return null;
  return vat.capacity - computeVatUsage(coats, vat.id, excludeCoatId);
}

/**
 * 保存道次时判定是否排队等下一缸：
 * 领用道次超过该缸当下余量即排队（vatPending = true）。
 */
export function shouldBeVatPending(
  vat: Vat | undefined,
  coats: Coat[],
  vatUsage: number,
  excludeCoatId?: string,
): boolean {
  if (!vat || vat.id === LEGACY_VAT_ID) return false;
  const remaining = computeVatRemaining(vat, coats, excludeCoatId);
  if (remaining === null) return false;
  return vatUsage > remaining;
}

/** 排队道次还差几道（领用道次 − 当下余量）；余量充足时返回 0 */
export function vatShortage(vat: Vat | undefined, coats: Coat[], vatUsage: number): number {
  if (!vat || vat.id === LEGACY_VAT_ID) return 0;
  const remaining = computeVatRemaining(vat, coats);
  if (remaining === null) return 0;
  return Math.max(0, vatUsage - remaining);
}

/* ------------------------------ 按缸号对账 ------------------------------ */

export interface VatReconRow {
  vat: Vat;
  capacity: number;
  /** 髹涂组口径：该缸已用道次合计 */
  usage: number;
  /** 当下余量（容量 − 已用）；历史缸为 null */
  remaining: number | null;
  /** 领用该缸的道次数 */
  coatCount: number;
  /** 对账状态：超扣即对不上 */
  status: 'ok' | 'overdrawn';
  /** 挂起：对不上，等人定 */
  suspended: boolean;
}

export interface OrphanCoat {
  coat: Coat;
  reason: 'missing-vat';
}

export interface VatRecon {
  rows: VatReconRow[];
  orphans: OrphanCoat[];
  pendingCoats: Coat[];
  /** 挂起总数：超扣缸数 + 孤儿道次数 */
  suspendedCount: number;
}

/**
 * 按缸号对账：
 * - 每缸比对调漆间容量与髹涂组已用合计，超扣即挂起；
 * - 道次领用了不存在的缸号 → 孤儿道次，挂起；
 * - 排队等下一缸的道次单列。
 */
export function computeReconciliation(vats: Vat[], coats: Coat[]): VatRecon {
  const vatIds = new Set(vats.map((vat) => vat.id));

  const rows: VatReconRow[] = vats
    .filter((vat) => vat.id !== LEGACY_VAT_ID)
    .map((vat) => {
      const usage = computeVatUsage(coats, vat.id);
      const remaining = computeVatRemaining(vat, coats);
      const coatCount = coats.filter((coat) => coat.vatId === vat.id).length;
      const overdrawn = remaining !== null && remaining < 0;
      return {
        vat,
        capacity: vat.capacity,
        usage,
        remaining,
        coatCount,
        status: overdrawn ? 'overdrawn' : 'ok',
        suspended: overdrawn,
      };
    });

  const orphans: OrphanCoat[] = coats
    .filter(
      (coat) => coat.vatId !== null && coat.vatId !== LEGACY_VAT_ID && !vatIds.has(coat.vatId),
    )
    .map((coat) => ({ coat, reason: 'missing-vat' }));

  const pendingCoats = coats.filter((coat) => coat.vatPending);

  return {
    rows,
    orphans,
    pendingCoats,
    suspendedCount: rows.filter((row) => row.suspended).length + orphans.length,
  };
}
