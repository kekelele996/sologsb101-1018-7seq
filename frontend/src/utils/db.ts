/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Coat 增加 paintType 索引并回填历史记录；
 *   v2 → v3：新增调漆缸与对账挂起单两张表，Coat 增加领用字段并按漆种与涂刷日期回填缸号）
 * - 八张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import { normalizeCoat } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';
import type { Vat } from '@/types/vat';
import { backfillCoatVats, createHistVat, HIST_VAT_ID } from '@/types/vat';
import type { ReconItem } from '@/types/recon';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  rooms!: Table<Room, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;
  vats!: Table<Vat, string>;
  recons!: Table<ReconItem, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const legal: PaintType[] = ['raw', 'color', 'topcoat'];
            if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });
      });

    // v3：新增调漆缸 vats 与对账挂起单 recons；Coat 增加领用字段与 vatId 索引，
    // 旧道次没记缸号的按漆种与涂刷日期回填，填不上的标历史缸号
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, vatId, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
        vats: 'id, vatNo, paintType, state, mixedDate, updatedAt',
        recons: 'id, vatId, state, updatedAt',
      })
      .upgrade(async (tx) => {
        const coatsTable = tx.table<Coat>('coats');
        // 先补领用字段默认值
        await coatsTable
          .toCollection()
          .modify((coat) => {
            Object.assign(coat, normalizeCoat(coat));
          });
        // 历史缸号占位（幂等），回填不上的道次挂此
        await tx.table<Vat>('vats').put(createHistVat(Date.now()));
        // 按漆种与涂刷日期回填缸号
        const coats = await coatsTable.toArray();
        const vats = await tx.table<Vat>('vats').toArray();
        const patches = backfillCoatVats(coats, vats);
        await Promise.all(patches.map((patch) => coatsTable.update(patch.id, { vatId: patch.vatId })));
      });
  }
}

export const db = new LacquerDatabase();

/** 八张业务表清单，事务中统一引用 */
const TABLE_LIST = [
  db.bodies,
  db.coats,
  db.rooms,
  db.polishes,
  db.inlays,
  db.inspects,
  db.vats,
  db.recons,
];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Body →（Coat / Room / Polish / Inlay）→ Inspect，id 固定便于深链命中 */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      createdAt: now - 86400000 * 12,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'box',
      sizeMm: 96,
      ownerName: '工作室自藏',
      state: 'drying',
      createdAt: now - 86400000 * 9,
      updatedAt: now - 86400000,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      createdAt: now - 86400000 * 30,
      updatedAt: now - 86400000 * 4,
    },
  ];

  const coats: Coat[] = [
    // 播种道次模拟旧数据：vatId 一律为 null，落库后由 applyVatBackfill 按漆种与涂刷日期回填
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
    // 涂刷日期早于任何罩漆缸的调漆日期，回填时找不到缸，会标历史缸号 HIST
    { id: 'coat_0304', bodyId: 'body_03', seq: 4, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-01-15', thicknessUm: 30, state: 'done', needRecheck: false, vatId: null, drawCoats: 1, drawState: 'valid', awaitVat: false, shortageCoats: 0, createdAt: now - 86400000 * 28, updatedAt: now - 86400000 * 28 },
  ];

  const vats: Vat[] = [
    { id: 'vat_01', vatNo: 'G-2601', paintType: 'raw', formula: '净滤生漆，不加填料', capacityCoats: 4, mixedDate: '2026-02-01', state: 'scrapped', note: '立春所调，静置过久结皮作废', createdAt: now - 86400000 * 30, updatedAt: now - 86400000 * 12 },
    { id: 'vat_02', vatNo: 'G-2602', paintType: 'color', formula: '朱砂粉调生漆 1:2', capacityCoats: 3, mixedDate: '2026-02-15', state: 'inUse', note: '', createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 20 },
    { id: 'vat_03', vatNo: 'G-2603', paintType: 'topcoat', formula: '透明罩漆加熟桐油 3:1', capacityCoats: 2, mixedDate: '2026-02-20', state: 'inUse', note: '', createdAt: now - 86400000 * 22, updatedAt: now - 86400000 * 14 },
    { id: 'vat_04', vatNo: 'G-2604', paintType: 'raw', formula: '净滤生漆，不加填料', capacityCoats: 6, mixedDate: '2026-03-01', state: 'inUse', note: '', createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 7 },
    { id: 'vat_05', vatNo: 'G-2605', paintType: 'color', formula: '赭石粉调生漆 1:2', capacityCoats: 2, mixedDate: '2026-03-05', state: 'usedUp', note: '容量已髹完', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 2 },
    createHistVat(now - 86400000 * 30),
  ];

  const rooms: Room[] = [
    { id: 'room_0101', bodyId: 'body_01', date: '2026-03-03', tempC: 24, humidityPct: 78, inAt: '09:00', outAt: '21:00', verdict: 'suitable', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'room_0102', bodyId: 'body_01', date: '2026-03-07', tempC: 27, humidityPct: 56, inAt: '08:30', outAt: '20:00', verdict: 'dry', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'room_0201', bodyId: 'body_02', date: '2026-03-05', tempC: 23, humidityPct: 91, inAt: '10:00', outAt: '22:30', verdict: 'wet', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'room_0301', bodyId: 'body_03', date: '2026-02-20', tempC: 25, humidityPct: 76, inAt: '09:30', outAt: '21:30', verdict: 'suitable', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
    { id: 'polish_0102', bodyId: 'body_01', seq: 2, grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'polish_0201', bodyId: 'body_02', seq: 1, grit: 800, method: 'water', durationMin: 30, operator: '李成', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'polish_0301', bodyId: 'body_03', seq: 3, grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 * 4 },
  ];

  const inlays: Inlay[] = [
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'room_0201', createdAt: now - 86400000, updatedAt: now - 86400000 },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(rooms);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
    await db.vats.bulkPut(vats);
  });
  // 播种道次模拟旧数据（未记缸号），落库后按漆种与涂刷日期回填，填不上的标历史缸号
  await applyVatBackfill();
}

