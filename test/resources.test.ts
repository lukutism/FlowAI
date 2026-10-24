import { describe, expect, test } from 'bun:test'
import { Resources } from '../src/resources.ts'

// Machine-wide slots shared by every run: a run that finds them full waits (and says for what), first come first served.
describe('Resources', () => {
  const log: string[] = []
  const make = (limits = { agents: 2, builds: 1, devices: 4 }) => {
    log.length = 0
    return new Resources(limits, { onWait: (run, kind) => log.push(`${run} waits for ${kind}`), onGo: (run, kind) => log.push(`${run} got ${kind}`) })
  }
  test('within the limit: at once, nothing recorded', async () => {
    const r = make()
    const free = await r.acquire('a', 'builds')
    expect(log).toEqual([])
    expect(r.snapshot().holders.builds).toEqual(['a'])
    free()
    expect(r.snapshot().holders.builds).toEqual([])
  })
  test('full: the run waits, saying for what; it gets the slot when one frees, first come first served', async () => {
    const r = make()
    const freeA = await r.acquire('a', 'builds')
    const order: string[] = []
    const b = r.acquire('b', 'builds').then(f => { order.push('b'); return f })
    const c = r.acquire('c', 'builds').then(f => { order.push('c'); return f })
    await Bun.sleep(1)
    expect(log).toEqual(['b waits for builds', 'c waits for builds'])
    expect(r.snapshot().waiting).toEqual([{ run: 'b', kind: 'builds' }, { run: 'c', kind: 'builds' }])
    freeA(); (await b)(); (await c)()
    expect(order).toEqual(['b', 'c'])
    expect(log.slice(2)).toEqual(['b got builds', 'c got builds'])
  })
  test('freeing twice frees one slot, not two', async () => {
    const r = make({ agents: 2, builds: 1, devices: 4 })
    const f = await r.acquire('a', 'builds'); f(); f()
    await r.acquire('b', 'builds')
    let c = false
    void r.acquire('c', 'builds').then(() => { c = true })
    await Bun.sleep(1)
    expect(c).toBe(false)
  })
  test('a run holding a slot asking for another of the same kind gets its own (two repos building at once is two builds)', async () => {
    const r = make({ agents: 2, builds: 2, devices: 4 })
    await r.acquire('a', 'builds'); await r.acquire('a', 'builds')
    expect(r.snapshot().holders.builds).toEqual(['a', 'a'])
  })
  test('the snapshot names limits, holders and who waits', async () => {
    const r = make()
    await r.acquire('a', 'devices')
    expect(r.snapshot()).toEqual({ limits: { agents: 2, builds: 1, devices: 4 }, holders: { agents: [], builds: [], devices: ['a'] }, waiting: [] })
  })
  test('a slot freed the moment a run starts waiting (in its waiting notice) still reaches it', async () => {
    let free: () => void = () => {}
    const r = new Resources({ agents: 1, builds: 1, devices: 1 }, { onWait: () => free() })
    free = await r.acquire('a', 'builds')
    const got = await Promise.race([r.acquire('b', 'builds').then(() => 'b got it'), Bun.sleep(500).then(() => 'stuck')])
    expect(got).toBe('b got it')
  })
  test('a freed slot goes to the run that waited, not to one that arrives in the same moment: the limit holds', async () => {
    const r = new Resources({ agents: 1, builds: 1, devices: 1 })
    const freeA = await r.acquire('a', 'builds')
    const b = r.acquire('b', 'builds')
    freeA()
    let cGot = false
    const c = r.acquire('c', 'builds').then(f => { cGot = true; return f })
    await b
    await Bun.sleep(1)
    expect(cGot).toBe(false)
    expect(r.snapshot().holders.builds).toEqual(['b'])
    expect(r.snapshot().waiting).toEqual([{ run: 'c', kind: 'builds' }])
    ;(await b)(); await c
  })
})
