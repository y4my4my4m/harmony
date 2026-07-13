// Dynamic positioning calculations for popups relative to trigger elements.
import { computed, ref, type Ref } from 'vue';
import { debug } from '@/utils/debug'

export type PopupPosition = 'above' | 'below' | 'left' | 'right' | 'auto';
export type PopupPositionKey = 'above' | 'below' | 'left' | 'right';

export interface PopupDimensions {
  width: number;
  height: number;
}

export interface PopupPositionResult {
  x: number;
  y: number;
  actualPosition: PopupPositionKey;
}

export interface UsePopupPositioningOptions {
  position?: PopupPosition;
  offset?: number;
  viewport?: {
    padding: number;
  };
  /**
   * Inline `z-index` written into the popup's positioning style. Defaults
   * to 1050. Override when the popup needs to sit above modals - e.g.
   * EmojiPopup opened from inside a modal teleports to body alongside the
   * modal overlay, so its scoped CSS z-index is overridden by this inline
   * value unless we bump it here too.
   */
  zIndex?: number;
  fallbackPositions?: PopupPositionKey[];
}

export function calculatePopupPosition(
  triggerElement: HTMLElement,
  popupDimensions: PopupDimensions,
  options: UsePopupPositioningOptions = {}
): PopupPositionResult {
  const {
    position = 'auto',
    offset = 8,
    viewport = { padding: 10 },
    fallbackPositions = ['above', 'below', 'right', 'left']
  } = options;

  if (!triggerElement || typeof triggerElement.getBoundingClientRect !== 'function') {
    debug.warn('Invalid trigger element provided to calculatePopupPosition');
    return {
      x: 0,
      y: 0,
      actualPosition: 'above'
    };
  }

  const triggerRect = triggerElement.getBoundingClientRect();
  const { width: popupWidth, height: popupHeight } = popupDimensions;
  
  const positions = {
    above: {
      x: triggerRect.left + (triggerRect.width / 2) - (popupWidth / 2),
      y: triggerRect.top - popupHeight - offset,
      actualPosition: 'above' as const
    },
    below: {
      x: triggerRect.left + (triggerRect.width / 2) - (popupWidth / 2),
      y: triggerRect.bottom + offset,
      actualPosition: 'below' as const
    },
    left: {
      x: triggerRect.left - popupWidth - offset,
      y: triggerRect.top + (triggerRect.height / 2) - (popupHeight / 2),
      actualPosition: 'left' as const
    },
    right: {
      x: triggerRect.right + offset,
      y: triggerRect.top + (triggerRect.height / 2) - (popupHeight / 2),
      actualPosition: 'right' as const
    }
  };

  const fitsInViewport = (pos: PopupPositionResult) => {
    return pos.x >= viewport.padding &&
           pos.y >= viewport.padding &&
           pos.x + popupWidth <= window.innerWidth - viewport.padding &&
           pos.y + popupHeight <= window.innerHeight - viewport.padding;
  };

  if (position !== 'auto' && positions[position] && fitsInViewport(positions[position])) {
    const result = positions[position];
    return {
      x: Math.max(viewport.padding, Math.min(result.x, window.innerWidth - popupWidth - viewport.padding)),
      y: Math.max(viewport.padding, Math.min(result.y, window.innerHeight - popupHeight - viewport.padding)),
      actualPosition: result.actualPosition
    };
  }

  const positionsToTry: PopupPositionKey[] = position === 'auto' ? fallbackPositions : [position as PopupPositionKey, ...fallbackPositions];

  for (const pos of positionsToTry) {
    if (positions[pos] && fitsInViewport(positions[pos])) {
      return positions[pos];
    }
  }

  const bestFit = positions.above;
  return {
    x: Math.max(viewport.padding, Math.min(bestFit.x, window.innerWidth - popupWidth - viewport.padding)),
    y: Math.max(viewport.padding, Math.min(bestFit.y, window.innerHeight - popupHeight - viewport.padding)),
    actualPosition: bestFit.actualPosition
  };
}

export function usePopupPositioning(
  triggerElement: Ref<HTMLElement | null>,
  popupDimensions: PopupDimensions,
  options: UsePopupPositioningOptions = {}
) {
  const positionResult = ref<PopupPositionResult | null>(null);

  const updatePosition = () => {
    if (!triggerElement.value) return;
    
    positionResult.value = calculatePopupPosition(
      triggerElement.value,
      popupDimensions,
      options
    );
  };

  const zIndex = options.zIndex ?? 1050;

  const positionStyle = computed(() => {
    if (!positionResult.value) {
      return {
        position: 'fixed' as const,
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex,
        visibility: 'hidden' as const
      };
    }

    return {
      position: 'fixed' as const,
      left: `${positionResult.value.x}px`,
      top: `${positionResult.value.y}px`,
      zIndex,
      visibility: 'visible' as const
    };
  });

  return {
    positionResult,
    positionStyle,
    updatePosition
  };
}
