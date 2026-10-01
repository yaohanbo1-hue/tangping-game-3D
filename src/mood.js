// ============================================================
//  mood.js —— 氛围层：环境光 / 雾 / 暗角（第 6 步）
// ============================================================
//
// ── 为什么需要这一层 ───────────────────────────────────────
//
//   第 3 步把空间立起来了，第 4 步把规则接进来了，但画面是「平的」：
//   从第 1 波到第 60 波都是同一套冷白主光、同一档雾。塔防里这是
//   真实的信息损失 —— 玩家没法从画面本身读出「这一局走到哪儿了」。
//
//   2D 版靠 HUD 数字表达进度。3D 多了一个维度可用：**光**。
//   所以这里按「幕」把环境光/雾/暗角推过去：
//
//     第 1 幕 夜巡      → 冷、清、雾薄     （一切还没开始）
//     第 2 幕 值夜表    → 偏青、雾起
//     第 3 幕 空位      → 灰紫、雾浓
//     第 4 幕 灯        → 暖橙、雾散一点
//     第 5 幕 回音      → 血紫、雾最浓、暗角重
//
//   再叠一层**战况反馈**（与幕无关，实时）：
//     · 床位掉血 → 整个画面偏红、暗角收紧（玩家的视线被逼向床）
//     · BOSS 在场 → 加一层脉动的暖色污染
//     · 失败     → 灰白化 + 暗角拉满
//     · 通关     → 提亮 + 暖色
//
// ── 为什么不用 THREE 的后期处理（EffectComposer）──────────
//
//   暗角（vignette）最正统的做法是 EffectComposer + ShaderPass。
//   但那样要引入 `three/examples/jsm/...` 三个模块 + 一次全屏
//   离屏渲染 —— 对一个只需要「四个角暗一点」的效果来说代价太大，
//   而且在 SwiftShader（CI 用的软件渲染）上会明显拖慢。
//
//   这里改用一个**贴脸的 Sprite**：在正交相机前放一张径向渐变纹理，
//   铺满整个视锥。视觉结果与后处理暗角几乎无法区分，成本是一次
//   透明四边形绘制，而且完全不依赖相机参数（正交相机下只要跟着
//   视锥大小缩放即可）。
//
// ── 与 stage.js 的灯光关系 ─────────────────────────────────
//
//   stage.js 建了 3 盏灯（ambient / key / fill）。mood 不去新建灯，
//   而是**查找并调制**它们 —— 好处是「灯在哪儿建的」只有一个答案，
//   不会出现「改 stage.js 的灯不改 mood 的灯」而导致的两套真相。
//
//   查找方式是遍历 scene.children 按类型 + 名字认。stage.js 的
//   三盏灯没有名字，所以这里按「第 N 个 AmbientLight / DirectionalLight」
//   的**顺序**认，并在文档里写死这个约定（改 stage.js 的灯顺序要同步改这里）。
//   这比让 mood 自己 new 一堆灯更脆弱一点，但保住了「一个地方建灯」。
// ============================================================

import * as THREE from 'three';
import { FINAL_WAVE } from './rules/constants.js';

// ══════════════════════════════════════════════════════════
//  幕次映射
// ══════════════════════════════════════════════════════════
//
// 与叙事包的 CHAPTER_DEFS 对应：15 个章节、5 幕，每幕 3 章。
// 剧情上「到第 50 波再慢慢找到真相」，60 波是最终 BOSS，
// 所以这里把 60 波切成 5 段，每段 12 波 = 一幕。
//
// ⚠️ 这个分界是**表现层的**，不参与任何规则判定。
//    叙事包内部的幕次切换（ChapterSystem）自己按章节数据算，
//    两边不需要一致 —— 一边是「哪一章的文本」，一边是「画面什么颜色」。
//    硬绑在一起会变成「改文案要改光照」的耦合。
export const ACT_SPAN = Math.ceil(FINAL_WAVE / 5);   // 12 波一幕

