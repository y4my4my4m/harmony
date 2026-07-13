/**
 * Recovery Key Service
 * 
 * Generates and manages the user's recovery key using BIP39 mnemonics.
 * The recovery key is used to:
 * 1. Encrypt session key backups stored on server
 * 2. Restore encryption on new devices
 * 3. Cross-device key sharing
 * 
 * Security Model:
 * - Recovery key is NEVER sent to server in plaintext
 * - User must write down and store securely (like a crypto wallet seed)
 * - All session keys are encrypted with derived key before server storage
 */

import { debug } from '@/utils/debug'
// BIP39 English wordlist (2048 words)
// Using a subset for simplicity - in production, use full wordlist from bip39 library
const WORDLIST = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
  'adapt', 'add', 'addict', 'address', 'adjust', 'admit', 'adult', 'advance',
  'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent',
  'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album',
  'alcohol', 'alert', 'alien', 'all', 'alley', 'allow', 'almost', 'alone',
  'alpha', 'already', 'also', 'alter', 'always', 'amateur', 'amazing', 'among',
  'amount', 'amused', 'analyst', 'anchor', 'ancient', 'anger', 'angle', 'angry',
  'animal', 'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique',
  'anxiety', 'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april',
  'arch', 'arctic', 'area', 'arena', 'argue', 'arm', 'armed', 'armor',
  'army', 'around', 'arrange', 'arrest', 'arrive', 'arrow', 'art', 'artefact',
  'artist', 'artwork', 'ask', 'aspect', 'assault', 'asset', 'assist', 'assume',
  'asthma', 'athlete', 'atom', 'attack', 'attend', 'attitude', 'attract', 'auction',
  'audit', 'august', 'aunt', 'author', 'auto', 'autumn', 'average', 'avocado',
  'avoid', 'awake', 'aware', 'away', 'awesome', 'awful', 'awkward', 'axis',
  'baby', 'bachelor', 'bacon', 'badge', 'bag', 'balance', 'balcony', 'ball',
  'bamboo', 'banana', 'banner', 'bar', 'barely', 'bargain', 'barrel', 'base',
  'basic', 'basket', 'battle', 'beach', 'bean', 'beauty', 'because', 'become',
  'beef', 'before', 'begin', 'behave', 'behind', 'believe', 'below', 'belt',
  'bench', 'benefit', 'best', 'betray', 'better', 'between', 'beyond', 'bicycle',
  'bid', 'bike', 'bind', 'biology', 'bird', 'birth', 'bitter', 'black',
  'blade', 'blame', 'blanket', 'blast', 'bleak', 'bless', 'blind', 'blood',
  'blossom', 'blouse', 'blue', 'blur', 'blush', 'board', 'boat', 'body',
  'boil', 'bomb', 'bone', 'bonus', 'book', 'boost', 'border', 'boring',
  'borrow', 'boss', 'bottom', 'bounce', 'box', 'boy', 'bracket', 'brain',
  'brand', 'brass', 'brave', 'bread', 'breeze', 'brick', 'bridge', 'brief',
  'bright', 'bring', 'brisk', 'broccoli', 'broken', 'bronze', 'broom', 'brother',
  'brown', 'brush', 'bubble', 'buddy', 'budget', 'buffalo', 'build', 'bulb',
  'bulk', 'bullet', 'bundle', 'bunker', 'burden', 'burger', 'burst', 'bus',
  'business', 'busy', 'butter', 'buyer', 'buzz', 'cabbage', 'cabin', 'cable',
  'cactus', 'cage', 'cake', 'call', 'calm', 'camera', 'camp', 'can',
  'canal', 'cancel', 'candy', 'cannon', 'canoe', 'canvas', 'canyon', 'capable',
  'capital', 'captain', 'car', 'carbon', 'card', 'cargo', 'carpet', 'carry',
  'cart', 'case', 'cash', 'casino', 'castle', 'casual', 'cat', 'catalog',
  'catch', 'category', 'cattle', 'caught', 'cause', 'caution', 'cave', 'ceiling',
  'celery', 'cement', 'census', 'century', 'cereal', 'certain', 'chair', 'chalk',
  'champion', 'change', 'chaos', 'chapter', 'charge', 'chase', 'chat', 'cheap',
  'check', 'cheese', 'chef', 'cherry', 'chest', 'chicken', 'chief', 'child',
  'chimney', 'choice', 'choose', 'chronic', 'chuckle', 'chunk', 'churn', 'cigar',
  'cinnamon', 'circle', 'citizen', 'city', 'civil', 'claim', 'clap', 'clarify',
  'claw', 'clay', 'clean', 'clerk', 'clever', 'click', 'client', 'cliff',
  'climb', 'clinic', 'clip', 'clock', 'clog', 'close', 'cloth', 'cloud',
  'clown', 'club', 'clump', 'cluster', 'clutch', 'coach', 'coast', 'coconut',
  'code', 'coffee', 'coil', 'coin', 'collect', 'color', 'column', 'combine',
  'come', 'comfort', 'comic', 'common', 'company', 'concert', 'conduct', 'confirm',
  'congress', 'connect', 'consider', 'control', 'convince', 'cook', 'cool', 'copper',
  'copy', 'coral', 'core', 'corn', 'correct', 'cost', 'cotton', 'couch',
  'country', 'couple', 'course', 'cousin', 'cover', 'coyote', 'crack', 'cradle',
  'craft', 'cram', 'crane', 'crash', 'crater', 'crawl', 'crazy', 'cream',
  'credit', 'creek', 'crew', 'cricket', 'crime', 'crisp', 'critic', 'crop',
  'cross', 'crouch', 'crowd', 'crucial', 'cruel', 'cruise', 'crumble', 'crunch',
  'crush', 'cry', 'crystal', 'cube', 'culture', 'cup', 'cupboard', 'curious',
  'current', 'curtain', 'curve', 'cushion', 'custom', 'cute', 'cycle', 'dad',
  'damage', 'damp', 'dance', 'danger', 'daring', 'dash', 'daughter', 'dawn',
  'day', 'deal', 'debate', 'debris', 'decade', 'december', 'decide', 'decline',
  'decorate', 'decrease', 'deer', 'defense', 'define', 'defy', 'degree', 'delay',
  'deliver', 'demand', 'demise', 'denial', 'dentist', 'deny', 'depart', 'depend',
  'deposit', 'depth', 'deputy', 'derive', 'describe', 'desert', 'design', 'desk',
  'despair', 'destroy', 'detail', 'detect', 'develop', 'device', 'devote', 'diagram',
  'dial', 'diamond', 'diary', 'dice', 'diesel', 'diet', 'differ', 'digital',
  'dignity', 'dilemma', 'dinner', 'dinosaur', 'direct', 'dirt', 'disagree', 'discover',
  'disease', 'dish', 'dismiss', 'disorder', 'display', 'distance', 'divert', 'divide',
  'divorce', 'dizzy', 'doctor', 'document', 'dog', 'doll', 'dolphin', 'domain',
  'donate', 'donkey', 'donor', 'door', 'dose', 'double', 'dove', 'draft',
  'dragon', 'drama', 'drastic', 'draw', 'dream', 'dress', 'drift', 'drill',
  'drink', 'drip', 'drive', 'drop', 'drum', 'dry', 'duck', 'dumb',
  'dune', 'during', 'dust', 'dutch', 'duty', 'dwarf', 'dynamic', 'eager',
  'eagle', 'early', 'earn', 'earth', 'easily', 'east', 'easy', 'echo',
  'ecology', 'economy', 'edge', 'edit', 'educate', 'effort', 'egg', 'eight',
  'either', 'elbow', 'elder', 'electric', 'elegant', 'element', 'elephant', 'elevator',
  'elite', 'else', 'embark', 'embody', 'embrace', 'emerge', 'emotion', 'employ',
  'empower', 'empty', 'enable', 'enact', 'end', 'endless', 'endorse', 'enemy',
  'energy', 'enforce', 'engage', 'engine', 'enhance', 'enjoy', 'enlist', 'enough',
  'enrich', 'enroll', 'ensure', 'enter', 'entire', 'entry', 'envelope', 'episode',
  'equal', 'equip', 'era', 'erase', 'erode', 'erosion', 'error', 'erupt',
  'escape', 'essay', 'essence', 'estate', 'eternal', 'ethics', 'evidence', 'evil',
  'evoke', 'evolve', 'exact', 'example', 'excess', 'exchange', 'excite', 'exclude',
  'excuse', 'execute', 'exercise', 'exhaust', 'exhibit', 'exile', 'exist', 'exit',
  'exotic', 'expand', 'expect', 'expire', 'explain', 'expose', 'express', 'extend',
  'extra', 'eye', 'eyebrow', 'fabric', 'face', 'faculty', 'fade', 'faint',
  'faith', 'fall', 'false', 'fame', 'family', 'famous', 'fan', 'fancy',
  'fantasy', 'farm', 'fashion', 'fat', 'fatal', 'father', 'fatigue', 'fault',
  'favorite', 'feature', 'february', 'federal', 'fee', 'feed', 'feel', 'female',
  'fence', 'festival', 'fetch', 'fever', 'few', 'fiber', 'fiction', 'field',
  'figure', 'file', 'film', 'filter', 'final', 'find', 'fine', 'finger',
  'finish', 'fire', 'firm', 'first', 'fiscal', 'fish', 'fit', 'fitness',
  'fix', 'flag', 'flame', 'flash', 'flat', 'flavor', 'flee', 'flight',
  'flip', 'float', 'flock', 'floor', 'flower', 'fluid', 'flush', 'fly',
  'foam', 'focus', 'fog', 'foil', 'fold', 'follow', 'food', 'foot',
  'force', 'forest', 'forget', 'fork', 'fortune', 'forum', 'forward', 'fossil',
  'foster', 'found', 'fox', 'fragile', 'frame', 'frequent', 'fresh', 'friend',
  'fringe', 'frog', 'front', 'frost', 'frown', 'frozen', 'fruit', 'fuel',
  'fun', 'funny', 'furnace', 'fury', 'future', 'gadget', 'gain', 'galaxy',
  'gallery', 'game', 'gap', 'garage', 'garbage', 'garden', 'garlic', 'garment',
  'gas', 'gasp', 'gate', 'gather', 'gauge', 'gaze', 'general', 'genius',
  'genre', 'gentle', 'genuine', 'gesture', 'ghost', 'giant', 'gift', 'giggle',
  'ginger', 'giraffe', 'girl', 'give', 'glad', 'glance', 'glare', 'glass',
  'glide', 'glimpse', 'globe', 'gloom', 'glory', 'glove', 'glow', 'glue',
  'goat', 'goddess', 'gold', 'good', 'goose', 'gorilla', 'gospel', 'gossip',
  'govern', 'gown', 'grab', 'grace', 'grain', 'grant', 'grape', 'grass',
  'gravity', 'great', 'green', 'grid', 'grief', 'grit', 'grocery', 'group',
  'grow', 'grunt', 'guard', 'guess', 'guide', 'guilt', 'guitar', 'gun',
  'gym', 'habit', 'hair', 'half', 'hammer', 'hamster', 'hand', 'happy',
  'harbor', 'hard', 'harsh', 'harvest', 'hat', 'have', 'hawk', 'hazard',
  'head', 'health', 'heart', 'heavy', 'hedgehog', 'height', 'hello', 'helmet',
  'help', 'hen', 'hero', 'hidden', 'high', 'hill', 'hint', 'hip',
  'hire', 'history', 'hobby', 'hockey', 'hold', 'hole', 'holiday', 'hollow',
  'home', 'honey', 'hood', 'hope', 'horn', 'horror', 'horse', 'hospital',
  'host', 'hotel', 'hour', 'hover', 'hub', 'huge', 'human', 'humble',
  'humor', 'hundred', 'hungry', 'hunt', 'hurdle', 'hurry', 'hurt', 'husband',
  'hybrid', 'ice', 'icon', 'idea', 'identify', 'idle', 'ignore', 'ill',
  'illegal', 'illness', 'image', 'imitate', 'immense', 'immune', 'impact', 'impose',
  'improve', 'impulse', 'inch', 'include', 'income', 'increase', 'index', 'indicate',
  'indoor', 'industry', 'infant', 'inflict', 'inform', 'inhale', 'inherit', 'initial',
  'inject', 'injury', 'inmate', 'inner', 'innocent', 'input', 'inquiry', 'insane',
  'insect', 'inside', 'inspire', 'install', 'intact', 'interest', 'into', 'invest',
  'invite', 'involve', 'iron', 'island', 'isolate', 'issue', 'item', 'ivory',
  'jacket', 'jaguar', 'jar', 'jazz', 'jealous', 'jeans', 'jelly', 'jewel',
  'job', 'join', 'joke', 'journey', 'joy', 'judge', 'juice', 'jump',
  'jungle', 'junior', 'junk', 'just', 'kangaroo', 'keen', 'keep', 'ketchup',
  'key', 'kick', 'kid', 'kidney', 'kind', 'kingdom', 'kiss', 'kit',
  'kitchen', 'kite', 'kitten', 'kiwi', 'knee', 'knife', 'knock', 'know',
  'lab', 'label', 'labor', 'ladder', 'lady', 'lake', 'lamp', 'language',
  'laptop', 'large', 'later', 'latin', 'laugh', 'laundry', 'lava', 'law',
  'lawn', 'lawsuit', 'layer', 'lazy', 'leader', 'leaf', 'learn', 'leave',
  'lecture', 'left', 'leg', 'legal', 'legend', 'leisure', 'lemon', 'lend',
  'length', 'lens', 'leopard', 'lesson', 'letter', 'level', 'liar', 'liberty',
  'library', 'license', 'life', 'lift', 'light', 'like', 'limb', 'limit',
  'link', 'lion', 'liquid', 'list', 'little', 'live', 'lizard', 'load',
  'loan', 'lobster', 'local', 'lock', 'logic', 'lonely', 'long', 'loop',
  'lottery', 'loud', 'lounge', 'love', 'loyal', 'lucky', 'luggage', 'lumber',
  'lunar', 'lunch', 'luxury', 'lyrics', 'machine', 'mad', 'magic', 'magnet',
  'maid', 'mail', 'main', 'major', 'make', 'mammal', 'man', 'manage',
  'mandate', 'mango', 'mansion', 'manual', 'maple', 'marble', 'march', 'margin',
  'marine', 'market', 'marriage', 'mask', 'mass', 'master', 'match', 'material',
  'math', 'matrix', 'matter', 'maximum', 'maze', 'meadow', 'mean', 'measure',
  'meat', 'mechanic', 'medal', 'media', 'melody', 'melt', 'member', 'memory',
  'mention', 'menu', 'mercy', 'merge', 'merit', 'merry', 'mesh', 'message',
  'metal', 'method', 'middle', 'midnight', 'milk', 'million', 'mimic', 'mind',
  'minimum', 'minor', 'minute', 'miracle', 'mirror', 'misery', 'miss', 'mistake',
  'mix', 'mixed', 'mixture', 'mobile', 'model', 'modify', 'mom', 'moment',
  'monitor', 'monkey', 'monster', 'month', 'moon', 'moral', 'more', 'morning',
  'mosquito', 'mother', 'motion', 'motor', 'mountain', 'mouse', 'move', 'movie',
  'much', 'muffin', 'mule', 'multiply', 'muscle', 'museum', 'mushroom', 'music',
  'must', 'mutual', 'myself', 'mystery', 'myth', 'naive', 'name', 'napkin',
  'narrow', 'nasty', 'nation', 'nature', 'near', 'neck', 'need', 'negative',
  'neglect', 'neither', 'nephew', 'nerve', 'nest', 'net', 'network', 'neutral',
  'never', 'news', 'next', 'nice', 'night', 'noble', 'noise', 'nominee',
  'noodle', 'normal', 'north', 'nose', 'notable', 'note', 'nothing', 'notice',
  'novel', 'now', 'nuclear', 'number', 'nurse', 'nut', 'oak', 'obey',
  'object', 'oblige', 'obscure', 'observe', 'obtain', 'obvious', 'occur', 'ocean',
  'october', 'odor', 'off', 'offer', 'office', 'often', 'oil', 'okay',
  'old', 'olive', 'olympic', 'omit', 'once', 'one', 'onion', 'online',
  'only', 'open', 'opera', 'opinion', 'oppose', 'option', 'orange', 'orbit',
  'orchard', 'order', 'ordinary', 'organ', 'orient', 'original', 'orphan', 'ostrich',
  'other', 'outdoor', 'outer', 'output', 'outside', 'oval', 'oven', 'over',
  'own', 'owner', 'oxygen', 'oyster', 'ozone', 'pact', 'paddle', 'page',
  'pair', 'palace', 'palm', 'panda', 'panel', 'panic', 'panther', 'paper',
  'parade', 'parent', 'park', 'parrot', 'party', 'pass', 'patch', 'path',
  'patient', 'patrol', 'pattern', 'pause', 'pave', 'payment', 'peace', 'peanut',
  'pear', 'peasant', 'pelican', 'pen', 'penalty', 'pencil', 'people', 'pepper',
  'perfect', 'permit', 'person', 'pet', 'phone', 'photo', 'phrase', 'physical',
  'piano', 'picnic', 'picture', 'piece', 'pig', 'pigeon', 'pill', 'pilot',
  'pink', 'pioneer', 'pipe', 'pistol', 'pitch', 'pizza', 'place', 'planet',
  'plastic', 'plate', 'play', 'please', 'pledge', 'pluck', 'plug', 'plunge',
  'poem', 'poet', 'point', 'polar', 'pole', 'police', 'pond', 'pony',
  'pool', 'popular', 'portion', 'position', 'possible', 'post', 'potato', 'pottery',
  'poverty', 'powder', 'power', 'practice', 'praise', 'predict', 'prefer', 'prepare',
  'present', 'pretty', 'prevent', 'price', 'pride', 'primary', 'print', 'priority',
  'prison', 'private', 'prize', 'problem', 'process', 'produce', 'profit', 'program',
  'project', 'promote', 'proof', 'property', 'prosper', 'protect', 'proud', 'provide',
  'public', 'pudding', 'pull', 'pulp', 'pulse', 'pumpkin', 'punch', 'pupil',
  'puppy', 'purchase', 'purity', 'purpose', 'purse', 'push', 'put', 'puzzle',
  'pyramid', 'quality', 'quantum', 'quarter', 'question', 'quick', 'quit', 'quiz',
  'quote', 'rabbit', 'raccoon', 'race', 'rack', 'radar', 'radio', 'rail',
  'rain', 'raise', 'rally', 'ramp', 'ranch', 'random', 'range', 'rapid',
  'rare', 'rate', 'rather', 'raven', 'raw', 'razor', 'ready', 'real',
  'reason', 'rebel', 'rebuild', 'recall', 'receive', 'recipe', 'record', 'recycle',
  'reduce', 'reflect', 'reform', 'refuse', 'region', 'regret', 'regular', 'reject',
  'relax', 'release', 'relief', 'rely', 'remain', 'remember', 'remind', 'remove',
  'render', 'renew', 'rent', 'reopen', 'repair', 'repeat', 'replace', 'report',
  'require', 'rescue', 'resemble', 'resist', 'resource', 'response', 'result', 'retire',
  'retreat', 'return', 'reunion', 'reveal', 'review', 'reward', 'rhythm', 'rib',
  'ribbon', 'rice', 'rich', 'ride', 'ridge', 'rifle', 'right', 'rigid',
  'ring', 'riot', 'ripple', 'risk', 'ritual', 'rival', 'river', 'road',
  'roast', 'robot', 'robust', 'rocket', 'romance', 'roof', 'rookie', 'room',
  'rose', 'rotate', 'rough', 'round', 'route', 'royal', 'rubber', 'rude',
  'rug', 'rule', 'run', 'runway', 'rural', 'sad', 'saddle', 'sadness',
  'safe', 'sail', 'salad', 'salmon', 'salon', 'salt', 'salute', 'same',
  'sample', 'sand', 'satisfy', 'satoshi', 'sauce', 'sausage', 'save', 'say',
  'scale', 'scan', 'scare', 'scatter', 'scene', 'scheme', 'school', 'science',
  'scissors', 'scorpion', 'scout', 'scrap', 'screen', 'script', 'scrub', 'sea',
  'search', 'season', 'seat', 'second', 'secret', 'section', 'security', 'seed',
  'seek', 'segment', 'select', 'sell', 'seminar', 'senior', 'sense', 'sentence',
  'series', 'service', 'session', 'settle', 'setup', 'seven', 'shadow', 'shaft',
  'shallow', 'share', 'shed', 'shell', 'sheriff', 'shield', 'shift', 'shine',
  'ship', 'shiver', 'shock', 'shoe', 'shoot', 'shop', 'short', 'shoulder',
  'shove', 'shrimp', 'shrug', 'shuffle', 'shy', 'sibling', 'sick', 'side',
  'siege', 'sight', 'sign', 'silent', 'silk', 'silly', 'silver', 'similar',
  'simple', 'since', 'sing', 'siren', 'sister', 'situate', 'six', 'size',
  'skate', 'sketch', 'ski', 'skill', 'skin', 'skirt', 'skull', 'slab',
  'slam', 'sleep', 'slender', 'slice', 'slide', 'slight', 'slim', 'slogan',
  'slot', 'slow', 'slush', 'small', 'smart', 'smile', 'smoke', 'smooth',
  'snack', 'snake', 'snap', 'sniff', 'snow', 'soap', 'soccer', 'social',
  'sock', 'soda', 'soft', 'solar', 'soldier', 'solid', 'solution', 'solve',
  'someone', 'song', 'soon', 'sorry', 'sort', 'soul', 'sound', 'soup',
  'source', 'south', 'space', 'spare', 'spatial', 'spawn', 'speak', 'special',
  'speed', 'spell', 'spend', 'sphere', 'spice', 'spider', 'spike', 'spin',
  'spirit', 'split', 'spoil', 'sponsor', 'spoon', 'sport', 'spot', 'spray',
  'spread', 'spring', 'spy', 'square', 'squeeze', 'squirrel', 'stable', 'stadium',
  'staff', 'stage', 'stairs', 'stamp', 'stand', 'start', 'state', 'stay',
  'steak', 'steel', 'stem', 'step', 'stereo', 'stick', 'still', 'sting',
  'stock', 'stomach', 'stone', 'stool', 'story', 'stove', 'strategy', 'street',
  'strike', 'strong', 'struggle', 'student', 'stuff', 'stumble', 'style', 'subject',
  'submit', 'subway', 'success', 'such', 'sudden', 'suffer', 'sugar', 'suggest',
  'suit', 'summer', 'sun', 'sunny', 'sunset', 'super', 'supply', 'supreme',
  'sure', 'surface', 'surge', 'surprise', 'surround', 'survey', 'suspect', 'sustain',
  'swallow', 'swamp', 'swap', 'swarm', 'swear', 'sweet', 'swift', 'swim',
  'swing', 'switch', 'sword', 'symbol', 'symptom', 'syrup', 'system', 'table',
  'tackle', 'tag', 'tail', 'talent', 'talk', 'tank', 'tape', 'target',
  'task', 'taste', 'tattoo', 'taxi', 'teach', 'team', 'tell', 'ten',
  'tenant', 'tennis', 'tent', 'term', 'test', 'text', 'thank', 'that',
  'theme', 'then', 'theory', 'there', 'they', 'thing', 'this', 'thought',
  'three', 'thrive', 'throw', 'thumb', 'thunder', 'ticket', 'tide', 'tiger',
  'tilt', 'timber', 'time', 'tiny', 'tip', 'tired', 'tissue', 'title',
  'toast', 'tobacco', 'today', 'toddler', 'toe', 'together', 'toilet', 'token',
  'tomato', 'tomorrow', 'tone', 'tongue', 'tonight', 'tool', 'tooth', 'top',
  'topic', 'topple', 'torch', 'tornado', 'tortoise', 'toss', 'total', 'tourist',
  'toward', 'tower', 'town', 'toy', 'track', 'trade', 'traffic', 'tragic',
  'train', 'transfer', 'trap', 'trash', 'travel', 'tray', 'treat', 'tree',
  'trend', 'trial', 'tribe', 'trick', 'trigger', 'trim', 'trip', 'trophy',
  'trouble', 'truck', 'true', 'truly', 'trumpet', 'trust', 'truth', 'try',
  'tube', 'tuition', 'tumble', 'tuna', 'tunnel', 'turkey', 'turn', 'turtle',
  'twelve', 'twenty', 'twice', 'twin', 'twist', 'two', 'type', 'typical',
  'ugly', 'umbrella', 'unable', 'unaware', 'uncle', 'uncover', 'under', 'undo',
  'unfair', 'unfold', 'unhappy', 'uniform', 'unique', 'unit', 'universe', 'unknown',
  'unlock', 'until', 'unusual', 'unveil', 'update', 'upgrade', 'uphold', 'upon',
  'upper', 'upset', 'urban', 'urge', 'usage', 'use', 'used', 'useful',
  'useless', 'usual', 'utility', 'vacant', 'vacuum', 'vague', 'valid', 'valley',
  'valve', 'van', 'vanish', 'vapor', 'various', 'vast', 'vault', 'vehicle',
  'velvet', 'vendor', 'venture', 'venue', 'verb', 'verify', 'version', 'very',
  'vessel', 'veteran', 'viable', 'vibrant', 'vicious', 'victory', 'video', 'view',
  'village', 'vintage', 'violin', 'virtual', 'virus', 'visa', 'visit', 'visual',
  'vital', 'vivid', 'vocal', 'voice', 'void', 'volcano', 'volume', 'vote',
  'voyage', 'wage', 'wagon', 'wait', 'walk', 'wall', 'walnut', 'want',
  'warfare', 'warm', 'warrior', 'wash', 'wasp', 'waste', 'water', 'wave',
  'way', 'wealth', 'weapon', 'wear', 'weasel', 'weather', 'web', 'wedding',
  'weekend', 'weird', 'welcome', 'west', 'wet', 'whale', 'what', 'wheat',
  'wheel', 'when', 'where', 'whip', 'whisper', 'wide', 'width', 'wife',
  'wild', 'will', 'win', 'window', 'wine', 'wing', 'wink', 'winner',
  'winter', 'wire', 'wisdom', 'wise', 'wish', 'witness', 'wolf', 'woman',
  'wonder', 'wood', 'wool', 'word', 'work', 'world', 'worry', 'worth',
  'wrap', 'wreck', 'wrestle', 'wrist', 'write', 'wrong', 'yard', 'year',
  'yellow', 'you', 'young', 'youth', 'zebra', 'zero', 'zone', 'zoo'
]

