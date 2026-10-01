import { BOSS_DIALOG, FOURTH_WALL_EVENTS, STORY_CHARACTERS, WAVE_STORY } from './story.js';
import { getStoryHost, getPacing, getLoreCodex } from './runtime-ctx.js';

// ============================================================
//  躺平发育：梦魇防线  —  支线剧情（Side Stories）
// ============================================================
//  定位：
//    WAVE_STORY 是「主线」—— 五幕，讲那七分钟到底发生了什么。
//    本文件是「支线」—— 不讲真相，讲人。周默为什么爱记录、赵磊的笑话本、
//    小夏留灯的习惯、楼下那只总在 03:07 叫的猫。
//    主线让玩家理解事件，支线让玩家认识人。两者互补，不抢同一波。
//
//  与其他文件的调用关系：
//    story.js       —— 上游：STORY_CHARACTERS 提供说话人配色；支线不另建角色
//    chapters.js    —— 平行：章节是时间线，支线是插曲；支线不推进幕
//    lore.js        —— 下游：支线完成时解锁对应世界观词条（stage.unlockLore）
//    dream.js       —— 触发：DreamEngine.onWaveStart() 调 SideStorySystem.checkWave()
//    ui.js          —— 展示：走既有 showStoryDialog()，不新增 UI
//    save.js        —— 持久：captureDream() / restoreDream() 存取 _progress
//
//  避让机制（重要）：
//    每个 stage 只写「期望波次」prefer。真正触发时 SideStorySystem 会检查该波是否
//    已被主线剧情 / BOSS 台词 / 第四面墙占用，若被占用则顺延到下一个空闲波次。
//    这样支线永远插在主线之间的空隙里，不会出现「一波连播三段对白」。
// ============================================================

