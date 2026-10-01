// ============================================================
//  rules/buildings.js —— 建筑面板属性（bstat）/ 生命公式 / 经济
// ============================================================
//
// 搬运自 core.js：
//   bstat()            366-385   面板属性（等级 → 实战数值）
//   buildingMaxHp()    248-250
//   doorMaxHp()        252-254
//   bedMaxHp()         256-258
//   totalGoldRate()    444-449
//   powerInfo()        450-454
//   towerDmgMul()      496-520   与 towers.js 共用，这里定义
//   towerRateMul*()    521-537
//   critRoll()         1418-1426
//   upgradeCost 等     见 constants.js
//
// ── 关键改造：把「全局 G」换成显式传入的 `gb`（game board）─────
//
// 2D 版这些函数全靠闭包里的全局 `G`。搬到 3D 后如果照抄，
// 规则层又会被一个单例绑死、且无法单测。所以统一收成一个 `gb`
// （game board 快照）参数：
//
//   gb = {
//     tech,          // 科技等级 { firepower, rapid, crit, ... }
//     buildings,     // 建筑数组（每个含 type/def/level/branch/runes/hp/maxHp）
//     enemies,       // 敌人数组（towerDmgMul 要查虚无光环）
//     buff,          // { overclock, freeze, goldBoost, dmgBoost }
//     fate, fateWave, melodyBuff,
//     prize,         // 道具加成 { dmg, hp, reward }
//     event,         // 事件 { eff: { goldMul, powerMul } }
//     bed,           // { lv }
//     diff,          // 难度配置（goldMul）
//     grow,
//   }
//
// 这样 `bstat(b, gb)` 就是纯函数，2D/3D 都能调，且可单测。
//
// ⚠️ 缓存：2D 版用 `statFrame` 做「同帧复用」（每帧 bstat 被调 4~6 次）。
//    3D 侧同样保留，但把帧号也塞进 gb（gb.statFrame），
//    这样测试里手动 +1 即可模拟新帧，不需要任何全局状态。
// ============================================================

import { BUILD_DEFS, DMG_KEYS, DOOR_HP_BASE, BED_HP_BASE, upgradeCost, BRANCH_AT } from './constants.js';
import { clamp, dist2D } from './math.js';

// ══════════════════════════════════════════════════════════
//  科技加成辅助
// ══════════════════════════════════════════════════════════

/** 科技加成：1 + tech[k] * per（core.js:358，签名里显式传 tech 而不是读全局 G） */
export function techVal(gb, k, per) {
  return 1 + (((gb && gb.tech && gb.tech[k]) || 0) * per);
}

// ══════════════════════════════════════════════════════════
//  符文词条（data.js:541 RUNE_AFFIXES）
// ══════════════════════════════════════════════════════════

export const RUNE_AFFIXES = {
  dmg: { name: '伤害', icon: '💥', base: 7, apply: (s, v) => { if (s.dmg != null) s.dmg *= 1 + v / 100; } },
  rate: { name: '射速', icon: '⏩', base: 6, apply: (s, v) => { if (s.rate != null) s.rate *= 1 + v / 100; } },
  range: { name: '射程', icon: '🎯', base: 5, apply: (s, v) => { if (s.range != null) s.range *= 1 + v / 100; } },
  crit: { name: '暴击率', icon: '✨', base: 4, apply: (s, v) => { s.crit = (s.crit || 0) + v / 100; } },
  critDmg: { name: '暴击伤害', icon: '💫', base: 16, apply: (s, v) => { s.critDmg = (s.critDmg || 2.2) + v / 100; } },
  pierce: { name: '穿透', icon: '➡️', base: 1, apply: (s, v) => { if (s.pierce != null) s.pierce += v; } },
  slow: { name: '减速', icon: '❄️', base: 5, apply: (s, v) => { if (s.slow != null) s.slow = Math.min(0.85, s.slow + v / 100); } },
  gold: { name: '金币产出', icon: '💰', base: 11, apply: (s, v) => { if (s.gold != null) s.gold *= 1 + v / 100; } },
  regen: { name: '发电量', icon: '⚡', base: 13, apply: (s, v) => { if (s.regen != null) s.regen *= 1 + v / 100; } },
};
export const RUNE_AFFIX_KEYS = Object.keys(RUNE_AFFIXES);