export interface RecoveryKeyData {
  mnemonic: string[] // 12 or 24 words
  version: number
  createdAt: number
}

export interface DerivedKeys {
  encryptionKey: CryptoKey // For encrypting local data
  backupKey: CryptoKey // For encrypting server backups
  signingKey: CryptoKey // For signing cross-device auth
}

/**
 * Recovery Key Service
 * Handles generation and management of the user's recovery key
 */
export class RecoveryKeyService {
  private static instance: RecoveryKeyService
  private derivedKeys: DerivedKeys | null = null
  private mnemonic: string[] | null = null

  private constructor() {}

  static getInstance(): RecoveryKeyService {
    if (!RecoveryKeyService.instance) {
      RecoveryKeyService.instance = new RecoveryKeyService()
    }
    return RecoveryKeyService.instance
  }


  /**
   * Generate a new 12-word recovery mnemonic.
   *
   * Standards-compliant: entropy → bit string → append SHA-256(entropy)
   * checksum (4 bits for 128-bit entropy, 8 bits for 256-bit entropy) →
   * 11-bit windows → wordlist indices. This matches BIP39 so phrases are
   * interoperable with standard wallets and can be validated cryptographically.
   *
   * NOTE: Key derivation from the mnemonic itself is unchanged (still
   * `mnemonic.join(' ')` → PBKDF2-SHA512 → HKDF). Existing recovery keys
   * remain usable, but newly-generated phrases now carry a real checksum.
   */
  async generateMnemonic(wordCount: 12 | 24 = 12): Promise<string[]> {
    const entropyBytes = wordCount === 12 ? 16 : 32
    const entropy = crypto.getRandomValues(new Uint8Array(entropyBytes))

    return this.encodeBip39Words(entropy, wordCount)
  }

