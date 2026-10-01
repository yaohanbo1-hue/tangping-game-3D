// ============================================================
//  rules/combat.js —— 伤害管线 / 元素反应 / 击杀结算
// ============================================================
//
// 这是第 4 步最核心的一块：把 `core.js` 的伤害规则**完整搬过来**，
// 同时把「表现」抽成一组可选回调。
//
// ── 搬运时做的一件关键改造 ─────────────────────────────────
//
// 2D 版的伤害函数里直接调 `addText()` / `spawnParts()` / `shakeBy()` /
// `SFX.hit()`。这些是渲染+音效，3D 里要换成 Three.js 的做法。
//
// 如果原样搬过来，规则层就被渲染层绑死了 —— 2D→3D 迁移最大的坑。
// 所以这里引入 **fx（表现回调）**：
//
//   const fx = {
//     text(x, y, s, color, big) {},   // 飘字
//     parts(x, y, n, color, spd, life) {},  // 粒子
//     shake(power) {},                // 震屏
//     effect(obj) {},                 // 特效对象
//     sfx(name) {},                   // 音效
//     hitStop(sec) {},                // 命中停顿
//   };
//
// 规则层只负责「在什么时机、以什么参数」发表现请求，不关心怎么画。
// 3D 侧传进来一个用 Three.js 实现的 fx；2D 侧传原来的函数即可。
// **默认 fx 是空实现（no-op）**，所以纯逻辑测试不需要任何渲染环境。
//
// `ctx` 则承载所有「规则需要但不属于敌人自身」的外部状态：
//   { G, fx, onWin, onKill, corridorspan, stats }
//
// 这样规则函数就是 `f(e, ..., ctx)` 的纯形式，可独立测试。
// ============================================================

import { DMG, DMG_KEYS, typeMul, findReaction } from './constants.js';
import { clamp, rnd, distResolved } from './math.js';

/** 从 ctx 取位置解算器（去像素化后敌人没有 x/y，一律走解算器） */
const xyOf = (ctx) => (ctx && ctx.xyOf) || ((e) => ({ x: (e && e.x) || 0, y: (e && e.y) || 0 }));
/** 解算后的位置（用于飘字/粒子的锚点） */
const pos = (e, ctx) => xyOf(ctx)(e);

/** 表现回调的空实现。纯逻辑测试直接用它。 */
export const NULL_FX = {
  text() {}, parts() {}, shake() {}, effect() {}, sfx() {}, hitStop() {},
};

/** 把传入的 fx 与空实现合并，缺哪个补哪个 */
export function makeFx(partial) {
  return Object.assign({}, NULL_FX, partial || {});
}

const DOT_MERGE_INTERVAL = 0.4;   // DoT 飘字合并间隔（秒），与 2D 一致

// ══════════════════════════════════════════════════════════
//  元素反应
// ══════════════════════════════════════════════════════════

/**
 * 在敌人身上叠加一次元素印记；若与已有印记构成反应则触发。
 * @returns {boolean} 是否触发了反应
 */
export function touchElement(e, dtype, baseDmg, ctx) {
  if (!dtype || e.boss || e.dead) return false;
  if (!e.elem) e.elem = {};
  let reacted = null, other = null;
  for (const k in e.elem) {
    if (k !== dtype && e.elem[k] > 0) {
      const rx = findReaction(dtype, k);
      if (rx) { reacted = rx; other = k; break; }
    }
  }
  if (reacted) {
    e.elem[other] = 0;
    e.elem[dtype] = 0;
    ctx.stats.reactions = (ctx.stats.reactions || 0) + 1;
    triggerReaction(e, reacted, baseDmg, ctx);
    return true;
  }
  e.elem[dtype] = 5;
  return false;
}

/**
 * 触发元素反应的连锁效果。**数值逐字搬运自 core.js。**
 */