/** 符文等级倍率（data.js:574）：1 + lv*0.12 */
export const runeMul = (r) => 1 + ((r && r.lv) || 0) * 0.12;
/** 单条词条的实际数值（data.js:575，保留一位小数） */
export const affixVal = (r, a) => Math.round(a.v * runeMul(r) * 10) / 10;

// ══════════════════════════════════════════════════════════
//  面板属性 bstat（core.js:366）
// ══════════════════════════════════════════════════════════

/**
 * 建筑面板属性 = stat(level) ⊕ 分支 mod ⊕ 符文词条 ⊕ 科技 ⊕ 道具。
 *
 * 调用频率极高（渲染每帧每建筑一次、开火时 towerDmgMul 又遍历一遍），
 * 所以保留 2D 版的「同帧缓存」：`gb.statFrame` 不变时复用 `b.__ss`。
 *
 * @param {object} b   建筑
 * @param {object} gb  game board 快照（见文件头）
 * @returns {object} 面板数值对象（每次可能返回同一个引用，调用方不要改）
 */
export function bstat(b, gb) {
  const frame = (gb && gb.statFrame) || 0;
  if (b.__sf === frame && b.__ss) return b.__ss;

  const s = b.def.stat(b.level);
  const base = (b.branch && b.def.branch && b.def.branch[b.branch])
    ? b.def.branch[b.branch].mod(s, b)
    : s;

  // 符文词条
  if (b.runes && b.runes.length) {
    const rm = 1 + (((gb && gb.tech && gb.tech.runemaster) || 0) * 0.15);
    b.runes.forEach((r) => {
      if (!r) return;
      r.affixes.forEach((a) => {
        const A = RUNE_AFFIXES[a.k];
        if (A) A.apply(base, affixVal(r, a) * rm);
      });
    });
  }

  // 科技 / 道具
  if (base.range != null) base.range *= techVal(gb, 'focus', 0.06);
  if (base.dmg != null && gb && gb.prize && gb.prize.dmg) base.dmg *= gb.prize.dmg;
  if (base.rate != null) base.rate *= techVal(gb, 'swift', 0.08);

  b.__sf = frame; b.__ss = base;
  return base;
}

/** 让某建筑的面板属性缓存失效（升级/转职/换符文后调用） */
export function invalidateBstat(b) { if (b) { b.__sf = -1; b.__ss = null; } }
/** 让全部建筑缓存失效 */
export function invalidateAllBstat(gb) {
  (gb && gb.buildings || []).forEach(invalidateBstat);
}

// ══════════════════════════════════════════════════════════
//  生命值公式（core.js:245-258，唯一来源）
// ══════════════════════════════════════════════════════════

/** 道具提供的生命倍率 */
const prizeHpMul = (gb) => (gb && gb.prize && gb.prize.hp) || 1;

/** 建筑生命总倍率：加固工程 × 生命强化 × 不朽要塞 × 道具 */
export function buildingHpMul(gb) {
  return techVal(gb, 'structure', 0.12) * techVal(gb, 'vitality', 0.10)
    * techVal(gb, 'fortress', 0.50) * prizeHpMul(gb);
}

/** 建筑最大生命 = def.hp × (1+(lv-1)*0.35) × 总倍率 × 转职 1.3（core.js:248） */
export function buildingMaxHp(def, level, branch, gb) {
  return def.hp * (1 + (Math.max(1, level) - 1) * 0.35) * buildingHpMul(gb) * (branch ? 1.3 : 1);
}

