import type {Result} from '../shared/types.js'
import type {CoordinationConfig} from './types.js'

import {err, ok} from '../shared/types.js'

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

export function resolveConditionalPut(
  config: CoordinationConfig,
): Result<NonNullable<CoordinationConfig['storeAdapter']['conditionalPut']>, Error> {
  try {
    return ok(requireConditionalPut(config))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export function resolveConditionalDelete(
  config: CoordinationConfig,
): Result<NonNullable<CoordinationConfig['storeAdapter']['conditionalDelete']>, Error> {
  try {
    return ok(requireConditionalDelete(config))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export function resolveGetObject(
  config: CoordinationConfig,
): Result<NonNullable<CoordinationConfig['storeAdapter']['getObject']>, Error> {
  try {
    return ok(requireGetObject(config))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}
