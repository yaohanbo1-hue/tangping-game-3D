// ============================================================
//  rules/towers.js —— 炮塔索敌 / 开火（core.js 的规则部分）
// ============================================================
//
// 搬运自 core.js：
//   findTarget()      1327-1339
//   updateTowers()    1340-1417
//   fire_()           1427-1502
//   turnTo()          5-11
//
// ── 与 2D 版最重要的差异：子弹不再是 rule 层的对象 ────────────
//
// 2D 版 `fire_()` 会往 `G.bullets` push 子弹对象，子弹由
// `updateBullets()` 单独推进（碰撞 → 命中 → applyDamage）。
// 那些子弹对象带着 `x/y/tx/ty/spd/crit` —— 是**表现层**的数据。
//
// 3D 侧的处理是：
//   · 规则层只负责「这一帧该不该开火、打谁、做什么伤害结算」
//   · 凡是「需要飞行时间」的炮（机枪/冰霜/毒液/导弹），
//     由规则层发一个**开火请求**（shots 数组）给表现层，
//     表现层自己造弹道并在命中时回调 rules.applyDamage
//   · 瞬发炮（激光/电磁/棱镜/声波/引力/火焰）直接在规则层结算
//
// 这样子弹的飞行、拖尾、命中特效都留在 3D 侧，规则层保持纯净。
// 对「瞬时结算」和「有飞行时间」的区别，用 `s.instant` 之外的方式表达：
// 由炮的 type 决定 —— 见 BALLISTIC_TYPES。
// ============================================================

import {
  BUILD_DEFS, DMG, DMG_KEYS, typeMul, findReaction,
} from './constants.js';
import { bstat, towerDmgMul, towerRateMul, towerRateMulOn, critRoll } from './buildings.js';
import { clamp, dist2D, rnd, distResolved, resolve } from './math.js';
import { applyDamage, dotDamage } from './combat.js';

/**
 * 从 ctx 取位置解算器。规则层**不直接读敌人的 x/y**（去像素化后那是派生量），
 * 一律走 `xyOf(e)`。2D 兼容路径（敌人自带 x/y）由 makeXYResolver 兜底。
 */
const xy = (ctx) => (ctx && ctx.xyOf) || ((e) => ({ x: (e && e.x) || 0, y: (e && e.y) || 0 }));
const distE = (a, b, ctx) => distResolved(a, b, ctx && ctx.xyOf);

/** 需要「飞行时间」的炮：规则层发请求，表现层造弹并回调命中 */
export const BALLISTIC_TYPES = new Set(['turret', 'frost', 'poison', 'missile', 'prism', 'laser', 'tesla']);

/** 子弹飞行速度（像素/秒，core.js:1484） */
export function bulletSpeed(type) {
  if (type === 'frost') return 390;
  if (type === 'missile') return 330;
  if (type === 'poison') return 470;
  return 640;
}
/** 子弹绘制半径（core.js:1485） */
export function bulletRadius(type) {
  if (type === 'frost') return 6;
  if (type === 'missile') return 7;
  return 4;
}

/** 角度插值（core.js:5） */
export function turnTo(from, to, t) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= t) return to;
  return from + Math.sign(d) * t;
}

// ══════════════════════════════════════════════════════════
//  索敌（core.js:1327）
// ══════════════════════════════════════════════════════════

/**
 * 在当前敌群里挑目标。
 *
 * ⚠️ 位置一律通过 `ctx.xyOf(e)` 解算（去像素化后敌人没有 x/y）。
 *    `front` 模式的排序键也是解算后的 x，不再是 `e.x`。
 *
 * @param {object} b      炮塔
 * @param {number} range  射程（逻辑像素）
 * @param {'front'|'strongest'|'weakest'} mode
 * @param {object[]} enemies
 * @param {object} [ctx]  伤害上下文（要拿 xyOf）
 * @returns {object|null}
 */
export function findTarget(b, range, mode, enemies, ctx) {
  const xyOf = xy(ctx);
  let best = null, bv = -1e9;
  for (const e of enemies) {
    if (e.dead || e.untargetable) continue;
    if (distE(e, b, ctx) > range) continue;
    let v;
    if (mode === 'strongest') v = e.hp + (e.boss ? 1e6 : 0);
    else if (mode === 'weakest') v = -e.hp;
    else v = xyOf(e).x - (e.state === 'walk' ? 0 : 600);   // 'front'：走着的按 x 由大到小
    if (v > bv) { bv = v; best = e; }
  }
  return best;
}

