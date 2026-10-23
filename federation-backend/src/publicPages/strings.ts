/**
 * Text of the public profile and post pages, in the SPA's seven languages. The page language
 * is the first Accept-Language tag naming one of them, English otherwise.
 *
 * `{name}` placeholders take HTML from the caller (fillHtml); the templates themselves are
 * escaped there.
 */

import { escapeHtml } from '../utils/html.js';

export const PAGE_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh'] as const;
export type PageLocale = (typeof PAGE_LOCALES)[number];

export interface PageStrings {
  signIn: string;
  createAccount: string;
  joinTitle: string;
  joinText: string;
  posts: string;
  followers: string;
  following: string;
  pinned: string;
  joined: string;
  locked: string;
  noPosts: string;
  olderPosts: string;
  newestPosts: string;
  showMore: string;
  showLess: string;
  sensitive: string;
  unlisted: string;
  edited: string;
  replyingTo: string;
  replies: string;
  boosts: string;
  favourites: string;
  pollPeople: string;
  pollClosed: string;
  pollEnds: string;
  movedTo: string;
  notFoundTitle: string;
  notFoundText: string;
  unavailableTitle: string;
  unavailableText: string;
  backHome: string;
  poweredBy: string;
  moreFrom: string;
  postBy: string;
  profileOn: string;
}

const en: PageStrings = {
  signIn: 'Sign in',
  createAccount: 'Create account',
  joinTitle: 'Join {instance}',
  joinText: 'Follow {name}, reply and react with an account on {instance} or on any server of the fediverse.',
  posts: 'Posts',
  followers: 'Followers',
  following: 'Following',
  pinned: 'Pinned',
  joined: 'Joined {date}',
  locked: 'Approves followers',
  noPosts: 'No public posts yet.',
  olderPosts: 'Older posts',
  newestPosts: 'Newest posts',
  showMore: 'Show more',
  showLess: 'Show less',
  sensitive: 'Sensitive media',
  unlisted: 'Unlisted',
  edited: 'Edited',
  replyingTo: 'Replying to {handle}',
  replies: 'Replies',
  boosts: 'Boosts',
  favourites: 'Favourites',
  pollPeople: '{count} people',
  pollClosed: 'Closed',
  pollEnds: 'Ends {date}',
  movedTo: 'This account has moved to {account}.',
  notFoundTitle: 'Nothing here',
  notFoundText: "This profile or post doesn't exist or isn't public.",
  unavailableTitle: 'Temporarily unavailable',
  unavailableText: 'This page could not be loaded. Try again in a moment.',
  backHome: 'Go to {instance}',
  poweredBy: 'Powered by {harmony}',
  moreFrom: 'More from {name}',
  postBy: 'Post by {name}',
  profileOn: '{name} on {instance}',
};

const de: PageStrings = {
  signIn: 'Anmelden',
  createAccount: 'Konto erstellen',
  joinTitle: '{instance} beitreten',
  joinText: 'Folge {name}, antworte und reagiere mit einem Konto auf {instance} oder auf einem beliebigen Server im Fediverse.',
  posts: 'Beiträge',
  followers: 'Follower',
  following: 'Folge ich',
  pinned: 'Angeheftet',
  joined: 'Dabei seit {date}',
  locked: 'Prüft Folgeanfragen',
  noPosts: 'Noch keine öffentlichen Beiträge.',
  olderPosts: 'Ältere Beiträge',
  newestPosts: 'Neueste Beiträge',
  showMore: 'Mehr anzeigen',
  showLess: 'Weniger anzeigen',
  sensitive: 'Sensible Medien',
  unlisted: 'Nicht gelistet',
  edited: 'Bearbeitet',
  replyingTo: 'Antwort an {handle}',
  replies: 'Antworten',
  boosts: 'Geteilt',
  favourites: 'Favoriten',
  pollPeople: '{count} Personen',
  pollClosed: 'Beendet',
  pollEnds: 'Endet am {date}',
  movedTo: 'Dieses Konto ist umgezogen zu {account}.',
  notFoundTitle: 'Nichts gefunden',
  notFoundText: 'Dieses Profil oder dieser Beitrag existiert nicht oder ist nicht öffentlich.',
  unavailableTitle: 'Vorübergehend nicht verfügbar',
  unavailableText: 'Diese Seite konnte nicht geladen werden. Versuche es gleich noch einmal.',
  backHome: 'Zu {instance}',
  poweredBy: 'Läuft mit {harmony}',
  moreFrom: 'Mehr von {name}',
  postBy: 'Beitrag von {name}',
  profileOn: '{name} auf {instance}',
};

