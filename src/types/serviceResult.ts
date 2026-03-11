/**
 * Standard result type for all service operations.
 *
 * Usage:
 *   async function doSomething(): Promise<ServiceResult<Widget>> {
 *     try {
 *       const widget = await fetchWidget();
 *       return { data: widget, error: null };
 *     } catch (err) {
 *       return { data: null, error: err instanceof Error ? err.message : String(err) };
 *     }
 *   }
 *
 * Consuming:
 *   const { data, error } = await doSomething();
 *   if (error) { toast.error(error); return; }
 *   // data is Widget
 */
export interface ServiceResult<T> {
  data: T | null;
  error: string | null;
}
