// ============================================================
//  shots.js —— 弹道飞行 + 命中结算
// ============================================================
//
// rules/towers.js 的约定：**有飞行时间的炮塔不自己结算伤害**，
// 而是往 `outShots` 里推一个请求对象：
//
//   { kind:'bullet', from:{x,y}, to:{x,y}, target, spd, r,
//     dmg, crit, towerType, dtype, color, src, range,
//     slow, freezeChance, shred, splash, aoe, knock, sonicStun,
//     poisonStack, poisonDps, poisonMax }
//
// 这些坐标是**逻辑像素**。本文件负责：
//   ① 把它变成一颗在 3D 世界里真的会飞的东西（XZ 位置 + 抛物线高度）
//   ② 目标移动时更新落点（2D 版 updateBullets 里有 b.tx/b.ty 追踪）
//   ③ 到达后调用 rules/towers.js 的 bulletHit() 结算
//
// ── 为什么「飞行」要放在表现层 ──────────────────────────────
//
// 因为飞行时间**会影响伤害总量**（子弹在飞的时候敌人可能死了、
// 可能被别的塔打死了、可能已经撞门了）。如果规则层自己模拟子弹，
// 纯逻辑测试就得连弹道一起跑，而且 3D 侧没法做「视觉上更帅的弹道」。
//
// 现在的切法：
//   · 有 outShots（浏览器）→ 塔只发射请求，子弹由本文件飞
//   · 没有 outShots（纯 Node 测试）→ 塔当场结算伤害
// 两条路都走得通，且**规则层的代码完全一样**。
//
// ⚠️ 高度（Y）纯属表现：逻辑判定全在 XZ 平面做，2D 版没有任何 Z 概念，
//    不能因为「子弹在空中」就漏判命中。
// ============================================================

import * as THREE from 'three';
import { UNIT } from './world.js';
import { bulletHit } from './rules/towers.js';

const MAX_BULLETS = 400;
const MAX_LIFE = 3.0;      // 子弹最长存活（秒），防止目标消失后永久滞留

/** 逻辑像素 → 世界米 */
const w = (px) => px * UNIT;

