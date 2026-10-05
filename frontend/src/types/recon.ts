/**
 * 对账挂起单（ReconItem）数据模型
 * 调漆间与髹涂组按缸号对账：登记容量 vs 领用合计，
 * 对不上的先生成挂起单，等人工定夺后核销。
 */

/** 对账状态：挂起待核 / 已核销 */
export type ReconState = 'pending' | 'resolved';

export interface ReconItem {
  id: string;
  /** 对账缸 id */
  vatId: string;
  /** 缸号快照（缸记录后续改动不影响挂起单） */
  vatNo: string;
  /** 调漆间账：登记容量（道） */
  capacityCoats: number;
  /** 髹涂组账：有效领用合计（道） */
  drawnCoats: number;
  /** 结皮作废退回损耗（道） */
  returnedCoats: number;
  /** 对不上的原因 */
  reason: string;
  state: ReconState;
  /** 核销人（人定） */
  resolvedBy: string;
  /** 核销时间 ISO；未核销为 null */
  resolvedAt: string | null;
  /** 核销说明（人定的结论） */
  resolveNote: string;
  createdAt: number;
  updatedAt: number;
}

export type ReconDraft = Omit<ReconItem, 'id' | 'createdAt' | 'updatedAt'>;

export const RECON_STATE_LABEL: Record<ReconState, string> = {
  pending: '挂起待核',
  resolved: '已核销',
};

export const RECON_STATE_COLOR: Record<ReconState, string> = {
  pending: '#c9963c',
  resolved: '#2f6f4f',
};
