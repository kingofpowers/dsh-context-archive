import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkManifest, compare, isExactPin, parse, satisfies } from '../scripts/check-compat.mjs'

const order = [
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-beta',
  '1.0.0-beta.2',
  '1.0.0-beta.11',
  '1.0.0-rc.1',
  '1.0.0',
]

test('compare follows SemVer precedence, prereleases included', () => {
  for (let index = 0; index < order.length - 1; index += 1) {
    assert.equal(compare(parse(order[index]), parse(order[index + 1])), -1, `${order[index]} < ${order[index + 1]}`)
    assert.equal(compare(parse(order[index + 1]), parse(order[index])), 1, `${order[index + 1]} > ${order[index]}`)
  }
  assert.equal(compare(parse('0.2.1-rc.1'), parse('0.2.1-rc.5')), -1)
  assert.equal(compare(parse('0.2.1-rc.5'), parse('0.2.1')), -1)
  assert.equal(compare(parse('0.2.1'), parse('0.2.2')), -1)
  assert.equal(compare(parse('v0.2.1'), parse('0.2.1')), 0, 'a leading v is tolerated')
  assert.equal(parse('not-a-version'), null)
})

test('the range that shipped in 0.10.2 rejects 0.2.1-rc.5 — the reported bug', () => {
  assert.equal(satisfies('0.2.1-rc.5', '0.2.1-rc.1 || 0.2.1-rc.2'), false)
  assert.equal(satisfies('0.2.1-rc.2', '0.2.1-rc.1 || 0.2.1-rc.2'), true)
})

test('the open-ended range covers every 0.2.x prerelease but not 0.3.0', () => {
  const range = '>=0.2.1-rc.1 <0.3.0'
  for (const version of ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.1', '0.2.2', '0.2.9-rc.3']) {
    assert.equal(satisfies(version, range), true, `${version} should satisfy`)
  }
  for (const version of ['0.2.0', '0.2.1-rc.0', '0.3.0', '1.0.0']) {
    assert.equal(satisfies(version, range), false, `${version} should not satisfy`)
  }
})

test('engines.dsh decides alone; peers are only consulted without it', () => {
  assert.deepEqual(checkManifest({ engines: { dsh: '0.2.1-rc.1 || 0.2.1-rc.2' } }, '0.2.1-rc.5'), {
    'engines.dsh': '0.2.1-rc.1 || 0.2.1-rc.2',
  })
  assert.deepEqual(checkManifest({ engines: { dsh: '>=0.2.1-rc.1 <0.3.0' } }, '0.2.1-rc.5'), {})
  assert.deepEqual(
    checkManifest(
      { peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.1 || 0.2.1-rc.2', '@deepseek-ai/schemastery': '>=3 <4' } },
      '0.2.1-rc.5',
    ),
    { '@deepseek-ai/dsh-tools': '0.2.1-rc.1 || 0.2.1-rc.2' },
    'non-dsh peers never gate compatibility',
  )
})

test('exact pins are flagged so they cannot creep back in', () => {
  assert.equal(isExactPin('0.2.1-rc.1 || 0.2.1-rc.2'), true)
  assert.equal(isExactPin('>=0.2.1-rc.1 <0.3.0'), false)
  assert.equal(isExactPin('0.2.1'), true)
})