/** 铁门最大生命（core.js:252）：(420 + 200*(lv-1)) × 铁壁 × 要塞 × 道具 */
export function doorMaxHp(lv, gb) {
  return (DOOR_HP_BASE + 200 * (Math.max(1, lv) - 1))
    * techVal(gb, 'ironwall', 0.15) * techVal(gb, 'fortress', 0.50) * prizeHpMul(gb);
}

/** 床铺最大生命（core.js:256）：(420 + 95*(lv-1)) × 要塞 × 道具 */
export function bedMaxHp(lv, gb) {
  return (BED_HP_BASE + 95 * (Math.max(1, lv) - 1))
    * techVal(gb, 'fortress', 0.50) * prizeHpMul(gb);
}

// ══════════════════════════════════════════════════════════
//  经济（core.js:442-455）
// ══════════════════════════════════════════════════════════

/** 床铺每秒产出金币（core.js:442）：8 × 2^(lv-1) */
export const bedGold = (lv) => 8 * Math.pow(2, Math.max(1, lv) - 1);

/**
 * 金币总产出速率（core.js:444）。
 * = (床铺 ⊕ 各矿机) × 经济头脑 × 复利奇迹 × 事件 × 黄金增益 × 难度
 */
export function totalGoldRate(gb) {
  const bed = bedGold(gb.bed ? gb.bed.lv : 1) * techVal(gb, 'sleep', 0.12) * techVal(gb, 'eternity', 0.60);
  let r = bed;
  (gb.buildings || []).forEach((b) => {
    if (b.type === 'miner') r += (bstat(b, gb).gold || 0) * techVal(gb, 'mining', 0.10);
  });
  const evMul = (gb.event && gb.event.eff && gb.event.eff.goldMul) || 1;
  const boost = (gb.buff && gb.buff.goldBoost) ? 2 : 1;
  const diffMul = (gb.diff && gb.diff.goldMul) || 1;
  return r * techVal(gb, 'economy', 0.07) * techVal(gb, 'compound', 0.25) * evMul * boost * diffMul;
}

/** 电力净产出（core.js:450）：Σ 发电 × 电力工程 × 超频核心 × 事件 */
export function powerInfo(gb) {
  let regen = 0;
  (gb.buildings || []).forEach((b) => { const s = bstat(b, gb); if (s.regen) regen += s.regen; });
  const evMul = (gb.event && gb.event.eff && gb.event.eff.powerMul) || 1;
  return { regen: regen * techVal(gb, 'electric', 0.12) * techVal(gb, 'overcore', 0.40) * evMul };
}

// ══════════════════════════════════════════════════════════
//  炮塔倍率（core.js:496-537）
// ══════════════════════════════════════════════════════════

/**
 * 某炮塔的伤害总倍率（core.js:496）。
 * 火力强化 × 湮灭协议 × 虚无光环削弱 × 聚能塔增幅 × buff × 血怒 × 共鸣 × 命运 × 旋律
 *
 * ⚠️ 2D 版最后还有一段 DeepDream 修正，3D 侧暂未接入深层梦境系统，
 *    用 `gb.deepDream` 可选对象替代（未传即跳过），行为与「未激活」一致。
 */
export function towerDmgMul(b, gb) {
  let m = techVal(gb, 'firepower', 0.08) * techVal(gb, 'annihilation', 0.20);

  // 虚无梦魇光环：附近炮塔伤害大幅降低
  (gb.enemies || []).forEach((e) => {
    if (e.dead || !e.def || !e.def.nullify) return;
    if (dist2D(e, b) <= e.def.nullify.range) m *= e.def.nullify.mul;
  });

  // 聚能塔相邻增幅
  (gb.buildings || []).forEach((o) => {
    if (o.type === 'amp' && dist2D(o, b) <= bstat(o, gb).range + 30) m += bstat(o, gb).bonus;
  });

  if (gb.buff && gb.buff.overclock > 0) m *= 1.5;
  if (gb.buff && gb.buff.dmgBoost) m *= 1.6;

  // 血怒：建筑残血时伤害提升
  const berserk = (gb.tech && gb.tech.berserk) || 0;
  if (berserk > 0 && b.hp < b.maxHp * 0.4) m *= 1 + berserk * 0.25;

  if (b.resDmg) m *= b.resDmg;

  const fate = gb.fate || {}, fateW = gb.fateWave || {};
  m *= 1 + (fate.dmg || 0) + (fateW.dmg || 0);
  if (gb.melodyBuff && gb.melodyBuff.dmgMul) m *= gb.melodyBuff.dmgMul;
  if (gb.deepDream && gb.deepDream.active && gb.deepDream.dmgMul) m *= gb.deepDream.dmgMul;

  return m;
}

