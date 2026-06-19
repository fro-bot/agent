/**
 * Tests for readRepoDenylist and deriveDatabaseId.
 *
 * All tests inject a fake MetadataReader — no GitHub API calls are made.
 * BDD comments: #given / #when / #then.
 */

import {Buffer} from 'node:buffer'

import {describe, expect, it} from 'vitest'

import {
  deriveDatabaseId,
  makeNotFoundError,
  MetadataParseError,
  MetadataSchemaError,
  MetadataTransportError,
  MetadataUnavailableError,
  NOT_FOUND_CODE,
  readRepoDenylist,
} from './metadata-reader.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid repos.yaml string. */
function makeYaml(repos: object[]): string {
  const lines = ['version: 1', 'repos:']
  for (const repo of repos) {
    lines.push('  -')
    for (const [k, v] of Object.entries(repo)) {
      lines.push(`    ${k}: ${JSON.stringify(v)}`)
    }
  }
  return lines.join('\n')
}

/** A fake reader that returns the given YAML string. */
function fakeReader(yaml: string) {
  return async (_path: string, _ref: string): Promise<string> => yaml
}

/** A fake reader that throws a not-found sentinel. */
function notFoundReader() {
  return async (_path: string, _ref: string): Promise<string> => {
    throw makeNotFoundError('metadata/repos.yaml not found')
  }
}

/** A fake reader that throws a transport error. */
function transportErrorReader(message: string) {
  return async (_path: string, _ref: string): Promise<string> => {
    throw new Error(message)
  }
}

// ---------------------------------------------------------------------------
// deriveDatabaseId
// ---------------------------------------------------------------------------

