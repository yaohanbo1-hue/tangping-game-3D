// ============================================================
//  enemies.js —— 敌人的 3D 呈现
// ============================================================
//
// 设计要点：**渲染层只读真值，绝不回写位置。**
// 每一帧的流程是：
//   rules 推进 progress  →  enemyWorldPos3D() 派生出 XZ  →  拷进 InstancedMesh 的矩阵
//
// 这样「逻辑」与「呈现」之间只有一条单向数据流，2D 版踩过的
// 「改坐标顺带改了逻辑」的坑在 3D 里不会重演。
//
// 用 InstancedMesh 而不是每只敌人一个 Mesh：
//   场上可能同时有 90+ 只（第 43 波开始队列就到 90 了），
//   实例化只有 1 次 draw call，而且每只敌人的配色走 instanceColor。
//
// ── 第 4 步的改动 ─────────────────────────────────────────
//
// 敌人对象从「sim.js 手搓的」换成了「rules/wave.js 的 spawnEnemy 产物」，
// 字段名有差异，这里逐项对齐：
//   · color  是 '#rrggbb' **字符串**（不是 0x 数值）→ 用 THREE.Color 解析
//   · state  是 'walk' | 'door'（2D 语义），不是 'walking' | 'knocking'
//   · 有 hp/maxHp/def（含尺寸 r）/elite/boss/slow/burn/poison/affixes
//
// 另外加了「状态可视化」：这些状态在 2D 里靠不同颜色的小图标表示，
// 3D 里改用**环的颜色 + 缩放抖动**来表示，信息密度更高：
//   冰霜减速 = 青环   灼烧 = 橙环   中毒 = 绿环
//   精英  = 金环      BOSS = 紫环 + 更大体型
//
// ── 第 6 步的改动：死亡溶解 ────────────────────────────────
//
//   board.js 在敌人 hp<=0 的**同一帧**就把它从 gb.enemies 里 splice 掉了
//   （见 board.js 的「原地 splice」注释）。渲染层因此永远看不到"正在死"的
//   敌人 —— 表现就是「啪」地一下凭空消失，配合 combat.js 已经炸出来的
//   粒子，看起来像粒子放了一半主角没了。
//
//   修法：渲染层自己维护一份**上一帧见过的敌人快照**（按对象引用）。
//   每帧 diff 出「上一帧有、这一帧没了」的那些，在它们最后的位置放一个
//   正在溶解的幽灵替身，缩放从 1 涨到 1.6、同时压扁并淡出，0.35 秒后回收。
//
//   ⚠️ 为什么不改 board.js 让死亡延迟一帧再 splice：那会让规则层的
//      「死亡」不再是瞬时事实，索敌/击杀统计/波次结算都要跟着改成
//      「几乎死」状态。为了一个纯视觉效果去动规则层的时间语义不划算。
//      渲染层多存一个快照，代价只是一次 Map 遍历。
// ============================================================

import * as THREE from 'three';
import { px2len, WALL_WX, LANES, px2wz, px2wx, WALL_X, WALL_APPROACH_DIST, UNIT } from './world.js';
import { enemyWorldPos3D } from './world.js';

const MAX = 160;
/** 基准体量：约 1 格宽的 1/4，和 2D 版的敌人视觉体量接近 */
const BODY_W = px2len(30);
const BODY_H = px2len(46);
const BODY_D = px2len(30);

/** 敌人「敲门」的位置：正好贴着门板靠走廊一侧 */
const KNOCK_WX = px2wx(WALL_X - WALL_APPROACH_DIST) - px2len(6);

const STATUS_COLORS = {
  frost: 0x7fdfff,
  burn: 0xff8c42,
  poison: 0xa3e635,
  elite: 0xffd166,
  boss: 0xc77dff,
};

