/**
 * useLoadingState - Professional loading state management composable
 * 
 * Provides consistent patterns for:
 * - Loading states with error handling
 * - Optimistic UI updates with rollback capability
 * - Toast notifications for service operations
 * - Type-safe service error handling
 */

import { ref, computed, reactive } from 'vue'
import type { Ref } from 'vue'
import { createLoadingState, setLoading, setSuccess, setError } from '@/services'
import type { LoadingState, ServiceError } from '@/services'
import { debug } from '@/utils/debug'

export interface OptimisticState<T> {
  data: T | null
  isOptimistic: boolean
  originalData?: T | null
}

export interface LoadingStateComposable<T> {
  state: Ref<LoadingState<T>>
  isLoading: Ref<boolean>
  hasError: Ref<boolean>
  errorMessage: Ref<string | null>
  execute: (operation: () => Promise<T>) => Promise<T | undefined>
  reset: () => void
}

export interface OptimisticUpdateComposable<T> {
  optimistic: Ref<OptimisticState<T>>
  setOptimistic: (data: T) => void
  clearOptimistic: () => void
  rollback: () => void
  executeWithOptimistic: (
    optimisticData: T,
    operation: () => Promise<T>,
    onSuccess?: (result: T) => void,
    onError?: (error: ServiceError) => void
  ) => Promise<T | undefined>
}

/**
 * Professional loading state management
 */
export function useLoadingState<T>(initialData: T | null = null): LoadingStateComposable<T> {
  // Vue's ref wraps T into UnwrapRef<T>, but the helpers operate on the raw T.
  // Cast through any so we can use the standard helpers without fighting UnwrapRef.
  const state = ref(createLoadingState<T>(initialData)) as any

  const isLoading = computed(() => state.value.loading)
  const hasError = computed(() => !!state.value.error)
  const errorMessage = computed(() => state.value.error?.message || null)

  const execute = async (operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      state.value = setLoading(state.value)
      const result = await operation()
      state.value = setSuccess(state.value, result)
      return result
    } catch (error) {
      const serviceError = formatServiceError(error)
      state.value = setError(state.value, serviceError)
      debug.error('❌ Operation failed:', serviceError)
      throw serviceError
    }
  }

  const reset = () => {
    state.value = createLoadingState<T>(initialData)
  }

  return {
    state: state as Ref<LoadingState<T>>,
    isLoading,
    hasError,
    errorMessage,
    execute,
    reset
  }
}

/**
 * Professional optimistic updates with rollback
 */
export function useOptimisticUpdate<T>(initialData: T | null = null): OptimisticUpdateComposable<T> {
  // Vue ref unwraps T into UnwrapRef<T>; cast through any so we can store T
  // directly without juggling UnwrapRef in every assignment.
  const optimistic = ref<OptimisticState<T>>({
    data: initialData,
    isOptimistic: false,
    originalData: null
  }) as any

  const setOptimistic = (data: T) => {
    if (!optimistic.value.isOptimistic) {
      optimistic.value.originalData = optimistic.value.data
    }
    optimistic.value = {
      data,
      isOptimistic: true,
      originalData: optimistic.value.originalData
    }
  }

  const clearOptimistic = () => {
    optimistic.value = {
      data: optimistic.value.data,
      isOptimistic: false,
      originalData: null
    }
  }

  const rollback = () => {
    if (optimistic.value.isOptimistic && optimistic.value.originalData !== undefined) {
      optimistic.value = {
        data: optimistic.value.originalData,
        isOptimistic: false,
        originalData: null
      }
    }
  }

  const executeWithOptimistic = async (
    optimisticData: T,
    operation: () => Promise<T>,
    onSuccess?: (result: T) => void,
    onError?: (error: ServiceError) => void
  ): Promise<T | undefined> => {
    try {
      // 1. Apply optimistic update
      setOptimistic(optimisticData)
      
      // 2. Execute actual operation
      const result = await operation()
      
      // 3. Replace optimistic with real data
      optimistic.value = {
        data: result,
        isOptimistic: false,
        originalData: null
      }
      
      // 4. Call success handler
      onSuccess?.(result)
      
      return result
    } catch (error) {
      // 5. Rollback optimistic update on error
      rollback()
      
      const serviceError = formatServiceError(error)
      debug.error('❌ Optimistic operation failed:', serviceError)
      
      // 6. Call error handler
      onError?.(serviceError)
      
      throw serviceError
    }
  }

  return {
    optimistic: optimistic as Ref<OptimisticState<T>>,
    setOptimistic,
    clearOptimistic,
    rollback,
    executeWithOptimistic
  }
}