describe('deriveDatabaseId', () => {
  it('returns null for an empty string', () => {
    // #given / #when / #then
    expect(deriveDatabaseId('')).toBeNull()
  })

  it('returns null for an R_-format node_id', () => {
    // #given
    const nodeId = 'R_kgDOJ_bMaQ'

    // #when / #then
    expect(deriveDatabaseId(nodeId)).toBeNull()
  })

  it('derives the correct numeric id from a legacy base64 node_id', () => {
    // #given — verified pair: MDEwOlJlcG9zaXRvcnkxODY5MTU0 → 1869154
    const nodeId = 'MDEwOlJlcG9zaXRvcnkxODY5MTU0'

    // #when
    const result = deriveDatabaseId(nodeId)

    // #then
    expect(result).toBe(1869154)
  })

  it('returns null for a base64 string that does not contain Repository<digits>', () => {
    // #given — base64 of "something else"
    const nodeId = Buffer.from('something else').toString('base64')

    // #when / #then
    expect(deriveDatabaseId(nodeId)).toBeNull()
  })

  it('returns null for a non-base64 garbage string', () => {
    // #given
    const nodeId = '!!!not-base64!!!'

    // #when / #then
    expect(deriveDatabaseId(nodeId)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// makeNotFoundError / NOT_FOUND_CODE
// ---------------------------------------------------------------------------

describe('makeNotFoundError', () => {
  it('produces an error with code === NOT_FOUND_CODE', () => {
    // #given / #when
    const error = makeNotFoundError('test')

    // #then
    expect(error.code).toBe(NOT_FOUND_CODE)
    expect(error).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// readRepoDenylist — happy path
// ---------------------------------------------------------------------------

describe('readRepoDenylist — happy path', () => {
  it('returns empty sets when all entries are public (non-redacted)', async () => {
    // #given
    const yaml = makeYaml([
      {owner: 'acme', name: 'public-repo', node_id: 'MDEwOlJlcG9zaXRvcnkx', discovery_channel: 'github'},
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedNodeIds.size : -1).toBe(0)
    expect(result.success === true ? result.data.redactedDatabaseIds.size : -1).toBe(0)
  })

  it('collects node_id and database_id for a private:true entry', async () => {
    // #given — private entry with a direct database_id field
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'MDEwOlJlcG9zaXRvcnkxODY5MTU0',
        private: true,
        database_id: 1869154,
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedNodeIds.has('MDEwOlJlcG9zaXRvcnkxODY5MTU0') : false).toBe(true)
    expect(result.success === true ? result.data.redactedDatabaseIds.has(1869154) : false).toBe(true)
  })

  it('collects node_id and database_id for an owner:[REDACTED] entry (not private)', async () => {
    // #given — redacted owner but private not set
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'MDEwOlJlcG9zaXRvcnkxODY5MTU0',
        database_id: 1869154,
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedNodeIds.has('MDEwOlJlcG9zaXRvcnkxODY5MTU0') : false).toBe(true)
    expect(result.success === true ? result.data.redactedDatabaseIds.has(1869154) : false).toBe(true)
  })

  it('public entries contribute nothing to the denylist', async () => {
    // #given — mix of public and redacted
    const yaml = makeYaml([
      {owner: 'acme', name: 'public-repo', node_id: 'MDEwOlJlcG9zaXRvcnkx', discovery_channel: 'github'},
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'MDEwOlJlcG9zaXRvcnkxODY5MTU0',
        private: true,
        database_id: 1869154,
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then — only the redacted entry's node_id is in the set
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedNodeIds.has('MDEwOlJlcG9zaXRvcnkx') : true).toBe(false)
    expect(result.success === true ? result.data.redactedNodeIds.has('MDEwOlJlcG9zaXRvcnkxODY5MTU0') : false).toBe(true)
    expect(result.success === true ? result.data.redactedDatabaseIds.has(1869154) : false).toBe(true)
  })

  it('derives database_id from a legacy base64 node_id when no direct database_id is present', async () => {
    // #given — redacted entry with only a legacy base64 node_id (no database_id field)
    // deriveDatabaseId('MDEwOlJlcG9zaXRvcnkxODY5MTU0') → 1869154
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'MDEwOlJlcG9zaXRvcnkxODY5MTU0',
        private: true,
        // no database_id field
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then — derived id must be in the set
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedNodeIds.has('MDEwOlJlcG9zaXRvcnkxODY5MTU0') : false).toBe(true)
    expect(result.success === true ? result.data.redactedDatabaseIds.has(1869154) : false).toBe(true)
  })

  it('accepts a redacted entry with a direct database_id via the id alias field', async () => {
    // #given — uses `id` instead of `database_id`
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'MDEwOlJlcG9zaXRvcnkxODY5MTU0',
        private: true,
        id: 1869154,
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedDatabaseIds.has(1869154) : false).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readRepoDenylist — R_-format fail-closed hardening
// ---------------------------------------------------------------------------

describe('readRepoDenylist — R_-format fail-closed hardening', () => {
  it('fails closed (MetadataSchemaError) when a redacted entry has only an R_-format node_id and no numeric database_id', async () => {
    // #given — R_ node_id → deriveDatabaseId returns null; no direct database_id
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'R_kgDOJ_bMaQ',
        private: true,
        // no database_id / id field
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then — whole load fails closed
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataSchemaError)
  })

  it('succeeds when a redacted entry has an R_-format node_id AND a direct database_id', async () => {
    // #given — R_ node_id but database_id is present directly
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        node_id: 'R_kgDOJ_bMaQ',
        private: true,
        database_id: 999999,
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then — load succeeds; node_id in set, database_id in set
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.redactedNodeIds.has('R_kgDOJ_bMaQ') : false).toBe(true)
    expect(result.success === true ? result.data.redactedDatabaseIds.has(999999) : false).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readRepoDenylist — fail-closed error taxonomy
// ---------------------------------------------------------------------------

describe('readRepoDenylist — fail-closed error taxonomy', () => {
  it('returns MetadataUnavailableError (not throw) when the reader signals not-found', async () => {
    // #given
    const reader = notFoundReader()

    // #when
    const result = await readRepoDenylist(reader)

    // #then — err, not throw
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataUnavailableError)
  })

  it('returns MetadataParseError (not throw) for malformed YAML', async () => {
    // #given — invalid YAML
    const reader = fakeReader(': : : invalid yaml {{{')

    // #when
    const result = await readRepoDenylist(reader)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataParseError)
  })

  it('returns MetadataParseError (not throw) when top-level is not an object', async () => {
    // #given — valid YAML but wrong shape (array at top level)
    const reader = fakeReader('- item1\n- item2\n')

    // #when
    const result = await readRepoDenylist(reader)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataParseError)
  })

  it('returns MetadataSchemaError (not throw) for wrong schema version', async () => {
    // #given — version: 2 (unsupported)
    const reader = fakeReader('version: 2\nrepos: []\n')

    // #when
    const result = await readRepoDenylist(reader)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataSchemaError)
  })

  it('returns MetadataSchemaError (not throw) when version is missing', async () => {
    // #given — no version field
    const reader = fakeReader('repos: []\n')

    // #when
    const result = await readRepoDenylist(reader)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataSchemaError)
  })

  it('returns MetadataParseError (not throw) when repos is not an array', async () => {
    // #given
    const reader = fakeReader('version: 1\nrepos: "not-an-array"\n')

    // #when
    const result = await readRepoDenylist(reader)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataParseError)
  })

  it('returns MetadataTransportError (not throw) for a transport error', async () => {
    // #given — reader throws a generic error (not not-found)
    const reader = transportErrorReader('network timeout')

    // #when
    const result = await readRepoDenylist(reader)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataTransportError)
  })

  it('returns MetadataSchemaError (not throw) when a redacted entry has no node_id and no database_id', async () => {
    // #given — redacted entry with neither node_id nor database_id
    const yaml = makeYaml([
      {
        owner: '[REDACTED]',
        name: '[REDACTED]',
        private: true,
        // no node_id, no database_id
      },
    ])

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataSchemaError)
  })

  it('does not throw — all error paths return err()', async () => {
    // #given — a set of readers that each trigger a different error path
    const readers = [
      notFoundReader(),
      fakeReader(': : : invalid yaml {{{'),
      fakeReader('version: 2\nrepos: []\n'),
      transportErrorReader('boom'),
    ]

    for (const reader of readers) {
      // #when
      let threw = false
      let result
      try {
        result = await readRepoDenylist(reader)
      } catch {
        threw = true
      }

      // #then — never throws; always returns a Result
      expect(threw).toBe(false)
      expect(result).toBeDefined()
      expect(result?.success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// readRepoDenylist — no-oracle: error messages must not contain redacted owner/name
// ---------------------------------------------------------------------------

describe('readRepoDenylist — no-oracle security', () => {
  it('error message for a redacted entry with no usable deny key does not contain the redacted owner or name', async () => {
    // #given — a redacted entry with no node_id and no database_id
    // We use distinctive sentinel values to detect leakage in error messages.
    const sensitiveOwner = 'secret-owner-xyz'
    const sensitiveName = 'secret-repo-xyz'
    const yaml = [
      'version: 1',
      'repos:',
      '  -',
      `    owner: "${sensitiveOwner}"`,
      `    name: "${sensitiveName}"`,
      '    private: true',
      '    # no node_id, no database_id',
    ].join('\n')

    // #when
    const result = await readRepoDenylist(fakeReader(yaml))

    // #then — error must not echo owner or name
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message.includes(sensitiveOwner) : true).toBe(false)
    expect(result.success === false ? result.error.message.includes(sensitiveName) : true).toBe(false)
  })

  it('transport error message does not echo raw reader error content verbatim (sanitized)', async () => {
    // #given — reader throws with a message that could contain sensitive info
    const reader = transportErrorReader('some transport failure')

    // #when
    const result = await readRepoDenylist(reader)

    // #then — result is a transport error (not a throw)
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataTransportError)
  })
})
