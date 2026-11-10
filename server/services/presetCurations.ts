/**
 * 六座预置城市的「人工整理稿」：城市人格、年代轴、城市味道。
 *
 * 真实性约定：
 *  - 年代轴的起止年份一律取自 server/data/dynasties.json（构建期整理），
 *    事件叙述为人工整理、通行说法，verification 标记 preset_manual，待人工复核。
 *  - 城市味道为人工/AI 整理的民俗常识，统一标注 AI 整理，不冒充官方认定。
 *  - 面积、人口等统计数值一律不出现在此文件，保持「待考」。
 */

export interface CuratedChronicleEntry {
  eraName: string;
  epithet?: string;
  startYear: number;
  endYear: number;
  periodRange: string;
  ancientCityName: string;
  keyEvents: string;
  relicToday: string;
}

export interface CuratedLocalSoul {
  foods: Array<{ name: string; flavor: string; origin: string }>;
  dialects: Array<{ word: string; pronunciation: string; meaning: string; example: string }>;
  ichItems: Array<{ name: string; level: 'national' | 'provincial' | '待考'; intro: string }>;
  festivals: Array<{ name: string; season: string; custom: string }>;
}

export interface CityCuration {
  persona: string;
  chronicle: CuratedChronicleEntry[];
  localSoul: CuratedLocalSoul;
}

