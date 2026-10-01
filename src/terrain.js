// ============================================================
//  terrain.js —— 地形：走廊 + 铁门 + 8×5 房间网格
// ============================================================
//
// 这一步只做「看得见的地形」，不含任何战斗逻辑。
// 目的是先把空间感立起来：一眼能看出哪里是走廊、哪里是铁门、
// 房间被切成 40 个格子、床占着右上角两个格子不能建。
//
// 所有尺寸都从 world.js 的契约拿，这里不出现任何魔数。
// 以后换成正式美术资源时，只需要替换 build* 系列的几何与材质，
// 坐标不用动。
// ============================================================

import * as THREE from 'three';
import {
  WORLD_W, WORLD_D, COLS, ROWS, CW, CH, ROOM_X0, ARENA_TOP,
  WALL_WX, CORRIDOR_WX0, ROOM_WX0, ROOM_WX1, ARENA_WZ0, ARENA_WZ1,
  cellCenter, px2len, px2wx, px2wz, LANES, laneDoors,
} from './world.js';

/** 主题色（与 2D 版 HUD 的霓虹紫青一脉相承） */
export const THEME = {
  floor: 0x141a26,
  floorLine: 0x2b3b57,
  buildable: 0x1b2740,
  buildableEdge: 0x3f6ea8,
  bed: 0x4a2f6b,
  bedEdge: 0xa97bff,
  corridor: 0x181c26,
  corridorStripe: 0x33405c,
  wall: 0x39445c,
  wallTop: 0x596a8c,
  gate: 0x8a5a2b,
  gateHot: 0xff9a3c,
  doorway: 0x000000,
};

const BOX = new THREE.BoxGeometry(1, 1, 1);
/** 复用一个单位立方体 + scale 的方式铺格子，40 个格子也只有 1 份几何数据。 */
function slab(w, h, d, color, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.85, metalness: opts.metalness ?? 0.08,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
  });
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(w, h, d);
  m.castShadow = opts.castShadow ?? false;
  m.receiveShadow = opts.receiveShadow ?? true;
  return m;
}

const BED_CELLS = [[7, 1], [7, 2]];

/**
 * 构建整个静态地形。
 * @returns {{group: THREE.Group, cells: Array, doors: Array, gate: THREE.Group}}
 */