/** 单塔射速修正（core.js:521）：冻结 × 共鸣 × 深层梦境 */
export function towerRateMulOn(b, gb) {
  let m = 1;
  if ((b.freezeT || 0) > 0) m *= 0.4;
  if (b.resRate) m *= b.resRate;
  if (gb.deepDream && gb.deepDream.active && gb.deepDream.rateMul) m *= gb.deepDream.rateMul;
  return m;
}

/** 全局射速修正（core.js:531）：急速射击 × 超频 × 命运 × 旋律 */
export function towerRateMul(gb) {
  let m = techVal(gb, 'rapid', 0.05);
  if (gb.buff && gb.buff.overclock > 0) m *= 1.8;
  const fate = gb.fate || {}, fateW = gb.fateWave || {};
  m *= 1 + (fate.rate || 0) + (fateW.rate || 0);
  if (gb.melodyBuff && gb.melodyBuff.rateMul) m *= gb.melodyBuff.rateMul;
  return m;
}

/**
 * 暴击判定（core.js:1418）。
 * @returns {number} 暴击则返回倍率（>=2.2），否则 1
 */
export function critRoll(b, gb, rand) {
  const R = rand || Math.random;
  const s = (b && b.def) ? bstat(b, gb) : null;
  const fate = gb.fate || {}, fateW = gb.fateWave || {};
  const chance = clamp(
    ((s && s.crit) ? s.crit : 0) + (((gb.tech && gb.tech.crit) || 0) * 0.04) + (fate.crit || 0) + (fateW.crit || 0),
    0, 0.95,
  );
  const extra = (fate.critDmg || 0) + (fateW.critDmg || 0);
  const base = (s && s.critDmg) ? s.critDmg : 2.2;
  return R() < chance ? (base + (((gb.tech && gb.tech.critmaster) || 0) * 0.4) + extra) : 1;
}

/** 面板 DPS 估算（core.js:390，仅展示用，不参与结算） */
export function towerPanelDps(s, b, gb) {
  if (!s || !s.dmg) return 0;
  const fate = (gb && gb.fate) || {}, fateW = (gb && gb.fateWave) || {};
  const critC = clamp((s.crit || 0) + (((gb && gb.tech && gb.tech.crit) || 0) * 0.04) + (fate.crit || 0) + (fateW.crit || 0), 0, 0.95);
  const critM = (s.critDmg || 2.2) + (((gb && gb.tech && gb.tech.critmaster) || 0) * 0.4) + (fate.critDmg || 0) + (fateW.critDmg || 0);
  const critMul = 1 + critC * (critM - 1);
  let targets = 1;
  if (s.split) targets = Math.min(4, s.split);
  else if (s.multi) targets = s.multi;
  else if (s.chain) targets = Math.min(3, s.chain);
  else if (s.aoe) targets = 2.5;
  else if (s.splash) targets = 1.6;
  const dps = s.dmg * targets;
  if (b && b.type === 'flame') return dps * 1.5;
  if (b && b.type === 'gravity') return dps;
  return dps * (s.rate || 0) * critMul;
}

// ══════════════════════════════════════════════════════════
//  建造 / 升级 / 出售 / 转职（core.js:568-635）
//  纯逻辑版：钱由调用方（gb.gold 是一个可变对象字段）结算
// ══════════════════════════════════════════════════════════

