/**
 * 髹涂道次（Coat）数据模型
 * 一件胎体上的逐道髹涂记录：漆种、色名、涂刷日期、湿膜厚度与状态推进。
 */

/** 漆种：生漆 / 色漆 / 罩漆 */
export type PaintType = 'raw' | 'color' | 'topcoat';

/** 道次状态：待涂 / 已涂 / 待打磨 / 已完成 */
export type CoatState = 'todo' | 'coated' | 'toPolish' | 'done';

/** 领用状态：有效 / 已退回（缸结皮作废后，未涂道次的领用退回待涂） */
export type DrawState = 'valid' | 'returned';

export interface Coat {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 道次序号，从 1 开始连续整数 */
  seq: number;
  /** 漆种 */
  paintType: PaintType;
  /** 色名，如「朱红」「漆黑」 */
  colorName: string;
  /** 涂刷日期 yyyy-MM-dd */
  coatDate: string;
  /** 湿膜厚度（微米） */
  thicknessUm: number;
  /** 当前状态 */
  state: CoatState;
  /** 荫房判定异常时回写的「待复检」标记 */
  needRecheck: boolean;
  /** 领用的调漆缸 id；null 表示未领用；旧数据回填不上时为历史缸号 vat_hist */
  vatId: string | null;
  /** 本次领用用掉的道数（按缸里当下余量扣） */
  drawCoats: number;
  /** 领用状态 */
  drawState: DrawState;
  /** 缸容量用满后在等漆队列中排队 */
  awaitVat: boolean;
  /** 等漆缺口：还差几道 */
  shortageCoats: number;
  createdAt: number;
  updatedAt: number;
}

export type CoatDraft = Omit<Coat, 'id' | 'createdAt' | 'updatedAt'>;

export const PAINT_TYPE_LABEL: Record<PaintType, string> = {
  raw: '生漆',
  color: '色漆',
  topcoat: '罩漆',
};

export const COAT_STATE_LABEL: Record<CoatState, string> = {
  todo: '待涂',
  coated: '已涂',
  toPolish: '待打磨',
  done: '已完成',
};

export const COAT_STATE_COLOR: Record<CoatState, string> = {
  todo: '#8c8c8c',
  coated: '#c9963c',
  toPolish: '#8c2f1f',
  done: '#2f6f4f',
};

export const COAT_STATE_FLOW: readonly CoatState[] = ['todo', 'coated', 'toPolish', 'done'];

export const DRAW_STATE_LABEL: Record<DrawState, string> = {
  valid: '有效',
  returned: '已退回',
};

export const PAINT_TYPE_OPTIONS: ReadonlyArray<{ value: PaintType; label: string }> = [
  { value: 'raw', label: '生漆' },
  { value: 'color', label: '色漆' },
  { value: 'topcoat', label: '罩漆' },
];

export const COAT_STATE_OPTIONS: ReadonlyArray<{ value: CoatState; label: string }> =
  COAT_STATE_FLOW.map((state) => ({ value: state, label: COAT_STATE_LABEL[state] }));

/** 色名候选，表单下拉直接复用 */
export const COLOR_NAME_OPTIONS: readonly string[] = [
  '漆黑',
  '朱红',
  '赭石',
  '藤黄',
  '石绿',
  '推光本色',
  '描金',
];

export function nextCoatState(state: CoatState): CoatState {
  const index = COAT_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= COAT_STATE_FLOW.length - 1) return state;
  return COAT_STATE_FLOW[index + 1] as CoatState;
}

export function createEmptyCoatDraft(bodyId: string, seq: number): CoatDraft {
  return {
    bodyId,
    seq,
    paintType: 'raw',
    colorName: '漆黑',
    coatDate: new Date().toISOString().slice(0, 10),
    thicknessUm: 40,
    state: 'todo',
    needRecheck: false,
    vatId: null,
    drawCoats: 1,
    drawState: 'valid',
    awaitVat: false,
    shortageCoats: 0,
  };
}

/** 旧备份 / 升级前的道次缺少领用字段时补默认值（v3 迁移与导入共用） */
export function normalizeCoat(coat: Coat): Coat {
  return {
    ...coat,
    vatId: coat.vatId ?? null,
    drawCoats: typeof coat.drawCoats === 'number' && coat.drawCoats > 0 ? coat.drawCoats : 1,
    drawState: coat.drawState === 'returned' ? 'returned' : 'valid',
    awaitVat: typeof coat.awaitVat === 'boolean' ? coat.awaitVat : false,
    shortageCoats: typeof coat.shortageCoats === 'number' ? coat.shortageCoats : 0,
  };
}
