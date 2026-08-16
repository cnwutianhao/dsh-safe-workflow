import assert from 'node:assert/strict'
import test from 'node:test'
import { createContract, decidePath, extractCandidatePaths, isMutatingTool } from '../src/policy.ts'

test('default contract blocks secrets and .git paths', () => {
  const contract = createContract({ title: 'x', goal: 'y' })
  assert.equal(decidePath('/tmp/project', '.env', contract).allowed, false)
  assert.equal(decidePath('/tmp/project', '.git/config', contract).allowed, false)
  assert.equal(decidePath('/tmp/project', 'src/index.ts', contract).allowed, true)
})

test('allowed paths and workspace escape are denied', () => {
  const contract = createContract({ title: 'x', goal: 'y', allowedPaths: ['src/**'] })
  assert.equal(decidePath('/tmp/project', 'src/a.ts', contract).allowed, true)
  assert.equal(decidePath('/tmp/project', 'README.md', contract).allowed, false)
  assert.equal(decidePath('/tmp/project', '../outside.txt', contract).allowed, false)
})

test('tool classification extracts file paths', () => {
  assert.equal(isMutatingTool('write', []), true)
  assert.equal(isMutatingTool('read', []), false)
  assert.deepEqual(extractCandidatePaths('edit', { path: 'src/a.ts', cwd: '/tmp/project' }), ['src/a.ts', '/tmp/project'])
})
