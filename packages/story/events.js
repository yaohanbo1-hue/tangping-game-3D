import { BOSS_DIALOG, FOURTH_WALL_EVENTS, WAVE_STORY } from './story.js';
import { getStoryHost, getLoreCodex } from './runtime-ctx.js';

// ============================================================
//  躺平发育：梦魇防线  —  关键事件与幕间转折（Key Events）
// ============================================================
//  定位：三套剧情系统各司其职，互不重叠 ——
//    WAVE_STORY   （story.js）      主线：那七分钟到底发生了什么
//    SIDE_STORIES （sidestories.js）支线：这几个人是谁
//    KEY_EVENTS   （本文件）        事件：这场梦正在发生什么
//    第四面墙     （story.js）      meta：梦露出了它是程序的接缝
//
//  关键事件不推动人物关系，也不解答谜题 —— 它负责「世界在动」的实感：
//  灯自己亮了、走廊多了一级台阶、录音进度自己走了一秒、雨忽然停了。
//  这类事件短、密、不给选项，作用是让玩家在战斗间隙持续感到不安。
//
//  与其他文件的调用关系：
//    lore.js        —— 下游：事件可解锁对应世界观词条（ev.unlockLore）
//    chapters.js    —— 配合：TURNING_POINTS 落在每幕交界，与幕卡演出呼应
//    sidestories.js —— 平行：共用同一套「波次避让」策略，避免同一波塞两段剧情
//    dream.js       —— 触发：DreamEngine.onWaveStart() 调 KeyEventSystem.checkWave()
//    ui.js          —— 展示：长事件走 showStoryDialog()，短事件走 pushDreamToast()
//    save.js        —— 持久：captureDream() / restoreDream() 存取 _fired
// ============================================================

// ─── 1. 关键事件 ───────────────────────────────────────────
// 字段说明：
//   id        稳定标识（存档只存 id）
//   wave      期望波次（被占用时自动顺延）
//   type      omen 环境 / find 发现 / crisis 危机 / reveal 揭示
//   title     事件名
//   text      事件正文（show=true 时走剧情框，否则压成一条 toast）
//   show      true = 用剧情框完整演出；省略 = 只发提示 + 写日记
//   choices   可选选项（与 WAVE_STORY 同结构）
//   unlockLore 解锁的世界观词条 id（可选）
const KEY_EVENT_TYPES = {
  omen:   { name: '环境', icon: '🌀', color: '#c084fc' },
  find:   { name: '发现', icon: '🔍', color: '#38bdf8' },
  crisis: { name: '危机', icon: '⚠️', color: '#f87171' },
  reveal: { name: '揭示', icon: '💡', color: '#fbbf24' },
};

