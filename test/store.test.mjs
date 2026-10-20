import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatsStore, readArchiveBuckets } from '../lib/store.js'

function resultEvent(seq, text, turn = 1) {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000,
    data: {
      turn,
      step: 0,
      message: {
        id: `m${seq}`,
        role: 'tool',
        toolCallId: 'c',
        isError: false,
        source: { kind: 'tool', callId: 'c' },
        content: [{ type: 'text', text }],
      },
    },
  }
}

function makeStore(home) {
  return new StatsStore({ path: join(home, 'stats.json') })
}

test('folding counts results, annotations and skips archived stubs', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-store-'))
  try {
    const store = makeStore(home)
    const session = { id: 's1', snapshotEvents: () => [] }
    store.apply(session, resultEvent(0, 'a'.repeat(400)))
    store.apply(session, resultEvent(1, '[#deadbeef · 2500 chars]\n' + 'b'.repeat(2500)))
    store.apply(session, resultEvent(2, '[archived #deadbeef · tool · 2500 chars]\nfile: /x'))
    assert.equal(store.state.buckets['<500'].seen, 1)
    assert.equal(store.state.buckets['2k-5k'].seen, 1)
    assert.equal(store.state.buckets['2k-5k'].annotated, 1)
    assert.equal(store.state.buckets['20k+'].seen, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the same seq is never folded twice', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-store-'))
  try {
    const store = makeStore(home)
    const session = { id: 's1', snapshotEvents: () => [] }
    store.apply(session, resultEvent(5, 'x'.repeat(300)))
    store.apply(session, resultEvent(5, 'x'.repeat(300)))
    store.apply(session, resultEvent(4, 'x'.repeat(300)))
    assert.equal(store.state.buckets['<500'].seen, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('first sight of a session backfills its in-memory prefix', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-store-'))
  try {
    const store = makeStore(home)
    const prefix = [resultEvent(0, 'a'.repeat(100)), resultEvent(1, 'b'.repeat(5000))]
    const session = { id: 's1', snapshotEvents: () => prefix }
    store.apply(session, resultEvent(2, 'c'.repeat(700)))
    assert.equal(store.state.buckets['<500'].seen, 1)
    assert.equal(store.state.buckets['500-1k'].seen, 1)
    assert.equal(store.state.buckets['5k-20k'].seen, 1)
    assert.equal(store.state.sessions.s1.lastSeq, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('snapshot joins archive rows and gives verdicts', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-store-'))
  try {
    const store = makeStore(home)
    const session = { id: 's1', snapshotEvents: () => [] }
    for (let index = 0; index < 4; index++) {
      store.apply(session, resultEvent(index, '[#aaaaaaaa · 5000 chars]\n' + 'z'.repeat(5000)))
    }
    const archivedRows = new Map([['5k-20k', { archived: 3, annotated: 3, chars: 15000, stubs: 900 }]])
    const rows = store.snapshot(archivedRows)
    const big = rows.find((row) => row.bucket === '5k-20k')
    assert.equal(big.annotated, 4)
    assert.equal(big.archived, 3)
    assert.equal(big.rate, 0.75)
    assert.equal(big.verdict, 'profitable')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('counters persist across a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-store-'))
  try {
    const first = makeStore(home)
    first.apply({ id: 's1', snapshotEvents: () => [] }, resultEvent(0, 'k'.repeat(900)))
    first.flush()

    const second = makeStore(home)
    assert.equal(second.state.buckets['500-1k'].seen, 1)
    assert.equal(second.state.sessions.s1.lastSeq, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readArchiveBuckets walks every session index', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ca-store-'))
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const sessionDir = join(home, 'sessions', '--proj--', 'session-1', 'archives')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'index.json'),
      JSON.stringify({
        version: 1,
        entries: {
          a1: { chars: 5000, stubChars: 300 },
          a2: { chars: 300, stubChars: 300 },
        },
      }),
    )
    const rows = readArchiveBuckets()
    assert.equal(rows.get('5k-20k').archived, 1)
    assert.equal(rows.get('5k-20k').chars, 5000)
    assert.equal(rows.get('<500').archived, 1)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