export function createShotLayer(scene) {
  const geo = new THREE.SphereGeometry(0.5, 8, 6);
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.3, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.6,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_BULLETS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.castShadow = false;
  scene.add(mesh);

  // ── 第 6 步：弹道拖尾 ──
  //
  // 做法：每颗子弹记一小段「最近位置」环形缓冲，渲染成 N 个逐渐变小的
  // 残影球。比真正的拖尾网格（TubeGeometry / 带状 mesh）简单得多，
  // 而且完全不需要重建几何 —— 残影就是同一套球体实例，只是缩得更小、
  // 颜色更暗、越靠后越透明（透明度靠 instanceColor 变暗近似）。
  //
  // ⚠️ 为什么不用「一条拉伸的四边形」：正交相机以 55° 俯视，一条
  //    沿运动方向拉的细长四边形在屏幕上会被压得几乎看不见，
  //    不同方向的弹道看起来宽度还不一样。用残影球序列没有这个问题。
  const TRAIL_PER_BULLET = 4;     // 每颗子弹留 4 个残影
  const TRAIL_MAX = MAX_BULLETS * TRAIL_PER_BULLET;
  const trailMesh = new THREE.InstancedMesh(geo, mat.clone(), TRAIL_MAX);
  trailMesh.material.transparent = true;
  trailMesh.material.opacity = 0.42;
  trailMesh.material.emissiveIntensity = 0.85;
  trailMesh.material.depthWrite = false;
  trailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  trailMesh.frustumCulled = false;
  trailMesh.count = 0;
  trailMesh.renderOrder = 8;
  trailMesh.name = 'bulletTrail';
  scene.add(trailMesh);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  /** 在飞的子弹 */
  const live = [];
  let spawnedTotal = 0, hitsTotal = 0, missedTotal = 0;

  /**
   * 把一帧里规则层发出的弹道请求变成在飞的子弹。
   * @param {Array} shots   rules/towers.js 的 outShots
   * @param {object} gb
   * @param {object} ctx
   */
  function spawn(shots) {
    if (!shots || !shots.length) return;
    for (const s of shots) {
      if (s.kind !== 'bullet') continue;
      if (live.length >= MAX_BULLETS) break;
      live.push({
        s,
        x: w(s.from.x), z: w(s.from.y),
        sx: w(s.from.x), sz: w(s.from.y),
        tx: w(s.to.x), tz: w(s.to.y),
        spd: w(s.spd),          // 逻辑像素/秒 → 米/秒
        t: 0,
        life: 0,
        // 抛物线参数：一段小弧线，视觉上更清楚
        arc: Math.min(0.5, 0.10 + Math.hypot(w(s.to.x - s.from.x), w(s.to.y - s.from.y)) * 0.06),
        color: s.color || '#ffe066',
        // 第 6 步：拖尾残影。索引 0 = 最新，越往后越旧。
        // 只在**有移动时**才记录（见 update），避免静止子弹留下一坨球。
        trail: [],
        trailAcc: 0,
      });
      spawnedTotal++;
    }
  }

  /**
   * 推进所有子弹。命中后调 bulletHit 结算（这才是真正扣血的地方）。
   *
   * @param {number} dt
   * @param {object} gb
   * @param {object} fx
   * @param {object} ctx
   */
  function update(dt, gb, fx, ctx) {
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      const s = b.s;
      b.life += dt;

      // ② 目标还在 → 追踪它的当前位置（对应 2D updateBullets 的 b.tx/b.ty 更新）
      const tgt = s.target;
      const alive = tgt && !tgt.dead;
      if (alive) {
        const p = ctx.xyOf(tgt);
        b.tx = w(p.x); b.tz = w(p.y);
      }

      // 目标没了：让子弹继续飞向「最后一次记住的位置」，
      // 到了就消失（不结算伤害）。对应 2D 里 target 变 dead 后的行为。
      const dx = b.tx - b.x, dz = b.tz - b.z;
      const d = Math.hypot(dx, dz);
      const step = b.spd * dt;

      if (d <= step || d < 1e-6) {
        // ③ 到达 → 结算
        b.x = b.tx; b.z = b.tz;
        if (alive) {
          bulletHit(s, tgt, gb, fx, ctx);
          hitsTotal++;
          if (fx && fx.parts) fx.parts(p2px(b.x), p2px(b.z), 2, b.color, 1.2, 0.22);
        } else {
          missedTotal++;
        }
        live.splice(i, 1);
        continue;
      }

      // 直线推进
      b.x += (dx / d) * step;
      b.z += (dz / d) * step;

      // 第 6 步：记录拖尾。
      // ⚠️ 不能每帧都记 —— 60fps 下 TRAIL_PER_BULLET 个采样点只覆盖
      //    4 帧 ≈ 67ms，拖尾会短到看不见。按**距离**采样（每 6cm 一格）
      //    才能让不同速度的子弹都有长度合理的尾巴：
      //    快的子弹尾巴长、慢的短，这在物理直觉上也是对的。
      b.trailAcc += step;
      const TRAIL_STEP = 0.06;
      if (b.trailAcc >= TRAIL_STEP) {
        b.trailAcc = 0;
        b.trail.unshift({ x: b.x, y: w(26) + Math.sin(k2Of(b) * Math.PI) * b.arc, z: b.z });
        if (b.trail.length > TRAIL_PER_BULLET) b.trail.length = TRAIL_PER_BULLET;
      }

      // 超时保护：目标一直不死又在射程外绕圈的话，别让子弹永久累积
      if (b.life > MAX_LIFE) { live.splice(i, 1); missedTotal++; }
    }

    syncMesh();
  }

  /** 子弹已飞行的抛物线进度 0..1（拖尾 y 要用，抽出来避免重复算） */
  function k2Of(b) {
    const total = Math.hypot(b.tx - b.sx, b.tz - b.sz) || 1;
    const gone = Math.hypot(b.x - b.sx, b.z - b.sz);
    return Math.min(1, gone / total);
  }

  /** 把在飞的子弹写进 InstancedMesh */
  function syncMesh() {
    let n = 0;
    let tn = 0;
    for (const b of live) {
      // 抛物线：总进度 0→1，Y 走一条 sin 弧
      const total = Math.hypot(b.tx - b.sx, b.tz - b.sz) || 1;
      const gone = Math.hypot(b.x - b.sx, b.z - b.sz);
      const k = Math.min(1, gone / total);
      const y = w(26) + Math.sin(k * Math.PI) * b.arc;

      const curScale = Math.max(0.02, (b.s.r || 5) * UNIT * 2.4);

      if (n < MAX_BULLETS) {
        dummy.position.set(b.x, y, b.z);
        dummy.scale.setScalar(curScale);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        col.set(b.color);
        mesh.setColorAt(n, col);
        n++;
      }

      // 拖尾残影：从最近的一个往过去数，逐个变小变暗
      if (b.trail && b.trail.length) {
        for (let i = 0; i < b.trail.length && tn < TRAIL_MAX; i++) {
          const p = b.trail[i];
          // i=0 是最新的残影 → 越大越亮；越往后越小越暗
          const k2 = 1 - (i + 1) / (b.trail.length + 1);   // 1 → 越小
          if (k2 <= 0.05) continue;
          dummy.position.set(p.x, p.y, p.z);
          dummy.scale.setScalar(curScale * (0.28 + k2 * 0.42));
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          trailMesh.setMatrixAt(tn, dummy.matrix);
          // 残影用子弹色压暗，而不是靠 alpha —— instanceColor 是每个实例
          // 自己的、不会和 material.opacity 打架（后者是全局的）。
          col.set(b.color).multiplyScalar(0.32 + k2 * 0.55);
          trailMesh.setColorAt(tn, col);
          tn++;
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    trailMesh.count = tn;
    trailMesh.instanceMatrix.needsUpdate = true;
    if (trailMesh.instanceColor) trailMesh.instanceColor.needsUpdate = true;
  }

  function clear() { live.length = 0; syncMesh(); }

  return {
    mesh, trailMesh, spawn, update, clear,
    get flying() { return live.length; },
    stats() { return { flying: live.length, spawned: spawnedTotal, hits: hitsTotal, missed: missedTotal }; },
  };
}

/** 世界米 → 逻辑像素（给 fx 用；fx 那边会再乘回去） */
const p2px = (m) => m / UNIT;
