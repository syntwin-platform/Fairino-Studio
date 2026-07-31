import { beforeEach, describe, expect, it } from 'vitest'
import {
  getSavedDeviceSecretsForAccount,
  saveDeviceSecretsForAccount
} from './deviceSecretStorage'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

describe('deviceSecretStorage', () => {
  beforeEach(() => {
    if (typeof window === 'undefined') {
      // @ts-expect-error Mocking window.localStorage for node environment
      globalThis.window = {
        localStorage: new MemoryStorage()
      }
    } else {
      window.localStorage.clear()
    }
  })

  it('returns empty object when account identifier is empty or invalid', () => {
    expect(getSavedDeviceSecretsForAccount('')).toEqual({})
    expect(getSavedDeviceSecretsForAccount('   ')).toEqual({})
  })

  it('saves and retrieves device secrets for a specific user account', () => {
    const userAccount = 'user-123'
    saveDeviceSecretsForAccount(userAccount, {
      'robot-1': 'secret-key-1',
      'robot-2': 'secret-key-2'
    })

    const retrieved = getSavedDeviceSecretsForAccount(userAccount)
    expect(retrieved).toEqual({
      'robot-1': 'secret-key-1',
      'robot-2': 'secret-key-2'
    })
  })

  it('isolates device secrets between different user accounts', () => {
    saveDeviceSecretsForAccount('user-A', { 'robot-1': 'secret-A' })
    saveDeviceSecretsForAccount('user-B', { 'robot-1': 'secret-B' })

    expect(getSavedDeviceSecretsForAccount('user-A')).toEqual({ 'robot-1': 'secret-A' })
    expect(getSavedDeviceSecretsForAccount('user-B')).toEqual({ 'robot-1': 'secret-B' })
  })

  it('merges new secrets without overwriting existing valid ones with empty values', () => {
    saveDeviceSecretsForAccount('user-1', { 'robot-1': 'secret-1', 'robot-2': 'secret-2' })
    saveDeviceSecretsForAccount('user-1', { 'robot-2': 'secret-2-new', 'robot-3': 'secret-3' })

    expect(getSavedDeviceSecretsForAccount('user-1')).toEqual({
      'robot-1': 'secret-1',
      'robot-2': 'secret-2-new',
      'robot-3': 'secret-3'
    })
  })
})
