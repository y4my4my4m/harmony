export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  intervalMs: number
): T {
  let lastCall = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;

  return ((...args: any[]) => {
    const now = Date.now();
    const remaining = intervalMs - (now - lastCall);

    if (remaining <= 0) {
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      lastCall = now;
      fn(...args);
    } else if (!scheduled) {
      scheduled = setTimeout(() => {
        lastCall = Date.now();
        scheduled = null;
        fn(...args);
      }, remaining);
    }
  }) as T;
}