const KEY_EVENTS = [
  // ── 第一幕：床边的第四声 ──
  {
    id: 'ev_lamp_on', wave: 3, type: 'omen', title: '走廊的灯自己亮了',
    text: '走廊尽头那盏坏了半年的应急灯，忽然亮了。\n'
        + '没有人按开关。它亮了三秒，又灭了。\n'
        + '按「灯律」，灯亮的地方梦魇无法成形 —— 刚才那一带确实是空的。',
    unlockLore: 'lore_lamp',
  },
  {
    id: 'ev_watermark', wave: 6, type: 'find', title: '门缝下的水痕',
    text: '铁门底下渗进来一道水痕，从楼梯口一直拖到床边。\n'
        + '你蹲下去看：那是三个人的鞋印，鞋尖朝着床。',
    show: true,
    choices: [
      { text: '他们上来过。', effect: '解锁世界观词条，全队防御 +8%（本波）' },
      { text: '只是雨水。', effect: '获得 150 金币' },
    ],
    unlockLore: 'lore_gap',
  },
  {
    id: 'ev_bell', wave: 9, type: 'omen', title: '钟响了一下',
    text: '走廊尽头的挂钟响了一声。\n'
        + '你抬头看 —— 指针还是 03:07。响的不是钟，是别的东西。',
  },

  // ── 第二幕：倒放的值夜表 ──
  {
    id: 'ev_recorder_on', wave: 12, type: 'reveal', title: '录音机自己开机',
    text: '值夜室那台旧录音机的指示灯亮了。\n'
        + '没有人碰它。磁带开始缓慢转动，发出很轻的「嘶——」声。\n'
        + '你忽然意识到：它一直都在放，只是你之前没在听。',
    show: true,
    choices: [
      { text: '凑近去听。', effect: '解锁世界观词条，炮塔射速 +6%（本局）' },
      { text: '退开。', effect: '免疫控制（本局）' },
    ],
    unlockLore: 'lore_recorder',
  },
  {
    id: 'ev_extra_step', wave: 16, type: 'omen', title: '楼梯间多了一级台阶',
    text: '你数过楼梯，从三楼到一楼是 54 级。\n'
        + '这次数出来是 55 级。多出来的那一级很新，水泥还没干。',
    unlockLore: 'lore_stairwell',
  },
  {
    id: 'ev_band_appear', wave: 19, type: 'find', title: '床头多了一只手环',
    text: '床头上放着一只硅胶手环，腕带上有名字。\n'
        + '你没有伸手去拿 —— 因为你想起来，你自己的手环一直戴在手上。',
    show: true,
    choices: [
      { text: '拿起来看名字。', effect: '解锁世界观词条' },
      { text: '不去碰它。', effect: '获得 220 金币' },
    ],
    unlockLore: 'lore_band',
  },

  // ── 第三幕：空位属于谁 ──
  {
    id: 'ev_mirror_open', wave: 23, type: 'crisis', title: '镜子里的人先睁眼',
    text: '你看着镜子。镜子里的你比现实慢了一拍 —— 你抬手，它没有抬。\n'
        + '然后床上那个人先睁开了眼。\n'
        + '它的嘴唇动了动，没有发出声音，但你看懂了：别再等门响了。',
    show: true,
    choices: [
      { text: '面对它。', effect: '暴击率 +10%（本局）' },
      { text: '闭眼。', effect: '床铺回复 20%、免疫控制（本局）' },
    ],
  },
  {
    id: 'ev_wet_shoes', wave: 27, type: 'find', title: '三双湿鞋印',
    text: '门口摆着三双湿鞋，鞋尖朝外，像是随时准备再出去一次。\n'
        + '旁边还有第四道水痕，从楼梯口一路拖到床边 —— 却没有对应的鞋。',
    unlockLore: 'lore_gap',
  },
  {
    // ⚠️ 这一条原本排在第 31 波并直接写出「四人已齐」，属于第四带（41-50）的内容，
    //    已后移到第 47 波 —— 与主线「周默烘干值夜表」同一波，互为印证。
    id: 'ev_ledger_page', wave: 47, type: 'reveal', title: '值夜表自己翻页',
    text: '桌上的值夜表被风翻了一页，停在最后一页。\n'
        + '你记得那一页是空白的。现在上面有字，墨迹还没干：\n'
        + '「床边：三人，已返回。」\n'
        + '「总人数：——」（最后这一格还是看不清。）',
    show: true,
    choices: [
      { text: '把最后一格凑近灯下。', effect: '解锁世界观词条，全属性 +6%' },
      { text: '合上本子。', effect: '获得 300 金币' },
    ],
    unlockLore: 'lore_ledger',
  },
  {
    id: 'ev_film', wave: 34, type: 'omen', title: '走廊变成胶片',
    text: '走廊像旧胶片一样抖了一下，边缘出现了齿孔。\n'
        + '每一扇门牌都变成 03:07。数字恢复后，最远那扇门开了一条缝。\n'
        + '门外不是走廊，是同一间宿舍 —— 你从床尾看见三个人把灯放回床头。',
  },

  // ── 第四幕：灯一直亮着 ──
  {
    id: 'ev_knock_again', wave: 37, type: 'crisis', title: '门从外面被敲了三下',
    text: '三下敲门。停顿。\n'
        + '你屏住呼吸等第四声 —— 这一次没有第四声。\n'
        + '取而代之的是一声很轻的「嗒」。\n'
        + '你终于听清了：那不是敲门，是录音机的停止键。',
    show: true,
    choices: [
      { text: '原来一直是这个声音。', effect: '解锁世界观词条，全属性 +8%' },
      { text: '我早就知道了。', effect: '炮塔伤害 +12%（本局）' },
    ],
    unlockLore: 'lore_fourth_knock',
  },
  {
    id: 'ev_lamp_full', wave: 40, type: 'reveal', title: '应急灯的电量回到满格',
    text: '你拿起应急灯，指示灯是三格 —— 满格。\n'
        + '说明书说它满电能亮两小时，那晚它只亮了七分钟。\n'
        + '缺掉的那部分电量，正照亮着梦里多出来的那段走廊。',
    unlockLore: 'lore_lamp',
  },
  {
    id: 'ev_shadow_overlap', wave: 44, type: 'reveal', title: '三个人的影子第一次重叠',
    text: '灯下的三道影子第一次叠在了一起，边缘没有冲突。\n'
        + '你忽然明白了：他们在现实里本来就是这个姿势 —— '
        + '围着床站成一圈，低头看着你。',
    show: true,
    choices: [
      { text: '他们一直在看着我。', effect: '床铺回复至满血' },
      { text: '我该起来了。', effect: '全属性 +10%' },
    ],
  },
  {
    id: 'ev_carving_new', wave: 46, type: 'omen', title: '墙上多了一组刻痕',
    text: '床头墙上多了一组新的刻痕。\n'
        + '三道短痕，一段空白 —— 然后什么也没有。\n'
        + '这一次，长痕那一笔留给你自己刻。',
    unlockLore: 'lore_carving',
  },
  {
    id: 'ev_progress_tick', wave: 49, type: 'reveal', title: '录音进度自己走了一秒',
    text: '进度条自己往前跳了一秒。\n'
        + '你一直以为它卡在 06:59，其实它只是需要有人愿意看着它走完。',
    show: true,
    choices: [
      { text: '我看着。', effect: '全属性 +12%、免疫控制（本局）' },
      { text: '快进。', effect: '获得 500 金币' },
    ],
  },

  // ── 第五幕：听完那条语音 ──
  {
    id: 'ev_rain_stop', wave: 52, type: 'omen', title: '雨停了',
    text: '雨声忽然小了，然后停了。\n'
        + '你这才发现自己听了整场梦的雨 —— 从第一波开始，它就没停过。\n'
        + '雨停的时候，走廊短了一截。',
    unlockLore: 'lore_gap',
  },
  {
    id: 'ev_band_clear', wave: 54, type: 'reveal', title: '手环上的名字清晰了',
    text: '照片上那只手环的名字不再发虚。\n'
        + '三个字，和你的名字一模一样。\n'
        + '你把它举到灯下，手环内侧还有一行小字：「别叫醒他。」',
    show: true,
    choices: [
      { text: '这是我自己写的。', effect: '全属性 +15%' },
      { text: '是别人写的。', effect: '永久护盾 +400' },
    ],
    unlockLore: 'lore_band',
  },
  {
    id: 'ev_footsteps_stop', wave: 57, type: 'crisis', title: '门外的脚步声停下',
    text: '门外的脚步声一直在走，从第一波走到现在。\n'
        + '这一刻，它停了。\n'
        + '停下来比走过去更让人害怕 —— 因为停下来的意思是：到了。',
    show: true,
    choices: [
      { text: '到了就好。', effect: '全属性 +18%、免疫控制（本局）' },
      { text: '再走一会儿。', effect: '获得 800 金币' },
    ],
  },
  {
    id: 'ev_lamp_warm', wave: 59, type: 'omen', title: '床头灯开始变暖',
    text: '应急灯的光从冷白变成了暖黄。\n'
        + '你记得这种颜色 —— 那是家里客厅那盏旧台灯的颜色。\n'
        + '走廊尽头出现了第一道不属于梦的光。',
  },
  {
    id: 'ev_dawn', wave: 60, type: 'reveal', title: '天要亮了',
    text: '窗外的天色一点点变浅。\n'
        + '这是整场梦里第一次出现「白天」这个概念。\n'
        + '梦正在结束 —— 但结束的方式由你决定。',
    show: true,
    choices: [
      { text: '那就醒过来。', effect: '全属性 +20%' },
      { text: '再听一遍录音。', effect: '床铺回满、全属性 +10%' },
    ],
  },

  // ══════════ v1.7.1 第二批追加 16 个 ══════════
  {
    id: 'ev_thermos', wave: 11, type: 'find', title: '桌上多了一个保温杯',
    text: '值夜室的桌上放着一个银灰色保温杯，杯底贴着一张写满日期的标签。\n'
        + '你翻过来看 —— 每一条后面都画着勾，只有最后一条没有。',
    unlockLore: 'lore_thermos',
  },
  {
    id: 'ev_slippers', wave: 18, type: 'omen', title: '三双拖鞋',
    text: '床边摆着三双拖鞋，鞋头朝里，摆得很整齐。\n'
        + '第四双的位置是空的 —— 但你低头看自己的脚，拖鞋还在脚上。',
    unlockLore: 'lore_slippers',
  },
  {
    id: 'ev_phone', wave: 21, type: 'find', title: '倒扣的手机亮了一下',
    text: '枕头边那部倒扣的手机亮了一下，屏幕从缝里透出一条光。\n'
        + '你没有翻过来看。\n'
        + '梦里它每隔一阵就亮一次，每一次你都没有翻过来。',
    show: true,
    choices: [
      { text: '翻过来看。', effect: '解锁世界观词条，全属性 +6%' },
      { text: '继续不看。', effect: '获得 300 金币、免疫控制（本局）' },
    ],
    unlockLore: 'lore_phone',
  },
  {
    id: 'ev_key', wave: 25, type: 'reveal', title: '门上的钥匙孔转了一下',
    text: '你盯着铁门的钥匙孔看。\n'
        + '它从里面转了一下 —— 但门没有开。\n'
        + '你忽然想起来：那晚小夏下楼前带走了钥匙。\n'
        + '所以门外那三下，从头到尾都不是他们敲的。',
    unlockLore: 'lore_key',
  },
  {
    id: 'ev_balcony', wave: 28, type: 'omen', title: '晾衣间的水声',
    text: '走廊尽头传来滴水声，很规律，一秒一滴。\n'
        + '你走过去看 —— 晾衣间里挂着三件湿外套，正在滴水。\n'
        + '但你已经走过这条走廊很多次了，之前那里什么都没有。',
    unlockLore: 'lore_balcony',
  },
  {
    id: 'ev_basement', wave: 30, type: 'crisis', title: '地下室的门开了',
    text: '楼梯往下多出一段，通向一楼半的地下室。\n'
        + '门开着。里面堆着旧床板，最上面那张的床垫上留着一个人形。\n'
        + '人形的大小和你差不多。',
    show: true,
    choices: [
      { text: '走进去看。', effect: '解锁世界观词条，全属性 +8%' },
      { text: '把门关上。', effect: '全队防御 +15%（本波）' },
    ],
    unlockLore: 'lore_basement',
  },
  {
    id: 'ev_roof', wave: 33, type: 'omen', title: '天台上有人',
    text: '你抬头看天花板，看见的不是水泥，是夜空。\n'
        + '天台上站着一个人，背对着你，正在往下看。\n'
        + '他没有回头，但你确定他知道你在看他。',
    unlockLore: 'lore_roof',
  },
  {
    id: 'ev_corridor_end', wave: 38, type: 'reveal', title: '走廊第一次有了尽头',
    text: '你往走廊深处看了一眼 —— 尽头出现了。\n'
        + '不是墙，是一块黄铜门牌，挂在那里，正面写着 307。\n'
        + '你走了六十波都没走到过那里。它今天自己走过来了。',
    show: true,
    choices: [
      { text: '走过去看背面。', effect: '解锁世界观词条，全属性 +10%' },
      { text: '先打完这一波。', effect: '获得 700 金币' },
    ],
    unlockLore: 'lore_dream_corridor_end',
  },
  {
    id: 'ev_chen_log', wave: 40, type: 'reveal', title: '老陈翻到了那一页',
    text: '一楼值班室的灯亮着。老陈坐在桌前，翻着他的日志。\n'
        + '他翻到中间某一页，用笔尖点了点其中一行。\n'
        + '那一行的格式和今晚一模一样 —— 只是年份早了很多。',
    unlockLore: 'lore_chen',
  },
  {
    id: 'ev_prev_photo', wave: 44, type: 'find', title: '合照里多了一个人',
    text: '你把那张旧合照举到灯下。\n'
        + '之前上面是四个人 —— 三个站着，一个躺着。\n'
        + '现在躺着那个人的脸清晰了。你认得那张脸。',
    show: true,
    choices: [
      { text: '那是上一届的值夜生。', effect: '解锁世界观词条，全属性 +12%' },
      { text: '把照片收起来。', effect: '床铺回复 30%' },
    ],
    unlockLore: 'lore_prev',
  },
  {
    id: 'ev_cat_follow', wave: 46, type: 'omen', title: '三点跟着你走',
    text: '三点从楼梯口站起来，跟在你后面。\n'
        + '你停它也停，你走它就走。它一直跟到床头那盏灯旁边才坐下。\n'
        + '它用爪子碰了碰灯罩，然后看着你。',
  },
  {
    id: 'ev_thermos_full', wave: 49, type: 'reveal', title: '保温杯被灌满了',
    text: '桌上那个保温杯被灌满了热水，杯壁是烫的。\n'
        + '没有人碰过它 —— 这一层只有你一个。\n'
        + '杯底那张标签还在，最后一条依然没有勾。\n'
        + '你拿起笔，替它画上了。',
    show: true,
    choices: [
      { text: '画上这个勾。', effect: '全属性 +15%、床铺回满' },
      { text: '留着让它自己画。', effect: '永久护盾 +350' },
    ],
  },
  {
    id: 'ev_rain_slow', wave: 52, type: 'omen', title: '雨声慢下来了',
    text: '雨声慢了半拍。\n'
        + '你这才听出来，之前的雨声里一直藏着另一层 —— '
        + '一个比雨更慢的节奏，像是有人在跟着雨一起呼吸。\n'
        + '现在那层呼吸变清晰了。',
    unlockLore: 'lore_seven',
  },
  {
    id: 'ev_lamp_three', wave: 55, type: 'reveal', title: '灯的第三格电',
    text: '应急灯的指示灯还剩三格 —— 从第一波到现在，一直是三格。\n'
        + '按说明书它满电能亮两小时，那晚只亮了七分钟。\n'
        + '多出来的那部分，一直在替某样东西照明。',
    show: true,
    choices: [
      { text: '那就在它耗完之前结束。', effect: '全属性 +18%' },
      { text: '让它继续亮着。', effect: '床铺回满、免疫控制（本局）' },
    ],
  },
  {
    id: 'ev_knock_four', wave: 57, type: 'crisis', title: '第四下没有响',
    text: '门外又是三下敲门。\n'
        + '你屏住呼吸等第四声 —— 这一次什么都没有。\n'
        + '然后你听见门框上传来一声极轻的「嗒」。\n'
        + '那不是敲门。那是有人上楼时习惯性碰了一下门框。',
    unlockLore: 'lore_fourth_knock',
  },
];