/**
 * 每一幕的氛围参数。
 *
 *   ambient      环境光颜色 + 强度（决定整体色调与影调）
 *   key          主光颜色 + 强度（决定"这是白天还是深夜"）
 *   fill         补光颜色 + 强度（决定暗部的冷暖对比）
 *   fogNear/Far  雾的起止距离（决定纵深感与"能不能看清走廊尽头"）
 *   fogColor     雾色（应当接近背景色，否则会出现脏边）
 *   vig          暗角强度 0-1
 *   vigTint      暗角的色偏（暗角不是纯黑，偏一点当前幕的颜色更融）
 */
export const ACT_MOODS = [
  {
    // 第一幕 · 夜巡 —— 一切还没开始，画面干净、冷、看得远
    id: 'night-watch', name: '夜巡',
    ambient: { color: 0x5a6a8a, intensity: 1.10 },
    key: { color: 0xbcd2ff, intensity: 1.50 },
    fill: { color: 0x7a4fa8, intensity: 0.55 },
    fog: { color: 0x0a0c14, near: 16, far: 34 },
    vig: 0.34, vigTint: 0x05060c,
  },
  {
    // 第二幕 · 值夜表 —— 记录出现了矛盾，色调偏青，雾开始进画面
    id: 'the-record', name: '值夜表',
    ambient: { color: 0x4a6478, intensity: 0.98 },
    key: { color: 0xa8c8e8, intensity: 1.34 },
    fill: { color: 0x3f7f88, intensity: 0.62 },
    fog: { color: 0x0a1016, near: 13, far: 30 },
    vig: 0.42, vigTint: 0x060a12,
  },
  {
    // 第三幕 · 空位 —— 最不安的一幕：灰紫、雾浓、看不清远处
    id: 'the-empty-place', name: '空位',
    ambient: { color: 0x555070, intensity: 0.90 },
    key: { color: 0xa89cc8, intensity: 1.18 },
    fill: { color: 0x6a4a90, intensity: 0.68 },
    fog: { color: 0x0d0a18, near: 11, far: 26 },
    vig: 0.50, vigTint: 0x0a0616,
  },
  {
    // 第四幕 · 灯 —— 天亮了但没全亮：暖橙，雾散回一点，是希望的一幕
    id: 'the-lamp', name: '灯',
    ambient: { color: 0x6a6050, intensity: 1.16 },
    key: { color: 0xffd7a8, intensity: 1.46 },
    fill: { color: 0x9a6a48, intensity: 0.60 },
    fog: { color: 0x140e0c, near: 15, far: 32 },
    vig: 0.36, vigTint: 0x100806,
  },
  {
    // 第五幕 · 回音 —— 终局：血紫、雾最浓、暗角拉满
    id: 'the-reply', name: '回音',
    ambient: { color: 0x60405e, intensity: 0.94 },
    key: { color: 0xffb0c8, intensity: 1.28 },
    fill: { color: 0xa03a6a, intensity: 0.72 },
    fog: { color: 0x160810, near: 9, far: 23 },
    vig: 0.58, vigTint: 0x120410,
  },
];

/** 波次 → 幕下标（0-4）。**纯函数**，方便单测。 */
export function actIndexForWave(wave) {
  const i = Math.floor((Math.max(1, wave) - 1) / ACT_SPAN);
  return Math.max(0, Math.min(ACT_MOODS.length - 1, i));
}

/** 波次 → 氛围深度 0..1（供 audio.setAmbient 用 —— 越深越"沉"） */
export function depthForWave(wave) {
  return actIndexForWave(wave) / (ACT_MOODS.length - 1);
}

// ══════════════════════════════════════════════════════════
//  暗角贴图（代码生成，零外部资产）
// ══════════════════════════════════════════════════════════

