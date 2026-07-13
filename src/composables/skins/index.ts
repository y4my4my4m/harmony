/**
 * Skins registry.
 *
 * Add a new skin by:
 *   1. Creating `./<skin-id>/skin.css` and `./<skin-id>/index.ts` (clone an
 *      existing folder).
 *   2. Importing the skin object and pushing it into the array below.
 *
 * Registry is a plain array; picker UI iterates it, `applySkin(id)` looks
 * up by id. Skin-specific CSS is scoped under `[data-skin="..."]`.
 */
import type { Skin } from './types'
import { sdr001Skin } from './sdr-001'

export type { Skin, SkinOption } from './types'

export const BUILTIN_SKINS: Skin[] = [sdr001Skin]
