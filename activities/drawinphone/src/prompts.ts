/** "Inspire me" prompts and the fill-ins for missing answers, per locale. */

const EN = [
  'A cat piloting a submarine', 'Grandma winning a breakdance battle', 'A snowman on a beach holiday',
  'The moon eating a sandwich', 'A dragon afraid of the dark', 'A robot learning to knit',
  'Penguins running a bakery', 'A ghost doing laundry', 'An octopus playing drums',
  'A dog that became mayor', 'Pirates at a job interview', 'A volcano with a cold',
  'A wizard stuck in traffic', 'A dinosaur at the dentist', 'Two snails in a race',
  'A banana going to the gym', 'Aliens visiting a supermarket', 'A shark selling ice cream',
  'A knight fighting a vacuum cleaner', 'A cloud that rains spaghetti', 'A giraffe in an elevator',
  'Tea party on a sinking ship', 'A cactus giving hugs', 'A frog proposing to a princess',
  'The sun wearing sunglasses', 'A haunted vending machine', 'A hamster bodybuilder',
  'Superhero with a terrible power', 'A bear stealing a picnic', 'A tiny horse in a big city',
  'A mermaid stuck in a bathtub', 'A chef cooking a shoe', 'A UFO abducting a cow',
  'A crocodile brushing its teeth', 'A rocket made of cheese', 'A sloth in a hurry',
  'An owl teaching math', 'A cowboy riding a chicken', 'A traffic jam of ducks',
  'A pizza with feelings', 'A king who lost his crown', 'A ninja tripping over a cat',
  'A lighthouse at a disco', 'Bees having a meeting', 'A tree wearing a scarf',
  'A skeleton at the beach', 'A vampire at a blood drive', 'A piano falling from the sky',
  'A unicorn stuck in mud', 'A spider knitting a sweater', 'A burger eating a burger',
  'A camel at the North Pole', 'Zombies at a yoga class', 'A toaster in love',
  'A lion getting a haircut', 'A whale in a swimming pool', 'A goat on a skateboard',
  'Monday morning as a monster', 'The internet going on vacation', 'A detective duck',
  'A mouse lifting an elephant', 'A time traveler confused by phones', 'A hot dog in a sleeping bag',
  'A wizard with a tiny wand', 'A sock monster under the bed', 'A turtle winning a sprint',
  'A balloon escaping a party', 'A flamingo doing karate', 'An astronaut mowing the lawn',
  'A teapot having a tantrum', 'Cats ruling the world', 'A carrot running from a rabbit',
]

