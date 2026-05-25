import { computed, type Ref } from 'vue';

/**
 * Adaptive grid layout composable for voice chat participants
 * Provides Discord-like grid sizing based on participant count
 */
export interface AdaptiveGridConfig {
  columns: number;
  minCardWidth: string;
  maxCardWidth: string;
  cardHeight: string;
  gap: string;
  gridClass: string;
}

export function useAdaptiveGrid(participantCount: Ref<number> | (() => number)) {
  const count = computed(() => {
    if (typeof participantCount === 'function') {
      return participantCount();
    }
    return participantCount.value;
  });

  /**
   * Get grid configuration based on participant count
   * Mimics Discord's adaptive layout behavior
   */
  const gridConfig = computed<AdaptiveGridConfig>(() => {
    const n = count.value;

    if (n <= 1) {
      // Single user - large centered card
      return {
        columns: 1,
        minCardWidth: '400px',
        maxCardWidth: '600px',
        cardHeight: '400px',
        gap: '16px',
        gridClass: 'grid-single'
      };
    }

    if (n === 2) {
      // 2 users - side by side, large cards
      return {
        columns: 2,
        minCardWidth: '320px',
        maxCardWidth: '1fr',
        cardHeight: '100vh',
        gap: '16px',
        gridClass: 'grid-duo'
      };
    }

    if (n <= 4) {
      // 3-4 users - 2x2 grid
      return {
        columns: 2,
        minCardWidth: '280px',
        maxCardWidth: '1fr',
        cardHeight: '280px',
        gap: '16px',
        gridClass: 'grid-quad'
      };
    }

    if (n <= 6) {
      // 5-6 users - 3x2 or 2x3 grid
      return {
        columns: 3,
        minCardWidth: '240px',
        maxCardWidth: '1fr',
        cardHeight: '240px',
        gap: '14px',
        gridClass: 'grid-six'
      };
    }

    if (n <= 9) {
      // 7-9 users - 3x3 grid
      return {
        columns: 3,
        minCardWidth: '200px',
        maxCardWidth: '1fr',
        cardHeight: '200px',
        gap: '12px',
        gridClass: 'grid-nine'
      };
    }

    if (n <= 16) {
      // 10-16 users - 4x4 grid
      return {
        columns: 4,
        minCardWidth: '180px',
        maxCardWidth: '1fr',
        cardHeight: '180px',
        gap: '10px',
        gridClass: 'grid-large'
      };
    }

    // 17+ users - 5 columns, scrollable
    return {
      columns: 5,
      minCardWidth: '160px',
      maxCardWidth: '1fr',
      cardHeight: '160px',
      gap: '8px',
      gridClass: 'grid-gallery'
    };
  });

  /**
   * CSS custom properties for the grid
   */
  const gridStyle = computed(() => ({
    '--grid-columns': gridConfig.value.columns,
    '--grid-min-width': gridConfig.value.minCardWidth,
    '--grid-max-width': gridConfig.value.maxCardWidth,
    '--grid-card-height': gridConfig.value.cardHeight,
    '--grid-gap': gridConfig.value.gap,
  }));

  /**
   * Grid CSS class for additional styling
   */
  const gridClass = computed(() => gridConfig.value.gridClass);

  /**
   * Should show pagination for very large groups
   */
  const showPagination = computed(() => count.value > 25);

  /**
   * Get optimal video aspect ratio based on participant count
   */
  const videoAspectRatio = computed(() => {
    const n = count.value;
    if (n <= 2) return '16/9';
    if (n <= 6) return '4/3';
    return '1/1'; // Square for many participants
  });

  return {
    gridConfig,
    gridStyle,
    gridClass,
    showPagination,
    videoAspectRatio,
    participantCount: count,
  };
}

