import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  configPath,
  effectiveSettings,
  pickValid,
  readRuntimeConfig,
  writeRuntimeConfig,
} from '../lib/config.js'

const DEFAULTS = { keepTurns: 3, minChars: 2000, annotate: true, maxAnnotated: 200 }

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-config-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return run(home)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('pickValid keeps only usable keys', () => {
  assert.deepEqual(pickValid({ keepTurns: 0, annotate: false }), { keepTurns: 0, annotate: false })
  assert.deepEqual(pickValid({ keepTurns: -1, minChars: 1.5, annotate: 'yes', other: 1 }), null)
  assert.equal(pickValid(null), null)
  assert.equal(pickValid([]), null)
})

test('runtime config round-trips through ~/.dsh/context-archive.json', () => {
  withHome((home) => {
    assert.equal(readRuntimeConfig(), null)
    writeRuntimeConfig({ keepTurns: 0, minChars: 500 })
    assert.equal(configPath(), join(home, 'context-archive.json'))
    assert.ok(existsSync(configPath()))
    assert.deepEqual(readRuntimeConfig(), { keepTurns: 0, minChars: 500 })
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf8'))
    assert.equal(onDisk.keepTurns, 0, 'written as JSON, not YAML')
  })
})

test('effectiveSettings layers the runtime override over loader defaults', () => {
  withHome(() => {
    assert.deepEqual(effectiveSettings(DEFAULTS), DEFAULTS)
    writeRuntimeConfig({ minChars: 500 })
    assert.deepEqual(effectiveSettings(DEFAULTS), { ...DEFAULTS, minChars: 500 })
  })
})

test('an externally rewritten file is picked up without a restart', () => {
  withHome((home) => {
    writeRuntimeConfig({ minChars: 2000 })
    assert.equal(effectiveSettings(DEFAULTS).minChars, 2000)
    // Simulate the user editing the file by hand.
    writeFileSync(join(home, 'context-archive.json'), JSON.stringify({ minChars: 5000, keepTurns: 1 }))
    const next = effectiveSettings(DEFAULTS)
    assert.equal(next.minChars, 5000)
    assert.equal(next.keepTurns, 1)
  })
})

test('invalid payloads are rejected and leave the old file alone', () => {
  withHome(() => {
    writeRuntimeConfig({ keepTurns: 2 })
    assert.throws(() => writeRuntimeConfig({ keepTurns: 'many' }), /no valid config keys/)
    assert.throws(() => writeRuntimeConfig({ bogus: true }), /no valid config keys/)
    assert.deepEqual(readRuntimeConfig(), { keepTurns: 2 })
  })
})
