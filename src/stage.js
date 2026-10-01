// ============================================================
//  stage.js —— 渲染舞台：正交相机 + 渲染器 + 主循环
// ============================================================
//
// 为什么用**正交相机**（而不是透视）：
//
//   1. 8×5 网格直接映射到 XZ 平面，正交投影下「格子中心 → 屏幕位置」
//      是线性变换，和 2D 版的观感一一对应，玩家不用重新学怎么读战场。
//   2. core.js 里所有 `e.x > WALL_X` 这类横向推进逻辑，在正交下
//      视觉表现也是匀速直线，不会有透视带来的近大远小干扰判断。
//   3. 最重要的一点：塔防的核心是「读位置」，不是「沉浸感」。
//      正交让玩家永远能同时看清 40 个格子里的所有东西，这是玩法需求。
//
// 相机摆位：从房间一侧斜上方俯视，让走廊在画面左侧、房间在右侧，
// 和 2D 版的布局心智一致（敌人从左进）。
// ============================================================

import * as THREE from 'three';
import { WORLD_W, WORLD_D } from './world.js';

// ── 渲染质量档位 ────────────────────────────────────────────
//
// 为什么需要「档位」而不是一个固定 DPR：
//   手机上一个 390×844 CSS px 的屏幕，在 devicePixelRatio=3 时全分辨率是
//   1170×2532 ≈ **296 万像素**，每帧还要额外跑一遍 2048² 的 PCFSoft 阴影贴图。
//   中低端 GPU 上这直接把帧率压到 20fps 上下。而塔防是**持续有 40 个格子
//   在动**的场景，掉帧比分辨率糊更致命。
//
//   所以这里做两件事：
//     1. 按**设备能力**给一个基础档（见 baseTierFor）；
//     2. 按**实测帧率**在基础档以下动态微调（见 adaptQuality），带迟滞。
//
// 档位表：索引越大越清晰、越贵。取值是「DPR 上限」，不是最终 DPR ——
// 最终 DPR = min(devicePixelRatio, 档位上限)，所以 1x 屏拿不到 2 的增益。
//
//   0 → 1     低端机：先保帧率，画质让位
//   1 → 1.5   移动端默认：2x/3x 屏上线性分辨率砍到 75%，肉眼在手机
//             观看距离下几乎无感，但像素量只剩 56%（1.5²/2²=0.5625）
//   2 → 2     桌面：与本次改动**完全一致**，观感不变
const DPR_TIERS = [1, 1.5, 2];

/**
 * 依据设备能力挑选基础档位。
 *
 * 判断依据（为什么是这几个阈值）：
 *   · 桌面（非移动 UA）→ 档位 2。桌面 GPU 充裕，且这是改动前的行为，
 *     不降档才能保证「桌面观感不变」。
 *   · 低端移动设备 → 档位 0。判据是「核心数 ≤ 4 或内存 ≤ 3GB」——
 *     这两个 API（hardwareConcurrency / deviceMemory）在低端安卓上
 *     会给出明显偏低的值；拿不到时（Safari 没有 deviceMemory）按 4 处理，
 *     宁可判成中端也不误伤旗舰。
 *   · 其余移动设备 → 档位 1。3x 屏（iPhone Pro / 多数旗舰安卓）是最大
 *     受益者：DPR 从 3 降到 1.5，像素量降到 1/4。
 *
 * ⚠️ 这里**不**依赖 matchMedia('(pointer:coarse)')：桌面触摸屏（Windows
 *    触屏本）会命中 coarse，但它有独显、不该降档。移动判定只认 UA +
 *    maxTouchPoints，避免误伤桌面触摸屏。
 */
