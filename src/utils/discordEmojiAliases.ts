/**
 * Discord shortcode names absent from gemoji (GitHub) and from the CLDR-derived
 * shortcodes in unicode-emoji-data.json. Discord's set derives from EmojiOne;
 * names it shares with gemoji resolve through the data file and are not listed.
 *
 * Country flags (`flag_us`) and `regional_indicator_x` are generated from the
 * regional indicator code points in `discordGeneratedAliases`.
 */
export const DISCORD_EMOJI_ALIASES: Readonly<Record<string, string>> = {
  slight_smile: '🙂',
  slight_frown: '🙁',
  frowning2: '☹️',
  upside_down: '🙃',
  hugging: '🤗',
  nerd: '🤓',
  cowboy: '🤠',
  clown: '🤡',
  smiling_face_with_3_hearts: '🥰',
  face_with_symbols_over_mouth: '🤬',
  head_bandage: '🤕',
  thermometer_face: '🤒',
  money_mouth: '🤑',
  zipper_mouth: '🤐',
  rolling_eyes: '🙄',
  skull_crossbones: '☠️',
  thumbup: '👍',
  thumbdown: '👎',
  call_me: '🤙',
  fingers_crossed: '🤞',
  hand_splayed: '🖐️',
  vulcan: '🖖',
  face_palm: '🤦',
  spy: '🕵️',
  levitate: '🕴️',
  speech_left: '🗨️',
  anger_right: '🗯️',
  first_place: '🥇',
  second_place: '🥈',
  third_place: '🥉',
  medal: '🏅',
  desktop: '🖥️',
  mouse_three_button: '🖱️',
  projector: '📽️',
  newspaper2: '🗞️',
  tools: '🛠️',
  hammer_pick: '⚒️',
  oil: '🛢️',
  urn: '⚱️',
  lion_face: '🦁',
  rhino: '🦏',
  wilted_rose: '🥀',
  champagne_glass: '🥂',
  fork_knife_plate: '🍽️',
  race_car: '🏎️',
  island: '🏝️',
  park: '🏞️',
  homes: '🏘️',
  house_abandoned: '🏚️',
  beach: '🏖️',
  white_sun_small_cloud: '🌤️',
  white_sun_cloud: '🌥️',
  white_sun_rain_cloud: '🌦️',
  cloud_rain: '🌧️',
  cloud_snow: '🌨️',
  cloud_lightning: '🌩️',
  cloud_tornado: '🌪️',
  thunder_cloud_rain: '⛈️',
  flag_white: '🏳️',
  flag_black: '🏴',
  gay_pride_flag: '🏳️‍🌈',
}

const REGIONAL_A = 0x1f1e6

/** `regional_indicator_a`..`_z` and `flag_xx` for every two-letter flag in `unicodes`. */
export function discordGeneratedAliases(unicodes: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < 26; i++) {
    out[`regional_indicator_${String.fromCharCode(97 + i)}`] = String.fromCodePoint(REGIONAL_A + i)
  }
  for (const u of unicodes) {
    const cps = Array.from(u, c => c.codePointAt(0)!)
    if (cps.length !== 2) continue
    const [a, b] = cps
    if (a < REGIONAL_A || a > REGIONAL_A + 25 || b < REGIONAL_A || b > REGIONAL_A + 25) continue
    out[`flag_${String.fromCharCode(97 + a - REGIONAL_A)}${String.fromCharCode(97 + b - REGIONAL_A)}`] = u
  }
  return out
}