const PROMPTS: Record<string, string[]> = {
  en: EN,
  es: [
    'Un gato pilotando un submarino', 'Una abuela ganando una batalla de breakdance', 'Un muñeco de nieve en la playa',
    'La luna comiéndose un bocadillo', 'Un dragón con miedo a la oscuridad', 'Un robot aprendiendo a tejer',
    'Pingüinos con una panadería', 'Un fantasma haciendo la colada', 'Un pulpo tocando la batería',
    'Un perro que se hizo alcalde', 'Piratas en una entrevista de trabajo', 'Un volcán resfriado',
    'Un mago atrapado en un atasco', 'Un dinosaurio en el dentista', 'Un tiburón vendiendo helados',
    'Un cactus dando abrazos', 'Un hámster culturista', 'Una nube que llueve espaguetis',
    'Un caballero contra una aspiradora', 'Una jirafa en un ascensor', 'Un pato detective',
  ],
  fr: [
    'Un chat qui pilote un sous-marin', 'Une mamie qui gagne un battle de breakdance', 'Un bonhomme de neige à la plage',
    'La lune qui mange un sandwich', 'Un dragon qui a peur du noir', 'Un robot qui apprend à tricoter',
    'Des pingouins qui tiennent une boulangerie', 'Un fantôme qui fait sa lessive', 'Une pieuvre à la batterie',
    'Un chien devenu maire', 'Des pirates en entretien d’embauche', 'Un volcan enrhumé',
    'Un sorcier coincé dans les bouchons', 'Un dinosaure chez le dentiste', 'Un requin qui vend des glaces',
    'Un cactus qui fait des câlins', 'Un hamster culturiste', 'Un nuage qui pleut des spaghettis',
    'Un chevalier contre un aspirateur', 'Une girafe dans un ascenseur', 'Un canard détective',
  ],
  de: [
    'Eine Katze steuert ein U-Boot', 'Oma gewinnt einen Breakdance-Battle', 'Ein Schneemann im Strandurlaub',
    'Der Mond isst ein Sandwich', 'Ein Drache mit Angst vor der Dunkelheit', 'Ein Roboter lernt Stricken',
    'Pinguine führen eine Bäckerei', 'Ein Geist macht Wäsche', 'Ein Oktopus spielt Schlagzeug',
    'Ein Hund wird Bürgermeister', 'Piraten beim Vorstellungsgespräch', 'Ein Vulkan mit Schnupfen',
    'Ein Zauberer im Stau', 'Ein Dinosaurier beim Zahnarzt', 'Ein Hai verkauft Eis',
    'Ein Kaktus verteilt Umarmungen', 'Ein Hamster beim Bodybuilding', 'Eine Wolke regnet Spaghetti',
    'Ein Ritter kämpft gegen einen Staubsauger', 'Eine Giraffe im Aufzug', 'Eine Detektiv-Ente',
  ],
  nl: [
    'Een kat die een onderzeeër bestuurt', 'Oma wint een breakdancebattle', 'Een sneeuwpop op strandvakantie',
    'De maan eet een boterham', 'Een draak die bang is in het donker', 'Een robot leert breien',
    'Pinguïns met een bakkerij', 'Een spook doet de was', 'Een octopus speelt drums',
    'Een hond die burgemeester werd', 'Piraten op sollicitatiegesprek', 'Een verkouden vulkaan',
    'Een tovenaar in de file', 'Een dinosaurus bij de tandarts', 'Een haai verkoopt ijsjes',
    'Een cactus die knuffels geeft', 'Een hamster die aan bodybuilding doet', 'Een wolk die spaghetti regent',
    'Een ridder vecht tegen een stofzuiger', 'Een giraf in een lift', 'Een detective-eend',
  ],
  ja: [
    '潜水艦を操縦するネコ', 'ブレイクダンスで優勝するおばあちゃん', 'ビーチでバカンス中の雪だるま',
    'サンドイッチを食べる月', '暗いところが怖いドラゴン', '編み物を習うロボット',
    'パン屋を営むペンギンたち', '洗濯をするおばけ', 'ドラムを叩くタコ',
    '市長になった犬', '面接を受ける海賊', '風邪をひいた火山',
    '渋滞にはまった魔法使い', '歯医者さんにいる恐竜', 'アイスを売るサメ',
    'ハグしてくれるサボテン', 'ボディビルダーのハムスター', 'スパゲッティの雨を降らす雲',
    '掃除機と戦う騎士', 'エレベーターに乗るキリン', '探偵のアヒル',
  ],
  ko: [
    '잠수함을 조종하는 고양이', '브레이크댄스 대회에서 우승한 할머니', '해변으로 휴가 간 눈사람',
    '샌드위치를 먹는 달', '어둠을 무서워하는 드래곤', '뜨개질을 배우는 로봇',
    '빵집을 운영하는 펭귄들', '빨래하는 유령', '드럼 치는 문어',
    '시장이 된 강아지', '면접 보는 해적들', '감기 걸린 화산',
    '교통 체증에 갇힌 마법사', '치과에 간 공룡', '아이스크림 파는 상어',
    '안아 주는 선인장', '보디빌더 햄스터', '스파게티 비를 내리는 구름',
    '청소기와 싸우는 기사', '엘리베이터 탄 기린', '탐정 오리',
  ],
  zh: [
    '驾驶潜水艇的猫', '赢得街舞比赛的奶奶', '在海滩度假的雪人',
    '吃三明治的月亮', '怕黑的龙', '学织毛衣的机器人',
    '开面包店的企鹅', '洗衣服的鬼魂', '打鼓的章鱼',
    '当上市长的狗', '参加面试的海盗', '感冒的火山',
    '堵在路上的巫师', '看牙医的恐龙', '卖冰淇淋的鲨鱼',
    '给人拥抱的仙人掌', '健美的仓鼠', '下意大利面雨的云',
    '大战吸尘器的骑士', '坐电梯的长颈鹿', '侦探鸭子',
  ],
}

export function promptsFor(locale: string): string[] {
  return PROMPTS[locale.slice(0, 2).toLowerCase()] ?? EN
}

/** A prompt from the list that differs from `avoid` when the list allows. */
export function randomPrompt(locale: string, avoid?: string, random: () => number = Math.random): string {
  const list = promptsFor(locale)
  for (let i = 0; i < 4; i++) {
    const pick = list[Math.floor(random() * list.length)]
    if (pick !== avoid) return pick
  }
  return list[0]
}
