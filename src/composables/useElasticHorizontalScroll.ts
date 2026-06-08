import { ref, computed, onMounted, onUnmounted, watch, type Ref } from 'vue';

interface VelocitySample {
  x: number;
  t: number;
}

interface ElasticScrollOptions {
  rubberBandFactor?: number;
  momentumFriction?: number;
  minMomentumVelocity?: number;
}

/**
 * Touch-driven horizontal scroll with rubber-band edges and flick momentum.
 * Used where native overflow scrolling fights global swipe gestures on mobile.
 */
export function useElasticHorizontalScroll(
  containerRef: Ref<HTMLElement | null>,
  trackRef: Ref<HTMLElement | null>,
  options: ElasticScrollOptions = {},
) {
  const rubberBandFactor = options.rubberBandFactor ?? 0.38;
  const momentumFriction = options.momentumFriction ?? 0.92;
  const minMomentumVelocity = options.minMomentumVelocity ?? 0.04;

  const scrollX = ref(0);
  const maxScroll = ref(0);
  const isDragging = ref(false);
  const isAnimating = ref(false);

  let dragLocked: 'horizontal' | 'vertical' | null = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let scrollStartX = 0;
  let lastTouchTime = 0;
  let velocitySamples: VelocitySample[] = [];
  let rafId = 0;

  const measure = () => {
    const container = containerRef.value;
    const track = trackRef.value;
    if (!container || !track) return;
    maxScroll.value = Math.max(0, track.scrollWidth - container.clientWidth);
    scrollX.value = clamp(scrollX.value, 0, maxScroll.value);
  };

  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

  const applyRubber = (value: number) => {
    if (value < 0) return value * rubberBandFactor;
    if (value > maxScroll.value) {
      return maxScroll.value + (value - maxScroll.value) * rubberBandFactor;
    }
    return value;
  };

  const stopAnimation = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    isAnimating.value = false;
  };

  const animateTo = (target: number, duration = 320) => {
    stopAnimation();
    const from = scrollX.value;
    const start = performance.now();
    isAnimating.value = true;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      scrollX.value = from + (target - from) * eased;
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        scrollX.value = target;
        isAnimating.value = false;
        rafId = 0;
      }
    };
    rafId = requestAnimationFrame(tick);
  };

  const snapToBounds = () => {
    if (scrollX.value < 0) {
      animateTo(0);
    } else if (scrollX.value > maxScroll.value) {
      animateTo(maxScroll.value);
    }
  };

  const getReleaseVelocity = () => {
    if (velocitySamples.length < 2) return 0;
    const first = velocitySamples[0];
    const last = velocitySamples[velocitySamples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (last.x - first.x) / dt;
  };

  const runMomentum = (initialVelocity: number) => {
    stopAnimation();
    let velocity = -initialVelocity;
    let lastTime = performance.now();
    isAnimating.value = true;

    const tick = (now: number) => {
      const dt = Math.min(32, now - lastTime);
      lastTime = now;

      if (scrollX.value < 0 || scrollX.value > maxScroll.value) {
        snapToBounds();
        return;
      }

      scrollX.value += velocity * dt;
      velocity *= momentumFriction ** (dt / 16);

      if (Math.abs(velocity) < minMomentumVelocity) {
        isAnimating.value = false;
        rafId = 0;
        snapToBounds();
        return;
      }

      if (scrollX.value < 0) {
        scrollX.value = 0;
        isAnimating.value = false;
        rafId = 0;
        return;
      }
      if (scrollX.value > maxScroll.value) {
        scrollX.value = maxScroll.value;
        isAnimating.value = false;
        rafId = 0;
        return;
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  const onTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;

    stopAnimation();
    isDragging.value = true;
    dragLocked = null;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    scrollStartX = scrollX.value;
    lastTouchTime = performance.now();
    velocitySamples = [{ x: touch.clientX, t: lastTouchTime }];
    e.stopPropagation();
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!isDragging.value) return;
    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;

    if (!dragLocked && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      dragLocked = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }

    if (dragLocked !== 'horizontal') return;
    if (maxScroll.value <= 0) return;

    e.preventDefault();
    e.stopPropagation();

    const now = performance.now();
    velocitySamples.push({ x: touch.clientX, t: now });
    if (velocitySamples.length > 6) velocitySamples.shift();

    const raw = scrollStartX - (touch.clientX - touchStartX);
    scrollX.value = applyRubber(raw);

    lastTouchTime = now;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!isDragging.value) return;
    isDragging.value = false;
    e.stopPropagation();

    if (dragLocked !== 'horizontal' || maxScroll.value <= 0) {
      dragLocked = null;
      return;
    }

    if (scrollX.value < 0 || scrollX.value > maxScroll.value) {
      snapToBounds();
      dragLocked = null;
      return;
    }

    const velocity = getReleaseVelocity();
    if (Math.abs(velocity) > minMomentumVelocity) {
      runMomentum(velocity);
    }

    dragLocked = null;
  };

  const onWheel = (e: WheelEvent) => {
    if (maxScroll.value <= 0) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    stopAnimation();
    scrollX.value = clamp(scrollX.value + e.deltaY, 0, maxScroll.value);
    e.preventDefault();
  };

  const trackStyle = computed(() => ({
    transform: `translate3d(${-scrollX.value}px, 0, 0)`,
    transition:
      isDragging.value || isAnimating.value
        ? 'none'
        : 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    willChange: isDragging.value || isAnimating.value ? 'transform' : 'auto',
  }));

  let resizeObserver: ResizeObserver | null = null;
  let touchMoveHandler: ((e: TouchEvent) => void) | null = null;

  const bind = () => {
    const el = containerRef.value;
    if (!el) return;

    touchMoveHandler = onTouchMove;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', touchMoveHandler, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
  };

  const unbind = () => {
    const el = containerRef.value;
    if (!el) return;
    el.removeEventListener('touchstart', onTouchStart);
    if (touchMoveHandler) el.removeEventListener('touchmove', touchMoveHandler);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchEnd);
  };

  onMounted(() => {
    measure();
    bind();

    resizeObserver = new ResizeObserver(() => measure());
    if (containerRef.value) resizeObserver.observe(containerRef.value);
    if (trackRef.value) resizeObserver.observe(trackRef.value);
    window.addEventListener('resize', measure);
  });

  onUnmounted(() => {
    stopAnimation();
    unbind();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', measure);
  });

  watch([containerRef, trackRef], () => {
    measure();
    unbind();
    bind();
  });

  return {
    scrollX,
    maxScroll,
    trackStyle,
    measure,
    onWheel,
  };
}