export function triggerReaction(e, rx, baseDmg, ctx) {
  const fx = ctx.fx;
  const s = ctx.stats;
  const f = baseDmg || 20;
  const p = pos(e, ctx);          // 表现锚点：解算出来的逻辑坐标
  const wave = (ctx.gb && ctx.gb.wave) || (ctx.G && ctx.G.wave) || 1;

  if (rx.id === 'steam') {
    const d = f * 1.6;
    e.hp -= d; s.dmg += d;
    fx.text(p.x, p.y - 30, '💨 蒸汽 ' + Math.round(d), '#e0f2fe', true);
    fx.parts(p.x, p.y, 16, '#e0f2fe', 3, 0.6);
    e.slow = Math.max(e.slow || 0, 0.35);
    e.slowT = 2;
  } else if (rx.id === 'overload') {
    const d = f * 1.2;
    (ctx.enemies || []).forEach((o) => {
      if (!o.dead && distResolved(o, e, ctx.xyOf) < 110) {
        o.hp -= d * 0.8; s.dmg += d * 0.8;
      }
    });
    e.hp -= d; s.dmg += d;
    fx.text(p.x, p.y - 30, '💥 过载 ' + Math.round(d), '#fbbf24', true);
    fx.parts(p.x, p.y, 22, '#fbbf24', 4, 0.6);
    fx.shake(4);
    // 注意 max 字段：缺了它特效层会算出 NaN 半径
    fx.effect({ type: 'boom', x: p.x, y: p.y, r: 110, max: 110, life: 0.35, maxLife: 0.35 });
  } else if (rx.id === 'toxiburn') {
    e.poison = Math.min(16, (e.poison || 0) * 2 + 2);
    e.poisonDps = Math.max(e.poisonDps || 0, 14 + wave * 1.2);
    e.poisonT = 6;
    fx.text(p.x, p.y - 30, '☠️ 毒燃 x' + e.poison, '#a3e635', true);
    fx.parts(p.x, p.y, 14, '#a3e635', 3, 0.6);
  } else if (rx.id === 'superduct') {
    e.vuln = 1.35 + Math.min(0.4, wave * 0.004);
    e.vulnT = 6;
    fx.text(p.x, p.y - 30, '⚡ 超导 易伤', '#67e8f9', true);
    fx.parts(p.x, p.y, 12, '#67e8f9', 3, 0.6);
  } else if (rx.id === 'crystal') {
    e.stun = Math.max(e.stun || 0, 1.6);
    e.slow = 0.8; e.slowT = 2;
    fx.text(p.x, p.y - 30, '🧊 结晶 定身', '#bae6fd', true);
    fx.parts(p.x, p.y, 14, '#bae6fd', 3, 0.6);
  } else if (rx.id === 'corrode') {
    DMG_KEYS.forEach((k) => { e.res[k] = Math.max(0, (e.res[k] || 0) - 0.18); });
    fx.text(p.x, p.y - 30, '🧬 腐蚀 破抗', '#f0abfc', true);
    fx.parts(p.x, p.y, 12, '#f0abfc', 3, 0.6);
  }

  if (e.hp <= 0 && !e.dead) killEnemy(e, ctx);
}

// ══════════════════════════════════════════════════════════
//  伤害管线
// ══════════════════════════════════════════════════════════

/**
 * 统一的伤害入口。所有伤害（子弹/DoT/反应/反伤）都必须走这里，
 * 才能保证护盾、固定减伤、抗性、易伤、统计全部生效。
 *
 * @param {object} e        目标敌人
 * @param {number} dmg      原始伤害
 * @param {string} dtype    伤害类型
 * @param {object} [src]    伤害来源建筑（读 bstat 用于 shred / reflect）
 * @param {boolean} [chain] 内部标记（保留，与 2D 签名一致）
 * @param {boolean} [silent] true = 不触发元素反应、不反伤（DoT 帧用）
 * @returns {number} 实际造成的伤害
 */