  /**
   * Sync wrapper for callers that haven't migrated to the async signature.
   * Falls back to the previous (non-checksum) implementation to preserve
   * backwards behavior; the async path above should be preferred.
   *
   * @deprecated Use `generateMnemonic()` (now async) for a real BIP39 checksum.
   */
  generateMnemonicSync(wordCount: 12 | 24 = 12): string[] {
    const entropyBytes = wordCount === 12 ? 16 : 32
    const entropy = crypto.getRandomValues(new Uint8Array(entropyBytes))
    const bitString = Array.from(entropy)
      .map(byte => byte.toString(2).padStart(8, '0'))
      .join('')
    const checksumBits = entropy[0]
      .toString(2)
      .padStart(8, '0')
      .slice(0, wordCount === 12 ? 4 : 8)
    const fullBitString = bitString + checksumBits
    const words: string[] = []
    for (let i = 0; i < wordCount; i++) {
      const bits = fullBitString.slice(i * 11, (i + 1) * 11)
      const index = parseInt(bits, 2) % WORDLIST.length
      words.push(WORDLIST[index])
    }
    return words
  }

  /**
   * Encode entropy bytes as a BIP39 mnemonic with proper SHA-256 checksum.
   */
  private async encodeBip39Words(entropy: Uint8Array, wordCount: 12 | 24): Promise<string[]> {
    const checksumBitsCount = wordCount === 12 ? 4 : 8 // ENT/32

    // SHA-256 over entropy → take first N bits as checksum.
    const hashBuffer = await crypto.subtle.digest('SHA-256', entropy)
    const hashBytes = new Uint8Array(hashBuffer)
    const checksumByte = hashBytes[0]
    const checksumBits = checksumByte
      .toString(2)
      .padStart(8, '0')
      .slice(0, checksumBitsCount)

    const bitString = Array.from(entropy)
      .map(byte => byte.toString(2).padStart(8, '0'))
      .join('')
    const fullBitString = bitString + checksumBits

    const words: string[] = []
    for (let i = 0; i < wordCount; i++) {
      const bits = fullBitString.slice(i * 11, (i + 1) * 11)
      const index = parseInt(bits, 2)
      if (index < 0 || index >= WORDLIST.length) {
        throw new Error('Internal mnemonic encoding error (index out of range)')
      }
      words.push(WORDLIST[index])
    }
    return words
  }