// ══════════════════════════════════════════════════════════
//  自动放电（发电机·特斯拉线圈分支，core.js:1346）
// ══════════════════════════════════════════════════════════

export function updateZap(b, s, dt, gb, fx, ctx) {
  if (!s.zapDmg) return;
  b.zcd = (b.zcd || 0) - dt;
  if (b.zcd > 0) return;
  const t = findTarget(b, s.zapRange, 'front', gb.enemies, ctx);
  if (!t) return;
  b.zcd = 1.4;
  applyDamage(t, s.zapDmg * towerDmgMul(b, gb), 'shock', b, false, false, ctx);
  if (fx && fx.effect) {
    const p = xy(ctx)(t);
    fx.effect({ type: 'arc', x: b.x, y: b.y, x2: p.x, y2: p.y, life: 0.2, maxLife: 0.2 });
  }
  if (fx && fx.sfx) fx.sfx('zap');
}

// ══════════════════════════════════════════════════════════
//  火焰喷射（core.js:1355）
// ══════════════════════════════════════════════════════════

function fireFlame(b, s, dt, gb, fx, ctx) {
  const xyOf = xy(ctx);
  const targets = gb.enemies.filter((e) => !e.dead && !e.untargetable && distE(e, b, ctx) <= s.range);
  b.flameOn = targets.length > 0;
  if (targets.length) {
    const p = xyOf(targets[0]);
    b.angle = Math.atan2(p.y - b.y, p.x - b.x);
  }
  const mul = towerDmgMul(b, gb);
  targets.forEach((e) => {
    // 灼烧叠层：仅在持续被喷到期间累积（core.js:1361）
    if (s.stack) e.burnStack = Math.min(5, (e.burnStack || 0) + dt * 1.2);
    e.flameOn = true;
    const d = s.dmg * mul * (1 + (e.burnStack || 0) * 0.35);
    e.burnT = Math.max(e.burnT || 0, 1.4);
    e.burnDmg = Math.max(e.burnDmg || 0, d * 0.5);
    e.burnSrc = b;
    dotDamage(e, d, 'fire', b, dt, ctx);
  });
  if (targets.length && fx && fx.parts && Math.random() < dt * 22) {
    fx.parts(rnd(b.x - 20, b.x + 20), rnd(b.y - 20, b.y + 20), 1, '#ff8c42', 1.4, 0.5);
  }
}

// ══════════════════════════════════════════════════════════
//  引力奇点（core.js:1375）
// ══════════════════════════════════════════════════════════

function fireGravity(b, s, dt, gb, fx, ctx) {
  const xyOf = xy(ctx);
  const targets = gb.enemies.filter((e) => !e.dead && !e.untargetable && distE(e, b, ctx) <= s.range);
  b.gravOn = targets.length > 0;
  const gm = s.dmg * towerDmgMul(b, gb);
  targets.forEach((e) => {
    const p = xyOf(e);
    const dx = b.x - p.x, dy = b.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    // ⚠️ 引力是 2D 里唯一一处「战斗中改坐标」的例外（把敌人往塔拉）。
    //    去像素化后位置真值源是 lane+progress，所以这里改为交给外部换算：
    //      ctx.pullProgress(e, amount)  —— 沿走廊拉回（board.js 实现）
    //    **不再保留改 e.x/e.y 的回落路径** —— 那会给敌人凭空添上 x/y 字段，
    //    而规则层的距离判定走 xyOf，会优先读这两个假坐标，
    //    于是「敌人在哪」出现两套真相。宁可什么都不做也不能写假坐标。
    //    （verify-imports.mjs 的边界 5 会拦下这种写法。）
    if (d > 26) {
      const sp = s.pull * dt * (e.boss ? 0.28 : 1);
      if (ctx.pullProgress) ctx.pullProgress(e, sp);
    }
    e.slow = Math.max(e.slow || 0, s.gravSlow);
    e.slowT = Math.max(e.slowT || 0, 0.4);
    dotDamage(e, gm, 'energy', b, dt, ctx);
  });
  if (targets.length && fx && fx.parts && Math.random() < dt * 14) {
    fx.parts(rnd(b.x - 16, b.x + 16), rnd(b.y - 16, b.y + 16), 1, '#818cf8', 1.3, 0.5);
  }
}