/** 能否负担（core.js:566）。gb.gold/power/souls 是普通数值字段。 */
export const canAfford = (gb, c) => !!(
  gb.admin || (gb.gold >= c.gold && gb.power >= (c.power || 0) && gb.souls >= (c.soul || 0))
);

/** 扣费（core.js:567） */
export function payCost(gb, c) {
  if (gb.admin) return;
  gb.gold -= c.gold;
  gb.power -= (c.power || 0);
  gb.souls -= (c.soul || 0);
}

/**
 * 造一座建筑（core.js:568 的纯逻辑部分）。
 * 校验 + 扣费 + 生成建筑对象；不碰网格（由调用方先判空格）。
 *
 * @returns {object|null} 新建的建筑，失败返回 null
 */
export function makeBuilding(type, col, row, cx, cy, gb) {
  const def = BUILD_DEFS[type];
  if (!def) return null;
  if (!gb.admin && gb.gold < def.cost.gold) return null;
  gb.gold -= def.cost.gold;

  const hp = buildingMaxHp(def, 1, null, gb);
  const b = {
    type, def, level: 1, col, row, x: cx, y: cy,
    hp, maxHp: hp,
    shield: 0, shieldMax: 0, cd: 0, angle: -Math.PI / 2, target: null, branch: null,
    invested: def.cost.gold, pulse: 0, kills: 0,
    runes: new Array(runeSlots(gb)).fill(null), fireFx: 0,
    freezeT: 0, empT: 0, idle: 0,
  };
  if (gb.buildings) gb.buildings.push(b);
  if (gb.stats) gb.stats.build = (gb.stats.build || 0) + 1;
  invalidateBstat(b);
  return b;
}

/** 符文槽数（core.js:419）：2 + 符文宗师等级 */
export const runeSlots = (gb) => 2 + (((gb && gb.tech && gb.tech.runelord) || 0));

/** 补齐符文槽数组（core.js:426） */
export function ensureRuneSlots(b, gb) {
  if (!b) return null;
  const n = runeSlots(gb);
  if (!Array.isArray(b.runes)) b.runes = [];
  while (b.runes.length < n) b.runes.push(null);
  return b.runes;
}

/**
 * 升级建筑（core.js:594）。等级上限、造价、生命同步都照搬。
 * @returns {boolean}
 */
export function tryUpgrade(b, gb) {
  if (b.level >= b.def.maxLv) return false;
  const c = upgradeCost(b.def, b.level, gb.event && gb.event.eff);
  if (!canAfford(gb, c)) return false;
  payCost(gb, c);
  b.level++;
  b.invested += c.gold;
  const nh = buildingMaxHp(b.def, b.level, b.branch, gb);
  b.hp += nh - b.maxHp;
  b.maxHp = nh;
  invalidateBstat(b);
  return true;
}

/**
 * 转职（core.js:610）。需要达到 BRANCH_AT 级且未转过。
 * @returns {boolean}
 */
export function tryBranch(b, which, gb) {
  const br = b.def.branch && b.def.branch[which];
  if (!br || b.branch || b.level < BRANCH_AT) return false;
  if (!canAfford(gb, br.cost)) return false;
  payCost(gb, br.cost);
  b.branch = which;
  b.invested += br.cost.gold;
  b.maxHp *= 1.3;
  b.hp = b.maxHp;
  invalidateBstat(b);
  return true;
}

/**
 * 出售建筑（core.js:621）。返还 invested × SELL_RATE。
 * 会从 gb.buildings 移除；网格回收由调用方处理。
 * @returns {number} 返还金币
 */
export function sellBuilding(b, gb, SELL_RATE_V) {
  const rate = SELL_RATE_V !== undefined ? SELL_RATE_V : 0.7;
  const back = Math.round(b.invested * rate);
  gb.gold += back;
  const i = (gb.buildings || []).indexOf(b);
  if (i >= 0) gb.buildings.splice(i, 1);
  return back;
}

