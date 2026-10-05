/**
 * 调漆缸（Vat）数据模型
 * 调漆间按缸登记漆种、配方与容量（可髹道数）；髹涂组领用按缸里当下余量扣减，
 * 两边按缸号对账。缸结皮作废后台账保留，仅状态置为「已作废」。
 */
import type { Coat, PaintType } from './coat';

/** 缸状态：在用 / 已用完 / 已作废（结皮） */
export type VatState = 'inUse' | 'usedUp' | 'scrapped';

/** 历史缸号：旧数据回填不上缸号的道次挂此，对账后等人工定夺 */
export const HIST_VAT_ID = 'vat_hist';
export const HIST_VAT_NO = 'HIST';

export interface Vat {
  id: string;
  /** 缸号，调漆间与髹涂组对账的凭据 */
  vatNo: string;
  /** 漆种 */
  paintType: PaintType;
  /** 配方（配比记述） */
  formula: string;
  /** 容量：这一缸够髹的道数 */
  capacityCoats: number;
  /** 调漆日期 yyyy-MM-dd（当天现调） */
  mixedDate: string;
  /** 当前状态 */
  state: VatState;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type VatDraft = Omit<Vat, 'id' | 'createdAt' | 'updatedAt'>;

export const VAT_STATE_LABEL: Record<VatState, string> = {
  inUse: '在用',
  usedUp: '已用完',
  scrapped: '已作废',
};

export const VAT_STATE_COLOR: Record<VatState, string> = {
  inUse: '#2f6f4f',
  usedUp: '#8c8c8c',
  scrapped: '#b03a2e',
};

/**
 * 缸账本：调漆间账（登记容量）与髹涂组账（领用合计）对照。
 * 余量不落地存储，一律由领用记录派生，保证两边看到的是同一本账。
 */
export interface VatBook {
  vatId: string;
  /** 调漆间账：登记容量（道） */
  capacityCoats: number;
  /** 髹涂组账：有效领用合计（道） */
  drawnCoats: number;
  /** 结皮作废时未涂道次退回的损耗（道） */
  returnedCoats: number;
  /** 当下余量 = 容量 - 有效领用 */
  remainingCoats: number;
}

export function buildVatBook(vat: Vat, coats: Coat[]): VatBook {
  let drawn = 0;
  let returned = 0;
  coats.forEach((coat) => {
    if (coat.vatId !== vat.id) return;
    if (coat.drawState === 'returned') returned += coat.drawCoats;
    else drawn += coat.drawCoats;
  });
  return {
    vatId: vat.id,
    capacityCoats: vat.capacityCoats,
    drawnCoats: drawn,
    returnedCoats: returned,
    remainingCoats: vat.capacityCoats - drawn,
  };
}

/** 历史缸号占位记录（升级迁移与播种共用，put 幂等） */
export function createHistVat(now: number): Vat {
  return {
    id: HIST_VAT_ID,
    vatNo: HIST_VAT_NO,
    paintType: 'raw',
    formula: '旧账未登记配方',
    capacityCoats: 0,
    mixedDate: '1970-01-01',
    state: 'scrapped',
    note: '历史缸号：旧数据里没记缸号的道次挂此，对账后等人定夺',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 旧道次回填缸号：按漆种与涂刷日期匹配调漆缸。
 * - 只回填已涂（非「待涂」）且未记缸号的道次；待涂道次尚未领漆，走正常领用流程
 * - 候选缸：同漆种、调漆日期不晚于涂刷日期；同日多缸时取最新调的一缸
 * - 一缸只够髹固定道数：按涂刷日期先后装缸，装满换下一缸
 * - 填不上的标历史缸号（HIST）
 */
export function backfillCoatVats(coats: Coat[], vats: Vat[]): Array<{ id: string; vatId: string }> {
  const used = new Map<string, number>();
  coats.forEach((coat) => {
    if (coat.vatId && coat.drawState !== 'returned') {
      used.set(coat.vatId, (used.get(coat.vatId) ?? 0) + Math.max(1, coat.drawCoats || 1));
    }
  });
  const targets = coats
    .filter((coat) => !coat.vatId && coat.state !== 'todo')
    .sort((a, b) => (a.coatDate === b.coatDate ? a.seq - b.seq : a.coatDate.localeCompare(b.coatDate)));
  const patches: Array<{ id: string; vatId: string }> = [];
  targets.forEach((coat) => {
    const need = Math.max(1, coat.drawCoats || 1);
    const vat = vats
      .filter(
        (item) =>
          item.id !== HIST_VAT_ID &&
          item.paintType === coat.paintType &&
          item.mixedDate <= coat.coatDate &&
          (used.get(item.id) ?? 0) + need <= item.capacityCoats,
      )
      .sort((a, b) => b.mixedDate.localeCompare(a.mixedDate))[0];
    if (vat) {
      used.set(vat.id, (used.get(vat.id) ?? 0) + need);
      patches.push({ id: coat.id, vatId: vat.id });
    } else {
      patches.push({ id: coat.id, vatId: HIST_VAT_ID });
    }
  });
  return patches;
}

/** 生成下一个缸号：G-26NN 形式，在现有最大序号上递增 */
export function nextVatNo(vats: Vat[]): string {
  const max = vats.reduce((acc, vat) => {
    const match = /^G-(\d{4})$/.exec(vat.vatNo);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 2600);
  return `G-${max + 1}`;
}

export function createEmptyVatDraft(vats: Vat[]): VatDraft {
  return {
    vatNo: nextVatNo(vats),
    paintType: 'raw',
    formula: '',
    capacityCoats: 6,
    mixedDate: new Date().toISOString().slice(0, 10),
    state: 'inUse',
    note: '',
  };
}