// ══════════════════════════════════════════════════════════
//  开火（core.js:1427 fire_）
// ══════════════════════════════════════════════════════════

/**
 * 一次开火结算。瞬发炮直接打，弹道炮把请求写进 outShots。
 *
 * @param {object} b   炮塔
 * @param {object} t   目标
 * @param {object} s   面板属性
 * @param {object} gb  game board
 * @param {object} fx  表现回调
 * @param {object} ctx 伤害上下文
 * @param {Array}  outShots 弹道请求收集器（表现层消费）
 */
export function fire_(b, t, s, gb, fx, ctx, outShots) {
  const xyOf = xy(ctx);
  const mul = towerDmgMul(b, gb);
  const dtype = b.def.dmgType;
  b.recoil = 1;
  b.fireFx = 0.2;

  // ── 激光：穿透一条直线（core.js:1432）──
  if (b.type === 'laser') {
    const shots = s.multi || 1;
    let list = [t];
    if (shots > 1) {
      list = gb.enemies
        .filter((e) => !e.dead && !e.untargetable && distE(e, b, ctx) <= s.range)
        .sort((p, q) => distE(p, b, ctx) - distE(q, b, ctx)).slice(0, shots);
    }
    list.forEach((tg) => {
      const tp = xyOf(tg);
      if (fx && fx.effect) fx.effect({ type: 'laser', x: b.x, y: b.y, x2: tp.x, y2: tp.y, life: 0.18, maxLife: 0.18, color: '#ff5d8f' });
      let hits = 0;
      const ang = Math.atan2(tp.y - b.y, tp.x - b.x);
      const sorted = gb.enemies.filter((e) => !e.dead).sort((p, q) => distE(p, b, ctx) - distE(q, b, ctx));
      for (const e of sorted) {
        if (hits >= (s.pierce || 1)) break;
        const ep = xyOf(e);
        const a2 = Math.atan2(ep.y - b.y, ep.x - b.x);
        if (Math.abs(Math.atan2(Math.sin(a2 - ang), Math.cos(a2 - ang))) < 0.24 && distE(e, b, ctx) <= s.range + 40) {
          applyDamage(e, s.dmg * mul * critRoll(b, gb), dtype, b, false, false, ctx);
          hits++;
        }
      }
    });
    if (fx && fx.sfx) fx.sfx('laser');
    return;
  }

  // ── 电磁：连锁跳跃（core.js:1453）──
  if (b.type === 'tesla') {
    let cur = t;
    const hit = new Set([t]);
    const chain = [t];
    for (let i = 1; i < (s.chain || 3); i++) {
      let nx = null, nd = 210;
      for (const e of gb.enemies) {
        if (e.dead || hit.has(e)) continue;
        const d = distE(e, cur, ctx);
        if (d < nd) { nd = d; nx = e; }
      }
      if (!nx) break;
      hit.add(nx); chain.push(nx); cur = nx;
    }
    let px = b.x, py = b.y;
    chain.forEach((e, i) => {
      const ep = xyOf(e);
      if (fx && fx.effect) fx.effect({ type: 'arc', x: px, y: py, x2: ep.x, y2: ep.y, life: 0.22, maxLife: 0.22 });
      applyDamage(e, s.dmg * mul * Math.pow(0.84, i), dtype, b, false, false, ctx);
      if (s.stun) e.stun = Math.max(e.stun || 0, s.stun * (e.boss ? 0.4 : 1));
      if (s.splash) {
        gb.enemies.forEach((o) => {
          if (!o.dead && !hit.has(o) && distE(o, e, ctx) < s.splash) applyDamage(o, s.dmg * mul * 0.5, dtype, b, false, false, ctx);
        });
      }
      px = ep.x; py = ep.y;
    });
    if (fx && fx.sfx) fx.sfx('zap');
    return;
  }

  // ── 棱镜：同时打 N 个随机目标（core.js:1472）──
  if (b.type === 'prism') {
    const n = s.split || 3;
    const pool = gb.enemies.filter((e) => !e.dead && !e.untargetable && distE(e, b, ctx) <= s.range);
    const tg = pool.length <= n ? pool : pool.sort(() => Math.random() - 0.5).slice(0, n);
    if (!tg.length) tg.push(t);
    tg.forEach((e) => {
      const ep = xyOf(e);
      if (fx && fx.effect) fx.effect({ type: 'laser', x: b.x, y: b.y, x2: ep.x, y2: ep.y, life: 0.16, maxLife: 0.16, color: '#67e8f9' });
      applyDamage(e, s.dmg * mul * critRoll(b, gb), dtype, b, false, false, ctx);
    });
    if (fx && fx.sfx) fx.sfx('laser');
    return;
  }

  // ── 默认：发射弹道（core.js:1482）──
  const nm = s.multi || 1;
  const spd = bulletSpeed(b.type);
  const br = bulletRadius(b.type);
  const tp = xyOf(t);
  for (let i = 0; i < nm; i++) {
    if (outShots) {
      outShots.push({
        kind: 'bullet',
        from: { x: b.x, y: b.y }, to: { x: tp.x, y: tp.y }, target: t,
        spd, r: br,
        dmg: s.dmg * mul, crit: critRoll(b, gb),
        towerType: b.type, dtype, color: b.def.color, src: b,
        range: s.range,
        // 命中时要施加的附带效果
        slow: s.slow || 0, freezeChance: s.freezeChance || 0, shred: s.shred || 0,
        splash: s.splash || 0, aoe: !!s.aoe, knock: s.knock || 0, sonicStun: s.sonicStun || 0,
        poisonStack: s.poison ? 1 : 0, poisonDps: s.poisonDps || 0, poisonMax: s.maxStack || 0,
      });
    } else {
      // 无表现层（纯逻辑测试）：直接瞬时结算
      applyDamage(t, s.dmg * mul, dtype, b, false, false, ctx);
    }
  }
  if (fx && fx.sfx) fx.sfx('shoot');
  if (fx && fx.parts) {
    const tipX = b.x + Math.cos(b.angle) * 28;
    const tipY = b.y + Math.sin(b.angle) * 28;
    fx.parts(tipX, tipY, 3, b.def.color, 1.2, 0.25);
  }
}