// ─── 支线定义 ──────────────────────────────────────────────
// 字段说明：
//   id          稳定标识（存档只存 id）
//   title/icon  支线名与图标
//   about       主角（剧中人名，用于配色）
//   hook        一句话卖点（面板/提示用）
//   stages[]    分阶段剧情，每阶段：
//                 prefer   期望触发的波次（实际可能顺延）
//                 speaker/text/choices  与 WAVE_STORY 同结构
//                 unlockLore  该阶段解锁的世界观词条 id（可选）
//   reward      全部阶段完成后的奖励文案（交给 applyStoryEffect 结算）
//   fragment    完成后解锁的记忆碎片 id（可选）
const SIDE_STORIES = [
  // ══ 1. 周默的笔记本 ══
  {
    id: 'side_notebook', title: '周默的笔记本', icon: '📓', about: '周默',
    hook: '他有两本本子：一本给楼里看，一本只给自己看。',
    stages: [
      {
        prefer: 12,
        speaker: '周默',
        text: '我有个习惯，值夜表之外还留一本自己的本子。\n'
            + '楼里那本记「发生了什么」，我这本记「我本来想写什么」。\n'
            + '……你要看吗？看完别笑我。',
        choices: [
          { text: '我想看。', effect: '周默好感度 +1' },
          { text: '那是你的东西，不用给我看。', effect: '获得 200 金币' },
        ],
      },
      {
        prefer: 24,
        speaker: '周默',
        text: '你看这一页。那晚我写了两遍。\n'
            + '第一遍写的是：「03:14，三人返回，第四人未应门。」\n'
            + '后来我划掉「未应门」，改成「仍在睡」。\n'
            + '……我不太确定自己是在记录，还是在替谁开脱。',
        choices: [
          { text: '你写得没错，他确实在睡。', effect: '周默好感度 +1，全队防御 +10%（本波）' },
          { text: '两个都是真的。', effect: '解锁隐藏对话' },
        ],
        unlockLore: 'lore_ledger',
      },
      {
        prefer: 36,
        speaker: '周默',
        text: '最后一页我一直空着。\n'
            + '本来想写「结论」，后来想想，这件事没有结论 —— 只有「谁先开口」。\n'
            + '所以我把笔给你了。这一页，你写。',
        choices: [
          { text: '我写：灯一直亮着。', effect: '全属性 +10%' },
          { text: '我写：我们都没事。', effect: '床铺回复至满血，获得 300 金币' },
        ],
      },
    ],
    reward: '获得 400 金币、获得 25 灵魂',
    fragment: 'frag_24',
  },

  // ══ 2. 赵磊的笑话本 ══
  {
    id: 'side_jokebook', title: '赵磊的笑话本', icon: '📔', about: '赵磊',
    hook: '三十七个笑话，只有三个能讲完整。',
    stages: [
      {
        prefer: 9,
        speaker: '赵磊',
        text: '给你看看我的宝贝。三十七个笑话，全在这本子上。\n'
            + '……但你猜怎么着？只有三个我能从头讲到尾。剩下的都卡在结尾。\n'
            + '每次讲到一半我就忘了后面，然后就假装「哎，算了，这个不好笑」。',
        choices: [
          { text: '为什么卡住？', effect: '赵磊好感度 +1' },
          { text: '三个也够用了。', effect: '金币获取 +10%（本局）' },
        ],
      },
      {
        prefer: 21,
        speaker: '赵磊',
        text: '我发现一个规律：卡住的那三十四个，全都是「有个人在听」的时候才卡。\n'
            + '自己对着墙讲，我一个都不卡。\n'
            + '……所以我不是记性差，我是怕讲了没人笑。',
        choices: [
          { text: '我在听。', effect: '赵磊好感度 +1' },
          { text: '讲吧，我保证不笑。', effect: '暴击率 +6%（本局）' },
        ],
      },
      {
        prefer: 41,
        speaker: '赵磊',
        text: '第三十八个。新写的，还没写进本子。\n'
            + '「为什么第四个人从来不应门？」\n'
            + '「因为他一应门，就说明他醒了 —— 而他还不想醒。」\n'
            + '……这个是不是有点太真实了。',
        choices: [
          { text: '笑了。', effect: '暴击伤害 +25%（本局）' },
          { text: '这个可以写进本子。', effect: '赵磊好感度 +2' },
        ],
      },
    ],
    reward: '获得 350 金币、获得 20 灵魂',
    fragment: 'frag_2',
  },

  // ══ 3. 小夏的灯 ══
  {
    id: 'side_lamp', title: '小夏的灯', icon: '🏮', about: '林小夏',
    hook: '她给晚归的人留了十几年灯，却没人问过她怕不怕黑。',
    stages: [
      {
        prefer: 7,
        speaker: '林小夏',
        text: '你注意到没有，我从来不让房间全黑。\n'
            + '我家开小卖部，小时候我爸妈经常半夜才回来。我就开着客厅那盏灯，'
            + '趴在桌上等，等睡着了他们回来会把我抱上床。\n'
            + '后来就成了习惯 —— 只要屋里还有人没回来，灯就不能关。',
        choices: [
          { text: '那你自己怕黑吗？', effect: '林小夏好感度 +1' },
          { text: '所以那晚你第一个说要去。', effect: '获得 180 金币' },
        ],
        unlockLore: 'lore_lamp',
      },
      {
        prefer: 26,
        speaker: '林小夏',
        text: '……你刚才问我怕不怕黑。\n'
            + '怕。当然怕。我一直开着灯，是因为我自己也怕。\n'
            + '但我不敢说，因为一说出来，好像我留灯就不是为了别人了。',
        choices: [
          { text: '为自己留灯也没什么不对。', effect: '林小夏好感度 +2' },
          { text: '那以后我陪你留。', effect: '床铺回复 30%、全队防御 +12%（本波）' },
        ],
      },
      {
        prefer: 43,
        speaker: '林小夏',
        text: '我想通了一件事。\n'
            + '我留灯，不是因为我勇敢，也不是因为我怕黑 —— 是因为我总觉得，'
            + '只要灯亮着，那个人就一定会回来。\n'
            + '现在我知道他回来了。他只是睡着了。',
        choices: [
          { text: '灯不用一直亮了。', effect: '全属性 +8%' },
          { text: '那就让它亮着吧。', effect: '永久护盾 +250' },
        ],
      },
    ],
    reward: '获得 300 金币、床铺回复至满血',
    fragment: 'frag_13',
  },

  // ══ 4. 楼下的猫 ══
  {
    id: 'side_cat', title: '楼下的猫', icon: '🐈', about: '旁白',
    hook: '宿舍楼下有只流浪猫，每天 03:07 准时叫。',
    stages: [
      {
        prefer: 4,
        speaker: '旁白',
        text: '宿舍楼下蹲着一只三花猫，前爪有一撮白毛。\n'
            + '楼里的人叫它「三点」—— 因为它每天凌晨三点零七分准时叫，一分钟不差。\n'
            + '有人说是巧合，有人说是它记得停电那天。',
        choices: [
          { text: '它为什么偏偏是三点零七？', effect: '解锁世界观词条' },
          { text: '一只猫而已。', effect: '获得 120 金币' },
        ],
        unlockLore: 'lore_0307',
      },
      {
        prefer: 31,
        speaker: '旁白',
        text: '三点那晚一直蹲在楼梯口，没有上楼。\n'
            + '三个人下来取灯的时候，它让开了路，然后跟着他们上到了三楼。\n'
            + '它停在 307 门口，没有进去 —— 因为它知道里面的人还没醒。',
        choices: [
          { text: '它一直在等？', effect: '解锁隐藏对话' },
          { text: '动物比人诚实。', effect: '全队防御 +10%（本波）' },
        ],
      },
      {
        prefer: 53,
        speaker: '旁白',
        text: '梦里的三点一直蹲在门外。你走过去，它抬头看了你一眼，然后走开了。\n'
            + '它带路的方向不是出口，是床头那盏灯。\n'
            + '它停在灯边，用爪子碰了碰灯罩，像是提醒你：这里有人替你留过灯。',
        choices: [
          { text: '谢谢你来过。', effect: '床铺回复 25%、获得 200 金币' },
          { text: '跟着它走。', effect: '全属性 +6%' },
        ],
      },
    ],
    reward: '获得 250 金币、获得 15 灵魂',
    fragment: 'frag_21',
  },

  // ══ 5. 值夜室的旧照片 ══
  {
    id: 'side_photo', title: '值夜室的旧照片', icon: '🖼️', about: '周默',
    hook: '铁皮柜最里面压着一张上一届值夜生的合照。',
    stages: [
      {
        prefer: 14,
        speaker: '周默',
        text: '值夜室铁皮柜最底下压着一张照片，是我们搬进来之前那届的。\n'
            + '四个人站在同一个门口，姿势和我们现在几乎一样。\n'
            + '背面写着日期和一句：「这次记得关灯。」',
        choices: [
          { text: '上一届也发生过同样的事？', effect: '解锁世界观词条' },
          { text: '只是巧合。', effect: '获得 220 金币' },
        ],
        unlockLore: 'lore_watchroom',
      },
      {
        prefer: 34,
        speaker: '周默',
        text: '我拿去问了管理员。老陈看了很久，说这张照片他见过。\n'
            + '他说那届也是四个人，也是停电，也是三个人下楼取灯。\n'
            + '唯一不同的是 —— 那次，床上那个人应门了。',
        choices: [
          { text: '后来呢？', effect: '周默好感度 +1，解锁隐藏对话' },
          { text: '所以这不是第一次。', effect: '炮塔射速 +8%（本局）' },
        ],
      },
      {
        prefer: 47,
        speaker: '周默',
        text: '照片上那句「这次记得关灯」，我一开始以为是提醒省电。\n'
            + '后来想明白了：灯一直亮着，是因为有人在等。\n'
            + '关灯的意思不是省电，是「不用等了，他醒了」。',
        choices: [
          { text: '那我们也可以关灯了。', effect: '全属性 +8%' },
          { text: '还不到时候。', effect: '永久护盾 +200' },
        ],
      },
    ],
    reward: '获得 380 金币、获得 22 灵魂',
    fragment: 'frag_12',
  },

  // ══ 6. 走廊里的回声 ══
  {
    id: 'side_echo', title: '走廊里的回声', icon: '🔊', about: '???',
    hook: '学弟学妹之间流传着一条走廊传说。',
    stages: [
      {
        prefer: 17,
        speaker: '旁白',
        text: '楼里一直有个说法：半夜在四楼走廊喊一声，会听见两声回音。\n'
            + '第二声比第一声慢半拍，而且音色不太一样 —— 像是另一个人跟着你喊。\n'
            + '学弟学妹管这叫「走廊里的第二个你」。',
        choices: [
          { text: '我想试试。', effect: '触发一次回响，解锁世界观词条' },
          { text: '无聊的传闻。', effect: '获得 150 金币' },
        ],
        unlockLore: 'lore_echo_omen',
      },
      {
        prefer: 39,
        speaker: '???',
        text: '你刚才是不是在心里喊了一声？\n'
            + '我听见了。你不用出声 —— 在这条走廊里，想出声就够了。\n'
            + '（第二声回音比你慢了半拍。）',
        choices: [
          { text: '你是谁？', effect: '解锁隐藏对话' },
          { text: '我不喊了。', effect: '免疫控制（本局）' },
        ],
      },
      {
        prefer: 56,
        speaker: '???',
        text: '你发现了吗？回音从来不说新的话。\n'
            + '它只会把你喊过的，再喊回来一遍。\n'
            + '所以只要你不喊「我没事」，我就没法用这三个字堵你的嘴。',
        choices: [
          { text: '那我换一句。', effect: '全属性 +10%' },
          { text: '我说：我听见你们回来了。', effect: '最终阶段全属性 +18%' },
        ],
      },
    ],
    reward: '获得 420 金币、获得 30 灵魂',
    fragment: 'frag_26',
  },

  // ══ 7. 管理员老陈 ══
  {
    id: 'side_caretaker', title: '管理员老陈', icon: '🔑', about: '周默',
    hook: '老陈在这栋楼守了三十年，他的日志比值夜表还厚。',
    stages: [
      {
        prefer: 18,
        speaker: '周默',
        text: '我去找老陈了。他在这栋楼守了三十年，自己另有一本日志。\n'
            + '他翻了半天，指给我看一行：「某年某月某日，四人住，一人睡，三人取灯。」\n'
            + '他说这种记录，他写过不止一次。',
        choices: [
          { text: '每一次都有人没出声？', effect: '解锁世界观词条' },
          { text: '他为什么不改？', effect: '获得 260 金币' },
        ],
        unlockLore: 'lore_watchroom',
      },
      {
        prefer: 40,
        speaker: '周默',
        text: '老陈说他不改，是因为「这行字不是给人看的，是给下一次的人看的」。\n'
            + '他说每次值夜生换人，他都会把这页翻出来给他们看一眼。\n'
            + '「看完就记住了，夜里就轻一点。」他是这么说的。',
        choices: [
          { text: '所以这是提醒。', effect: '周默好感度 +1' },
          { text: '他还说了什么？', effect: '炮塔伤害 +10%（本局）' },
        ],
      },
      {
        prefer: 52,
        speaker: '周默',
        text: '临走前老陈叫住我，说了一句话。\n'
            + '他说：「门敲三下是规矩，第四下是习惯 —— 我们上楼习惯性会再碰一下门框。」\n'
            + '……所以那第四声，可能根本不是敲门。',
        choices: [
          { text: '是三个人上楼的习惯。', effect: '全属性 +12%' },
          { text: '谢谢你，老陈。', effect: '永久护盾 +300' },
        ],
      },
    ],
    reward: '获得 500 金币、获得 35 灵魂',
    fragment: 'frag_4',
  },

  // ══ 8. 第四张床 ══
  {
    id: 'side_fourth_bed', title: '第四张床', icon: '🛏️', about: '林小夏',
    hook: '307 原本是四人间，第四张床被搬走以后留下了一道墙印。',
    stages: [
      {
        prefer: 22,
        speaker: '林小夏',
        text: '你有没有注意过墙角那道印子？比墙白一点，一人宽。\n'
            + '307 本来是四人间，我大一那年第四张床被搬走了。\n'
            + '搬走那天管理员说：「以后就住三个，宽敞点。」',
        choices: [
          { text: '为什么搬走？', effect: '解锁世界观词条' },
          { text: '难怪总觉得少了点什么。', effect: '获得 240 金币' },
        ],
        unlockLore: 'lore_fourth_person',
      },
      {
        prefer: 35,
        speaker: '林小夏',
        text: '我问过老陈，他说那床不是搬走，是「抬走的」—— 床垫上还留着人形。\n'
            + '他让我别多想，说那届的学长毕业了。\n'
            + '可是墙角那道印子，每年梅雨季都会泛潮，像有人还在上面躺着。',
        choices: [
          { text: '所以梦里的第四张床是真的。', effect: '解锁隐藏对话' },
          { text: '别看了，走吧。', effect: '全队防御 +15%（本波）' },
        ],
      },
      {
        prefer: 50,
        speaker: '林小夏',
        text: '我懂了。那张床不是少了，是「不需要了」。\n'
            + '因为第四个人一直在 —— 只是他不再睡那张床，他睡在靠窗的那张。\n'
            + '就是你躺的那张。',
        choices: [
          { text: '……原来一直是我。', effect: '全属性 +12%' },
          { text: '那你为什么不早点说。', effect: '林小夏好感度 +2' },
        ],
      },
    ],
    reward: '获得 450 金币、获得 28 灵魂',
    fragment: 'frag_3',
  },

  // ══════════ v1.7.1 第二批追加 6 条 ══════════
  // 第一批讲的是「他们是什么样的人」，这一批讲的是「他们没告诉你的那件事」。
  {
    id: 'side_call', title: '赵磊的那通电话', icon: '📞', about: '赵磊',
    hook: '停电那晚他想给家里打个电话，最后没打。',
    stages: [
      {
        prefer: 7,
        speaker: '赵磊',
        text: '那晚停电的时候，我第一反应是掏手机。\n'
            + '不是照路 —— 是想给我妈打个电话。\n'
            + '……我也不知道打给她干嘛。就是忽然特别想听她说句话。\n'
            + '后来我把手机又塞回去了，因为我想：她这个点肯定睡了。',
        choices: [
          { text: '你平时经常打吗？', effect: '赵磊好感度 +1' },
          { text: '那你可以现在打。', effect: '获得 200 金币' },
        ],
      },
      {
        prefer: 33,
        speaker: '赵磊',
        text: '我一个月打一次，报平安那种，三分钟就挂。\n'
            + '每次挂之前她都问「还有别的事吗」，我都说没有。\n'
            + '其实有。就是说不出来。\n'
            + '你看，我连讲笑话都要写在本子上，你指望我能说出什么正经话。',
        choices: [
          { text: '你写下来的那些就是正经话。', effect: '赵磊好感度 +2，暴击率 +8%（本局）' },
          { text: '下次可以跟我说。', effect: '赵磊好感度 +1，金币获取 +10%（本局）' },
        ],
      },
      {
        prefer: 48,
        speaker: '赵磊',
        text: '刚才梦里我手机响了。屏幕上是我妈的号码。\n'
            + '我接了，但是那边没有人说话，只有雨声。\n'
            + '我对着话筒讲了很久，讲的全是我平时不会讲的。\n'
            + '讲完之后那边说了一句：「醒了就好。」\n'
            + '……你说这是梦还是真的？',
        choices: [
          { text: '是真的。', effect: '全属性 +10%' },
          { text: '是你自己想听的。', effect: '床铺回复至满血' },
        ],
      },
    ],
    reward: '获得 520 金币、获得 30 灵魂',
    fragment: 'frag_5',
  },
  {
    id: 'side_thermos', title: '保温杯底的标签', icon: '🍵', about: '周默',
    hook: '他杯底贴着一张写满日期的标签，只有最后一条没有勾。',
    stages: [
      {
        prefer: 13,
        speaker: '周默',
        text: '你看见我杯子底下那张纸了？\n'
            + '那是我的核对记录。每次值夜我都会核对一遍人数，然后画个勾。\n'
            + '三年，一百多次，全都有勾。\n'
            + '只有最后一条没有。',
        choices: [
          { text: '最后一条是什么时候？', effect: '周默好感度 +1' },
          { text: '撕了吧，不用留着。', effect: '获得 260 金币' },
        ],
      },
      {
        prefer: 37,
        speaker: '周默',
        text: '最后一条是那晚。03:07。\n'
            + '我核对了四遍，四遍的人数都是四。\n'
            + '但我就是画不上那个勾。\n'
            + '因为四遍里，没有一遍我能确认床上那个人醒着。\n'
            + '记录只记「在不在」，不记「醒没醒」。这是我的疏漏。',
        choices: [
          { text: '那不是你的错。', effect: '周默好感度 +2，全队防御 +12%（本波）' },
          { text: '你可以现在补上。', effect: '永久护盾 +260' },
        ],
      },
      {
        prefer: 50,
        speaker: '周默',
        text: '我把最后一条撕下来了。\n'
            + '没有扔 —— 我把它折好，夹进了值夜表的最后一页。\n'
            + '等哪天有人翻开那本子，会看见一张没有勾的纸条。\n'
            + '他会知道，有个人在这里核对过，而且一直没有放下。',
        choices: [
          { text: '那也是一条记录。', effect: '全属性 +12%' },
          { text: '你可以放下了。', effect: '床铺回复至满血、获得 400 金币' },
        ],
      },
    ],
    reward: '获得 480 金币、获得 26 灵魂',
    fragment: 'frag_6',
  },
  {
    id: 'side_key', title: '小夏带走的钥匙', icon: '🗝️', about: '林小夏',
    hook: '下楼前她顺手把钥匙带走了 —— 所以回来时她没有敲门。',
    stages: [
      {
        prefer: 14,
        speaker: '林小夏',
        text: '下楼之前我抓了钥匙。\n'
            + '因为那扇门被风带上过一次，那次我们三个在外面站了十分钟。\n'
            + '所以我现在的习惯是：只要出门，钥匙就揣兜里。\n'
            + '……你问这个干嘛？',
        choices: [
          { text: '你们回来的时候敲门了吗？', effect: '林小夏好感度 +1' },
          { text: '随口问问。', effect: '获得 240 金币' },
        ],
      },
      {
        prefer: 34,
        speaker: '林小夏',
        text: '没有。我们有钥匙，为什么要敲。\n'
            + '而且 —— 说实话，我们不敢敲。\n'
            + '屋里那会儿一点声音都没有，周默说「轻点」，我们就都放轻了。\n'
            + '赵磊是碰了一下门框，那是他的习惯，不是敲门。\n'
            + '……所以你梦里那三下敲门，到底是谁敲的？',
        choices: [
          { text: '我也想知道。', effect: '解锁世界观词条，全属性 +6%' },
          { text: '也许是我自己敲的。', effect: '获得 350 金币' },
        ],
        unlockLore: 'lore_key',
      },
      {
        prefer: 52,
        speaker: '林小夏',
        text: '我想通了。\n'
            + '那三下不是任何人敲的，是你心里那声「他们回来了吗」敲的。\n'
            + '因为如果真的是敲门，我们不可能不答应。\n'
            + '我们只是没有敲门 —— 这一点我从来没有骗过你。',
        choices: [
          { text: '我知道。', effect: '全属性 +12%' },
          { text: '谢谢你告诉我。', effect: '林小夏好感度 +2，永久护盾 +280' },
        ],
      },
    ],
    reward: '获得 500 金币、获得 28 灵魂',
    fragment: 'frag_8',
  },
  {
    id: 'side_catbowl', title: '三点的碗', icon: '🥣', about: '旁白',
    hook: '一楼楼梯口有个搪瓷碗，每天都有人添水。',
    stages: [
      {
        prefer: 9,
        speaker: '旁白',
        text: '一楼楼梯口的墙角放着一个搪瓷碗，边缘磕掉了一块。\n'
            + '碗里永远有干净的水，冬天还会有半根火腿肠。\n'
            + '没有人承认是自己在喂它 —— 但碗从来没有空过。',
        choices: [
          { text: '是谁在喂？', effect: '解锁世界观词条' },
          { text: '一只猫而已。', effect: '获得 150 金币' },
        ],
        unlockLore: 'lore_cat',
      },
      {
        prefer: 36,
        speaker: '旁白',
        text: '老陈说那个碗是很多年前一个值夜生留下的。\n'
            + '那个学生毕业前把碗洗干净，放在墙角，说「以后麻烦你了」。\n'
            + '老陈没问「以后」是什么意思，只是一直添水。\n'
            + '添了三十年。',
        choices: [
          { text: '他一直在守一个约定。', effect: '床铺回复 25%' },
          { text: '（安静地听完）', effect: '获得 300 金币' },
        ],
      },
      {
        prefer: 49,
        speaker: '旁白',
        text: '梦里的那个碗也在墙角，也是满的。\n'
            + '三点走过去喝了一口，抬头看了你一眼。\n'
            + '你忽然明白了：这只猫不是野猫。\n'
            + '它是被留下来的 —— 和那盏灯、那张照片、那本值夜表一样。\n'
            + '这栋楼里所有「没人认领但一直有人管」的东西，都是同一种东西。',
        choices: [
          { text: '都是有人在等。', effect: '全属性 +8%、床铺回复至满血' },
          { text: '（安静地看完）', effect: '获得 400 金币、获得 20 灵魂' },
        ],
      },
    ],
    reward: '获得 460 金币、获得 24 灵魂',
    fragment: 'frag_9',
  },
  {
    id: 'side_lock', title: '天台的那把挂锁', icon: '🌌', about: '周默',
    hook: '老陈腰上挂着一把从没打开过的钥匙。',
    stages: [
      {
        prefer: 21,
        speaker: '周默',
        text: '老陈腰上挂着一串钥匙，其中一把从来没见他用过。\n'
            + '我问过，他说那是天台的门。\n'
            + '「那门为什么一直锁着？」\n'
            + '他说：「因为有人上去过。」',
        choices: [
          { text: '上去以后怎么了？', effect: '周默好感度 +1' },
          { text: '不问了。', effect: '获得 300 金币' },
        ],
      },
      {
        prefer: 39,
        speaker: '周默',
        text: '他说十几年前有个学生半夜上了天台。\n'
            + '第二天早上是被找到的，人没事，只是在上面坐了一整夜。\n'
            + '问他为什么，他说：「我想看看这栋楼有多小。」\n'
            + '老陈说从那以后他就把门锁了 —— 不是怕人上去，是怕人上去了下不来。',
        choices: [
          { text: '我明白那种感觉。', effect: '周默好感度 +1，全属性 +6%' },
          { text: '他后来怎么样了？', effect: '获得 380 金币' },
        ],
      },
      {
        prefer: 51,
        speaker: '周默',
        text: '梦里我上了天台，门是开着的。\n'
            + '整栋楼在脚下，很小，小到能看见三楼那扇亮着的窗。\n'
            + '从上面看，307 只是一格光。\n'
            + '我忽然想：如果我一直站在这里看，会不会就不用下去了。\n'
            + '……然后我听见楼下有人喊我的名字。是赵磊。',
        choices: [
          { text: '所以你还是下去了。', effect: '全属性 +12%' },
          { text: '有人喊你，就该下去。', effect: '永久护盾 +320' },
        ],
      },
    ],
    reward: '获得 540 金币、获得 32 灵魂',
    fragment: 'frag_10',
  },
  {
    id: 'side_hidden_note', title: '铁皮柜的夹层', icon: '🗄️', about: '周默',
    hook: '柜子背板后面塞着一张纸，看起来放了很多年。',
    stages: [
      {
        prefer: 21,
        speaker: '周默',
        text: '我搬柜子的时候发现背板是松的。\n'
            + '后面塞着一张纸，折得很小，边角已经发黄。\n'
            + '上面只有一行字，写得很用力：\n'
            + '「如果你也在数人数，说明轮到你了。」',
        choices: [
          { text: '打开看全文。', effect: '周默好感度 +1，解锁世界观词条' },
          { text: '放回去。', effect: '获得 320 金币' },
        ],
        unlockLore: 'lore_prev',
      },
      {
        prefer: 33,
        speaker: '周默',
        text: '纸的背面还有字，但要逆着光才能看见。\n'
            + '是另一行：「不要替床上的人回答。他听得见。」\n'
            + '……落款是一个日期，很多年前。\n'
            + '没有署名。但字迹和值夜表上某几页很像。',
        choices: [
          { text: '是上一届写的。', effect: '周默好感度 +1，全属性 +8%' },
          { text: '所以这是一条传给下一届的留言。', effect: '获得 450 金币' },
        ],
      },
      {
        prefer: 44,
        speaker: '周默',
        text: '我决定也写一张，塞回夹层里。\n'
            + '我写的是：「他听得见。而且他回答了。」\n'
            + '写完我犹豫了很久要不要放 —— 因为这句话得是真的才有意义。\n'
            + '……最后还是放了。\n'
            + '因为我相信它会是真的。',
        choices: [
          { text: '它会是真的。', effect: '全属性 +15%、床铺回满' },
          { text: '那就让它成真。', effect: '永久护盾 +400、获得 600 金币' },
        ],
      },
    ],
    reward: '获得 620 金币、获得 38 灵魂',
    fragment: 'frag_14',
  },
];