/**
 * Combined loading state + optimistic updates for advanced scenarios
 */
export function useAdvancedLoadingState<T>(
  initialData: T | null = null
): LoadingStateComposable<T> & OptimisticUpdateComposable<T> {
  const loadingState = useLoadingState<T>(initialData)
  const optimisticState = useOptimisticUpdate<T>(initialData)

  return {
    ...loadingState,
    ...optimisticState
  }
}

/**
 * Toast notification helpers for service operations
 */
export interface ToastComposable {
  showSuccessToast: (message: string, details?: string) => void
  showErrorToast: (error: ServiceError) => void
  showLoadingToast: (message: string) => void
}

export function useServiceToasts(): ToastComposable {
  // Note: This would integrate with your actual toast system
  // For now, using console logs as placeholder
  
  const showSuccessToast = (message: string, details?: string) => {
    debug.log('✅ Success:', message, details || '')
    // TODO: Integrate with actual toast system
    // toast.success(message, { description: details })
  }

  const showErrorToast = (error: ServiceError) => {
    debug.error('❌ Error:', error.message)
    // TODO: Integrate with actual toast system
    // toast.error(error.message, { description: error.details })
  }

  const showLoadingToast = (message: string) => {
    debug.log('🔄 Loading:', message)
    // TODO: Integrate with actual toast system
    // toast.loading(message)
  }

  return {
    showSuccessToast,
    showErrorToast,
    showLoadingToast
  }
}

/**
 * Utility function to format errors consistently
 */
function formatServiceError(error: any): ServiceError {
  if (error && typeof error === 'object' && error.code && error.message) {
    return error as ServiceError
  }

  if (error instanceof Error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: error.message,
      details: error.stack
    }
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'An unexpected error occurred',
    details: error
  }
}

/**
 * Professional error boundary for service operations
 */
export function useServiceErrorBoundary() {
  const handleServiceError = (error: any, context: string) => {
    const formattedError = formatServiceError(error)
    debug.error(`❌ Service error in ${context}:`, formattedError)
    
    // TODO: Send to error reporting service
    // errorReporting.captureException(formattedError, { context })
    
    return formattedError
  }

  return { handleServiceError }
}

// Export commonly used patterns for convenience
export const LoadingPatterns = {
  /**
   * Standard pattern for service operations with loading states
   */
  async executeServiceOperation<T>(
    operation: () => Promise<T>,
    options?: {
      loadingMessage?: string
      successMessage?: string
      errorMessage?: string
    }
  ): Promise<T | undefined> {
    const { execute } = useLoadingState<T>()
    const { showLoadingToast, showSuccessToast, showErrorToast } = useServiceToasts()

    try {
      if (options?.loadingMessage) {
        showLoadingToast(options.loadingMessage)
      }

      const result = await execute(operation)

      if (options?.successMessage) {
        showSuccessToast(options.successMessage)
      }

      return result
    } catch (error) {
      const formattedError = formatServiceError(error)
      showErrorToast(formattedError)
      
      if (options?.errorMessage) {
        showErrorToast({
          code: 'CUSTOM_ERROR',
          message: options.errorMessage,
          details: formattedError
        })
      }
      
      throw formattedError
    }
  }
}