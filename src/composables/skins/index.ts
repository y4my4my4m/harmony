/**
 * Skins registry.
 *
 * Add a new skin by:
 *   1. Creating `./<skin-id>/skin.css` and `./<skin-id>/index.ts` (clone an
 *      existing folder).
 *   2. Importing the skin object and pushing it into the array below.
 *
 * No TypeScript branches anywhere — the registry is a plain array, the
 * picker UI iterates it, and `applySkin(id)` looks up by id. Skin-specific
 * CSS is scoped under `[data-skin="..."]` selectors so the file structure
 * stays clean even as more skins land.
 */
import type { Skin } from './types'
import { sdr001Skin } from './sdr-001'

export type { Skin, SkinOption } from './types'

export const BUILTIN_SKINS: Skin[] = [sdr001Skin]