/** 修复目标（core.js:701） */
export function healTarget(t, v) {
  if (t.hp < t.maxHp) { t.hp = Math.min(t.maxHp, t.hp + v); return true; }
  return false;
}

/**
 * 经济/后勤 tick（core.js:673 的纯逻辑部分）。
 * 处理：金币产出、电力回复、发育成长、维修台治疗、护盾核心赋盾、护盾再生、铁门自修复。
 *
 * 粒子/飘字等表现通过 fx 回调发出。
 */
export function updateEconomy(dt, gb, fx) {
  const F = fx || {};
  const addText = F.text || (() => {});
  const sfx = F.sfx || (() => {});

  const g = totalGoldRate(gb) * dt;
  gb.gold += g;
  if (gb.stats) gb.stats.goldTotal = (gb.stats.goldTotal || 0) + g;
  gb.power = Math.max(0, gb.power + powerInfo(gb).regen * dt);

  // 发育：每 8 秒 +1（上限 25），灵魂收益 +2%/级
  gb.growTimer = (gb.growTimer || 0) + dt;
  if (gb.growTimer >= 8 && (gb.grow || 0) < 25) {
    gb.growTimer -= 8;
    gb.grow = (gb.grow || 0) + 1;
    if (F.growText) F.growText(gb.grow);
    sfx('coin');
  }

  // 维修台 / 护盾核心
  (gb.buildings || []).forEach((b) => {
    const s = bstat(b, gb);
    if (b.type === 'repair' || s.heal) {
      (gb.doors || []).forEach((d) => {
        if (Math.abs(d.y - b.y) < 130 && dist2D({ x: 380, y: d.y }, b) <= s.range + 90) healTarget(d, s.heal * dt);
      });
      (gb.buildings || []).forEach((o) => { if (o !== b && dist2D(b, o) <= s.range) healTarget(o, s.heal * 0.6 * dt); });
      if (s.shieldHeal) {
        (gb.buildings || []).forEach((o) => {
          if (o !== b && dist2D(b, o) <= s.range && o.shieldMax > 0) o.shield = Math.min(o.shieldMax, o.shield + s.shieldHeal * dt);
        });
      }
    }
    if (b.type === 'shield' || s.shield) {
      (gb.doors || []).forEach((d) => { if (Math.abs(d.y - b.y) < 150) d.shieldMax = Math.max(d.shieldMax, s.shield); });
      if (gb.bed) gb.bed.shieldMax = Math.max(gb.bed.shieldMax || 0, s.shield * 0.8);
      (gb.buildings || []).forEach((o) => { if (dist2D(b, o) <= s.range) o.shieldMax = Math.max(o.shieldMax || 0, s.shield); });
    }
  });

  // 护盾被动再生：等级越高修得越慢（最少 3）
  const maxLvShield = Math.max(1, ...(gb.buildings || []).filter((b) => b.type === 'shield').map((b) => b.level), 1);
  const regen = Math.max(3, 14 - maxLvShield);
  const all = [gb.bed, ...(gb.doors || []), ...(gb.buildings || [])].filter(Boolean);
  all.forEach((t) => {
    if (t.shieldMax > 0 && t.shield < t.shieldMax) t.shield = Math.min(t.shieldMax, t.shield + regen * dt);
  });

  // 铁门自修复
  (gb.doors || []).forEach((d) => {
    if (d.broken && d.hp > d.maxHp * 0.25) {
      d.broken = false;
      if (F.doorRepaired) F.doorRepaired(d);
    }
  });

  // 梦境银行利息：每波结算，见 bankInterest() / wave.js 的 endWave
}

/** 每波银行利息（供 wave.js 的 endWave 调用） */
export function bankInterest(gb) {
  let r = 0;
  (gb.buildings || []).forEach((b) => { if (b.type === 'bank') r += bstat(b, gb).interest || 0; });
  return gb.gold * r;
}

export { DMG_KEYS };
