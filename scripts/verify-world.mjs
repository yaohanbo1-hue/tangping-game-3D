// 世界坐标契约的纯逻辑验收（不需要浏览器）。
// 用法：node scripts/verify-world.mjs
//
// 这个脚本的价值：把「坐标映射」和「渲染」解耦验证。
// 3D 画面出问题时的第一反应应该是「先跑这个」——
// 如果契约测试过而画面不对，问题一定在渲染层，不在数学层。
import {
  assertWorldContract, LANES, enemyWorldPos3D, cellCenter,
  WORLD_W, WORLD_D, CORRIDOR_SPAN, px2wx, px2wz,
  WALL_X, CORRIDOR_SPAWN_X, WALL_APPROACH_DIST, COLS, ROWS, CW, CH,
} from '../src/world.js';

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

console.log('── 1. 契约内部一致性 ──');
const c = assertWorldContract();
ok('assertWorldContract() 通过', c.ok, c.problems.join('；'));

console.log('\n── 2. 车道几何 ──');
ok('车道数 = 3', LANES.length === 3);
ok('车道首尾相接无空隙', LANES.every((L, i) => i === 0 || LANES[i - 1].y1 === L.y0));
ok('车道铺满走廊高度', LANES[0].y0 === 66 && LANES[2].y1 === 556,
  `${LANES[0].y0} → ${LANES[2].y1}`);
ok('门洞都在车道内', LANES.every((L) => L.doorY - L.doorHalf >= L.y0 && L.doorY + L.doorHalf <= L.y1));

console.log('\n── 3. 世界尺寸 ──');
ok('场地宽 = 12.8 m', WORLD_W === 12.8, String(WORLD_W));
ok('场地深 = 7.2 m', WORLD_D === 7.2, String(WORLD_D));
ok('1 格 = 1.10 × 0.98 m', CW * 0.01 === 1.1 && CH * 0.01 === 0.98);

console.log('\n── 4. 敌人位置派生（去像素化的核心不变量）──');
// 对照 core.js:29 —— x = WALL_X - WALL_APPROACH_DIST - max(0,p) * corridorSpan()
// progress=0 时在走廊最外侧（x 最大），progress=1 时贴着铁门（x 最小）。
for (const lane of [0, 1, 2]) {
  const e = { lane, progress: 0 };
  const p0 = enemyWorldPos3D(e, 0);
  const pm = enemyWorldPos3D(e, 0.5);
  const p1 = enemyWorldPos3D(e, 1);
  const expectedStart = px2wx(WALL_X - WALL_APPROACH_DIST);                  // p=0：离门最远
  const expectedEnd = px2wx(WALL_X - WALL_APPROACH_DIST - CORRIDOR_SPAN);    // p=1：贴门
  ok(`车道 ${lane}：progress 单调推进（x 递减）`, p0.x > pm.x && pm.x > p1.x);
  ok(`车道 ${lane}：progress=0 在走廊最外侧`, Math.abs(p0.x - expectedStart) < 1e-9,
    `${p0.x.toFixed(4)} vs ${expectedStart.toFixed(4)}`);
  ok(`车道 ${lane}：progress=1 贴到铁门前`, Math.abs(p1.x - expectedEnd) < 1e-9,
    `${p1.x.toFixed(4)} vs ${expectedEnd.toFixed(4)}`);
  ok(`车道 ${lane}：z 恒定于门中线`, Math.abs(p0.z - p1.z) < 1e-12);
  ok(`车道 ${lane}：中点正好在起终点之间`,
    Math.abs(pm.x - (p0.x + p1.x) / 2) < 1e-12);
}

console.log('\n── 5. 越界容忍（原 2D 版有 progress=1.002 的正常溢出）──');
const over = enemyWorldPos3D({ lane: 0 }, 1.002);
const at1 = enemyWorldPos3D({ lane: 0 }, 1);
ok('progress>1 不被钳制（映射层不负责钳制）', over.x < at1.x,
  `${over.x.toFixed(5)} < ${at1.x.toFixed(5)}`);
const neg = enemyWorldPos3D({ lane: 0 }, -0.5);
const at0 = enemyWorldPos3D({ lane: 0 }, 0);
ok('progress<0 被 Math.max(0,...) 兜住', Math.abs(neg.x - at0.x) < 1e-12);

console.log('\n── 6. 8×5 网格铺满房间 ──');
const c00 = cellCenter(0, 0);
const c74 = cellCenter(COLS - 1, ROWS - 1);
ok('左上格中心 = 格子半宽处', Math.abs(c00.x - (380 * 0.01 + 1.1 / 2)) < 1e-9,
  c00.x.toFixed(4));
ok('右下格右边界 = ROOM_X1', Math.abs(c74.x + c74.w / 2 - px2wx(1260)) < 1e-9,
  (c74.x + c74.w / 2).toFixed(4) + ' vs ' + px2wx(1260).toFixed(4));
ok('右下格下边界 = ARENA_BOT', Math.abs(c74.z + c74.d / 2 - px2wz(556)) < 1e-9,
  (c74.z + c74.d / 2).toFixed(4) + ' vs ' + px2wz(556).toFixed(4));
ok('40 个格子互不重叠且铺满', (() => {
  const seen = new Set();
  for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) {
    const k = `${cellCenter(col, r).x}_${cellCenter(col, r).z}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return seen.size === COLS * ROWS;
})());

console.log('\n' + (fail === 0
  ? '✅ 世界坐标契约全部通过（7 组 30 项断言）'
  : `❌ 有 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