// ─── 2. 幕间转折 ───────────────────────────────────────────
// 落在每幕交界的「小结式」事件：不是新剧情，是把这一幕的线索收拢一次，
// 让玩家在进入下一幕前有一个明确的「阶段感」。走剧情框，不给选项。
//
// ⚠️ 带 priority:true —— 这类节点是**结构型**的，必须在指定波次播出，
// 不参与避让。原因：五幕交界（10/20/35/50/60）恰好都是主线剧情波，
// 如果也走「每波最多一个」的排队规则，最后一个（终幕）会因为游戏已经结束
// 而永远播不出来 —— 这是模拟器实测抓到的，不是推测。
const TURNING_POINTS = [
  {
    id: 'tp_act1', afterAct: 'night-watch', wave: 12, priority: true, title: '第一幕收束 · 门外有三个人',
    text: '【本幕小结】\n'
        + '你确认了三件事：门外三下是真的；床头那一声「嗒」不是敲门；\n'
        + '而值夜表上本该写总人数的那一格，被雨泡得看不清。\n'
        + '屋里三个人都在。所以门外那三下，至今没有人认领。',
  },
  {
    id: 'tp_act2', afterAct: 'the-record', wave: 25, priority: true, title: '第二幕收束 · 第四格是折起来的',
    text: '【本幕小结】\n'
        + '值夜表第四格不是空白，是一张折起来的便条，露出半句「他睡着了，灯留着」。\n'
        + '周默画了四个圈，第四个只画了一张床 —— 他说写名字就像把人叫醒。\n'
        + '梦魇问了一句谁也没回答的话：你们四个人里，有一个从头到尾没有出过声。',
  },
  {
    id: 'tp_act3', afterAct: 'the-empty-place', wave: 40, priority: true, title: '第三幕收束 · 她没说出口的那句话',
    text: '【本幕小结】\n'
        + '合照上第四个位置不是空的，是被被子盖住了半张脸 —— 而赵磊认不出那张脸。\n'
        + '录音只有前半段，后半段是空的。\n'
        + '小夏说了一半的话停住了：「我们回来的时候——」然后她改口，让你自己去值夜表上找。',
  },
  {
    id: 'tp_act4', afterAct: 'the-seven', wave: 50, priority: true, title: '第四幕收束 · 四人已齐',
    text: '【本幕小结】\n'
        + '值夜表烘干以后，被水遮住的两行终于看清：「床边：三人，已返回。」「总人数：四人。」\n'
        + '这间宿舍从大一开始就是四人间。第四张床被抬走了，但人没有。\n'
        + '你守了四十九波的那扇门，从来没有关住任何东西。',
  },
  {
    id: 'tp_act5', afterAct: 'the-reply', wave: 60, priority: true, title: '终幕 · 亲口回答',
    text: '【终幕】\n'
        + '七分钟走完了。雨声结束，脚步停下，停止键响过。\n'
        + '接下来这一段没有台词 —— 因为该说的话，只能由你自己说。',
  },
];