  /**
   * Validate a mnemonic phrase.
   *
   * `strict` (default `false`) only checks word count + wordlist membership,
   * so phrases generated by the old (non-checksum) generator still validate.
   * `strict: true` additionally verifies the BIP39 SHA-256 checksum.
   */
  validateMnemonic(words: string[], strict = false): boolean {
    if (words.length !== 12 && words.length !== 24) {
      return false
    }

    // Check all words are in wordlist
    for (const word of words) {
      if (!WORDLIST.includes(word.toLowerCase())) {
        return false
      }
    }

    if (!strict) return true

    // Strict mode: verify BIP39 SHA-256 checksum. Cannot be async here, so
    // callers wanting strict validation should call validateMnemonicStrict()
    // below. We return false here to err on the side of caution.
    return false
  }

  /**
   * Strict BIP39 checksum validation. Async because WebCrypto SHA-256 is async.
   */
  async validateMnemonicStrict(words: string[]): Promise<boolean> {
    if (words.length !== 12 && words.length !== 24) return false

    const normalized = words.map(w => w.toLowerCase())
    const indices: number[] = []
    for (const word of normalized) {
      const idx = WORDLIST.indexOf(word)
      if (idx === -1) return false
      indices.push(idx)
    }

    const totalBits = words.length * 11
    const checksumBitsCount = words.length === 12 ? 4 : 8
    const entropyBitsCount = totalBits - checksumBitsCount

    const bitString = indices.map(i => i.toString(2).padStart(11, '0')).join('')
    const entropyBits = bitString.slice(0, entropyBitsCount)
    const checksumBits = bitString.slice(entropyBitsCount)

    // Bytes from entropyBits
    const entropy = new Uint8Array(entropyBitsCount / 8)
    for (let i = 0; i < entropy.length; i++) {
      entropy[i] = parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2)
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', entropy)
    const hashBytes = new Uint8Array(hashBuffer)
    const expectedChecksumBits = hashBytes[0]
      .toString(2)
      .padStart(8, '0')
      .slice(0, checksumBitsCount)

    return expectedChecksumBits === checksumBits
  }