// ─── 运行时：支线推进 ──────────────────────────────────────
const SideStorySystem = {
  /** @type {Object<string, number>} 每条支线已推进到第几个 stage */
  _progress: null,
  /** @type {Object<string, boolean>} 已完成的支线 */
  _done: null,

  init() {
    if (!this._progress) this._progress = {};
    if (!this._done) this._done = {};
  },

  /**
   * 判断某个波次是否已被其他剧情系统占用。
   * 支线只插空隙，不跟主线抢同一波 —— 否则玩家会在同一波里连读三段对白。
   */
  _waveBusy(wave) {
    if (typeof WAVE_STORY !== 'undefined' && WAVE_STORY.some(s => s.wave === wave)) return true;
    if (typeof BOSS_DIALOG !== 'undefined') {
      const keys = Object.keys(BOSS_DIALOG);
      if (keys.some(k => BOSS_DIALOG[k] && BOSS_DIALOG[k].wave === wave)) return true;
    }
    if (typeof FOURTH_WALL_EVENTS !== 'undefined' && FOURTH_WALL_EVENTS.some(e => e.wave === wave)) return true;
    // 幕交界波次留给「主线 + 幕间小结」，支线让开（见 events.js TURNING_POINTS 的 priority 说明）
    if (typeof TURNING_POINTS !== 'undefined' && TURNING_POINTS.some(t => t.wave === wave)) return true;
    return false;
  },

  /**
   * 波次钩子：由 DreamEngine.onWaveStart() 调用。
   * 策略（关键）：**每波最多播一段支线**，按「最早到期优先」排队。
   * 这样即使多个阶段的 prefer 撞在一起或被主线占用，节奏也是均匀的 ——
   * 不会出现某一波连播五段对白，也不会因为顺延而丢掉任何一段。
   * @param {number} wave
   * @returns {Array} 本波实际播出的支线阶段（0 或 1 个）
   */
  checkWave(wave) {
    this.init();
    const fired = [];

    // 收集所有「已到期但还没播」的阶段，按到期波次升序
    const queue = [];
    SIDE_STORIES.forEach(s => {
      if (this._done[s.id]) return;
      const idx = this._progress[s.id] || 0;
      const st = s.stages[idx];
      if (!st) return;
      if (st.prefer <= wave) queue.push({ sid: s.id, idx, prefer: st.prefer });
    });
    if (!queue.length) return fired;
    // ⚠️ 排序规则（踩过的坑）：必须先按「已推进的阶段数」降序，再按 prefer 升序。
    //    如果只按 prefer 排，一条支线的第 2/3 段（prefer 靠后）永远排在
    //    新支线的第 1 段（prefer 靠前）后面 —— 表现就是「先开的支线永远做不完」，
    //    实测有 3 条支线到第 60 波都卡在第 2 段。先把开了头的收掉，再开新的。
    queue.sort((a, b) => (b.idx - a.idx) || (a.prefer - b.prefer));
    // 波次预算：名额用完就让位（主线波 1 段、空闲波 2 段）；
    // 传入最早到期节点的逾期量，严重逾期时会放宽名额，避免内容被排期卡死。
    if (typeof StoryPacing !== 'undefined' && !StoryPacing.canPlay(wave, wave - queue[0].prefer)) return fired;

    // 挑选顺序：本波到期且本波空闲 > 本波空闲（补最早到期的）> 全被占用则播最早到期的
    const pick = queue.find(q => q.prefer === wave && !this._waveBusy(wave))
      || queue.find(q => !this._waveBusy(wave))
      || queue[0];

    this._fire(pick.sid, pick.idx, wave);
    if (typeof StoryPacing !== 'undefined') StoryPacing.take(wave);
    fired.push(pick);
    return fired;
  },

  /** 播出某个阶段并推进进度；走完最后一阶段则结算奖励 */
  _fire(sid, idx, wave) {
    const s = SIDE_STORIES.find(x => x.id === sid);
    if (!s) return;
    const st = s.stages[idx];
    if (!st) return;

    // 全部走宿主接口（见 host.js）。全局探测在 ESM 里恒失效，而且是静默的 ——
    // 支线会"推进了但玩家什么都没看到"，最坏的一种失败。
    const host = getStoryHost();

    if (st.unlockLore) {
      try { getLoreCodex().unlock(st.unlockLore); } catch (e) {}
    }
    try {
      host.showDialog({
        wave: wave, speaker: st.speaker, text: st.text, choices: st.choices, kind: 'side',
      });
    } catch (e) { console.warn('[SideStory] dialog:', e); }
    try {
      host.diary('story', '支线「' + s.title + '」推进：' + (idx + 1) + '/' + s.stages.length);
    } catch (e) {}

    this._progress[sid] = idx + 1;

    // 全部阶段走完 → 结算
    if (this._progress[sid] >= s.stages.length) {
      this._done[sid] = true;
      if (s.reward) {
        try { host.applyEffect(s.reward); } catch (e) { console.warn('[SideStory] reward:', e); }
      }
      // 碎片收集走宿主通道（3D 侧由 story-runtime 转给 DreamFragments，
      // 2D 侧由 host.js 的全局回落转过去）。
      if (s.fragment) {
        try { host.collectFragment(s.fragment); } catch (e) {}
      }
      try { host.toast('📓 支线完成 · ' + s.title, s.hook, 'green', 6); } catch (e) {}
      try { host.diary('discover', '完成了支线「' + s.title + '」'); } catch (e) {}
    }
  },

  /** 面板用：全部支线及进度 */
  list() {
    this.init();
    return SIDE_STORIES.map(s => ({
      def: s,
      step: this._progress[s.id] || 0,
      total: s.stages.length,
      done: !!this._done[s.id],
    }));
  },

  /** 完成度统计（章节回顾用） */
  progress() {
    this.init();
    const done = SIDE_STORIES.filter(s => this._done[s.id]).length;
    return { done, total: SIDE_STORIES.length };
  },

  snapshot() {
    this.init();
    return { progress: Object.assign({}, this._progress), done: Object.assign({}, this._done) };
  },

  restore(snap) {
    this.init();
    if (!snap) return;
    if (snap.progress) Object.assign(this._progress, snap.progress);
    if (snap.done) Object.assign(this._done, snap.done);
  },

  reset() { this._progress = {}; this._done = {}; },
};

// ── ESM 导出（构建脚本自动追加，勿手改这段）──
export { SIDE_STORIES, SideStorySystem };
