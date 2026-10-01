// ============================================================
//  rules/math.js —— 规则层用到的纯数学工具
// ============================================================
//
// 从 2D 版搬到这里的四个基础函数。它们看似简单，但被上百处调用，
// 语义必须逐字一致（尤其是 rnd 的闭开区间与 dist 的欧氏距离）。
//
// ⚠️ 3D 侧的 `dist` 有两个版本：
//   · dist2D(a, b)   —— 比较「逻辑坐标」(x,y)，与 2D 版 dist 完全一致，
//                       用于射程判定（射程是逻辑像素，与画面无关）
//   · distXZ(a, b)   —— 比较世界坐标 (x,z)，供 3D 表现层用
//   战斗逻辑**必须**用 dist2D，否则射程会随 UNIT 的改动而变。
// ============================================================

/** 钳制到 [lo, hi] */
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** [a, b) 区间随机（与 2D 版一致：下闭上开） */
export function rnd(a, b) { return a + Math.random() * (b - a); }

/** 2D 逻辑坐标距离。战斗射程判定用这个。 */
export function dist2D(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  return Math.hypot(dx, dy);
}

/** 3D 世界坐标距离（XZ 平面）。仅表现层/调试用。 */
export function distXZ(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dz);
}

/** 从数组随机取一个 */
export function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

// ══════════════════════════════════════════════════════════
//  逻辑坐标解算器（去像素化的关键适配层）
// ══════════════════════════════════════════════════════════
//
// 第 4 步把 core.js 的规则搬过来后遇到一个绕不开的问题：
//
//   core.js 的索敌/射程/引力/击退全靠 `dist(e, b)` 读敌人的 e.x/e.y。
//   但去像素化之后，敌人**没有** e.x/e.y —— 位置是 lane + progress 派生量。
//
// 直接在规则层读 e.x 会全变 undefined → dist 退化成 |b.x|（巨大），
// 表现就是「塔一座也不开火」（verify-combat 的 D 段第一版就踩了这个坑）。
//
// 解法：规则层不直接读坐标，而是通过一个 **位置解算器** 取：
//   · 给敌人一个 `xyOf(e)` → {x, y}
//   · 给建筑用建筑自己的 b.x / b.y（建筑本来就是网格位置，是静态的）
//
// `xyOf` 由调用方注入（3D 侧传 enemyWorldPos 的逆映射，2D 侧直接返回 e.x/e.y），
// 这样规则层既不写坐标、也不假设坐标从哪来。

/**
 * 造一个「敌人 → 逻辑像素坐标」的解算器。
 *
 * @param {(e:object)=>{x:number,y:number}} resolver
 * @returns {(e:object)=>{x:number,y:number}}
 */
export function makeXYResolver(resolver) {
  if (typeof resolver === 'function') return resolver;
  // 兜底：敌人自带 x/y（2D 兼容路径）
  return (e) => ({ x: (e && e.x) || 0, y: (e && e.y) || 0 });
}

/**
 * 两个「带位置」对象之间的距离。
 * 与 dist2D 的区别：位置通过 `xyOf` 解算，而不是直接读 .x/.y。
 *
 * @param {object} a
 * @param {object} b
 * @param {(e:object)=>{x:number,y:number}} [xyOf] 敌人位置解算器（缺省则读 .x/.y）
 */
export function distResolved(a, b, xyOf) {
  const pa = resolve(a, xyOf);
  const pb = resolve(b, xyOf);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** 取一个对象的位置：建筑直接读，敌人走解算器 */
export function resolve(o, xyOf) {
  if (!o) return { x: 0, y: 0 };
  // 建筑/门/床：自带 x/y（网格静态位置）
  if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
  // 敌人：交给解算器
  if (xyOf) return xyOf(o);
  return { x: 0, y: 0 };
}

/** 加权随机：w 为权重数组，返回下标 */
export function weightedIndex(weights) {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}