export function applyDamage(e, dmg, dtype, src, chain, silent, ctx) {
  if (e.dead) return 0;
  const fx = ctx.fx;
  const s = ctx.stats;
  const gb = ctx.gb || ctx.G || {};
  const tech = gb.tech || {};
  const p = pos(e, ctx);

  const tm = typeMul(e, dtype, tech);
  let d = dmg * tm;

  if (e.flat) d = Math.max(1, d - e.flat);

  if (dtype === 'frost' && src) {
    // src 是建筑 → 用建筑的 bstat（ctx.bstat 由外部注入，缺省回落到 buildings.bstat）
    const st = (ctx.bstat ? ctx.bstat(src) : (src.__ss || null));
    if (st && st.shred) DMG_KEYS.forEach((k) => { e.res[k] = Math.max(0, (e.res[k] || 0) - st.shred * 0.1); });
  }

  // 元素反应：不同伤害类型叠加触发连锁
  if (!silent) touchElement(e, dtype, dmg, ctx);

  if (e.vulnT > 0 && e.vuln > 1) d *= e.vuln;

  // 分阶段护盾（BOSS）：每段血量被打穿时碎一层护盾
  if (e.phaseShield && e.segIdx < e.phaseShield && d > 0) {
    const gate = e.maxHp - e.segMax * (e.segIdx + 1);
    if (e.hp - d <= gate) {
      d = Math.max(0, e.hp - gate);
      e.segIdx++;
      fx.text(p.x, p.y - 46, '🛡 护盾破碎 ' + e.segIdx + '/' + e.phaseShield, '#a8a29e', true);
      fx.parts(p.x, p.y, 26, '#d6d3d1', 4, 0.7);
      fx.shake(6);
      e.stun = Math.max(e.stun || 0, 0.35);
      if (e.state === 'walk') {
        const span = ctx.corridorSpan ? ctx.corridorSpan() : 323;
        e.progress = clamp(e.progress - ctx.shieldKnockback / span, 0, 1);
      }
    }
  }

  // 反伤：DoT 帧不反，否则火焰塔会被镜面梦魇每帧反弹致死
  if (!silent && e.def && e.def.reflect && src && src.def && d > 0) {
    const rb = d * e.def.reflect;
    damageTarget(src, rb, ctx);
    if (Math.random() < 0.3) fx.text(p.x, p.y - 44, '🪞 反弹 ' + Math.round(rb), '#e2e8f0');
  }

  // 吸血
  if (!silent && e.def && e.def.vamp && src && src.def && d > 0) {
    const heal = d * e.def.vamp;
    src.hp = Math.min(src.maxHp, (src.hp || 0) + heal);
  }

  if (d <= 0) return 0;

  e.hp -= d;
  s.dmg += d;
  e.hitFlash = 0.12;

  if (e.hp <= 0) killEnemy(e, ctx);
  return d;
}

/**
 * 对「玩家设施」（门 / 床）造成伤害。
 * 与 applyDamage 分开：设施没有抗性/元素，但有护盾与破门判定。
 */
export function damageTarget(target, dmg, ctx) {
  if (!target || target.broken) return 0;
  const fx = ctx.fx;
  // 设施（门/床）自带 x/y（静态位置）；缺省用 0
  const tx = target.x || 0, ty = target.y || 0;

  // 先扣护盾
  if (target.shield > 0) {
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
    fx.text(tx, ty - 30, '🛡 -' + Math.round(absorbed), '#7fdfff');
    if (target.shield <= 0 && target.shieldMax > 0) {
      fx.parts(tx, ty, 20, '#7fdfff', 3, 0.6);
      fx.shake(4);
    }
  }
  if (dmg <= 0) return 0;

  target.hp -= dmg;
  target.hitFlash = 0.2;

  if (target.hp <= 0) {
    target.hp = 0;
    if (target.isDoor && !target.broken) {
      target.broken = true;
      fx.text(tx, ty - 40, '🚪 铁门被攻破！', '#ff6b81', true);
      fx.shake(14);
      fx.sfx('boom');
    } else if (target.isBed && !target.broken) {
      target.broken = true;
      fx.text(tx, ty - 40, '🛏 床被攻破！', '#ff6b81', true);
      fx.shake(20);
      fx.sfx('boom');
      if (ctx.gameOver) ctx.gameOver();
    }
  }
  return dmg;
}

/**
 * 持续伤害（DoT）。飘字按 DOT_MERGE_INTERVAL 合并，避免每帧刷屏。
 */