export const PRESET_CURATIONS: Record<string, CityCuration> = {
  'CN-610100': {
    persona: '十三朝古都的厚重，与回坊街巷的烟火在此并存。',
    chronicle: [
      {
        eraName: '西周',
        epithet: '丰镐二京',
        startYear: -1046,
        endYear: -771,
        periodRange: '前1046—前771',
        ancientCityName: '镐京',
        keyEvents: '周人于沣河两岸营建丰、镐二京，为西安地区建城之始；通行说法以镐京为西周都城。',
        relicToday: '丰镐遗址',
      },
      {
        eraName: '秦',
        startYear: -221,
        endYear: -206,
        periodRange: '前221—前206',
        ancientCityName: '咸阳',
        keyEvents: '秦孝公迁都咸阳，秦统一后仍以此为都；今西安、咸阳渭河两岸分布大量秦代遗址。',
        relicToday: '秦始皇陵及兵马俑坑',
      },
      {
        eraName: '西汉',
        startYear: -202,
        endYear: 9,
        periodRange: '前202—公元9',
        ancientCityName: '长安',
        keyEvents: '汉高祖定都长安，营建未央宫等宫室；汉长安城遗址位于今西安西北郊。',
        relicToday: '汉长安城遗址',
      },
      {
        eraName: '唐',
        startYear: 618,
        endYear: 907,
        periodRange: '618—907',
        ancientCityName: '长安',
        keyEvents: '隋建大兴城，唐改称长安并不断扩建，成为当时东亚重要的国际都会。',
        relicToday: '大明宫遗址、大雁塔',
      },
    ],
    localSoul: {
      foods: [
        { name: '肉夹馍', flavor: '咸香', origin: '关中面食' },
        { name: '羊肉泡馍', flavor: '醇厚', origin: '回坊清真饮食' },
        { name: '凉皮', flavor: '酸辣', origin: '关中街头小吃' },
      ],
      dialects: [
        {
          word: '嘹咋咧',
          pronunciation: 'liáo zā liě',
          meaning: '太好了、非常棒',
          example: '这碗泡馍嘹咋咧！',
        },
      ],
      ichItems: [
        {
          name: '秦腔',
          level: 'national',
          intro: '流行于关中一带的古老梆子腔剧种，唱腔高亢激越。',
        },
        {
          name: '西安鼓乐',
          level: 'national',
          intro: '流传于西安及周边的大型吹打乐，保留唐宋以来多种曲牌。',
        },
      ],
      festivals: [
        { name: '城墙新春灯会', season: '冬春', custom: '于明城墙沿线张灯结彩，登城赏灯。' },
        { name: '关中社火', season: '春节', custom: '乡村锣鼓、芯子、高跷巡游，祈求新年顺遂。' },
      ],
    },
  },
  'CN-330100': {
    persona: '一半湖山一半城，宋韵与茶香在巷陌间流转。',
    chronicle: [
      {
        eraName: '秦',
        startYear: -221,
        endYear: -206,
        periodRange: '前221—前206',
        ancientCityName: '钱唐',
        keyEvents: '秦置钱唐县，属会稽郡，为杭州地区设县之始。',
        relicToday: '钱塘江沿岸早期聚落遗址',
      },
      {
        eraName: '隋',
        startYear: 581,
        endYear: 618,
        periodRange: '581—618',
        ancientCityName: '杭州',
        keyEvents: '隋置杭州，州治后移钱唐；大运河贯通后，杭州成为江南交通节点。',
        relicToday: '拱宸桥、运河杭州段',
      },
      {
        eraName: '五代十国',
        epithet: '吴越国都',
        startYear: 907,
        endYear: 979,
        periodRange: '907—979',
        ancientCityName: '临安',
        keyEvents: '吴越国以杭州为都，修筑罗城、疏浚西湖，奠定后世城市格局。',
        relicToday: '雷峰塔、西湖',
      },
      {
        eraName: '南宋',
        startYear: 1127,
        endYear: 1279,
        periodRange: '1127—1279',
        ancientCityName: '临安',
        keyEvents: '宋室南渡后以临安为行在，杭州成为南宋政治与商业中心。',
        relicToday: '南宋御街、西湖',
      },
    ],
    localSoul: {
      foods: [
        { name: '西湖醋鱼', flavor: '酸甜', origin: '西湖船菜' },
        { name: '片儿川', flavor: '鲜咸', origin: '杭州面食' },
        { name: '龙井虾仁', flavor: '清鲜', origin: '龙井茶入馔' },
      ],
      dialects: [
        {
          word: '落胃',
          pronunciation: 'lào wèi',
          meaning: '舒服、满足',
          example: '一碗片儿川下肚，真当落胃。',
        },
      ],
      ichItems: [
        {
          name: '西湖龙井茶制作技艺',
          level: 'national',
          intro: '西湖产区龙井茶的传统炒制技艺，讲究抖、搭、搨、捺等手法。',
        },
        {
          name: '胡庆余堂中药文化',
          level: 'national',
          intro: '以「戒欺」为训的中药老字号文化，涵盖炮制、配伍与经营传统。',
        },
      ],
      festivals: [
        { name: '西湖桂花节', season: '秋', custom: '满觉陇一带赏桂、品桂花糖藕。' },
        { name: '端午龙舟', season: '夏', custom: '运河与西湖水域举行龙舟竞渡。' },
      ],
    },
  },
  'CN-510100': {
    persona: '慢火煮茶、麻辣入味，闲适里藏着两千年的从容。',
    chronicle: [
      {
        eraName: '战国',
        startYear: -475,
        endYear: -221,
        periodRange: '前475—前221',
        ancientCityName: '成都',
        keyEvents: '秦灭蜀后置蜀郡，成都为郡治；城名与城址沿用两千余年。',
        relicToday: '武侯祠、锦里一带的古城遗存',
      },
      {
        eraName: '三国',
        startYear: 220,
        endYear: 280,
        periodRange: '220—280',
        ancientCityName: '益州',
        keyEvents: '蜀汉以成都为都，诸葛亮治蜀期间重视水利与农桑。',
        relicToday: '武侯祠、杜甫草堂',
      },
      {
        eraName: '唐',
        startYear: 618,
        endYear: 907,
        periodRange: '618—907',
        ancientCityName: '益州',
        keyEvents: '唐代成都称益州，织锦业繁盛，故有「锦官城」之名。',
        relicToday: '蜀锦织绣博物馆、浣花溪',
      },
      {
        eraName: '五代十国',
        startYear: 907,
        endYear: 979,
        periodRange: '907—979',
        ancientCityName: '成都',
        keyEvents: '前蜀、后蜀相继以成都为都，留下永陵等遗迹。',
        relicToday: '永陵、宽窄巷子',
      },
    ],
    localSoul: {
      foods: [
        { name: '火锅', flavor: '麻辣', origin: '川渝码头饮食' },
        { name: '担担面', flavor: '麻辣鲜香', origin: '成都街头面食' },
        { name: '钟水饺', flavor: '甜辣', origin: '成都传统小吃' },
      ],
      dialects: [
        {
          word: '巴适',
          pronunciation: 'bā shì',
          meaning: '舒服、合适',
          example: '坐到茶馆头晒哈太阳，巴适得很。',
        },
      ],
      ichItems: [
        {
          name: '蜀锦织造技艺',
          level: 'national',
          intro: '成都传统织锦技艺，以经线显花、色彩艳丽著称。',
        },
        {
          name: '川剧',
          level: 'national',
          intro: '融合昆、高、胡、弹、灯五腔的四川地方戏曲。',
        },
      ],
      festivals: [
        { name: '成都灯会', season: '春节', custom: '于公园与街区布置大型彩灯。' },
        { name: '成都花会', season: '春', custom: '青羊宫一带赏花、逛集市。' },
      ],
    },
  },
  'CN-110000': {
    persona: '中轴线上的宫阙与胡同里的鸽哨，共写一座城的规矩与温度。',
    chronicle: [
      {
        eraName: '西周',
        epithet: '蓟城',
        startYear: -1046,
        endYear: -771,
        periodRange: '前1046—前771',
        ancientCityName: '蓟',
        keyEvents: '周初分封蓟国，城址约在今北京城区西南，为北京建城史的重要源头。',
        relicToday: '今广安门一带的早期城址',
      },
      {
        eraName: '唐',
        startYear: 618,
        endYear: 907,
        periodRange: '618—907',
        ancientCityName: '幽州',
        keyEvents: '唐代北京为幽州治所，是中原与北方往来的军事重镇。',
        relicToday: '法源寺、幽州城遗址',
      },
      {
        eraName: '元',
        startYear: 1271,
        endYear: 1368,
        periodRange: '1271—1368',
        ancientCityName: '大都',
        keyEvents: '元世祖定都大都，营建宫城与中轴线，奠定今北京城的基本格局。',
        relicToday: '元大都城垣遗址公园、钟鼓楼',
      },
      {
        eraName: '明',
        startYear: 1368,
        endYear: 1644,
        periodRange: '1368—1644',
        ancientCityName: '北京',
        keyEvents: '明成祖迁都北京，营建紫禁城与天坛等礼制建筑。',
        relicToday: '故宫、天坛',
      },
    ],
    localSoul: {
      foods: [
        { name: '北京烤鸭', flavor: '皮酥肉嫩', origin: '京城宴席' },
        { name: '炸酱面', flavor: '咸鲜', origin: '胡同家常饭' },
        { name: '豆汁', flavor: '酸馊', origin: '老北京早点' },
      ],
      dialects: [
        {
          word: '局气',
          pronunciation: 'jú qi',
          meaning: '仗义、守规矩',
          example: '这事儿办得局气。',
        },
      ],
      ichItems: [
        {
          name: '京剧',
          level: 'national',
          intro: '融合唱念做打的全国性戏曲剧种，形成于清代北京。',
        },
        {
          name: '景泰蓝制作技艺',
          level: 'national',
          intro: '铜胎掐丝珐琅工艺，以掐丝、点蓝、烧蓝等工序著称。',
        },
      ],
      festivals: [
        { name: '厂甸庙会', season: '春节', custom: '琉璃厂一带逛庙会、赏民俗。' },
        { name: '中秋拜月', season: '秋', custom: '家宴团聚、供月赏月。' },
      ],
    },
  },
  'CN-320500': {
    persona: '粉墙黛瓦、评弹软语，把江南收进一园一巷。',
    chronicle: [
      {
        eraName: '春秋',
        epithet: '阖闾城',
        startYear: -770,
        endYear: -476,
        periodRange: '前770—前476',
        ancientCityName: '姑苏',
        keyEvents: '吴王阖闾筑城，后世传为伍子胥主持，被视为苏州建城之始。',
        relicToday: '盘门、胥门',
      },
      {
        eraName: '秦',
        startYear: -221,
        endYear: -206,
        periodRange: '前221—前206',
        ancientCityName: '吴县',
        keyEvents: '秦置会稽郡，治吴县，即今苏州老城一带。',
        relicToday: '苏州古城墙遗迹',
      },
      {
        eraName: '隋',
        startYear: 581,
        endYear: 618,
        periodRange: '581—618',
        ancientCityName: '苏州',
        keyEvents: '隋改吴州为苏州，因城西南姑苏山得名。',
        relicToday: '山塘街、枫桥',
      },
      {
        eraName: '南宋',
        startYear: 1127,
        endYear: 1279,
        periodRange: '1127—1279',
        ancientCityName: '平江',
        keyEvents: '宋代称平江府，今平江路一带仍保留水陆并行的街巷格局。',
        relicToday: '平江路、拙政园',
      },
    ],
    localSoul: {
      foods: [
        { name: '松鼠桂鱼', flavor: '酸甜', origin: '苏帮菜' },
        { name: '奥灶面', flavor: '鲜咸', origin: '昆山一带面食' },
        { name: '苏式汤面', flavor: '清淡', origin: '苏州早点' },
      ],
      dialects: [
        {
          word: '适意',
          pronunciation: 'shì yì',
          meaning: '舒服、惬意',
          example: '坐勒园林里吃茶，适意煞哉。',
        },
      ],
      ichItems: [
        {
          name: '苏绣',
          level: 'national',
          intro: '以「平、齐、细、密」著称的苏州刺绣技艺。',
        },
        {
          name: '昆曲',
          level: 'national',
          intro: '发源于昆山一带的古老声腔剧种，被誉为「百戏之祖」。',
        },
      ],
      festivals: [
        { name: '端午伍子胥祭祀', season: '夏', custom: '胥门一带举行纪念伍子胥的民俗活动。' },
        { name: '冬至团', season: '冬', custom: '冬至前后制作团子、祭祖团聚。' },
      ],
    },
  },
  'CN-410300': {
    persona: '河洛之间，牡丹与石窟守着十三朝的记忆。',
    chronicle: [
      {
        eraName: '西周',
        epithet: '成周',
        startYear: -1046,
        endYear: -771,
        periodRange: '前1046—前771',
        ancientCityName: '洛邑',
        keyEvents: '周公营建洛邑，作为周朝东都，为洛阳建城史的重要节点。',
        relicToday: '王城公园、周公庙',
      },
      {
        eraName: '东汉',
        startYear: 25,
        endYear: 220,
        periodRange: '25—220',
        ancientCityName: '雒阳',
        keyEvents: '东汉定都洛阳（时称雒阳），太学、灵台等设施汇集于此。',
        relicToday: '汉魏洛阳故城遗址、白马寺',
      },
      {
        eraName: '隋',
        startYear: 581,
        endYear: 618,
        periodRange: '581—618',
        ancientCityName: '东都',
        keyEvents: '隋炀帝营建东都洛阳，开凿大运河使其成为南北漕运枢纽。',
        relicToday: '隋唐洛阳城遗址、含嘉仓',
      },
      {
        eraName: '唐',
        startYear: 618,
        endYear: 907,
        periodRange: '618—907',
        ancientCityName: '神都',
        keyEvents: '武则天改东都为神都，洛阳在唐代长期作为政治副中心。',
        relicToday: '龙门石窟、明堂天堂',
      },
    ],
    localSoul: {
      foods: [
        { name: '洛阳水席', flavor: '酸辣', origin: '洛阳传统宴席' },
        { name: '浆面条', flavor: '酸香', origin: '洛阳家常面食' },
        { name: '不翻汤', flavor: '酸辣', origin: '洛阳早点' },
      ],
      dialects: [
        {
          word: '中',
          pronunciation: 'zhōng',
          meaning: '行、可以',
          example: '这事儿中！',
        },
      ],
      ichItems: [
        {
          name: '唐三彩烧制技艺',
          level: 'national',
          intro: '以黄、绿、白为主色的低温铅釉陶器烧制技艺。',
        },
        {
          name: '河洛大鼓',
          level: 'national',
          intro: '流行于洛阳一带的说唱艺术，以鼓板伴奏、方言演唱。',
        },
      ],
      festivals: [
        { name: '牡丹文化节', season: '春', custom: '牡丹花期举办赏花与文化展演活动。' },
        { name: '关林庙会', season: '春', custom: '关林一带祭关公、逛传统庙会。' },
      ],
    },
  },
};