export function createEnemyLayer(scene) {
  const geo = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D);
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.55, metalness: 0.12,
    emissive: 0xffffff, emissiveIntensity: 0.34,
  });

  const body = new THREE.InstancedMesh(geo, mat, MAX);
  body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  body.castShadow = true;
  body.receiveShadow = true;
  body.frustumCulled = false;
  body.count = 0;
  body.name = 'enemyBody';
  scene.add(body);

  // 血量条：一个 InstancedMesh 的薄片，挂在敌人头顶
  const hpGeo = new THREE.PlaneGeometry(1, 1);
  const hpMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.92,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const hpBars = new THREE.InstancedMesh(hpGeo, hpMat, MAX);
  hpBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hpBars.frustumCulled = false;
  hpBars.count = 0;
  hpBars.renderOrder = 16;
  hpBars.name = 'enemyHp';
  scene.add(hpBars);

  // 状态环：每个敌人一个，扁平贴在脚底（InstancedMesh）
  const ringGeo = new THREE.RingGeometry(px2len(20), px2len(26), 18);
  const ringMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.InstancedMesh(ringGeo, ringMat, MAX);
  ring.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ring.frustumCulled = false;
  ring.count = 0;
  ring.renderOrder = 14;
  ring.name = 'enemyRing';
  scene.add(ring);

  // 敲门提示环：每条车道一个，贴在门板前面
  const knockGeo = new THREE.RingGeometry(px2len(16), px2len(24), 20);
  const knockFx = LANES.map((L, i) => {
    const m = new THREE.Mesh(
      knockGeo,
      new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    m.visible = false;
    m.name = `knock_${i}`;
    m.position.set(KNOCK_WX, px2len(70), px2wz(L.doorY));
    m.rotation.set(0, Math.PI / 2, 0);
    scene.add(m);
    return m;
  });

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const col2 = new THREE.Color();
  let t = 0;
  /** hpBars / ring 各自的写入游标（不能共用 —— 一个敌人可能只有血条没有环） */
  let barCount = 0;
  let ringCount = 0;

  // ── 第 6 步：死亡溶解的幽灵池 ──
  //
  // 固定容量的池子（不是每死一只 new 一个 Mesh）。塔防后期一秒可能死
  // 十几只，动态创建/销毁 Mesh 会持续触发 GC 抖动。池子满了就复用最旧的
  // —— 视觉上"少看到一个溶解"远比"卡一下"可接受。
  const GHOST_POOL = 28;
  const GHOST_LIFE = 0.35;
  const ghostGeo = new THREE.BoxGeometry(1, 1, 1);
  const ghosts = Array.from({ length: GHOST_POOL }, () => {
    const m = new THREE.Mesh(ghostGeo, new THREE.MeshStandardMaterial({
      transparent: true, opacity: 0, depthWrite: false,
      emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.6,
    }));
    m.visible = false;
    m.frustumCulled = false;
    m.name = 'enemyGhost';
    scene.add(m);
    return { mesh: m, life: 0, maxLife: GHOST_LIFE, sizeK: 1, color: 0xffffff };
  });
  let ghostCursor = 0;
  /** 累计放出过的溶解替身总数（调试/测试用） */
  let ghostsSpawned = 0;
  /** 上一帧见过的活敌人 → 它们最后的派生位置与外观（用来做溶解替身） */
  const seen = new Map();
  const seenNow = new Set();

  /** 放一个正在溶解的替身 */
  function spawnGhost(rec, snap) {
    const g = ghosts[ghostCursor];
    ghostCursor = (ghostCursor + 1) % GHOST_POOL;
    g.life = GHOST_LIFE;
    g.maxLife = GHOST_LIFE;
    g.sizeK = snap.sizeK;
    g.color = snap.color;
    g.mesh.visible = true;
    g.mesh.position.set(snap.x, snap.y, snap.z);
    g.mesh.scale.set(BODY_W, BODY_H, BODY_D);
    g.mesh.material.color.set(snap.color);
    g.mesh.material.emissive.set(snap.color);
    g.mesh.material.opacity = 0.85;
    ghostsSpawned++;
    void rec;
  }

  /** 推进幽灵的溶解动画（每帧，独立于敌人数量） */
  function updateGhosts(dt) {
    for (const g of ghosts) {
      if (g.life <= 0) continue;
      g.life -= dt;
      if (g.life <= 0) { g.mesh.visible = false; g.mesh.material.opacity = 0; continue; }
      const k = 1 - g.life / g.maxLife;            // 0 → 1 溶解进度
      // 横向膨胀 + 纵向压扁：比单纯缩放更像"散开"
      g.mesh.scale.set(
        BODY_W * (1 + k * 0.75),
        BODY_H * (1 - k * 0.55),
        BODY_D * (1 + k * 0.75),
      );
      g.mesh.position.y = BODY_H * g.sizeK * 0.5 * (1 - k * 0.35);
      g.mesh.material.opacity = 0.85 * (1 - k) * (1 - k);   // 二次淡出，收尾更快
    }
  }

  /**
   * 每帧同步。返回真正绘制的敌人数，方便自动化测试断言。
   */
  function sync(enemies, dt) {
    t += dt;
    let n = 0;
    barCount = 0;
    ringCount = 0;
    const knockingLanes = [false, false, false];

    // 第 6 步：先处理上一帧的幽灵（与这一帧的敌人无关）
    updateGhosts(dt);
    seenNow.clear();

    for (const e of enemies) {
      if (n >= MAX) break;
      const p = enemyWorldPos3D(e, e.progress);
      seenNow.add(e);

      // 走路起伏 / 敲门晃动只作用在渲染变换上，progress 一个字节都不动
      let y = BODY_H / 2;
      let xOff = 0;
      if (e.state === 'walk') {
        y += Math.sin(t * 9 + (e.bobPhase || 0)) * BODY_H * 0.07;
      } else {
        xOff = Math.sin(t * 26 + (e.bobPhase || 0)) * px2len(4);
        if (knockingLanes[e.lane] !== undefined) knockingLanes[e.lane] = true;
      }

      // 体型按 def.r 缩放（杂兵 r=17，BOSS 更大）
      const sizeK = Math.max(0.6, Math.min(2.2, (e.r || 17) / 17));

      dummy.position.set(p.x + xOff, y * sizeK, p.z);
      dummy.rotation.set(0, Math.PI / 2, 0); // 面朝门（+X）
      dummy.scale.set(sizeK, sizeK, sizeK);
      dummy.updateMatrix();
      body.setMatrixAt(n, dummy.matrix);

      // ⚠️ dummy 是个**共享**的临时对象，下面画血条/状态环还会反复改它。
      //    所以这里必须把本体的位置**拷出来**，不能存 dummy.position 的引用
      //    （引用会指向最后一次写入的值 = 状态环的位置）。
      const bodyX = dummy.position.x;
      const bodyY = dummy.position.y;
      const bodyZ = dummy.position.z;

      // 颜色：受伤越重越暗；受击瞬间刷白（e.hitFlash）
      const hpRatio = Math.max(0, Math.min(1, e.hp / e.maxHp));
      col.set(e.color || '#b28dff').multiplyScalar(0.45 + hpRatio * 0.55);
      if (e.hitFlash > 0) col.lerp(col2.setHex(0xffffff), 0.55);
      body.setColorAt(n, col);

      // 第 6 步：记住这只敌人的位置与颜色。下一帧若它不在了，
      // 就用这份快照放一个溶解替身。
      // ⚠️ 颜色要存**当帧算好的**（受伤变暗/受击刷白之后的），
      //    否则溶解出来的替身是满血原色，和它临死的样子对不上。
      seen.set(e, {
        x: bodyX,
        y: bodyY,
        z: bodyZ,
        sizeK,
        color: col.getHex(),
      });

      // 血条：只有受伤了才显示（避免满场白条）
      if (hpRatio < 1 && !e.boss && barCount < MAX) {
        const bw = px2len(28) * sizeK;
        dummy.position.set(p.x + xOff, BODY_H * sizeK + px2len(10), p.z);
        dummy.rotation.set(0, -Math.PI / 2, 0);
        dummy.scale.set(bw, px2len(5), 1);
        dummy.updateMatrix();
        hpBars.setMatrixAt(barCount, dummy.matrix);
        // 血条颜色：>50% 绿 → <=50% 黄 → <=25% 红
        const hc = hpRatio > 0.5 ? 0x6ee7a8 : (hpRatio > 0.25 ? 0xffd166 : 0xff5d5d);
        hpBars.setColorAt(barCount, col2.setHex(hc));
        barCount++;
      }

      // 状态环：BOSS / 精英 / 减速 / 灼烧 / 中毒 五种状态各一种颜色
      let ringColor = 0;
      if (e.boss) ringColor = STATUS_COLORS.boss;
      else if (e.elite) ringColor = STATUS_COLORS.elite;
      else if (e.slowT > 0 || e.stun > 0) ringColor = STATUS_COLORS.frost;
      else if (e.burnT > 0) ringColor = STATUS_COLORS.burn;
      else if (e.poisonT > 0) ringColor = STATUS_COLORS.poison;

      if (ringColor && ringCount < MAX) {
        dummy.position.set(p.x, px2len(3), p.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        const pulse = e.boss ? 1 + Math.sin(t * 4) * 0.12 : 1;
        dummy.scale.setScalar(sizeK * pulse);
        dummy.updateMatrix();
        ring.setMatrixAt(ringCount, dummy.matrix);
        ring.setColorAt(ringCount, col2.setHex(ringColor));
        ringCount++;
      }

      n++;
    }

    body.count = n;
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;

    hpBars.count = barCount;
    hpBars.instanceMatrix.needsUpdate = true;
    if (hpBars.instanceColor) hpBars.instanceColor.needsUpdate = true;

    ring.count = ringCount;
    ring.instanceMatrix.needsUpdate = true;
    if (ring.instanceColor) ring.instanceColor.needsUpdate = true;

    knockFx.forEach((fx, i) => {
      fx.visible = knockingLanes[i];
      if (fx.visible) {
        const s = 1 + Math.sin(t * 14 + i) * 0.18;
        fx.scale.set(s, s, s);
      }
    });

    // 第 6 步：diff 出「上一帧还在、这一帧没了」的敌人 → 放溶解替身。
    //
    // ⚠️ 只有**真的消失**才算死。第一版没区分「死了」和「还没出生」，
    //    结果开波第一帧把整波敌人当成"刚死"（seen 是空的，seenNow 满了 ——
    //    差集算反了就成了满屏幽灵）。所以方向必须写死：
    //    遍历 seen 里**不在 seenNow** 的键。
    //    另外，重开/读档会整批换敌人，那一帧会被误判成"全部死亡"——
    //    没什么坏处（一批幽灵溶解掉，视觉上反而像清场），所以不额外特判。
    for (const [e, snap] of seen) {
      if (seenNow.has(e)) continue;
      seen.delete(e);
      spawnGhost(e, snap);
    }

    return n;
  }

  return {
    body, hpBars, ring, sync, knockFx, MAX,
    ghosts, seen,
    get ringCount() { return ringCount; },
    get barCount() { return barCount; },
    /** 正在溶解的替身数量（自动化测试断言用） */
    get ghostCount() { return ghosts.filter((g) => g.life > 0).length; },
    /** 累计放出过多少溶解替身（用于"确实看见了死亡"这类断言） */
    get ghostsSpawned() { return ghostsSpawned; },
  };
}