  /**
   * Format mnemonic for display (groups of 4 words)
   */
  formatMnemonicForDisplay(words: string[]): string {
    const groups: string[] = []
    for (let i = 0; i < words.length; i += 4) {
      groups.push(words.slice(i, i + 4).join(' '))
    }
    return groups.join('\n')
  }

  /**
   * Parse mnemonic from user input
   */
  parseMnemonicInput(input: string): string[] {
    return input
      .toLowerCase()
      .replace(/[^a-z\s]/g, '') // Remove non-letters
      .split(/\s+/)
      .filter(word => word.length > 0)
  }


  /**
   * Derive encryption keys from mnemonic
   * Uses HKDF to derive multiple keys for different purposes
   */
  async deriveKeysFromMnemonic(words: string[]): Promise<DerivedKeys> {
    // LOOSE validation (word-count + wordlist membership), NOT strict BIP39
    // checksum: derivation must stay backwards-compatible with phrases from older
    // clients (legacy sync generator produced no SHA-256 checksum), and any
    // wordlist-valid phrase is treated as derivable. Strict checksum is surfaced as
    // a non-blocking typo hint in the recovery UI, never a rejection.
    if (!this.validateMnemonic(words)) {
      throw new Error('Invalid mnemonic phrase')
    }

    this.mnemonic = words

    const mnemonicString = words.join(' ')
    const encoder = new TextEncoder()
    const seedData = encoder.encode(mnemonicString)

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      seedData,
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    )