const es: PageStrings = {
  signIn: 'Iniciar sesión',
  createAccount: 'Crear cuenta',
  joinTitle: 'Únete a {instance}',
  joinText: 'Sigue a {name}, responde y reacciona con una cuenta en {instance} o en cualquier servidor del fediverso.',
  posts: 'Publicaciones',
  followers: 'Seguidores',
  following: 'Siguiendo',
  pinned: 'Fijado',
  joined: 'Se unió el {date}',
  locked: 'Revisa las solicitudes de seguimiento',
  noPosts: 'Aún no hay publicaciones públicas.',
  olderPosts: 'Publicaciones anteriores',
  newestPosts: 'Publicaciones más recientes',
  showMore: 'Mostrar más',
  showLess: 'Mostrar menos',
  sensitive: 'Contenido multimedia sensible',
  unlisted: 'No listado',
  edited: 'Editado',
  replyingTo: 'En respuesta a {handle}',
  replies: 'Respuestas',
  boosts: 'Impulsos',
  favourites: 'Favoritos',
  pollPeople: '{count} personas',
  pollClosed: 'Cerrada',
  pollEnds: 'Termina el {date}',
  movedTo: 'Esta cuenta se ha mudado a {account}.',
  notFoundTitle: 'No hay nada aquí',
  notFoundText: 'Este perfil o publicación no existe o no es público.',
  unavailableTitle: 'No disponible por ahora',
  unavailableText: 'No se pudo cargar esta página. Inténtalo de nuevo en un momento.',
  backHome: 'Ir a {instance}',
  poweredBy: 'Funciona con {harmony}',
  moreFrom: 'Más de {name}',
  postBy: 'Publicación de {name}',
  profileOn: '{name} en {instance}',
};

const fr: PageStrings = {
  signIn: 'Se connecter',
  createAccount: 'Créer un compte',
  joinTitle: 'Rejoindre {instance}',
  joinText: 'Suivez {name}, répondez et réagissez avec un compte sur {instance} ou sur n’importe quel serveur du fédivers.',
  posts: 'Publications',
  followers: 'Abonnés',
  following: 'Abonnements',
  pinned: 'Épinglé',
  joined: 'Ici depuis le {date}',
  locked: 'Approuve ses abonnés',
  noPosts: 'Aucune publication publique pour l’instant.',
  olderPosts: 'Publications plus anciennes',
  newestPosts: 'Publications les plus récentes',
  showMore: 'Afficher plus',
  showLess: 'Afficher moins',
  sensitive: 'Média sensible',
  unlisted: 'Non listé',
  edited: 'Modifié',
  replyingTo: 'En réponse à {handle}',
  replies: 'Réponses',
  boosts: 'Partages',
  favourites: 'Favoris',
  pollPeople: '{count} personnes',
  pollClosed: 'Terminé',
  pollEnds: 'Se termine le {date}',
  movedTo: 'Ce compte a déménagé vers {account}.',
  notFoundTitle: 'Rien ici',
  notFoundText: 'Ce profil ou cette publication n’existe pas ou n’est pas public.',
  unavailableTitle: 'Momentanément indisponible',
  unavailableText: 'Cette page n’a pas pu être chargée. Réessayez dans un instant.',
  backHome: 'Aller sur {instance}',
  poweredBy: 'Propulsé par {harmony}',
  moreFrom: 'Plus de {name}',
  postBy: 'Publication de {name}',
  profileOn: '{name} sur {instance}',
};

const ja: PageStrings = {
  signIn: 'ログイン',
  createAccount: 'アカウントを作成',
  joinTitle: '{instance}に参加',
  joinText: '{instance}またはフェディバースのどのサーバーのアカウントでも、{name}をフォローしたり、返信やリアクションをしたりできます。',
  posts: '投稿',
  followers: 'フォロワー',
  following: 'フォロー中',
  pinned: 'ピン留め',
  joined: '{date}から利用',
  locked: 'フォローを承認制にしています',
  noPosts: '公開投稿はまだありません。',
  olderPosts: '以前の投稿',
  newestPosts: '最新の投稿',
  showMore: 'もっと見る',
  showLess: '閉じる',
  sensitive: 'センシティブなメディア',
  unlisted: '未収載',
  edited: '編集済み',
  replyingTo: '{handle}への返信',
  replies: '返信',
  boosts: 'ブースト',
  favourites: 'お気に入り',
  pollPeople: '{count}人',
  pollClosed: '終了',
  pollEnds: '{date}に終了',
  movedTo: 'このアカウントは{account}に引っ越しました。',
  notFoundTitle: 'ページが見つかりません',
  notFoundText: 'このプロフィールまたは投稿は存在しないか、公開されていません。',
  unavailableTitle: '一時的に利用できません',
  unavailableText: 'このページを読み込めませんでした。しばらくしてからもう一度お試しください。',
  backHome: '{instance}へ',
  poweredBy: '{harmony}で稼働中',
  moreFrom: '{name}のその他の投稿',
  postBy: '{name}の投稿',
  profileOn: '{instance}の{name}',
};