/**
 * 生成一张径向渐变贴图当作暗角。
 *
 * 关键点是**渐变曲线**。第一版用了 `addColorStop(1, ...)` 的线性渐变，
 * 结果中间 60% 的屏幕都被均匀压暗了 —— 那不是暗角，那是降低亮度。
 * 真实暗角应该是「中心完全透明、边缘快速变暗」，所以用一条
 * 分段曲线把不透明度的拐点放在 0.55 左右：
 *
 *   r = 0.00 → alpha 0
 *   r = 0.55 → alpha 0     ← 中心一大片完全不受影响
 *   r = 0.78 → alpha 0.35
 *   r = 1.00 → alpha 1
 */
function makeVignetteTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

  // 曲线：中心大片全透明，边缘陡起。alpha 单位是 0-1，这里乘 255 给 CSS 用。
  const stops = [
    [0.00, 0],
    [0.48, 0],
    [0.62, 0.05],
    [0.76, 0.28],
    [0.88, 0.62],
    [1.00, 1],
  ];
  for (const [r, a] of stops) {
    g.addColorStop(r, `rgba(0,0,0,${a.toFixed(3)})`);
  }
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ══════════════════════════════════════════════════════════
//  主工厂
// ══════════════════════════════════════════════════════════

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera  正交相机。暗角要按它的视锥尺寸缩放。
 * @returns {object} 见文件末尾的返回对象
 */