export function dotDamage(e, dps, dtype, src, dt, ctx) {
  if (e.dead || !(dps > 0)) return 0;
  const d = applyDamage(e, dps * dt, dtype, src, false, true, ctx);
  if (d > 0 && !e.dead) {
    e.dotAcc = (e.dotAcc || 0) + d;
    e.dotT = (e.dotT || 0) + dt;
    if (e.dotT >= DOT_MERGE_INTERVAL) {
      const col = (DMG[dtype] && DMG[dtype].color) || '#ffd6d6';
      const p = pos(e, ctx);
      ctx.fx.text(p.x + rnd(-5, 5), p.y - (e.r || 14), Math.round(e.dotAcc), col);
      e.dotAcc = 0;
      e.dotT = 0;
      // 合并窗口结束时才叠一次元素印记（否则每帧叠会疯狂触发反应）
      touchElement(e, dtype, dps * DOT_MERGE_INTERVAL, ctx);
    }
  }
  return d;
}

// ══════════════════════════════════════════════════════════
//  击杀结算
// ══════════════════════════════════════════════════════════

/**
 * 击杀处理：连杀、掉落、粒子、BOSS 判定。
 * `ctx.onKill(e)` 是给外部（掉落系统 / 梦境系统）的钩子。
 */
export function killEnemy(e, ctx) {
  if (e.dead) return;
  e.dead = true;
  const fx = ctx.fx;
  const G = ctx.gb || ctx.G;
  const s = ctx.stats;
  const p = pos(e, ctx);

  s.kills++;
  G.combo = (G.combo || 0) + 1;
  G.comboT = 3;
  G.maxCombo = Math.max(G.maxCombo || 0, G.combo);

  if (G.combo === 10 || (G.combo > 10 && G.combo % 10 === 0)) {
    fx.text(p.x, p.y - 44, G.combo + ' 连杀！', '#ffd166', true);
  }

  const gold = e.def.gold * (e.elite ? 2.5 : 1) * ctx.techVal('greed', 0.08) * ((G.event && G.event.eff && G.event.eff.rewardMul) || 1);
  G.gold += gold;
  s.goldTotal = (s.goldTotal || 0) + gold;

  const soulGain = Math.round(
    (e.def.soul + ((G.tech && G.tech.harvest) || 0))
    * ((G.event && G.event.eff && G.event.eff.soulMul) || 1)
    * (e.elite ? 2 : 1)
    * (1 + (G.grow || 0) * 0.02)
    * ctx.techVal('soulstorm', 0.30)
    * ctx.diffSoulMul(),
  );
  G.souls += soulGain;

  if (ctx.onKill) ctx.onKill(e, { gold, soulGain });

  // 击杀粒子
  const pCount = e.boss ? 50 : (e.elite ? 28 : 18);
  const pSpd = e.boss ? 7 : (e.elite ? 4.5 : 3.5);
  fx.parts(p.x, p.y, pCount, e.def.color, pSpd, 0.8);
  fx.parts(p.x, p.y, Math.min(8, pCount / 2), '#fff', pSpd * 1.3, 0.4);

  if (soulGain > 0) {
    for (let i = 0; i < 3; i++) {
      fx.parts(p.x + rnd(-10, 10), p.y + rnd(-10, 10), 1, '#c77dff', 1.5 + i * 0.5, 1.2);
    }
  }

  if (!e.boss && !e.elite) fx.shake(2);
  if (e.boss) fx.hitStop(0.15);
  else if (e.elite) fx.hitStop(0.06);

  fx.text(p.x, p.y - (e.r || 14), '+' + Math.round(gold), '#ffd166');
  if (soulGain) fx.text(p.x + 14, p.y - (e.r || 14) - 14, '+' + soulGain + '🔮', '#c77dff');

  if (e.boss) {
    s.bossKills++;
    fx.shake(18);
    fx.sfx('boom');
    fx.text(p.x, p.y - 50, 'BOSS 击杀！', '#ffd166', true);
    if (e.def.finalBoss && ctx.onFinalBossKilled) ctx.onFinalBossKilled();
  } else if (e.elite) {
    fx.sfx('hit');
  }
}
