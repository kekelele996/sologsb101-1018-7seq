/**
 * 调漆缸（Vat）数据模型
 * 调漆间按缸登记漆种、配方与容量；髹涂组按缸领用道次并扣减余量。
 * 一缸只够髹固定道数，容量用满即排队等下一缸。
 */
import type { PaintType } from './coat';

/** 缸状态：在用 / 已结皮作废 */
export type VatState = 'active' | 'void';

export interface Vat {
  id: string;
  /** 缸号，如 VAT-20260312-01 */
  code: string;
  /** 漆种 */
  paintType: PaintType;
  /** 配方（色名 / 配比等） */
  formula: string;
  /** 容量（道）：这一缸总共能髹多少道 */
  capacity: number;
  /** 调制日期 yyyy-MM-dd */
  mixedAt: string;
  /** 在用 / 已结皮作废 */
  state: VatState;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type VatDraft = Omit<Vat, 'id' | 'createdAt' | 'updatedAt'>;

/** 历史缸号：升级回填时匹配不上的道次统一挂到这口虚拟缸 */
export const LEGACY_VAT_ID = 'vat_legacy';

export const VAT_STATE_LABEL: Record<VatState, string> = {
  active: '在用',
  void: '已结皮作废',
};

export const VAT_STATE_COLOR: Record<VatState, string> = {
  active: '#2f6f4f',
  void: '#8c8c8c',
};

export const VAT_STATE_OPTIONS: ReadonlyArray<{ value: VatState; label: string }> = [
  { value: 'active', label: '在用' },
  { value: 'void', label: '已结皮作废' },
];

export function createEmptyVatDraft(): VatDraft {
  return {
    code: '',
    paintType: 'raw',
    formula: '',
    capacity: 4,
    mixedAt: new Date().toISOString().slice(0, 10),
    state: 'active',
    note: '',
  };
}

/** 生成缸号：VAT-yyyyMMdd-两位序号 */
export function generateVatCode(mixedAt: string, seq: number): string {
  const compact = mixedAt.replace(/-/g, '');
  return `VAT-${compact}-${String(seq).padStart(2, '0')}`;
}
