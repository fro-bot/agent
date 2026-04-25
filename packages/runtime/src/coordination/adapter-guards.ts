import type {CoordinationConfig} from './types.js'

export function requireConditionalPut(
  config: CoordinationConfig,
): NonNullable<CoordinationConfig['storeAdapter']['conditionalPut']> {
  if (config.storeAdapter.conditionalPut == null) {
    throw new Error('Object store adapter does not support conditionalPut')
  }

  return config.storeAdapter.conditionalPut
}

export function requireConditionalDelete(
  config: CoordinationConfig,
): NonNullable<CoordinationConfig['storeAdapter']['conditionalDelete']> {
  if (config.storeAdapter.conditionalDelete == null) {
    throw new Error('Object store adapter does not support conditionalDelete')
  }

  return config.storeAdapter.conditionalDelete
}

export function requireGetObject(
  config: CoordinationConfig,
): NonNullable<CoordinationConfig['storeAdapter']['getObject']> {
  if (config.storeAdapter.getObject == null) {
    throw new Error('Object store adapter does not support getObject')
  }

  return config.storeAdapter.getObject
}