function profileDevice() {
  const nav = globalThis.navigator || {};
  const ua = String(nav.userAgent || '');
  const maxTouchPoints = nav.maxTouchPoints || 0;
  const cores = nav.hardwareConcurrency || 4;
  const memGB = nav.deviceMemory || 4;   // 只有 Chromium 系有；Safari 恒为 undefined
  const dpr = globalThis.devicePixelRatio || 1;

  // iPadOS 13+ 的 Safari 默认发桌面 UA（Macintosh），只能靠多点触控认出来。
  const iPadDesktopUA = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || iPadDesktopUA;
  const isLowEnd = isMobile && (cores <= 4 || memGB <= 3);

  let baseTier;
  if (!isMobile) baseTier = 2;
  else if (isLowEnd) baseTier = 0;
  else baseTier = 1;

  return { isMobile, isLowEnd, dpr, cores, memGB, maxTouchPoints, baseTier };
}

/**
 * 帧率自适应的调参（迟滞在这里）。
 *
 * 为什么要迟滞：帧时是**噪声很大**的信号（一次 GC、一次贴图上传就能
 * 让某一帧跳到 100ms）。如果「慢了就降、快了就升」用同一个阈值，
 * 档位会在两个值之间来回震荡，玩家看到的是分辨率闪烁。
 * 这里的做法是：
 *   · 降档阈值 22ms（≈45fps） 与 升档阈值 12ms（≈83fps）之间留 10ms 死区；
 *   · 升档还要求**连续 3 个采样窗口**都快（fastStreak），降档只需 1 个窗口；
 *   · 每次换档后有 90 帧冷却，冷却期内不再评估。
 * 三个条件叠加，单帧抖动不可能触发换档。
 */
// ⚠️ 预热用**时间**而不是帧数：启动期有 1~2 秒的着色器编译 / 贴图上传抖动，
//    如果按帧数算，一台只有 10fps 的低端机要跑 120 帧（12 秒）才开始评估，
//    黄花菜都凉了。时间门槛在任何帧率下都等价。
const QUALITY_WARMUP_MS = 2000;
const QUALITY_WARMUP_MIN_FRAMES = 30;
const QUALITY_SAMPLE_FRAMES = 60;    // 每 60 帧评估一次（≈1 秒）
const QUALITY_DOWNGRADE_MS = 22;     // 平均帧时 > 22ms → 降档
const QUALITY_UPGRADE_MS = 12;       // 平均帧时 < 12ms → 计入「快」
const QUALITY_UPGRADE_STREAK = 3;    // 连续 3 个窗口都快才升档
const QUALITY_COOLDOWN_FRAMES = 90;  // 换档后冷却 90 帧

/**
 * 正交相机的可视高度（世界单位）。
 * 场地是 12.8 × 7.2 m，55° 俯视后 Z 方向会投影成 7.2*sin(55°) ≈ 5.9 m 高。
 * 取 8.6 是为了给 HUD 留出上下留白 —— 之前用 8.2 时，房间最右列
 * （床所在的第 8 列）在 16:9 下会被裁掉一点。
 */
const VIEW_H = 8.6;
/**
 * 视口在**屏幕垂直方向**上抬的比例（0.5 = 正中，0 = 贴底，1 = 贴顶）。
 *
 * ⚠️ 为什么需要这个：底部有一条 `position:fixed` 的建造栏（高约 140px），
 *    如果场地画在视口正中，建造栏一定会压住最下面一排格子 —— 玩家
 *    看不见也点不到。把正交视锥整体上抬一点（等效于把场地往画面上方推），
 *    底部就腾出纯粹的 HUD 空间，场地也不再被遮挡。
 *
 * 0.425 ≈ 场地中心在屏幕高度 42.5% 处，给底部建造栏留出足够的净空
 * （建造栏约 140px 高且贴底 44px，实测需要 ~40% 以上的下缘留白）。
 */
const VIEW_BIAS_Y = 0.425;
/** 相机仰角（弧度）：55° 俯视，能看见地块侧面但不会太扁。 */
const CAM_ELEV = THREE.MathUtils.degToRad(55);
/**
 * 相机方位角（弧度）。
 *
 * ⚠️ 这里很容易搞错，写清楚：
 *   我们希望屏幕上「世界 +X 朝右、世界 +Z 朝下」，因为 2D 版就是
 *   「x 向右、y 向下」，一一对应玩家已有的心智。
 *
 *   相机位置 = target + dist * (cos(elev)cos(azim), sin(elev), cos(elev)sin(azim))
 *   当 azim = -90° 时相机位于 target 的 -Z 侧（屏幕上方）往 +Z 看，
 *   此时世界 +X 会映射到屏幕**右**侧、+Z 映射到屏幕**下**侧 —— 正是要的效果。
 *   （azim = +90° 会左右镜像；azim = 0 会让房间跑到屏幕左边。）
 */