export function buildTerrain() {
  const group = new THREE.Group();
  group.name = 'terrain';

  // ── 1. 底板：整个场地垫一层薄薄的暗色地板，防止看到虚空 ──
  group.add(slab(WORLD_W, 0.2, WORLD_D, THEME.floor, { receiveShadow: true })
    .translateX(WORLD_W / 2).translateZ(WORLD_D / 2).translateY(-0.1));

  // ── 2. 走廊：左侧那条带，压暗一点，并用横向条纹标出推进方向 ──
  const corridor = new THREE.Group();
  corridor.name = 'corridor';
  const corrW = WALL_WX - CORRIDOR_WX0;
  corridor.add(slab(corrW, 0.06, ARENA_WZ1 - ARENA_WZ0, THEME.corridor, { receiveShadow: true })
    .translateX(CORRIDOR_WX0 + corrW / 2)
    .translateZ((ARENA_WZ0 + ARENA_WZ1) / 2)
    .translateY(0.03));

  // 推进方向条纹（每 1 米一条，越靠门越亮一点，给个方向暗示）
  const stripeCount = Math.floor(corrW / 1.0);
  for (let i = 0; i < stripeCount; i++) {
    const t = i / Math.max(1, stripeCount - 1);
    const stripe = slab(0.03, 0.07, ARENA_WZ1 - ARENA_WZ0,
      THEME.corridorStripe, { emissive: THEME.corridorStripe, emissiveIntensity: 0.15 + t * 0.35 });
    stripe.translateX(CORRIDOR_WX0 + 0.35 + i * 1.0)
      .translateZ((ARENA_WZ0 + ARENA_WZ1) / 2)
      .translateY(0.035);
    corridor.add(stripe);
  }

  // 走廊上下两条边界矮墙，把三条车道框住，强化「走廊是一条通道」
  for (const [z, name] of [[ARENA_WZ0, 'edgeN'], [ARENA_WZ1, 'edgeS']]) {
    const edge = slab(corrW, 0.35, 0.16, THEME.wall, { emissive: THEME.wallTop, emissiveIntensity: 0.2 });
    edge.name = name;
    edge.translateX(CORRIDOR_WX0 + corrW / 2).translateZ(z).translateY(0.175);
    corridor.add(edge);
  }
  group.add(corridor);

  // ── 3. 车道分隔虚线：三条车道的分界，让「敌人走哪条道」一眼可读 ──
  for (let i = 1; i < LANES.length; i++) {
    const z = px2wz(LANES[i].y0);
    for (let seg = 0; seg < Math.floor(corrW / 0.8); seg++) {
      if (seg % 2 === 1) continue; // 隔一段空一段 = 虚线
      const dash = slab(0.5, 0.05, 0.05, THEME.corridorStripe, { emissive: THEME.corridorStripe, emissiveIntensity: 0.5 });
      dash.translateX(CORRIDOR_WX0 + 0.4 + seg * 0.8).translateZ(z).translateY(0.07);
      group.add(dash);
    }
  }

  // ── 4. 铁门墙：竖直分隔走廊与房间，只留三个门洞 ──
  const gate = new THREE.Group();
  gate.name = 'gate';
  const doors = laneDoors();
  const wallT = px2len(26); // 墙厚
  const arenaDepth = ARENA_WZ1 - ARENA_WZ0;

  // 用「整面墙减去三个洞」的方式拼：先按 Z 排序每个开口，逐段补实体墙
  const openings = doors.map((d) => ({ z0: d.z0, z1: d.z1 })).sort((a, b) => a.z0 - b.z0);
  let cursor = ARENA_WZ0;
  const wallSegs = [];
  for (const op of openings) {
    if (op.z0 > cursor) wallSegs.push([cursor, op.z0]);
    cursor = Math.max(cursor, op.z1);
  }
  if (cursor < ARENA_WZ1) wallSegs.push([cursor, ARENA_WZ1]);

  for (const [z0, z1] of wallSegs) {
    const d = z1 - z0;
    if (d <= 0.001) continue;
    const w = slab(wallT, 0.9, d, THEME.wall, { castShadow: true, emissive: THEME.wallTop, emissiveIntensity: 0.12 });
    w.translateX(WALL_WX).translateZ((z0 + z1) / 2).translateY(0.45);
    gate.add(w);
  }

  // 三个门洞的门框（两侧立柱 + 顶梁），强调「这里是入口」
  for (const d of doors) {
    for (const z of [d.z0, d.z1]) {
      const post = slab(wallT + 0.06, 1.35, 0.1, THEME.gate,
        { emissive: THEME.gateHot, emissiveIntensity: 0.35, castShadow: true });
      post.translateX(WALL_WX).translateZ(z).translateY(0.675);
      gate.add(post);
    }
    const lintel = slab(wallT + 0.06, 0.12, d.z1 - d.z0, THEME.gate,
      { emissive: THEME.gateHot, emissiveIntensity: 0.45, castShadow: true });
    lintel.translateX(WALL_WX).translateZ((d.z0 + d.z1) / 2).translateY(1.32);
    gate.add(lintel);
  }
  // 注意：铁门不开洞，视觉上留空 = 敌人从门洞进入
  void arenaDepth;
  group.add(gate);

  // ── 5. 房间地板：整片深色，再叠 8×5 格子 ──
  const roomW = ROOM_WX1 - ROOM_WX0;
  const roomFloor = slab(roomW, 0.06, arenaDepth, THEME.floor, { receiveShadow: true });
  roomFloor.translateX(ROOM_WX0 + roomW / 2).translateZ((ARENA_WZ0 + ARENA_WZ1) / 2).translateY(0.03);
  group.add(roomFloor);

  const cells = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const c = cellCenter(col, row);
      const isBed = BED_CELLS.some(([bc, br]) => bc === col && br === row);
      const base = slab(c.w * 0.94, 0.08, c.d * 0.94,
        isBed ? THEME.bed : THEME.buildable,
        {
          emissive: isBed ? THEME.bedEdge : THEME.buildableEdge,
          emissiveIntensity: isBed ? 0.5 : 0.22,
          receiveShadow: true,
        });
      base.name = `cell_${col}_${row}`;
      base.position.set(c.x, 0.07, c.z);
      base.userData = { col, row, isBed, type: 'cell' };
      group.add(base);

      // 格子描边：四条细边，比线框更清楚，也方便将来点亮「可建造/已占位」
      const edgeColor = isBed ? THEME.bedEdge : THEME.buildableEdge;
      const ew = c.w * 0.94, ed = c.d * 0.94, t = 0.025;
      const edges = [
        [ew, t, 0, -ed / 2 + t / 2],
        [ew, t, 0, ed / 2 - t / 2],
        [t, ed, -ew / 2 + t / 2, 0],
        [t, ed, ew / 2 - t / 2, 0],
      ];
      for (const [w2, d2, ox, oz] of edges) {
        const e = slab(w2, 0.1, d2, edgeColor, { emissive: edgeColor, emissiveIntensity: 0.8 });
        e.position.set(c.x + ox, 0.075, c.z + oz);
        group.add(e);
      }

      cells.push(base);
    }
  }

  // ── 6. 床：占 (7,1)(7,2)，做成一块抬高一点的方块，一眼看出不能建 ──
  const bedCells = BED_CELLS.map(([c, r]) => cellCenter(c, r));
  const bedW = bedCells[0].w * 0.94;
  const bedD = bedCells[0].d * 0.94 * 2 + 0.02;
  const bedCenterZ = (bedCells[0].z + bedCells[1].z) / 2;
  const bedMesh = slab(bedW, 0.42, bedD, THEME.bed,
    { emissive: THEME.bedEdge, emissiveIntensity: 0.45, castShadow: true, roughness: 0.6 });
  bedMesh.name = 'bed';
  bedMesh.position.set(bedCells[0].x, 0.28, bedCenterZ);
  bedMesh.userData = { type: 'bed', cells: BED_CELLS };
  group.add(bedMesh);

  // ── 7. 房间外框：把可建造区域圈起来，边界感 ──
  const frameT = 0.09, frameH = 0.42;
  const frames = [
    [roomW + frameT, ARENA_WZ0 - frameT / 2],
    [roomW + frameT, ARENA_WZ1 + frameT / 2],
  ];
  for (const [w2, z] of frames) {
    const f = slab(w2, frameH, frameT, THEME.wall, { emissive: THEME.wallTop, emissiveIntensity: 0.25 });
    f.translateX(ROOM_WX0 + roomW / 2).translateZ(z).translateY(frameH / 2);
    group.add(f);
  }
  const eastFrame = slab(frameT, frameH, arenaDepth + frameT * 2, THEME.wall,
    { emissive: THEME.wallTop, emissiveIntensity: 0.25 });
  eastFrame.translateX(ROOM_WX1 + frameT / 2).translateZ((ARENA_WZ0 + ARENA_WZ1) / 2).translateY(frameH / 2);
  group.add(eastFrame);

  return { group, cells, doors, gate };
}

/**
 * 把地形里的某格高亮/熄灭（给第 4 步的建造预览留的接口，这一步先搁着）。
 * @param {THREE.Mesh} cell
 * @param {boolean} on
 */
export function setCellHighlight(cell, on) {
  if (!cell) return;
  const mats = Array.isArray(cell.material) ? cell.material : [cell.material];
  for (const m of mats) {
    m.emissiveIntensity = on ? 1.2 : 0.22;
  }
}