/**
 * 子弹命中结算（供表现层在弹道到达时回调）。
 * 对应 2D 版 updateBullets 里的命中分支。
 */
export function bulletHit(shot, hitEnemy, gb, fx, ctx) {
  const dtype = shot.dtype;
  const xyOf = xy(ctx);
  const d = applyDamage(hitEnemy, shot.dmg * (shot.crit || 1), dtype, shot.src, false, false, ctx);
  // 附带效果
  if (shot.slow > 0) { hitEnemy.slow = Math.max(hitEnemy.slow || 0, shot.slow); hitEnemy.slowT = Math.max(hitEnemy.slowT || 0, 2); }
  if (shot.freezeChance && Math.random() < shot.freezeChance) hitEnemy.stun = Math.max(hitEnemy.stun || 0, 1.0);
  if (shot.poisonStack) {
    hitEnemy.poison = Math.min(shot.poisonMax || 8, (hitEnemy.poison || 0) + shot.poisonStack);
    hitEnemy.poisonDps = Math.max(hitEnemy.poisonDps || 0, shot.poisonDps);
    hitEnemy.poisonT = 6;
  }
  const hp = xyOf(hitEnemy);
  if (shot.splash > 0) {
    gb.enemies.forEach((o) => {
      if (!o.dead && o !== hitEnemy && distE(o, hitEnemy, ctx) < shot.splash) {
        applyDamage(o, shot.dmg * (shot.crit || 1) * 0.6, dtype, shot.src, false, false, ctx);
      }
    });
    if (fx && fx.effect) fx.effect({ type: 'boom', x: hp.x, y: hp.y, r: shot.splash, max: shot.splash, life: 0.3, maxLife: 0.3 });
    if (fx && fx.shake) fx.shake(3);
  }
  if (shot.aoe) {
    // 声波：全范围打击 + 击退 + 眩晕
    const origin = shot.src || hitEnemy;
    const all = gb.enemies.filter((e) => !e.dead && !e.untargetable && distE(e, origin, ctx) <= (shot.range || 400));
    all.forEach((e) => {
      applyDamage(e, shot.dmg * (shot.crit || 1), dtype, shot.src, false, false, ctx);
      if (shot.knock && ctx.knockProgress) {
        const ctrl = e.boss ? 0.25 : 1;
        ctx.knockProgress(e, shot.knock * ctrl);
      }
      if (shot.sonicStun) e.stun = Math.max(e.stun || 0, shot.sonicStun * (e.boss ? 0.25 : 1));
    });
  }
  return d;
}

