import { ref, watch, type Ref } from 'vue'

export interface UseDebounceOptions {
  delay?: number
  immediate?: boolean
}

export function useDebounce<T>(
  source: Ref<T>,
  callback: (value: T) => void | Promise<void>,
  options: UseDebounceOptions = {}
) {
  const { delay = 300, immediate = false } = options
  
  let timeoutId: number | undefined

  const debouncedValue = ref(source.value) as Ref<T>
  const isDebouncing = ref(false)

  const executeCallback = async (value: T) => {
    try {
      isDebouncing.value = true
      await callback(value)
    } finally {
      isDebouncing.value = false
    }
  }

  watch(
    source,
    (newValue) => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      if (immediate && !timeoutId) {
        executeCallback(newValue)
        debouncedValue.value = newValue
        return
      }

      timeoutId = window.setTimeout(() => {
        executeCallback(newValue)
        debouncedValue.value = newValue
        timeoutId = undefined
      }, delay)
    },
    { immediate }
  )

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = undefined
      isDebouncing.value = false
    }
  }

  return {
    debouncedValue,
    isDebouncing,
    cancel
  }
}

export function useDebouncedSearch(
  searchQuery: Ref<string>,
  searchCallback: (query: string) => void | Promise<void>,
  delay = 300
) {
  const { isDebouncing } = useDebounce(
    searchQuery,
    async (query) => {
      const trimmedQuery = query.trim()
      await searchCallback(trimmedQuery)
    },
    { delay }
  )

  return {
    isSearching: isDebouncing
  }
}
