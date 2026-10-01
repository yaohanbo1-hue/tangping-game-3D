// 最小模拟的纯逻辑验收（不需要浏览器、不需要 three）。
// 用法：node scripts/verify-sim.mjs
//
// 重点验证一件事：**敌人的 x/z 完全能由 lane + progress 重派生**。
// 这条不变量如果成立，就说明第 1 步的去像素化在 3D 侧同样干净，
// 第 4 步接 core.js 时不会有「视觉位置和逻辑位置对不上」的隐患。
import { createWorld, stepWorld, makeEnemy, enemyPos, WALK_SPEED, KNOCK_TIME } from '../src/sim.js';
import { enemyWorldPos3D, LANES, progressSpeed, CORRIDOR_SPAN } from '../src/world.js';

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

console.log('── 1. 敌人对象不含位置字段（去像素化的断言）──');
const e = makeEnemy(1);
const posKeys = ['x', 'y', 'z', 'worldX', 'worldZ', 'px', 'py'].filter((k) => k in e);
ok('敌人对象没有 x/y/z 等位置字段', posKeys.length === 0, posKeys.join(',') || '（干净）');
ok('真值源是 lane + progress', e.lane === 1 && e.progress === 0);
ok('有 lane 环回保护', makeEnemy(7).lane === 7 % LANES.length || makeEnemy(7).lane < LANES.length);

console.log('\n── 2. 推进 1200 帧（20 秒）后的世界状态 ──');
// 出怪间隔 1.6s，走完走廊约 7.6s，敲门 2.4s → 20s 足够看到「出怪 → 敲门 → 破门」全链路。
const w = createWorld();
for (let i = 0; i < 1200; i++) stepWorld(w, 1 / 60);
console.log(`  时间 ${w.time.toFixed(2)}s / 累计出怪 ${w.spawned} / 在场 ${w.enemies.length} / 敲门 ${w.doorHits} / 破门 ${w.breaches}`);
ok('时间推进正确（1200 帧 = 20s）', Math.abs(w.time - 20) < 1e-9, w.time.toFixed(6));
ok('确实出怪了', w.spawned > 0, String(w.spawned));
ok('有敌人走到门口敲门', w.doorHits > 0, String(w.doorHits));
ok('有敌人破门', w.breaches > 0, String(w.breaches));
ok('在场数不超过上限', w.enemies.length <= 24, String(w.enemies.length));
ok('三条车道都被用到（cursor 无跳号）', (() => {
  const lanes = new Set();
  const ww = createWorld();
  for (let i = 0; i < 2000; i++) {
    stepWorld(ww, 1 / 60);
    ww.enemies.forEach((e) => lanes.add(e.lane));
  }
  return lanes.size === 3;
})(), '车道覆盖 3/3');

