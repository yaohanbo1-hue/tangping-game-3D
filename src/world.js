// ============================================================
//  world.js —— 世界坐标契约（2D 逻辑 → 3D 世界的唯一映射点）
// ============================================================
//
// 这是整个 3D 迁移里最关键的一个文件。它只做一件事：
// 把 2D 版里那套「1280×720 像素」翻译成「XZ 平面上的米」。
//
// 为什么要这么做：
//   第 1 步（去像素化）已经把敌人的位置真值源改成了 lane + progress(0→1)。
//   现在只需要把「逻辑像素」整体缩放成「世界单位」，core.js 的战斗规则
//   就能一行不改地跑在 3D 里 —— 因为它从来只认 lane / progress / 格子坐标。
//
// ── 坐标约定（务必记住）────────────────────────────────────
//
//   2D 逻辑坐标          3D 世界坐标
//   ─────────────        ──────────────────────────────
//   x  0 → 1280   ⇒     X  0 → 12.8      （越靠左越外侧，敌人从左进入）
//   y  0 → 720    ⇒     Z  0 → 7.2       （y 是屏幕上下，映射到 Z 的远近）
//   （无）         ⇒     Y  0 = 地面，>0 是高度
//
//   即：**XZ 平面承载原本的 xy，Y 轴专门用来做高度。**
//   这样就得到「俯视一层地面」的视角，和原 2D 版的观感最接近，
//   同时立刻获得了高度维度（炮塔可以抬高、飞行敌人可以真的飞起来）。
//
// ── 为什么是 0.01 ────────────────────────────────────────
//   格子 110×98 像素 → 1.10×0.98 米，接近真实房间的建材尺度，
//   人形单位高约 1.7 米，比例自然，不用再调美术尺度。
//
// ── 与 2D 版的严格一致性 ─────────────────────────────────
//   UNIT 必须是 0.01 而不是「约等于 0.01」，因为 3D 版与 2D 版会做
//   数值对照测试（同一段模拟跑两遍，位置误差 < 1e-6）。
//   一旦改了 UNIT，两形态就不再可比，必须重跑全部回归。
// ============================================================

/** 逻辑像素 → 世界单位的缩放比。1 逻辑像素 = 0.01 世界单位（米）。 */
export const UNIT = 0.01;

/** 2D 逻辑画布尺寸（来自 tangping-game/data.js 的 W / H） */
export const LOGIC_W = 1280;
export const LOGIC_H = 720;

/** 3D 世界的地面尺寸（米） */
export const WORLD_W = LOGIC_W * UNIT; // 12.8
export const WORLD_D = LOGIC_H * UNIT; // 7.2

// ─── 2D 侧几何常量（镜像自 data.js，3D 这边只读不写）───────────
// 刻意在这里**重新声明一份文本值**而不是 import 引擎包：
//   · 引擎包是 600KB 的状态机，只为了几个数字而把它拉进 3D 主线程不划算；
//   · 这些数字是「设计规格」而非「实现细节」，改动频率极低；
//   · 用下面的 assertions 在启动时校验，一旦 2D 侧改了会立刻炸出来，
//     不会出现「悄悄跑偏」的情况。
export const ARENA_TOP = 66;
export const ARENA_BOT = 556;
export const CORRIDOR_X0 = 40;
export const WALL_X = 380;
export const ROOM_X0 = 380;
export const ROOM_X1 = 1260;
export const COLS = 8;
export const ROWS = 5;
export const CW = 110;
export const CH = 98;
export const CORRIDOR_SPAWN_X = 31;
export const WALL_APPROACH_DIST = 26;

/**
 * 三条走廊车道。必须与 data.js 的 LANES 生成逻辑完全一致：
 *   h = (ARENA_BOT - ARENA_TOP) / 3
 *   lane.i.y0 = ARENA_TOP + i * h,  lane.i.doorY = y0 + h / 2
 */
export const LANES = (() => {
  const h = (ARENA_BOT - ARENA_TOP) / 3;
  const a = [];
  for (let i = 0; i < 3; i++) {
    const y0 = ARENA_TOP + i * h;
    a.push({ i, y0, y1: y0 + h, doorY: y0 + h / 2, doorHalf: 40 });
  }
  return a;
})();

// ─── 坐标换算 ──────────────────────────────────────────────

/** 动画坐标 → 世界坐标（XZ 平面） */
export const px2wx = (x) => x * UNIT;
export const px2wz = (y) => y * UNIT;

/** 世界坐标 → 动画坐标（调试/对照用） */
export const wx2px = (wx) => wx / UNIT;
export const wz2py = (wz) => wz / UNIT;

/** 逻辑长度 → 世界长度 */
export const px2len = (px) => px * UNIT;

/**
 * 格子（col,row）→ 格子中心的世界坐标。
 * 与 2D 版 cellRect() 保持同一套像素定义，只是最后乘了 UNIT。
 *
 * @returns {{x:number, z:number, w:number, d:number}} 中心点 + 尺寸（米）
 */
export function cellCenter(col, row) {
  return {
    x: px2wx(ROOM_X0 + col * CW + CW / 2),
    z: px2wz(ARENA_TOP + row * CH + CH / 2),
    w: px2len(CW),
    d: px2len(CH),
  };
}

