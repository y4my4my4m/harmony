import { describe, it, expect } from 'vitest'
import {
  createLoadingState,
  setLoading,
  setSuccess,
  setError,
  type LoadingState,
  type ServiceError,
} from '@/services/index'

describe('Loading state helpers', () => {
  describe('createLoadingState', () => {
    it('creates initial state with null data', () => {
      const state = createLoadingState<string>()
      expect(state).toEqual({
        data: null,
        loading: false,
        error: null,
      })
    })

    it('creates initial state with provided data', () => {
      const state = createLoadingState<number>(42)
      expect(state.data).toBe(42)
      expect(state.loading).toBe(false)
      expect(state.error).toBeNull()
    })
  })

  describe('setLoading', () => {
    it('sets loading to true and clears error', () => {
      const initial: LoadingState<string> = {
        data: 'existing',
        loading: false,
        error: { code: 'ERR', message: 'old error' },
      }
      const result = setLoading(initial)
      expect(result.loading).toBe(true)
      expect(result.error).toBeNull()
      expect(result.data).toBe('existing')
    })
  })

  describe('setSuccess', () => {
    it('sets data and clears loading/error', () => {
      const initial: LoadingState<string> = {
        data: null,
        loading: true,
        error: null,
      }
      const result = setSuccess(initial, 'success data')
      expect(result.data).toBe('success data')
      expect(result.loading).toBe(false)
      expect(result.error).toBeNull()
    })
  })

  describe('setError', () => {
    it('sets error and clears loading', () => {
      const initial: LoadingState<string> = {
        data: 'old',
        loading: true,
        error: null,
      }
      const error: ServiceError = { code: 'NOT_FOUND', message: 'Not found' }
      const result = setError(initial, error)
      expect(result.loading).toBe(false)
      expect(result.error).toEqual(error)
      expect(result.data).toBe('old')
    })
  })

  describe('state transition flow', () => {
    it('follows create -> loading -> success pattern', () => {
      let state = createLoadingState<string[]>()
      expect(state.loading).toBe(false)

      state = setLoading(state)
      expect(state.loading).toBe(true)

      state = setSuccess(state, ['item1', 'item2'])
      expect(state.loading).toBe(false)
      expect(state.data).toEqual(['item1', 'item2'])
    })

    it('follows create -> loading -> error pattern', () => {
      let state = createLoadingState<string[]>()
      state = setLoading(state)

      const error: ServiceError = { code: 'NETWORK', message: 'Connection failed' }
      state = setError(state, error)

      expect(state.loading).toBe(false)
      expect(state.error).toEqual(error)
    })
  })
})