console.log('\n── 3. 核心不变量：x/z 可由 progress 精确重派生 ──');
const w2 = createWorld();
for (let i = 0; i < 240; i++) stepWorld(w2, 1 / 60);
let maxErr = 0, checked = 0;
for (const en of w2.enemies) {
  const a = enemyPos(en);
  const b = enemyWorldPos3D(en, en.progress);
  maxErr = Math.max(maxErr, Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  checked++;
}
ok(`在场 ${checked} 只敌人的派生坐标与渲染取值一致`, maxErr < 1e-12, `最大误差 ${maxErr}`);

console.log('\n── 4. 状态机三阶段（walking → knocking → breached）──');
// ⚠️ 不能用 `world.enemies.length` 当循环条件 —— 破门后敌人会被移出，
//    但自动出怪又会补进来，长度永远不为 0。改为盯住 probe 对象自身的 state。
const w3 = createWorld();
w3.spawnInterval = 0;               // 关掉自动出怪（0 = 关闭），只观察手动放的那一只
const probe3 = makeEnemy(0, { speed: WALK_SPEED });
w3.enemies.push(probe3);
const seen = new Set();
let frames = 0;
let onFieldWhenBreached = null;    // 破门那一帧敌人还在不在场上
while (probe3.state !== 'breached' && frames < 3000) {
  stepWorld(w3, 1 / 60);
  seen.add(probe3.state);          // 直接盯对象，不通过数组下标
  frames++;
  if (probe3.state === 'breached') onFieldWhenBreached = w3.enemies.includes(probe3);
}
console.log(`  经过 ${frames} 帧（${(frames / 60).toFixed(3)}s）到破门`);

// ⚠️ 必须用 progressSpeed() 反推理论帧数，不能手写像素跨度 ——
//    走廊跨度实际是 380-31-26 = 323，不是 320。
//    手写常量会让断言因为「差 3 像素」而偏 4 帧，排查半天。
const theoryWalkFrames = Math.ceil(1 / (progressSpeed(WALK_SPEED) * (1 / 60)));
const theoryKnockFrames = Math.ceil(KNOCK_TIME / (1 / 60));
console.log(`  走廊跨度 ${CORRIDOR_SPAN}px / 每帧增量 ${(progressSpeed(WALK_SPEED) / 60).toExponential(4)}`);
console.log(`  理论：走完走廊 ${theoryWalkFrames} 帧 + 敲门 ${theoryKnockFrames} 帧 = ${theoryWalkFrames + theoryKnockFrames} 帧`);

ok('经历了 walking', seen.has('walking'));
ok('经历了 knocking', seen.has('knocking'));
ok('最终破门', w3.breaches === 1, String(w3.breaches));
ok('破门当帧即被移出场上', onFieldWhenBreached === false,
  String(onFieldWhenBreached));
ok('耗时符合理论值（含敲门等待）', Math.abs(frames - (theoryWalkFrames + theoryKnockFrames)) <= 1,
  `实际 ${frames} 帧 vs 理论 ${theoryWalkFrames + theoryKnockFrames} 帧`);

console.log('\n── 5. progress 单调性与钳制 ──');
const w4 = createWorld();
const probe = makeEnemy(2, { speed: WALK_SPEED });
w4.enemies.push(probe);
let last = -1, monotone = true;
for (let i = 0; i < 100; i++) {
  stepWorld(w4, 1 / 60);
  if (!w4.enemies.length) break;
  const p = w4.enemies[0].progress;
  if (p < last - 1e-9) monotone = false;
  last = p;
}
ok('progress 单调不减', monotone, `终值 ${last.toFixed(4)}`);
ok('progress 未超过 1', last <= 1 + 1e-9, last.toFixed(6));

console.log('\n── 6. 自动出怪开关（spawnInterval = 0 必须真的关闭）──');
// 回归：曾用 spawnInterval = 1e9 来「关闭」出怪，但 spawnTimer 初值为 0，
// 第一帧仍然会出一只，导致断言不稳定地在 1/2 之间跳。
const wOff = createWorld();
wOff.spawnInterval = 0;
for (let i = 0; i < 600; i++) stepWorld(wOff, 1 / 60);
ok('spawnInterval=0 时 600 帧内不出怪', wOff.spawned === 0, `spawned=${wOff.spawned}`);

const wOn = createWorld();
for (let i = 0; i < 600; i++) stepWorld(wOn, 1 / 60);
ok('默认间隔下 600 帧会出怪', wOn.spawned > 0, `spawned=${wOn.spawned}`);

console.log('\n── 7. 破门计数不重复累加（回归）──');
// 同样的场景跑 5 次，breaches 必须恒为 1（曾经会随机变成 2）
let breachCounts = [];
for (let run = 0; run < 5; run++) {
  const wr = createWorld();
  wr.spawnInterval = 0;
  const pr = makeEnemy(0, { speed: WALK_SPEED });
  wr.enemies.push(pr);
  let f = 0;
  while (pr.state !== 'breached' && f < 3000) { stepWorld(wr, 1 / 60); f++; }
  breachCounts.push(wr.breaches);
}
ok('5 次独立运行 breaches 恒为 1', breachCounts.every((c) => c === 1),
  `实测 [${breachCounts.join(', ')}]`);

console.log('\n' + (fail === 0 ? '✅ 最小模拟全部通过' : `❌ 有 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