/** 铁门所在的世界 X（走廊与房间的分界线） */
export const WALL_WX = px2wx(WALL_X);
/** 走廊尽头（画面左边缘内侧）的世界 X */
export const CORRIDOR_WX0 = px2wx(CORRIDOR_X0);
/** 房间的世界 X 范围 */
export const ROOM_WX0 = px2wx(ROOM_X0);
export const ROOM_WX1 = px2wx(ROOM_X1);
/** 竞技区（走廊 + 房间）的世界 Z 范围 */
export const ARENA_WZ0 = px2wz(ARENA_TOP);
export const ARENA_WZ1 = px2wz(ARENA_BOT);

/**
 * 走廊可推进长度（逻辑像素）。必须与 core.js 的 corridorSpan() 一致：
 *   Math.max(1, WALL_X - CORRIDOR_SPAWN_X - WALL_APPROACH_DIST)
 */
export const CORRIDOR_SPAN = Math.max(1, WALL_X - CORRIDOR_SPAWN_X - WALL_APPROACH_DIST);

/**
 * 敌人的 3D 真值源：lane + progress(0→1) → 世界 XZ。
 *
 * ⚠️ 这是 core.js 里 enemyWorldPos() 的 3D 孪生函数。
 *    2D 版返回像素，这里返回米，**换算公式必须逐字对应**，
 *    否则敌人会在 2D（逻辑判定）和 3D（视觉呈现）里出现在两个地方。
 *
 * 注意 progress 允许略大于 1（原版有个 1.002 的正常溢出），
 * 所以这里**不做钳制** —— 钳制是状态机的职责，不是映射层的。
 *
 * @param {{lane:number}} e   敌人对象（只读 lane）
 * @param {number} [progress] 省略时读 e.progress
 * @returns {{x:number, z:number}} 世界坐标
 */
export function enemyWorldPos3D(e, progress) {
  const p = progress !== undefined ? progress : e.progress || 0;
  const L = LANES[e.lane] || LANES[0];
  const px = WALL_X - WALL_APPROACH_DIST - Math.max(0, p) * CORRIDOR_SPAN;
  return { x: px2wx(px), z: px2wz(L.doorY) };
}

/** 进度速度换算（core.js progressSpeed 的镜像，保留以便将来 3D 内模拟） */
export const progressSpeed = (sp) => sp / CORRIDOR_SPAN;

// ─── 走廊与房间的「开口」几何（给建造 mesh 用）─────────────────

/**
 * 每条车道的门洞世界坐标（门框在 WALL_WX 处，开口跨 lane 的 doorY ± doorHalf）。
 * @returns {Array<{z0:number, z1:number, cz:number, half:number}>}
 */
export function laneDoors() {
  return LANES.map((L) => ({
    z0: px2wz(L.doorY - L.doorHalf),
    z1: px2wz(L.doorY + L.doorHalf),
    cz: px2wz(L.doorY),
    half: px2len(L.doorHalf),
  }));
}

/**
 * 启动期自检：3D 侧的几何常量必须和 2D 侧一致。
 *
 * 调用时传入 2D 引擎暴露的常量快照（可选）。若没传，只做内部一致性检查。
 * 这样即使 3D 版独立跑，也能抓到「改了一边忘了另一边」的问题。
 */
export function assertWorldContract(engineSnapshot) {
  const problems = [];

  // 内部一致性：网格必须正好铺满房间区域
  const gridW = COLS * CW;
  const roomW = ROOM_X1 - ROOM_X0;
  if (gridW !== roomW) {
    problems.push(`网格宽度 ${gridW}px 与房间宽度 ${roomW}px 不符（COLS*CW 应等于 ROOM_X1-ROOM_X0）`);
  }

  // 内部一致性：车道必须正好铺满走廊高度且首尾相接
  if (LANES.length !== 3) problems.push(`车道数应为 3，实为 ${LANES.length}`);
  const laneTop = LANES[0].y0;
  const laneBot = LANES[LANES.length - 1].y1;
  if (laneTop !== ARENA_TOP) problems.push(`首条车道顶边 ${laneTop} 应等于 ARENA_TOP ${ARENA_TOP}`);
  if (laneBot !== ARENA_BOT) problems.push(`末条车道底边 ${laneBot} 应等于 ARENA_BOT ${ARENA_BOT}`);
  for (let i = 1; i < LANES.length; i++) {
    if (LANES[i - 1].y1 !== LANES[i].y0) problems.push(`车道 ${i - 1} 与 ${i} 之间有空隙`);
  }

  // 内部一致性：门洞不能超出车道
  for (const L of LANES) {
    if (L.doorY - L.doorHalf < L.y0 || L.doorY + L.doorHalf > L.y1) {
      problems.push(`车道 ${L.i} 的门洞超出了车道范围`);
    }
  }

  // 与 2D 引擎对照（调用方提供快照时）
  if (engineSnapshot) {
    const pairs = [
      ['WALL_X', WALL_X], ['ARENA_TOP', ARENA_TOP], ['ARENA_BOT', ARENA_BOT],
      ['ROOM_X0', ROOM_X0], ['ROOM_X1', ROOM_X1], ['COLS', COLS], ['ROWS', ROWS],
      ['CW', CW], ['CH', CH], ['CORRIDOR_SPAWN_X', CORRIDOR_SPAWN_X],
      ['WALL_APPROACH_DIST', WALL_APPROACH_DIST],
    ];
    for (const [name, mine] of pairs) {
      if (engineSnapshot[name] !== undefined && engineSnapshot[name] !== mine) {
        problems.push(`${name} 不一致：3D 侧 ${mine} vs 引擎侧 ${engineSnapshot[name]}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