const ko: PageStrings = {
  signIn: '로그인',
  createAccount: '계정 만들기',
  joinTitle: '{instance}에 가입하기',
  joinText: '{instance} 또는 페디버스의 어느 서버 계정으로든 {name} 님을 팔로우하고 답글과 반응을 남길 수 있습니다.',
  posts: '게시물',
  followers: '팔로워',
  following: '팔로잉',
  pinned: '고정됨',
  joined: '{date}에 가입',
  locked: '팔로우 요청을 승인함',
  noPosts: '아직 공개 게시물이 없습니다.',
  olderPosts: '이전 게시물',
  newestPosts: '최신 게시물',
  showMore: '더 보기',
  showLess: '접기',
  sensitive: '민감한 미디어',
  unlisted: '미등재',
  edited: '편집됨',
  replyingTo: '{handle} 님에게 답글',
  replies: '답글',
  boosts: '부스트',
  favourites: '좋아요',
  pollPeople: '{count}명',
  pollClosed: '종료됨',
  pollEnds: '{date}에 종료',
  movedTo: '이 계정은 {account}(으)로 이사했습니다.',
  notFoundTitle: '찾을 수 없습니다',
  notFoundText: '이 프로필이나 게시물은 존재하지 않거나 공개되어 있지 않습니다.',
  unavailableTitle: '일시적으로 사용할 수 없음',
  unavailableText: '이 페이지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  backHome: '{instance}(으)로 이동',
  poweredBy: '{harmony} 기반',
  moreFrom: '{name} 님의 다른 게시물',
  postBy: '{name} 님의 게시물',
  profileOn: '{instance}의 {name}',
};

const zh: PageStrings = {
  signIn: '登录',
  createAccount: '创建账号',
  joinTitle: '加入 {instance}',
  joinText: '使用 {instance} 或联邦宇宙中任意服务器的账号，即可关注 {name}、回复和回应。',
  posts: '帖子',
  followers: '关注者',
  following: '关注中',
  pinned: '已置顶',
  joined: '加入于 {date}',
  locked: '关注需经批准',
  noPosts: '还没有公开帖子。',
  olderPosts: '更早的帖子',
  newestPosts: '最新帖子',
  showMore: '显示更多',
  showLess: '收起',
  sensitive: '敏感媒体',
  unlisted: '未列出',
  edited: '已编辑',
  replyingTo: '回复 {handle}',
  replies: '回复',
  boosts: '转发',
  favourites: '喜欢',
  pollPeople: '{count} 人',
  pollClosed: '已结束',
  pollEnds: '{date} 结束',
  movedTo: '此账号已迁移至 {account}。',
  notFoundTitle: '这里什么都没有',
  notFoundText: '此个人资料或帖子不存在或未公开。',
  unavailableTitle: '暂时无法访问',
  unavailableText: '无法加载此页面，请稍后再试。',
  backHome: '前往 {instance}',
  poweredBy: '由 {harmony} 驱动',
  moreFrom: '{name} 的更多帖子',
  postBy: '{name} 的帖子',
  profileOn: '{instance} 上的 {name}',
};

export const PAGE_STRINGS: Record<PageLocale, PageStrings> = { en, de, es, fr, ja, ko, zh };

/** First Accept-Language tag naming a page locale, by q then order; 'en' otherwise. */
export function pickPageLocale(acceptLanguage: string | undefined | null): PageLocale {
  if (!acceptLanguage) return 'en';
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const primary = tag.split('-')[0] as PageLocale;
    if ((PAGE_LOCALES as readonly string[]).includes(primary)) return primary;
  }
  return 'en';
}

/** The template escaped, each `{key}` replaced by its HTML value. */
export function fillHtml(template: string, values: Record<string, string>): string {
  return template
    .split(/(\{[a-z]+\})/)
    .map((piece) => {
      const key = /^\{([a-z]+)\}$/.exec(piece)?.[1];
      return key !== undefined && key in values ? values[key] : escapeHtml(piece);
    })
    .join('');
}

/** The template with each `{key}` replaced by its plain-text value. */
export function fillText(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (match, key: string) => (key in values ? values[key] : match));
}