/**
 * 旧道次回填缸号：按漆种与涂刷日期匹配调漆缸，填不上的标历史缸号。
 * 播种与 v3 升级迁移共用同一套规则（backfillCoatVats），返回回填道次数。
 */
export async function applyVatBackfill(): Promise<number> {
  const [coats, vats] = await Promise.all([db.coats.toArray(), db.vats.toArray()]);
  const patches = backfillCoatVats(coats, vats);
  if (patches.length === 0) return 0;
  const now = Date.now();
  await db.transaction('rw', [db.coats], async () => {
    await Promise.all(
      patches.map((patch) => db.coats.update(patch.id, { vatId: patch.vatId, updatedAt: now } as never)),
    );
  });
  return patches.length;
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  bodies: Body[];
  coats: Coat[];
  rooms: Room[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
  vats: Vat[];
  recons: ReconItem[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, rooms, polishes, inlays, inspects, vats, recons] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
    db.vats.toArray(),
    db.recons.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bodies,
    coats,
    rooms,
    polishes,
    inlays,
    inspects,
    vats,
    recons,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过）；vats / recons 为 v3 新增，旧备份缺省视为空 */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'rooms', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  const optional: Array<keyof LacquerSnapshot> = ['vats', 'recons'];
  for (const key of optional) {
    if (snapshot[key] !== undefined && !Array.isArray(snapshot[key])) return `备份文件 ${String(key)} 集合格式不正确`;
  }
  return '';
}

export async function importSnapshot(snapshot: LacquerSnapshot): Promise<void> {
  await clearAllTables();
  // 旧备份（v2 及以前）没有调漆缸与对账单，缺省补空；道次补领用字段默认值
  const coats = snapshot.coats.map((coat) => normalizeCoat(coat));
  const vats = snapshot.vats ?? [];
  if (!vats.some((vat) => vat.id === HIST_VAT_ID)) vats.push(createHistVat(Date.now()));
  const recons = snapshot.recons ?? [];
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(snapshot.rooms);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
    await db.vats.bulkPut(vats);
    await db.recons.bulkPut(recons);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.rooms.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
      db.vats.clear(),
      db.recons.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [bodies, coats, rooms, polishes, inlays, inspects, vats, recons] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.rooms.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
    db.vats.count(),
    db.recons.count(),
  ]);
  return { bodies, coats, rooms, polishes, inlays, inspects, vats, recons };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.rooms.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    await db.bodies.delete(bodyId);
  });
}
