// 规则层搬运校验（纯 Node，不需要 three / 浏览器）。
// 用法：node scripts/verify-rules.mjs
//
// 目的：第 4 步要把 data.js / core.js 的**数值**搬进 3D 侧，
// 而「凭印象抄数值」是这次迁移里真实发生过的事故（见 constants.js 顶部注释）：
//   SELL_RATE 写成 0.6（实际 0.7）、COST_MUL 写成 1.18（实际 2）、
//   FREE_POWER_LV 写成 1（实际 7）、升级费公式整条不对、
//   ENEMY_DEFS 键名记错、BUILD_DEFS 只搬了 4/17。
//
// 所以这里不靠人眼复读，而是**直接读 2D 源码文本**做交叉校验：
//   ① 从 data.js 抽出 BUILD_KEYS / ENEMY 数量 / AFFIX 键 / BOSS 键 / DIFF 键
//   ② 从 core.js 抽出 SELL_RATE / COST_MUL / FREE_POWER_LV 三个常量
//   ③ 逐条断言我们搬过来的值与之相等
// 任何一处抄错，测试立刻红。
//
// 同时校验**内部一致性**：反应配对表、波次公式边界、stat() 采样值。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DMG, DMG_KEYS, REACTIONS, REACTION_PAIRS, findReaction,
  BUILD_DEFS, BUILD_KEYS, TOWER_KEYS, BRANCH_AT,
  ENEMY_DEFS, ENEMY_KEYS, AFFIX, AFFIX_KEYS,
  BOSS_DEFS, BOSS_KEYS, BOSS_ORDER, FINAL_WAVE, bossKeyForWave, bossPhases,
  DIFFS, DIFF_KEYS, TECH_DEFS, TECH_KEYS,
  waveUnlocks, waveCount, waveBossCount, waveSpawnInterval, eliteChance,
  enemyHpScale, enemyDmgScale,
  SELL_RATE, COST_MUL, FREE_POWER_LV, upgradeCost, doorUpgradeCost, bedUpgradeCost,
  DOOR_HP_BASE, BED_HP_BASE, typeMul, RULES_SNAPSHOT,
} from '../src/rules/constants.js';

let fail = 0, pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};

// ── 定位 2D 源码 ─────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const SRC2D = join(here, '..', '..', 'tangping-game');
const dataJs = join(SRC2D, 'data.js');
const coreJs = join(SRC2D, 'core.js');

if (!existsSync(dataJs) || !existsSync(coreJs)) {
  console.log('⚠️  找不到 2D 源码，跳过交叉校验：');
  console.log(`   ${dataJs}`);
  console.log(`   ${coreJs}`);
  console.log('   （仅做内部一致性校验）');
}
const D = existsSync(dataJs) ? readFileSync(dataJs, 'utf8') : '';
const C = existsSync(coreJs) ? readFileSync(coreJs, 'utf8') : '';
const has2D = !!D;
const hasCore = !!C;

