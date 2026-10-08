/**
 * Mic and deafen in the minimized voice panel duplicate those of the desktop
 * user panel (BaseLayout, bottom-left). At its default position the minimized
 * panel sits directly above the user panel, so the pair is hidden there.
 */
export interface MinimizedPanelPlacement {
  /** Minimized panel at DEFAULT_POSITION, above the user panel. */
  atDefaultPosition: boolean;
  /** Mobile viewport: BaseLayout renders no desktop user panel. */
  mobile: boolean;
  /** User panel collapsed into the server rail as the avatar alone. */
  userPanelDocked: boolean;
}

export const showsMinimizedAudioControls = (p: MinimizedPanelPlacement): boolean =>
  !p.atDefaultPosition || p.mobile || p.userPanelDocked;