    // Fixed salt for deterministic key derivation
    const salt = encoder.encode('harmony-e2ee-recovery-v1')

    // Derive master secret (512 bits)
    const masterBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-512'
      },
      keyMaterial,
      512
    )

    const masterKey = await crypto.subtle.importKey(
      'raw',
      masterBits,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    )

    // Derive individual keys using HKDF
    const encryptionKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: encoder.encode('harmony-encryption-key')
      },
      masterKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )

    const backupKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: encoder.encode('harmony-backup-key')
      },
      masterKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )

    const signingKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: encoder.encode('harmony-signing-key')
      },
      masterKey,
      { name: 'AES-GCM', length: 256 },
      false, // Don't need to export signing key
      ['encrypt', 'decrypt']
    )

    this.derivedKeys = {
      encryptionKey,
      backupKey,
      signingKey
    }

    return this.derivedKeys
  }

  /**
   * Get the encryption key (for local data encryption)
   */
  getEncryptionKey(): CryptoKey | null {
    return this.derivedKeys?.encryptionKey || null
  }

  /**
   * Get the backup key (for server backup encryption)
   */
  getBackupKey(): CryptoKey | null {
    return this.derivedKeys?.backupKey || null
  }

  /**
   * Check if recovery key is loaded
   */
  isLoaded(): boolean {
    return this.derivedKeys !== null
  }

  /**
   * Set pre-derived keys directly (for auto-unlock from IndexedDB).
   * The mnemonic is intentionally NOT stored - only CryptoKey objects.
   */
  setDerivedKeys(keys: DerivedKeys): void {
    this.derivedKeys = keys
    this.mnemonic = null
  }

  /**
   * Clear derived keys from memory
   */
  clear(): void {
    this.derivedKeys = null
    this.mnemonic = null
  }


  /**
   * Encrypt data with the backup key (for server storage)
   */
  async encryptForBackup(data: string): Promise<string> {
    if (!this.derivedKeys?.backupKey) {
      throw new Error('Recovery key not loaded')
    }

    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(data)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.derivedKeys.backupKey,
      dataBytes
    )

    // Combine IV + ciphertext
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return this.arrayBufferToBase64(combined.buffer)
  }

  /**
   * Decrypt data with the backup key (from server storage)
   */
  async decryptFromBackup(encryptedData: string): Promise<string> {
    if (!this.derivedKeys?.backupKey) {
      throw new Error('Recovery key not loaded')
    }

    const combined = this.base64ToArrayBuffer(encryptedData)
    const combinedArray = new Uint8Array(combined)
    const iv = combinedArray.slice(0, 12)
    const ciphertext = combinedArray.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.derivedKeys.backupKey,
      ciphertext
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  }


  /**
   * Generate data for QR code (for cross-device sharing)
   * Returns a compact representation of the mnemonic
   */
  generateQRData(): string | null {
    if (!this.mnemonic) return null

    const data = {
      v: 1, // version
      m: this.mnemonic.join(' '),
      t: Date.now()
    }

    return btoa(JSON.stringify(data))
  }

  /**
   * Parse QR code data
   */
  parseQRData(qrData: string): string[] | null {
    try {
      const decoded = JSON.parse(atob(qrData))
      if (decoded.v !== 1) {
        debug.error('Unknown QR version:', decoded.v)
        return null
      }

      const words = decoded.m.split(' ')
      if (!this.validateMnemonic(words)) {
        return null
      }

      return words
    } catch (error) {
      debug.error('Failed to parse QR data:', error)
      return null
    }
  }


  /**
   * Generate a verification code from the mnemonic
   * Used to verify user has correctly written down the phrase
   */
  async generateVerificationCode(): Promise<string> {
    if (!this.mnemonic) {
      throw new Error('No mnemonic loaded')
    }

    const encoder = new TextEncoder()
    const data = encoder.encode(this.mnemonic.join(' '))
    const hash = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hash))
    
    // Return first 6 characters of hex hash as verification code
    return hashArray.slice(0, 3)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }

  /**
   * Verify a recovery phrase against expected verification code
   */
  async verifyRecoveryPhrase(words: string[], expectedCode: string): Promise<boolean> {
    const encoder = new TextEncoder()
    const data = encoder.encode(words.join(' '))
    const hash = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hash))
    
    const code = hashArray.slice(0, 3)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()

    return code === expectedCode.toUpperCase()
  }


  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }
}

export const recoveryKeyService = RecoveryKeyService.getInstance()