// ══════════════════════════════════════════════════════════
console.log('── 1. 建筑清单与 2D data.js 一致 ──');
if (has2D) {
  // BUILD_DEFS 顶层键：匹配 "  key: {" 且缩进恰为 2 空格
  const block = D.slice(D.indexOf('const BUILD_DEFS = {'), D.indexOf('const BUILD_KEYS'));
  const keys = [...block.matchAll(/^  ([a-z][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  ok('2D BUILD_DEFS 键数量 = 16', keys.length === 16, `实际 ${keys.length}: ${keys.join(',')}`);
  ok('3D BUILD_DEFS 键集合与 2D 完全相同',
    keys.length === BUILD_KEYS.length && keys.every((k) => BUILD_DEFS[k]),
    `3D=${BUILD_KEYS.length} 2D=${keys.length}`);
  const missing = keys.filter((k) => !BUILD_DEFS[k]);
  const extra = BUILD_KEYS.filter((k) => !keys.includes(k));
  ok('没有遗漏的建筑', missing.length === 0, missing.join(',') || '（无）');
  ok('没有凭空多出的建筑', extra.length === 0, extra.join(',') || '（无）');

  // 逐建筑核对 cost.gold / cost.power / hp / maxLv / tower / dmgType
  let mism = [];
  for (const k of keys) {
    const b = block.slice(block.indexOf(`\n  ${k}: {`));
    const seg = b.slice(0, b.indexOf('\n  },'));
    const g = /gold:\s*(\d+)/.exec(seg);
    const p = /power:\s*(\d+)/.exec(seg);
    const hp = /hp:\s*(\d+)/.exec(seg);
    const ml = /maxLv:\s*(\d+)/.exec(seg);
    const tw = /tower:\s*true/.test(seg);
    const dt = /dmgType:\s*'([a-z]+)'/.exec(seg);
    const def = BUILD_DEFS[k];
    if (!def) { mism.push(k + ':缺失'); continue; }
    if (g && def.cost.gold !== +g[1]) mism.push(`${k}.gold ${def.cost.gold}≠${g[1]}`);
    if (p && def.cost.power !== +p[1]) mism.push(`${k}.power ${def.cost.power}≠${p[1]}`);
    if (hp && def.hp !== +hp[1]) mism.push(`${k}.hp ${def.hp}≠${hp[1]}`);
    if (ml && def.maxLv !== +ml[1]) mism.push(`${k}.maxLv ${def.maxLv}≠${ml[1]}`);
    if (!!def.tower !== tw) mism.push(`${k}.tower ${!!def.tower}≠${tw}`);
    if (dt && def.dmgType !== dt[1]) mism.push(`${k}.dmgType ${def.dmgType}≠${dt[1]}`);
  }
  ok('每个建筑的基础数值逐项与 2D 一致', mism.length === 0, mism.slice(0, 6).join(' | ') || '（全部一致）');

  // stat(lv) 采样：直接对拍 2D 公式（这几条是每座塔的强度基线）
  const statChecks = [
    ['turret', 1, { dmg: 12, rate: 1.6, range: 520 }],
    ['turret', 10, { dmg: 57, rate: 2.86 }],
    ['miner', 3, { gold: 12 }],
    ['frost', 1, { slow: 0.3 }],
    ['laser', 5, { dmg: 133, pierce: 2 }],
    ['tesla', 10, { dmg: 90, chain: 7 }],
    ['bank', 1, { interest: 0.08 }],
    ['amp', 1, { bonus: 0.25, range: 165 }],
  ];
  let statBad = [];
  for (const [k, lv, exp] of statChecks) {
    const s = BUILD_DEFS[k].stat(lv);
    for (const [f, v] of Object.entries(exp)) {
      if (Math.abs(s[f] - v) > 1e-9) statBad.push(`${k}(lv${lv}).${f}=${s[f]}≠${v}`);
    }
  }
  ok('stat(lv) 采样值与手算一致（8 组）', statBad.length === 0, statBad.join(' | ') || '（全部一致）');
} else {
  console.log('  ⏭️  跳过（无 2D 源码）');
}

// ══════════════════════════════════════════════════════════
console.log('\n── 2. 敌人 / 词缀 / BOSS / 难度清单与 2D 一致 ──');
if (has2D) {
  const eblk = D.slice(D.indexOf('const ENEMY_DEFS = {'), D.indexOf('const BOSS_PHASES'));
  const ekeys = [...eblk.matchAll(/^  ([a-z][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  ok('2D ENEMY_DEFS 键数量与 3D 相同', ekeys.length === ENEMY_KEYS.length,
    `2D=${ekeys.length} 3D=${ENEMY_KEYS.length}`);
  const eMiss = ekeys.filter((k) => !ENEMY_DEFS[k]);
  const eExtra = ENEMY_KEYS.filter((k) => !ekeys.includes(k));
  ok('3D ENEMY_DEFS 没有键名抄错 / 缺漏 / 杜撰',
    eMiss.length === 0 && eExtra.length === 0,
    (eMiss.length ? '缺:' + eMiss.join(',') : '') + (eExtra.length ? ' 多:' + eExtra.join(',') : '') || '（完全一致）');

  // 关键字段抽查
  const eNum = [];
  for (const k of ekeys) {
    const b = eblk.slice(eblk.indexOf(`\n  ${k}: {`));
    const seg = b.slice(0, b.indexOf('},') + 1);
    for (const f of ['hp', 'speed', 'dmg', 'gold', 'soul', 'r']) {
      const m = new RegExp(`\\b${f}:\\s*([\\d.]+)`).exec(seg);
      if (m && ENEMY_DEFS[k] && Math.abs(ENEMY_DEFS[k][f] - +m[1]) > 1e-9) {
        eNum.push(`${k}.${f} ${ENEMY_DEFS[k][f]}≠${m[1]}`);
      }
    }
  }
  ok('每个敌人的 hp/speed/dmg/gold/soul/r 与 2D 一致', eNum.length === 0, eNum.slice(0, 6).join(' | ') || '（全部一致）');

  const ablk = D.slice(D.indexOf('const AFFIX = {'), D.indexOf('const AFFIX_KEYS'));
  const akeys = [...ablk.matchAll(/^  ([a-z][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  ok('AFFIX 键集合一致', akeys.length === AFFIX_KEYS.length && akeys.every((k) => AFFIX[k]),
    `2D=${akeys.length} 3D=${AFFIX_KEYS.length}`);

  const bblk = D.slice(D.indexOf('const BOSS_DEFS = {'), D.indexOf('const BOSS_ORDER'));
  const bkeys = [...bblk.matchAll(/^  ([a-z][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  ok('BOSS_DEFS 键集合一致', bkeys.length === BOSS_KEYS.length && bkeys.every((k) => BOSS_DEFS[k]),
    `2D=${bkeys.length} 3D=${BOSS_KEYS.length}`);
  ok('BOSS_ORDER = [lord,abyss,machine,void]',
    BOSS_ORDER.join(',') === 'lord,abyss,machine,void', BOSS_ORDER.join(','));
  ok('各 BOSS 的 hp 与 2D 一致', (() => {
    const bad = [];
    for (const k of bkeys) {
      const b = bblk.slice(bblk.indexOf(`\n  ${k}: {`));
      const seg = b.slice(0, b.indexOf('phases:'));
      const m = /hp:\s*(\d+)/.exec(seg);
      if (m && BOSS_DEFS[k].hp !== +m[1]) bad.push(`${k}.hp ${BOSS_DEFS[k].hp}≠${m[1]}`);
    }
    return bad.length === 0;
  })(), '');

  const dblk = D.slice(D.indexOf('const DIFFS = {'), D.indexOf('const DIFF_KEYS'));
  const dkeys = [...dblk.matchAll(/^  ([a-z][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  ok('DIFFS 键集合一致', dkeys.length === DIFF_KEYS.length && dkeys.every((k) => DIFFS[k]),
    `2D=${dkeys.length} 3D=${DIFF_KEYS.length}`);

  const tkeys2d = [...D.slice(D.indexOf('const TECH_DEFS = {'), D.indexOf('const TECH_KEYS')).matchAll(/^  ([a-z][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  ok('TECH_DEFS 键集合一致', tkeys2d.length === TECH_KEYS.length && tkeys2d.every((k) => TECH_DEFS[k]),
    `2D=${tkeys2d.length} 3D=${TECH_KEYS.length}`);
} else {
  console.log('  ⏭️  跳过（无 2D 源码）');
}

// ══════════════════════════════════════════════════════════
console.log('\n── 3. 经济常量与 core.js 一致（第一版抄错重灾区）──');
if (hasCore) {
  const pick = (re) => { const m = re.exec(C); return m ? +m[1] : null; };
  const s2d = pick(/^const SELL_RATE\s*=\s*([\d.]+)\s*;/m);
  const c2d = pick(/^const COST_MUL\s*=\s*([\d.]+)\s*;/m);
  const f2d = pick(/^const FREE_POWER_LV\s*=\s*(\d+)\s*;/m);
  ok('SELL_RATE 与 core.js 一致', s2d === SELL_RATE, `2D=${s2d} 3D=${SELL_RATE}`);
  ok('COST_MUL 与 core.js 一致', c2d === COST_MUL, `2D=${c2d} 3D=${COST_MUL}`);
  ok('FREE_POWER_LV 与 core.js 一致', f2d === FREE_POWER_LV, `2D=${f2d} 3D=${FREE_POWER_LV}`);

  // 手算对拍 upgradeCost：core.js 公式 = gold*COST_MUL^(lv-1)，free 时 power=0
  const hand = (gold, power, noPowerUp, lv) => {
    const free = noPowerUp || lv <= f2d;
    return {
      gold: Math.round(gold * Math.pow(c2d, lv - 1)),
      power: free ? 0 : Math.round(power * Math.pow(1.5, lv - f2d)),
    };
  };
  const cases = [['turret', 3], ['turret', 8], ['generator', 10], ['miner', 5], ['laser', 20]];
  const uBad = [];
  for (const [k, lv] of cases) {
    const def = BUILD_DEFS[k];
    const me = upgradeCost(def, lv);
    const ref = hand(def.cost.gold, def.cost.power || 0, def.noPowerUp, lv);
    if (me.gold !== ref.gold) uBad.push(`${k}@${lv}.gold ${me.gold}≠${ref.gold}`);
    if (me.power !== ref.power) uBad.push(`${k}@${lv}.power ${me.power}≠${ref.power}`);
  }
  ok('upgradeCost 与 core.js 公式逐例对拍（5 例）', uBad.length === 0, uBad.join(' | ') || '（一致）');

  const dUC = /const doorUpgradeCost = lv => Math\.round\(85 \* Math\.pow\(COST_MUL, lv - 1\)\)/.test(C);
  const bUC = /const bedUpgradeCost = lv => Math\.round\(200 \* Math\.pow\(COST_MUL, lv - 1\)\)/.test(C);
  ok('doorUpgradeCost 基准 85 与 core.js 一致', dUC && doorUpgradeCost(3) === Math.round(85 * Math.pow(COST_MUL, 2)),
    `lv3=${doorUpgradeCost(3)}`);
  ok('bedUpgradeCost 基准 200 与 core.js 一致', bUC && bedUpgradeCost(3) === Math.round(200 * Math.pow(COST_MUL, 2)),
    `lv3=${bedUpgradeCost(3)}`);
} else {
  // 无源码时至少校验内部自洽（对照第一版抄错的旧值）
  console.log('  ⏭️  无 core.js，改为断言「不是第一版的错值」');
  ok('SELL_RATE 不是错值 0.6', SELL_RATE !== 0.6, String(SELL_RATE));
  ok('COST_MUL 不是错值 1.18', COST_MUL !== 1.18, String(COST_MUL));
  ok('FREE_POWER_LV 不是错值 1', FREE_POWER_LV !== 1, String(FREE_POWER_LV));
}

// ══════════════════════════════════════════════════════════
console.log('\n── 4. 反应表 / typeMul 内部一致性 ──');
ok('DMG 有 6 种伤害类型', DMG_KEYS.length === 6, DMG_KEYS.join(','));
ok('反应表 6 组配对', Object.keys(REACTION_PAIRS).length === 6, String(Object.keys(REACTION_PAIRS).length));
ok('findReaction 顺序无关（fire+frost == frost+fire）',
  findReaction('fire', 'frost') === findReaction('frost', 'fire')
  && findReaction('fire', 'frost').id === 'steam');
ok('不构成配对的组合返回 null', findReaction('kinetic', 'toxic') === null);
ok('每个反应都能反查到 DMG 里的类型', (() => {
  const pairs = [
    ['fire', 'frost'], ['shock', 'fire'], ['toxic', 'fire'],
    ['frost', 'shock'], ['frost', 'energy'], ['toxic', 'energy'],
  ];
  return pairs.every(([a, b]) => DMG[a] && DMG[b] && findReaction(a, b));
})());

// typeMul：抗性/弱点/词缀/科技四条通路
const mk = (over) => Object.assign({ res: {}, weak: {} }, over);
ok('无抗性无弱点 → 1.0', typeMul(mk({}), 'kinetic') === 1);
ok('50% 抗性 → 0.5', Math.abs(typeMul(mk({ res: { kinetic: 0.5 } }), 'kinetic') - 0.5) < 1e-9);
ok('50% 弱点 → 1.5', Math.abs(typeMul(mk({ weak: { fire: 0.5 } }), 'fire') - 1.5) < 1e-9);
ok('抗性下限钳制 0.15（120% 抗性）',
  typeMul(mk({ res: { kinetic: 1.2 } }), 'kinetic') === 0.15);
ok('上限钳制 3（500% 弱点）',
  typeMul(mk({ weak: { fire: 5 } }), 'fire') === 3);
ok('词缀全抗叠加并封顶 0.85', (() => {
  const m = typeMul(mk({ res: { kinetic: 0.5 }, affixRes: 0.5 }), 'kinetic');
  return Math.abs(m - (1 - 0.85)) < 1e-9;
})());
ok('科技 overload 每级 -6% 抗性',
  Math.abs(typeMul(mk({ res: { kinetic: 0.5 } }), 'kinetic', { overload: 5 }) - 0.8) < 1e-9);
ok('dtype 为空 → 1.0', typeMul(mk({ res: { kinetic: 0.5 } }), null) === 1);

// ══════════════════════════════════════════════════════════
console.log('\n── 5. 波次编排公式（与 core.js:1697 对齐）──');
ok('waveCount(1) = 8', waveCount(1) === 8, String(waveCount(1)));
ok('waveCount(30) = 69', waveCount(30) === 69, String(waveCount(30)));
ok('waveCount 上限 90', waveCount(500) === 90, String(waveCount(500)));
ok('waveBossCount：非 5 倍数 = 0', waveBossCount(7) === 0 && waveBossCount(22) === 0,
  `7→${waveBossCount(7)} 22→${waveBossCount(22)}`);
ok('waveBossCount(5) = 1', waveBossCount(5) === 1);
ok('waveBossCount(45) = 3（BOSS 波：1+floor(45/22)）', waveBossCount(45) === 3, String(waveBossCount(45)));
ok('waveBossCount(65) = 3', waveBossCount(65) === 3, String(waveBossCount(65)));
ok('waveSpawnInterval(1) 约 0.832', Math.abs(waveSpawnInterval(1) - 0.832) < 1e-9, waveSpawnInterval(1).toFixed(4));
ok('waveSpawnInterval 下限 0.20', waveSpawnInterval(1000) === 0.20);
ok('eliteChance(4) = 0', eliteChance(4) === 0);
ok('eliteChance(30) = 0.42（封顶）', Math.abs(eliteChance(30) - 0.42) < 1e-9, eliteChance(30).toFixed(3));
ok('waveUnlocks(1) 只有 grunt', (() => {
  const p = waveUnlocks(1);
  return p.every((t) => t === 'grunt');
})(), `len=${waveUnlocks(1).length}`);
ok('waveUnlocks(60) 池子显著变大', waveUnlocks(60).length > 150, String(waveUnlocks(60).length));
ok('FINAL_WAVE = 60', FINAL_WAVE === 60);
ok('bossKeyForWave(5) = lord', bossKeyForWave(5) === 'lord', bossKeyForWave(5));
ok('bossKeyForWave(60) = final', bossKeyForWave(60) === 'final', bossKeyForWave(60));
ok('bossKeyForWave(65) = final（越过终局仍是 final）', bossKeyForWave(65) === 'final');

// ══════════════════════════════════════════════════════════
console.log('\n── 6. HP/伤害成长曲线单调且端点正确 ──');
ok('enemyHpScale 单调递增', (() => {
  let prev = -1;
  for (let w = 1; w <= 60; w++) { const v = enemyHpScale(w, { hpMul: 1 }); if (v <= prev) return false; prev = v; }
  return true;
})());
ok('enemyHpScale(0) = 1', Math.abs(enemyHpScale(0, { hpMul: 1 }) - 1) < 1e-12);
ok('enemyHpScale 乘上事件 hpMul', Math.abs(enemyHpScale(10, { hpMul: 2 }) / enemyHpScale(10, { hpMul: 1 }) - 2) < 1e-12);
ok('enemyDmgScale(0) = 1（diffMul=1）', Math.abs(enemyDmgScale(0, { dmgMul: 1 }) - 1) < 1e-12);
ok('enemyDmgScale 乘上难度 dmgMul', Math.abs(enemyDmgScale(20, { dmgMul: 1.5 }) / enemyDmgScale(20, { dmgMul: 1 }) - 1.5) < 1e-12);

// ══════════════════════════════════════════════════════════
console.log('\n── 7. 炮塔清单与 TOWER_KEYS ──');
ok('Tower 数量 = 10', TOWER_KEYS.length === 10, `${TOWER_KEYS.length}: ${TOWER_KEYS.join(',')}`);
ok('所有 tower 条目都有 dmgType', TOWER_KEYS.every((k) => BUILD_DEFS[k].dmgType),
  TOWER_KEYS.filter((k) => !BUILD_DEFS[k].dmgType).join(',') || '（全部有）');
ok('非 tower 条目不应有 dmgType', BUILD_KEYS.filter((k) => !BUILD_DEFS[k].tower).every((k) => !BUILD_DEFS[k].dmgType));
ok('BRANCH_AT = 6', BRANCH_AT === 6);
ok('每座可转职建筑都有 a/b 两个分支', BUILD_KEYS.every((k) => BUILD_DEFS[k].branch && BUILD_DEFS[k].branch.a && BUILD_DEFS[k].branch.b));

console.log('\n── 8. RULES_SNAPSHOT 快照自洽 ──');
ok('快照 BUILD_COUNT = 16', RULES_SNAPSHOT.BUILD_COUNT === 16, String(RULES_SNAPSHOT.BUILD_COUNT));
ok('快照 ENEMY_COUNT = 13', RULES_SNAPSHOT.ENEMY_COUNT === 13, String(RULES_SNAPSHOT.ENEMY_COUNT));
ok('快照 AFFIX_COUNT = 10', RULES_SNAPSHOT.AFFIX_COUNT === 10, String(RULES_SNAPSHOT.AFFIX_COUNT));
ok('快照 BOSS_COUNT = 5', RULES_SNAPSHOT.BOSS_COUNT === 5, String(RULES_SNAPSHOT.BOSS_COUNT));
ok('快照 DIFF_COUNT = 4', RULES_SNAPSHOT.DIFF_COUNT === 4, String(RULES_SNAPSHOT.DIFF_COUNT));
ok('快照 TECH_COUNT = 28', RULES_SNAPSHOT.TECH_COUNT === 28, String(RULES_SNAPSHOT.TECH_COUNT));
ok('快照 TOWER_COUNT = 10', RULES_SNAPSHOT.TOWER_COUNT === 10, String(RULES_SNAPSHOT.TOWER_COUNT));
ok('快照与导出值同源', RULES_SNAPSHOT.SELL_RATE === SELL_RATE && RULES_SNAPSHOT.COST_MUL === COST_MUL);

// ══════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}  ——  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
