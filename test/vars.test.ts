import { describe, expect, test } from 'bun:test'
import { parseProject } from '../src/config.ts'
import { detectVars, fillVars, resolveVars, type Var } from '../src/vars.ts'

// A run's environment (hwt's questions at creation): which cloud the app talks to, its application id, the portal's
// tenant. Given in the form or with --var; else what the variable follows; else its default; empty keeps the
// template's value.
const vars = [
  { name: 'CLOUD', label: 'Cloud', choices: ['https://qa.example.cloud', 'https://demo.example.cloud'] },
  { name: 'APP_ID', label: 'Application id', default: '0' },
  { name: 'PORTAL_HUB', label: 'Portal HUB', choices: ['https://qa.example.cloud', 'https://demo.example.cloud'], from: 'CLOUD', default: 'https://qa.example.cloud' },
]

describe('resolveVars', () => {
  test('given, else what it follows, else its default, else empty (the template\'s value stays)', () => {
    expect(resolveVars(vars, {})).toEqual({ CLOUD: '', APP_ID: '0', PORTAL_HUB: 'https://qa.example.cloud' })
    expect(resolveVars(vars, { CLOUD: 'https://demo.example.cloud' })).toEqual({ CLOUD: 'https://demo.example.cloud', APP_ID: '0', PORTAL_HUB: 'https://demo.example.cloud' })
    expect(resolveVars(vars, { CLOUD: 'https://demo.example.cloud', PORTAL_HUB: 'https://qa.example.cloud', APP_ID: '12' })).toEqual({ CLOUD: 'https://demo.example.cloud', APP_ID: '12', PORTAL_HUB: 'https://qa.example.cloud' })
  })
  test('a variable the project doesn\'t have is refused, naming the ones it has', () => {
    expect(() => resolveVars(vars, { CLUOD: 'x' })).toThrow(/no variable CLUOD \(CLOUD, APP_ID, PORTAL_HUB\)/)
  })
  test('a value with a line break or a quote is refused (it goes into an env file and a URL)', () => {
    expect(() => resolveVars(vars, { APP_ID: '1\nOPS_X=1' })).toThrow(/APP_ID/)
  })
})

describe('fillVars', () => {
  test('{NAME} filled; a text whose variables are all empty is empty (nothing to set)', () => {
    const v = { CLOUD: '', APP_ID: '0', PORTAL_HUB: 'https://qa.example.cloud' }
    expect(fillVars('{PORTAL_HUB}/portal/portal.html#WEB_dev/c/a', v)).toBe('https://qa.example.cloud/portal/portal.html#WEB_dev/c/a')
    expect(fillVars('{CLOUD}', v)).toBe('')
    expect(fillVars('{APP_ID}', v)).toBe('0')
    expect(fillVars('fixed', v)).toBe('fixed')
  })
})

describe('the project\'s vars', () => {
  const base = { key: 'ex', name: 'Ex', worktrees: '/w', tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, repos: [{ key: 'mobile', path: '/m', defaultBase: 'origin/develop', verify: [] }] }
  test('read with their choices and links; a link to a variable that isn\'t there is refused', () => {
    expect(parseProject({ ...base, vars }, 't').vars.map(v => v.name)).toEqual(['CLOUD', 'APP_ID', 'PORTAL_HUB'])
    expect(() => parseProject({ ...base, vars: [{ name: 'HUB', from: 'CLOUD' }] }, 't')).toThrow(/HUB follows CLOUD, which is not one of the vars before it/)
    expect(() => parseProject({ ...base, vars: [{ name: 'cloud host' }] }, 't')).toThrow(/vars/)
  })
})

describe('detectVars: suggested from the ticket', () => {
  const detecting: Var[] = [
    { name: 'CLOUD', detect: { field: 'environment' as const, map: { '^qa': 'https://qa.example.cloud', 'demo': 'https://demo.example.cloud' } } },
    { name: 'PORTAL_CUSTOMER', detect: { field: 'customer' as const } },
    { name: 'PORTAL_APP', detect: { field: 'application' as const } },
    { name: 'LINE', detect: { field: 'tags' as const, map: { '\\b3\\.18\\b': 'patch/3.18' } } },
    { name: 'APP_ID', default: '0' },
  ]
  test('a field mapped by pattern, or taken as it is; nothing when the ticket says nothing', () => {
    expect(detectVars(detecting, { environment: 'QA', customer: ' acme-qa ', application: 'shop-app', tags: ['3.18', 'Mobile'] }))
      .toEqual({ CLOUD: 'https://qa.example.cloud', PORTAL_CUSTOMER: 'acme-qa', PORTAL_APP: 'shop-app', LINE: 'patch/3.18' })
    expect(detectVars(detecting, { environment: 'Production', tags: [] })).toEqual({})
    expect(detectVars(detecting, {})).toEqual({})
  })
  test('a ticket value that could break out of an env file or a URL is not taken', () => {
    expect(detectVars(detecting, { customer: 'x"; rm -rf ~' })).toEqual({})
  })
})