// ══════════════════════════════════════════════════════════
//  炮塔主循环（core.js:1340）
// ══════════════════════════════════════════════════════════

/**
 * 每固定步进一次所有炮塔。
 *
 * @param {number} dt
 * @param {object} gb   game board
 * @param {object} fx   表现回调
 * @param {object} ctx  伤害上下文（见 combat.js）
 * @param {Array}  outShots 弹道请求收集器（可为 null）
 * @returns {Array} outShots
 */
export function updateTowers(dt, gb, fx, ctx, outShots) {
  const shots = outShots || [];
  for (const b of gb.buildings) {
    const s = bstat(b, gb);
    b.pulse += dt;
    if (b.empT > 0) { b.empT -= dt; continue; }   // 瘫痪：主火力与自动放电一起停

    updateZap(b, s, dt, gb, fx, ctx);

    if (!b.def.tower) continue;
    if (b.freezeT > 0) b.freezeT -= dt;

    if (b.type === 'flame') { fireFlame(b, s, dt, gb, fx, ctx); continue; }
    if (s.gravity) { fireGravity(b, s, dt, gb, fx, ctx); continue; }

    const rate = (s.rate || 1) * towerRateMul(gb) * towerRateMulOn(b, gb);
    b.cd -= dt * rate;
    if (b.cd > 0) continue;

    const mode = b.type === 'laser' ? 'strongest' : 'front';
    const t = findTarget(b, s.range, mode, gb.enemies, ctx);
    if (!t) { b.cd = 0; b.idle = (b.idle || 0) + dt; continue; }
    b.cd = 1;
    b.idle = 0;
    {
      const tp = xy(ctx)(t);
      b.angle = turnTo(b.angle, Math.atan2(tp.y - b.y, tp.x - b.x), dt * 14);
    }

    // ── 全范围声波（core.js:1398）──
    if (s.aoe) {
      const mul = towerDmgMul(b, gb);
      const all = gb.enemies.filter((e) => !e.dead && !e.untargetable && distE(e, b, ctx) <= s.range);
      all.forEach((e) => {
        applyDamage(e, s.dmg * mul * critRoll(b, gb), 'kinetic', b, false, false, ctx);
        const ctrl = e.boss ? 0.25 : 1;
        // 击退同理：只走 ctx.knockProgress（改 progress），不写 e.x/e.y。
        // 详见 fireGravity 里的长注释。
        if (s.knock && ctx.knockProgress) ctx.knockProgress(e, s.knock * ctrl);
        if (s.sonicStun) e.stun = Math.max(e.stun || 0, s.sonicStun * ctrl);
      });
      if (fx && fx.effect) fx.effect({ type: 'ring', x: b.x, y: b.y, r: s.range, life: 0.3, maxLife: 0.3, color: '#f0abfc' });
      b.fireFx = 0.25; b.recoil = 1;
      if (fx && fx.parts) fx.parts(b.x, b.y, 5, b.def.color, 1.5, 0.3);
      if (fx && fx.sfx) fx.sfx('shoot');
      continue;
    }

    // ⚠️ 这里必须把 **原来的 outShots** 传下去，不能传 `shots`。
    //    `shots` 是 `outShots || []` 的兜底副本：当 outShots 为 null 时它是个
    //    丢弃用的真值数组。若把它传给 fire_，fire_ 里 `if (outShots)` 会成立，
    //    于是把弹道请求塞进垃圾桶、走不到「瞬时结算」分支 —— 结果就是
    //    炮塔每帧都 `b.cd = 1`（有射速、有转向）但伤害恒为 0。
    //    传 null 才会让 fire_ 走纯逻辑通道。
    fire_(b, t, s, gb, fx, ctx, outShots);
  }
  return shots;
}

// 供表现层按需引用
export { DMG, DMG_KEYS, typeMul, findReaction, bstat, towerDmgMul, critRoll };