export function createMood(scene, camera) {
  // ── 1. 认领 stage.js 建好的三盏灯 ──
  //
  // ⚠️ 顺序约定：stage.js 里先 add(ambient)、再 add(key)、再 add(fill)。
  //    three 的 scene.children 保序，所以按类型取第一个即可。
  //    改 stage.js 的灯顺序时必须同步改这里 —— 在文件头注释里也写了这条。
  let ambientLight = null, keyLight = null, fillLight = null;
  for (const o of scene.children) {
    if (!ambientLight && o.isAmbientLight) ambientLight = o;
    else if (!keyLight && o.isDirectionalLight) keyLight = o;
    else if (!fillLight && o.isDirectionalLight && o !== keyLight) fillLight = o;
  }
  if (!ambientLight || !keyLight) {
    console.warn('[mood] 没能在场景里找到 stage.js 的灯（ambient/key）。'
      + '氛围调色将被跳过，但游戏仍可玩。');
  }

  // ── 2. 暗角：一张贴在相机前的 sprite ──
  //
  // 挂在相机上（而不是场景上）：这样它永远跟着视线，不受场景平移/震屏影响。
  // 震屏时相机位置在动，如果暗角挂在场景里，画面边缘会露出未压暗的区域。
  const vigTex = makeVignetteTexture(256);
  const vigMat = new THREE.SpriteMaterial({
    map: vigTex,
    color: ACT_MOODS[0].vigTint,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    // ⚠️ 正常混合 + 黑色暗角贴图 = 只会变暗，不会变亮。
    //    用 AdditiveBlending 会变成"加一层白光"（黑是加法的单位元，
    //    想加暗色加不上去）。这里保持 NormalBlending。
    blending: THREE.NormalBlending,
  });
  const vignette = new THREE.Sprite(vigMat);
  vignette.name = 'vignette';
  vignette.renderOrder = 9999;   // 最后画，盖在所有东西上
  vignette.frustumCulled = false;
  camera.add(vignette);
  // ⚠️ camera 必须进 scene.children 才会渲染它的子节点。
  //    正交相机默认不在场景里，所以要显式 add（重复 add 无害）。
  if (!scene.children.includes(camera)) scene.add(camera);

  // ── 3. 状态 ──
  const cur = {
    ambient: Object.assign({}, ACT_MOODS[0].ambient),
    key: Object.assign({}, ACT_MOODS[0].key),
    fill: Object.assign({}, ACT_MOODS[0].fill),
    fog: Object.assign({}, ACT_MOODS[0].fog),
    vig: ACT_MOODS[0].vig,
    vigTint: new THREE.Color(ACT_MOODS[0].vigTint),
  };
  // 幕次目标（慢速插值）与战况目标（快速插值）分开，避免"床掉血"把幕次过渡打断
  const target = JSON.parse(JSON.stringify({
    ambient: ACT_MOODS[0].ambient, key: ACT_MOODS[0].key, fill: ACT_MOODS[0].fill,
    fog: ACT_MOODS[0].fog, vig: ACT_MOODS[0].vig, vigTint: ACT_MOODS[0].vigTint,
  }));

  let actIdx = 0;
  /** 战况叠加：-1 .. 1 之间的小偏移，由 update() 每帧算 */
  let stress = 0;       // 床位危险度 0..1
  let boss = 0;         // BOSS 在场 0..1
  let over = 0;         // 失败/通关 0..1
  let won = 0;          // 通关（正向）
  let t = 0;

  const baseFogColor = new THREE.Color(ACT_MOODS[0].fog.color);
  scene.fog = scene.fog || new THREE.Fog(0x0a0c14, 16, 34);

  // ⚠️ 场景背景色也要跟着雾色走。否则雾把远处染成 #0d0a18，
  //    背景还是 #0a0c14，地平线会出现一条可见的色带。
  const sceneBg = new THREE.Color(0x0a0c14);

  // ── 4. 切换幕次 ──

  /**
   * 立刻把氛围设到某一幕（不做过渡）。
   * 用于：读档、重开、初始化。
   */
  function setAct(idx, immediate = true) {
    actIdx = Math.max(0, Math.min(ACT_MOODS.length - 1, idx | 0));
    const m = ACT_MOODS[actIdx];
    Object.assign(target.ambient, m.ambient);
    Object.assign(target.key, m.key);
    Object.assign(target.fill, m.fill);
    Object.assign(target.fog, m.fog);
    target.vig = m.vig;
    target.vigTint = m.vigTint;
    if (immediate) {
      Object.assign(cur.ambient, target.ambient);
      Object.assign(cur.key, target.key);
      Object.assign(cur.fill, target.fill);
      Object.assign(cur.fog, target.fog);
      cur.vig = target.vig;
      cur.vigTint.set(target.vigTint);
      apply();
    }
    return ACT_MOODS[actIdx];
  }

  /** 按波次设幕次（main.js 在开波/读档时用） */
  function setWave(wave, immediate = false) {
    return setAct(actIndexForWave(wave), immediate);
  }

  /** main.js 的旧接口名：setDepth 与 setAct 同义（深度=幕下标） */
  function setDepth(depth) { return setAct(Math.round(depth), true); }

  /** 波次 → 氛围深度（给 audio.setAmbient 用） */
  function depthFor(wave) { return depthForWave(wave); }

  /** 把 cur 写进真正的 three 对象 */
  function apply() {
    if (ambientLight) {
      ambientLight.color.setHex(cur.ambient.color);
      ambientLight.intensity = cur.ambient.intensity;
    }
    if (keyLight) {
      keyLight.color.setHex(cur.key.color);
      keyLight.intensity = cur.key.intensity;
    }
    if (fillLight) {
      fillLight.color.setHex(cur.fill.color);
      fillLight.intensity = cur.fill.intensity;
    }

    // 雾色 + 背景色 + 距离
    baseFogColor.setHex(cur.fog.color);
    if (scene.fog) {
      scene.fog.color.copy(baseFogColor);
      scene.fog.near = cur.fog.near;
      scene.fog.far = cur.fog.far;
    }
    scene.background = sceneBg.copy(baseFogColor);

    // 暗角
    vigMat.color.copy(cur.vigTint);
    vigMat.opacity = cur.vig;
  }

  // ── 5. 每帧 ──

  const AMBIENT = 1;

  function update(dt, st = {}) {
    t += dt;

    // ── 5.1 战况读数 ──
    const bedMax = Math.max(1, st.bedMax || 1);
    const bedHp = Math.max(0, st.bedHp == null ? bedMax : st.bedHp);
    const hpK = bedHp / bedMax;

    // 床位低于 50% 才开始"紧张"，线性到 0% 满格。
    // 用 smoothstep 而不是线性：线性会让 100%→99% 就开始变色，
    // 玩家会一直看到画面在抖，反而麻木。
    const stressTarget = hpK >= 0.5 ? 0 : (1 - hpK / 0.5);
    const bossTarget = st.bossAlive ? 1 : 0;
    const overTarget = st.gameOver ? 1 : 0;
    const wonTarget = st.won ? 1 : 0;

    // 战况用快一点的插值（0.12s 级），让"床被撞"这件事立刻有反馈；
    // 幕次用慢的（2s 级），因为它是一次性的大过渡，快了会闪。
    const kFast = 1 - Math.pow(0.001, dt);
    const kSlow = 1 - Math.pow(0.55, dt);
    stress = lerp(stress, stressTarget, kFast);
    boss = lerp(boss, bossTarget, kFast);
    over = lerp(over, overTarget, kFast);
    won = lerp(won, wonTarget, kFast);

    // ── 5.2 幕次插值 ──
    cur.ambient.intensity = lerp(cur.ambient.intensity, target.ambient.intensity, kSlow);
    cur.key.intensity = lerp(cur.key.intensity, target.key.intensity, kSlow);
    cur.fill.intensity = lerp(cur.fill.intensity, target.fill.intensity, kSlow);
    cur.fog.near = lerp(cur.fog.near, target.fog.near, kSlow);
    cur.fog.far = lerp(cur.fog.far, target.fog.far, kSlow);
    cur.vig = lerp(cur.vig, target.vig, kSlow);
    // 颜色也插值（用 hex 通道手工插，避免引入额外 Color 对象）
    cur.ambient.color = mixHex(cur.ambient.color, target.ambient.color, kSlow);
    cur.key.color = mixHex(cur.key.color, target.key.color, kSlow);
    cur.fill.color = mixHex(cur.fill.color, target.fill.color, kSlow);
    cur.fog.color = mixHex(cur.fog.color, target.fog.color, kSlow);
    mixColorInto(cur.vigTint, target.vigTint, kSlow);

    // ── 5.3 战况叠加（不改 cur，只在本帧写出去） ──
    //
    // 叠加量算在 apply 之前，所以不会污染插值状态 —— 下一帧
    // 幕次插值从"干净的 cur"继续，床回血后画面能干净地恢复。
    const stressTint = 0x3a0008;   // 危险：偏血红的暗角
    const bossTint = 0x2a0a30;     // BOSS：偏紫的暗角
    const overTint = 0x101010;     // 失败：灰
    const wonTint = 0x2a2208;      // 通关：暖金

    let vigOut = cur.vig;
    let tintOut = cur.vigTint.getHex();

    if (stress > 0.001) {
      vigOut += stress * 0.30;
      tintOut = mixHex(tintOut, stressTint, stress * 0.85);
    }
    if (boss > 0.001) {
      // BOSS 脉动：1.6Hz 的呼吸感，幅度不大但足以让人"注意到有事发生"
      const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.6);
      vigOut += boss * (0.12 + pulse * 0.10);
      tintOut = mixHex(tintOut, bossTint, boss * 0.75);
    }
    if (over > 0.001) {
      vigOut += over * 0.34;
      tintOut = mixHex(tintOut, overTint, over * 0.9);
    }
    if (won > 0.001) {
      vigOut -= won * 0.16;                       // 通关：暗角松开
      tintOut = mixHex(tintOut, wonTint, won * 0.7);
    }
    vigOut = Math.max(0, Math.min(0.92, vigOut));

    // 写出去（临时覆盖，apply 之后立刻还原）
    const saveVig = cur.vig, saveTint = cur.vigTint.getHex();
    const saveAmbI = cur.ambient.intensity, saveKeyI = cur.key.intensity;
    const saveFogNear = cur.fog.near, saveFogFar = cur.fog.far;

    cur.vig = vigOut;
    cur.vigTint.setHex(tintOut);
    // 床位危险时压暗环境光一点，同时把主光偏红 —— 视线被逼向床
    cur.ambient.intensity *= (1 - stress * 0.22) * (1 - over * 0.35) * (1 + won * 0.14);
    cur.key.intensity *= (1 - stress * 0.12) * (1 - over * 0.30) * (1 + won * 0.18);
    // 雾随危险收紧：看得更近 = 压迫感
    cur.fog.near *= (1 - stress * 0.18);
    cur.fog.far *= (1 - stress * 0.22) * (1 - over * 0.28);
    if (won > 0.001) { cur.fog.far *= (1 + won * 0.20); }

    apply();

    // 还原插值状态
    cur.vig = saveVig;
    cur.vigTint.setHex(saveTint);
    cur.ambient.intensity = saveAmbI;
    cur.key.intensity = saveKeyI;
    cur.fog.near = saveFogNear;
    cur.fog.far = saveFogFar;
  }

  // ── 6. 暗角跟随视锥 ──
  //
  // 相机是正交的，视锥尺寸变了（窗口 resize）暗角就要跟着变，
  // 否则改变窗口大小后暗角会缩在画面中间或者在边缘留白。
  // sprite 用的是世界单位（正交相机下 = 米），所以要按 halfW/halfH 算。
  function resizeVignette() {
    const halfH = (camera.top - camera.bottom) / 2;
    const halfW = (camera.right - camera.left) / 2;
    // 对角线的 2 倍，保证径向渐变的"边缘"落在屏幕外一点，
    // 否则四角会出现可见的圆弧边界
    const span = Math.hypot(halfW, halfH) * 2.12;
    vignette.scale.set(span, span, 1);
    // 放在相机正前方一点点 —— 正交下位置在视锥内的任何深度都一样，
    // 但要保证在 near 之外，否则会被裁掉
    vignette.position.set(0, 0, -(camera.near + 0.05));
  }
  resizeVignette();

  return {
    vignette, vigMat, ACT_MOODS,
    update,
    setAct, setWave, setDepth, depthFor,
    resizeVignette,
    /** 当前幕的定义（只读用途） */
    get act() { return ACT_MOODS[actIdx]; },
    get actIndex() { return actIdx; },
    /** 调试/测试用：当前生效的数值 */
    state() {
      return {
        act: ACT_MOODS[actIdx].id, actIndex: actIdx,
        ambient: { color: cur.ambient.color, intensity: +cur.ambient.intensity.toFixed(3) },
        key: { color: cur.key.color, intensity: +cur.key.intensity.toFixed(3) },
        fill: { color: cur.fill.color, intensity: +cur.fill.intensity.toFixed(3) },
        fog: { near: +cur.fog.near.toFixed(2), far: +cur.fog.far.toFixed(2) },
        vig: +cur.vig.toFixed(3),
        stress: +stress.toFixed(3), boss: +boss.toFixed(3),
        over: +over.toFixed(3), won: +won.toFixed(3),
      };
    },
  };
}

// ══════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════

/** 两个 hex 颜色按 t 混合，返回 hex。手写以避免每帧 new THREE.Color。 */
function mixHex(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(lerp(ar, br, t)) << 16)
    | (Math.round(lerp(ag, bg, t)) << 8)
    | Math.round(lerp(ab, bb, t))) >>> 0;
}

/** 把 target hex 按 t 混进一个 THREE.Color */
function mixColorInto(color, targetHex, t) {
  color.setHex(mixHex(color.getHex(), targetHex, t));
}