const CAM_AZIM = THREE.MathUtils.degToRad(-90);
/** 相机看向场地中心，略微偏向房间（主战场在房间那侧） */
const LOOK_BIAS_X = 0.52;

export function createStage({ canvas, onResize } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x0a0c14, 1);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // ── 质量状态 ────────────────────────────────────────────
  const profile = profileDevice();
  const baseTier = profile.baseTier;
  let dprTier = baseTier;          // 当前档位（自适应可能把它降到 baseTier 以下）
  let autoQuality = true;          // 帧率自适应开关
  let appliedDpr = 1;              // 实际生效的 pixelRatio（供调试面读取）
  let lastW = 0, lastH = 0;        // 最近一次尺寸 —— 换档时要按同一尺寸重设缓冲区
  let frameCount = 0;
  let warmupMs = 0;                // 已运行的帧时累计（预热判据，见 QUALITY_WARMUP_MS）
  let sampleAcc = 0, sampleN = 0;  // 帧时采样累加
  let sinceChange = QUALITY_COOLDOWN_FRAMES;
  let fastStreak = 0;

  // 阴影默认策略：桌面开、移动关。
  // 桌面（含 Windows 触屏本）保持 PCFSoftShadowMap —— 观感与改动前一致。
  // 移动端默认关闭：阴影贴图是移动 GPU 上最贵的一项，关了立竿见影，
  // 且塔防读的是**平面位置**，没有阴影不影响任何玩法判断。
  let shadowsEnabled = !profile.isMobile;
  let shadowType = shadowsEnabled ? THREE.PCFSoftShadowMap : THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0c14, 16, 34);

  // 相机看向场地中心（略微往房间侧偏一点，因为房间是主战场）
  const target = new THREE.Vector3(WORLD_W * LOOK_BIAS_X, 0, WORLD_D * 0.5);
  const camDist = 20;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  camera.position.set(
    target.x + camDist * Math.cos(CAM_ELEV) * Math.cos(CAM_AZIM),
    target.y + camDist * Math.sin(CAM_ELEV),
    target.z + camDist * Math.cos(CAM_ELEV) * Math.sin(CAM_AZIM),
  );
  camera.up.set(0, 0, -1); // ⚠️ 关键：让世界 +Z 映射到屏幕「下」，与 2D 的 y 向下一致
  camera.lookAt(target);

  /**
   * 依据画布尺寸更新正交视锥，保证 16:9 时地面完整可见。
   *
   * ⚠️ 这里同时做了「垂直偏心」：把视锥整体上移 (VIEW_BIAS_Y - 0.5) * VIEW_H，
   *    等效于场地在屏幕上偏上，底部腾出建造栏的空间。
   *    注意**不能**用 camera.setViewOffset（正交相机上它按像素算，跨分辨率不稳）。
   */
  /**
   * 按**当前档位**把渲染缓冲区设成 lastW × lastH。
   *
   * ⚠️ 抽出来是因为它有两个调用点：resize（尺寸变了）与 setDprTier
   *    （尺寸没变、只是档位变了）。如果只在 resize 里应用档位，
   *    自适应降档就会「降了个寂寞」—— 直到下次旋转屏幕才生效。
   */
  function applyRenderSize() {
    if (!lastW || !lastH) return;
    const cap = DPR_TIERS[dprTier];
    // 上限截断：1x 屏不会因为档位 2 就渲染 2x（那只是浪费）
    appliedDpr = Math.max(0.5, Math.min(globalThis.devicePixelRatio || 1, cap));
    renderer.setPixelRatio(appliedDpr);
    renderer.setSize(lastW, lastH, false);
  }

  function resize(w, h) {
    lastW = w;
    lastH = h;
    applyRenderSize();

    const aspect = w / h;
    const halfH = VIEW_H / 2;
    const halfW = halfH * aspect;
    // 视锥中心上抬：屏幕坐标 y 向下为正，所以「上抬」= 视锥 top/bottom 同时加正值
    const shiftY = (VIEW_BIAS_Y - 0.5) * VIEW_H;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH + shiftY;
    camera.bottom = -halfH + shiftY;
    camera.updateProjectionMatrix();

    if (onResize) onResize({ w, h, aspect });
  }

  // ── 灯光：一盏主光投影 + 一盏补光提亮暗部 + 一点环境色 ──
  const ambient = new THREE.AmbientLight(0x5a6a8a, 1.1);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xbcd2ff, 1.5);
  key.position.set(-6, 14, -8);
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 50;
  key.shadow.bias = -0.0012;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x7a4fa8, 0.55);
  fill.position.set(9, 7, 9);
  scene.add(fill);

  /**
   * 把当前阴影策略落到渲染器与主光上。可逆 —— 关掉再开回原样。
   *
   * · 关闭时：shadowMap.enabled=false 让整趟阴影 pass 被跳过，
   *   同时把 key.castShadow 也置 false（否则光还会去更新 shadow camera）。
   * · 打开时：桌面固定 PCFSoftShadowMap（**桌面观感必须与改动前一致**）；
   *   移动端用更便宜的 PCFShadowMap，并把贴图从 2048² 降到 1024²
   *   （阴影贴图的开销与边长平方成正比，2048→1024 是 4 倍差距）。
   */
  function applyShadows() {
    renderer.shadowMap.enabled = shadowsEnabled;
    shadowType = !shadowsEnabled ? THREE.PCFSoftShadowMap
      : (profile.isMobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap);
    renderer.shadowMap.type = shadowType;
    key.castShadow = shadowsEnabled;

    const size = (shadowsEnabled && profile.isMobile) ? 1024 : 2048;
    if (key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      // 改了尺寸必须丢弃旧的 render target，否则 three 会沿用旧的缓冲区
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
  }
  applyShadows();

  /**
   * 设置 DPR 档位。手动调用会**关掉自适应**（玩家的显式选择优先于自动策略）。
   * @param {number} i 档位索引 0..DPR_TIERS.length-1（越界会被夹取）
   */
  function setDprTier(i, { auto = false } = {}) {
    const next = Math.max(0, Math.min(DPR_TIERS.length - 1, i | 0));
    autoQuality = auto ? true : false;
    if (next === dprTier) { applyRenderSize(); return dprTier; }
    dprTier = next;
    applyRenderSize();          // 尺寸没变也要重设缓冲区 —— 这正是「换档生效」的关键
    return dprTier;
  }

  /** 打开/关闭帧率自适应（重新打开时从当前档位继续评估） */
  function setAutoQuality(v) {
    autoQuality = !!v;
    // 重新打开时重置采样与预热 —— 否则会拿「刚打开前那段时间」的旧抖动立刻换档
    if (autoQuality) { sinceChange = QUALITY_COOLDOWN_FRAMES; fastStreak = 0; sampleAcc = 0; sampleN = 0; warmupMs = 0; }
    return autoQuality;
  }

  /** 阴影开关（可逆）。桌面默认开、移动默认关，见上面 shadowsEnabled 的注释。 */
  function setShadows(v) {
    shadowsEnabled = !!v;
    applyShadows();
    return shadowsEnabled;
  }

  /**
   * 帧率自适应：采样平均帧时，慢了降档、长期富余才升档（带迟滞，见顶部注释）。
   * 只在 autoQuality 打开时运行，且永远不越过 baseTier（设备能力上限）。
   */
  function adaptQuality(dt) {
    if (!autoQuality) return;
    frameCount++;
    warmupMs += dt * 1000;
    if (warmupMs < QUALITY_WARMUP_MS || frameCount < QUALITY_WARMUP_MIN_FRAMES) return;  // 跳过启动期抖动

    sampleAcc += dt;
    sampleN++;
    if (sampleN < QUALITY_SAMPLE_FRAMES) return;

    const avgMs = (sampleAcc / sampleN) * 1000;
    sampleAcc = 0; sampleN = 0;
    sinceChange++;

    if (sinceChange < QUALITY_COOLDOWN_FRAMES) return;  // 换档后先冷一会儿

    if (avgMs > QUALITY_DOWNGRADE_MS) {
      fastStreak = 0;
      if (dprTier > 0) { dprTier--; applyRenderSize(); sinceChange = 0; }
    } else if (avgMs < QUALITY_UPGRADE_MS && dprTier < baseTier) {
      if (++fastStreak >= QUALITY_UPGRADE_STREAK) {
        dprTier++; applyRenderSize(); sinceChange = 0; fastStreak = 0;
      }
    } else {
      fastStreak = 0;
    }
  }

  // ── 主循环：固定步长，与 2D 版一致的 60Hz 逻辑节拍 ──
  const FIXED_DT = 1 / 60;
  const MAX_FRAME = 0.25;
  let acc = 0;
  let last = 0;
  let raf = 0;
  const frameHooks = [];
  const renderHooks = [];
  let running = false;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = rawDt > MAX_FRAME ? MAX_FRAME : rawDt; // 切标签页回来时不要一次追平几百帧
    // ⚠️ 只用**未被钳制**的帧去评估性能：被钳制的那一帧是「切后台回来 /
    //    首帧」的跳变，把它算进去会让玩家切一次标签页就白降一档。
    if (rawDt < MAX_FRAME) adaptQuality(rawDt);
    acc += dt;
    let steps = 0;
    while (acc >= FIXED_DT && steps < 8) {
      for (const h of frameHooks) h(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }
    if (steps === 8) acc = 0;

    // 呈现同步：每帧一次，不是每逻辑帧一次 —— 它只关心「现在长什么样」
    for (const h of renderHooks) h(dt);
    renderer.render(scene, camera);
  }

  return {
    renderer,
    scene,
    camera,
    resize,
    /** 注册固定步长逻辑回调 */
    onStep(fn) { frameHooks.push(fn); return () => {
      const i = frameHooks.indexOf(fn);
      if (i >= 0) frameHooks.splice(i, 1);
    }; },
    /** 注册「每帧渲染前」回调（表现同步用，不做逻辑推进） */
    onBeforeRender(fn) { renderHooks.push(fn); return () => {
      const i = renderHooks.indexOf(fn);
      if (i >= 0) renderHooks.splice(i, 1);
    }; },
    start() { if (running) return; running = true; last = 0; acc = 0; raf = requestAnimationFrame(frame); },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    get running() { return running; },

    // ── 质量 / 性能调试面 ────────────────────────────────
    // 通过 __TANGPING3D__.stage.* 读取（stage 已经挂在调试面上）。
    // 验收脚本要验证「自适应真的生效」只能靠这里 —— 否则档位是黑盒。
    setDprTier, setAutoQuality, setShadows,
    get dprTier() { return dprTier; },
    get dprTierBase() { return baseTier; },
    get dprTierCaps() { return DPR_TIERS.slice(); },
    /** 当前实际生效的 pixelRatio（= min(devicePixelRatio, 档位上限)） */
    get pixelRatio() { return appliedDpr; },
    get shadowsEnabled() { return shadowsEnabled; },
    get shadowType() { return shadowType; },
    get autoQuality() { return autoQuality; },
    get deviceProfile() { return { ...profile }; },
    /** 一次性快照：验收脚本读这个最省事 */
    get quality() {
      return {
        dprTier, dprTierBase: baseTier, dprTierCaps: DPR_TIERS.slice(),
        pixelRatio: appliedDpr, autoQuality, shadowsEnabled, shadowType,
        isMobile: profile.isMobile, isLowEnd: profile.isLowEnd,
        devicePixelRatio: profile.dpr,
      };
    },
    THREE,
  };
}