// ─── 3. 运行时：关键事件触发 ───────────────────────────────
const KeyEventSystem = {
  /** @type {Set<string>} 已触发的事件 id */
  _fired: null,

  init() {
    if (!this._fired) this._fired = new Set();
  },

  /** 与支线共用同一套避让判断：只插空隙，不跟主线抢波次 */
  _waveBusy(wave) {
    if (typeof WAVE_STORY !== 'undefined' && WAVE_STORY.some(s => s.wave === wave)) return true;
    if (typeof BOSS_DIALOG !== 'undefined') {
      const keys = Object.keys(BOSS_DIALOG);
      if (keys.some(k => BOSS_DIALOG[k] && BOSS_DIALOG[k].wave === wave)) return true;
    }
    if (typeof FOURTH_WALL_EVENTS !== 'undefined' && FOURTH_WALL_EVENTS.some(e => e.wave === wave)) return true;
    // 幕交界波次已由「幕间小结」占用，普通演出型事件让开
    if (typeof TURNING_POINTS !== 'undefined' && TURNING_POINTS.some(t => t.wave === wave)) return true;
    return false;
  },

  /**
   * 波次钩子：由 DreamEngine.onWaveStart() 调用。
   * 策略分两档：
   *   · 短事件（show 未设置）→ 只发 toast + 写日记，不占用剧情框，
   *     所以当波到期就直接触发，不受主线占用影响。
   *   · 演出型事件（show:true）→ 会占用剧情框，每波最多一个，
   *     优先挑「本波到期且本波空闲」的，其次补最早到期的，全被占用才硬插。
   * @param {number} wave
   * @returns {Array} 本波实际触发的事件
   */
  checkWave(wave) {
    this.init();
    const fired = [];
    const all = KEY_EVENTS.concat(TURNING_POINTS.map(t => Object.assign({ show: true }, t)));

    // 0) 结构型节点（幕间转折，priority:true）：必须在指定波次播出，不参与避让。
    //    它们是每幕的小结，漏掉会让玩家彻底失去阶段感。
    all.forEach(e => {
      if (!e.priority || this._fired.has(e.id) || e.wave !== wave) return;
      this._fire(e, wave);
      fired.push(e);
    });

    // 1) 短事件：当波到期就发，不参与避让（只发 toast，不抢剧情框）
    all.forEach(e => {
      if (e.priority || this._fired.has(e.id) || e.show || e.wave !== wave) return;
      this._fire(e, wave);
      fired.push(e);
    });

    // 2) 普通演出型事件：每波最多一个，按到期先后排队，优先挑空闲波。
    //    但必须让位于「波次预算」—— 主线波只有 1 个名额，用完就不再插。
    const due = all
      .filter(e => e.show && !e.priority && !this._fired.has(e.id) && e.wave <= wave)
      .sort((a, b) => a.wave - b.wave);
    const canPlay = (typeof StoryPacing === 'undefined') || StoryPacing.canPlay(wave, due.length ? wave - due[0].wave : 0);
    if (due.length && canPlay) {
      const pick = due.find(e => e.wave === wave && !this._waveBusy(wave))
        || due.find(e => !this._waveBusy(wave))
        || due[0];
      this._fire(pick, wave);
      if (typeof StoryPacing !== 'undefined') StoryPacing.take(wave);
      fired.push(pick);
    }

    return fired;
  },

  _fire(ev, wave) {
    this._fired.add(ev.id);

    // ⚠️ 走宿主接口，不要用 `typeof showStoryDialog` 探测全局。
    //    在 ESM（3D 工程）里，`typeof <未声明标识符>` 恒为 'undefined'，
    //    全局探测会**静默**跳过整条通道 —— 事件照常标记为已触发，但
    //    玩家什么都没看到。这类失败不抛错、不断言、极难排查。
    //    宿主接口由 host.js 提供：3D 显式注入，2D 回落到全局作用域，
    //    两边行为一致。
    const host = getStoryHost();
    if (ev.show) {
      try {
        host.showDialog({
          wave: wave, speaker: ev.speaker || '旁白', text: ev.text,
          choices: ev.choices, kind: 'event',
        });
      } catch (e) { console.warn('[KeyEvent] dialog:', e); }
    } else {
      // 短事件压成一条提示：不打断战斗节奏，但留下痕迹
      const t = KEY_EVENT_TYPES[ev.type] || KEY_EVENT_TYPES.omen;
      try { host.toast(t.icon + ' ' + ev.title, (ev.text || '').split('\n')[0], 'gold', 7); } catch (e) {}
    }

    if (ev.unlockLore) {
      try { getLoreCodex().unlock(ev.unlockLore); } catch (e) {}
    }
    {
      const t = KEY_EVENT_TYPES[ev.type] || KEY_EVENT_TYPES.omen;
      try {
        host.diary('discover', '【' + t.name + '】' + ev.title + '：'
          + (ev.text || '').replace(/\n+/g, ' ').slice(0, 80));
      } catch (e) {}
    }
  },

  /** 面板/回顾用：本局已触发的关键事件 */
  list() {
    this.init();
    return KEY_EVENTS.map(e => ({ def: e, fired: this._fired.has(e.id) }));
  },

  /** 进度统计 */
  progress() {
    this.init();
    const total = KEY_EVENTS.length;
    const fired = KEY_EVENTS.filter(e => this._fired.has(e.id)).length;
    return { fired, total };
  },

  snapshot() { this.init(); return { fired: Array.from(this._fired) }; },

  restore(snap) {
    this.init();
    if (snap && Array.isArray(snap.fired)) snap.fired.forEach(x => this._fired.add(x));
  },

  reset() { this._fired = new Set(); },
};

// ── ESM 导出（构建脚本自动追加，勿手改这段）──
export { KEY_EVENTS, TURNING_POINTS, KeyEventSystem };
