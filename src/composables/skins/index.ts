/**
 * Skins registry.
 *
 * Add a new skin by:
 *   1. Creating `./<skin-id>/skin.css` and `./<skin-id>/index.ts` (clone an
 *      existing folder).
 *   2. Importing the skin object and pushing it into the array below.
 *
 * No TypeScript branches anywhere - the registry is a plain array, the
 * picker UI iterates it, and `applySkin(id)` looks up by id. Skin-specific
 * CSS is scoped under `[data-skin="..."]` selectors so the file structure
 * stays clean even as more skins land.
 *
 * Manifests are eager; stylesheets and scenes are not. `loadCss` and
 * `loadScene` are dynamic imports, so each is its own chunk, fetched the
 * first time its skin is active.
 *
 * Layout regions. Layout containers carry `data-region`, so a skin can
 * reorder (`order`, `flex-direction`), gap, float, resize or re-centre them
 * from CSS alone. A region cannot move to a different parent; that needs a
 * template change.
 *
 *   rail       server rail                        BaseLayout
 *   content    everything right of the rail       BaseLayout
 *   user       desktop user panel, absolute       BaseLayout
 *   context    context bar over the workspace     ChatLayout
 *   workspace  row: nav + main                    ChatLayout, SocialLayout
 *   nav        channel or social sidebar          ChatLayout, SocialLayout
 *   main       column: header + body              ChatLayout, SocialLayout
 *   header     channel header                     ChatLayout
 *   body       row: view + aside                  ChatLayout
 *   view       routed view                        ChatLayout, SocialLayout
 *   aside      member list or social sidebar      ChatLayout, SocialLayout
 *   messages   message scroller                   MessageDisplay
 *   composer   message input                      MessageInput
 *
 * Keep layout rules under `@media (min-width: 769px)`: below that, rail, nav
 * and aside are touch-driven drawers positioned by transform.
 */
import type { Skin } from './types'
import { sdr001Skin } from './sdr-001'
import { skyglassSkin } from './skyglass'
import { latticeSkin } from './lattice'
import { fluxSkin } from './flux'

export type { Skin, SkinOption, SkinScene, SkinSceneFactory } from './types'

export const BUILTIN_SKINS: Skin[] = [sdr001Skin, skyglassSkin, latticeSkin, fluxSkin]
