import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import {
  buildHermesPrompt,
  createIncidentSnapshot,
  isRescueCandidate,
  loadRescuePolicy,
  mapContainerPath,
  processFailedJob,
  redactSensitive,
} from '../scripts/hermes-rescue-worker.mjs'

const execFileAsync = promisify(execFile)

describe('Hermes rescue worker', () => {
  it('only selects terminal managed failures', () => {
    assert.equal(isRescueCandidate({ id: 'job-1', status: 'failed' }), true)
    assert.equal(isRescueCandidate({ id: 'job-1', status: 'queued' }), false)
    assert.equal(isRescueCandidate({ id: 'job-1', status: 'failed', readOnly: true }), false)
    assert.equal(isRescueCandidate({ id: 'job-1', status: 'failed', hidden: true }), false)
  })

  it('redacts credentials from nested incident data and log text', () => {
    const redacted = redactSensitive({
      apiKey: 'sk-secret-value',
      nested: { authorization: 'Bearer secret-token' },
      log: 'request used Bearer abc.def.ghi and ghp_abcdefghijklmnopqrstuvwxyz',
      args: ['--api-key', 'plain-secret', '--token=other-secret', '--safe', 'value'],
    })
    assert.equal(redacted.apiKey, '[REDACTED]')
    assert.equal(redacted.nested.authorization, '[REDACTED]')
    assert.doesNotMatch(redacted.log, /abc\.def\.ghi|ghp_/)
    assert.deepEqual(redacted.args, ['--api-key', '[REDACTED]', '--token=[REDACTED]', '--safe', 'value'])
  })

  it('maps container run paths to the production host root', () => {
    assert.equal(
      mapContainerPath('/app/runs/file-book/run-one', '/srv/production'),
      '/srv/production/runs/file-book/run-one',
    )
  })

  it('defaults to a bounded production-pipeline-only repair policy', () => {
    const policy = loadRescuePolicy({ enabled: true })
    assert.equal(policy.maxJobsPerScan, 1)
    assert.equal(policy.maxFailureAgeMs, 24 * 60 * 60_000)
    assert.deepEqual(policy.repair.allowedPathPrefixes, ['production-pipeline/'])
    assert.equal(policy.repair.autoDeploy, false)
    assert.equal(policy.repair.autoRetryJob, false)
  })

  it('captures a bounded incident snapshot and builds a constrained prompt', async () => {
      const serviceRoot = await mkdtemp(join(tmpdir(), 'hermes-rescue-test-'))
    try {
      const runDir = join(serviceRoot, 'runs', 'file-book', 'run-one')
      const olderRunDir = join(serviceRoot, 'runs', 'file-book', 'run-older')
      await mkdir(join(runDir, 'logs'), { recursive: true })
      await mkdir(olderRunDir, { recursive: true })
      await mkdir(join(serviceRoot, 'data'), { recursive: true })
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ status: 'failed', token: 'secret' }))
      await writeFile(join(olderRunDir, 'run.json'), JSON.stringify({
        status: 'stopped',
        updatedAt: '2026-07-14T16:59:41.716Z',
        stages: {
          import: { status: 'completed' },
          chunkEmbedding: { status: 'completed' },
        },
      }))
      await writeFile(join(runDir, 'logs', 'kg.log'), 'line one\nline two\nquality failed\n')
      await writeFile(join(serviceRoot, 'data', 'jobs.json'), JSON.stringify([
        {
          id: 'job-hidden',
          title: '样书',
          status: 'stopped',
          hidden: true,
          productionBookId: 'file-book',
          productionRunDir: '/app/runs/file-book/run-older',
          updatedAt: '2026-07-14T16:59:44.780Z',
        },
      ]))
      const policy = loadRescuePolicy({
        enabled: true,
        serviceRoot,
        codeWorkspace: join(serviceRoot, 'workspace'),
        recentLogLines: 2,
      })
      const incident = await createIncidentSnapshot({
        id: 'job-1',
        status: 'failed',
        updatedAt: '2026-07-15T00:00:00.000Z',
        attempts: 6,
        automaticRetryCount: 5,
        error: 'KG failed with Bearer abc.def.ghi',
        productionBookId: 'file-book',
        productionRunDir: '/app/runs/file-book/run-one',
      }, policy)

      assert.equal(incident.snapshot.run.token, '[REDACTED]')
      assert.doesNotMatch(incident.snapshot.job.error, /abc\.def\.ghi/)
      assert.match(incident.snapshot.recentLogs[0].tail, /quality failed/)
      assert.doesNotMatch(incident.snapshot.recentLogs[0].tail, /line one/)
      assert.equal(incident.snapshot.related.sameBookJobs[0].id, 'job-hidden')
      assert.equal(incident.snapshot.related.sameBookRuns.some((run) => run.stages.import === 'completed'), true)
      const stored = JSON.parse(await readFile(incident.snapshotPath, 'utf8'))
      assert.equal(stored.incidentId, incident.incidentKey)

      const prompt = buildHermesPrompt({ ...incident, policy })
      assert.match(prompt, /不得 git commit、git push/)
      assert.match(prompt, /不得修改 .*在线数据/)
      assert.match(prompt, /result\.json/)
      assert.match(prompt, /related\.sameBookJobs/)
    } finally {
      await rm(serviceRoot, { recursive: true, force: true })
    }
  })

  it('preserves transcript diagnostics when Hermes exits without writing result JSON', async () => {
    const serviceRoot = await mkdtemp(join(tmpdir(), 'hermes-rescue-no-result-test-'))
    try {
      const workspace = join(serviceRoot, 'workspace')
      const runDir = join(serviceRoot, 'runs', 'file-book', 'run-one')
      await mkdir(join(workspace, 'production-pipeline'), { recursive: true })
      await mkdir(join(runDir, 'logs'), { recursive: true })
      await writeFile(join(workspace, 'production-pipeline', 'noop.mjs'), 'export const noop = true\n')
      await execFileAsync('git', ['init'], { cwd: workspace })
      await execFileAsync('git', ['add', '.'], { cwd: workspace })
      await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline'], { cwd: workspace })
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ status: 'failed' }))
      await writeFile(join(runDir, 'logs', 'import.log'), 'Book already exists: file-book. Use --replace to overwrite.\n')

      const fakeHermes = join(serviceRoot, 'fake-hermes-no-result.mjs')
      await writeFile(fakeHermes, `
        console.log('根因：Book already exists: file-book. Use --replace to overwrite.')
        console.log('当前进展：已定位为 resume import 未自动 replace，但尚未写 result.json。')
      `)

      const policy = loadRescuePolicy({
        enabled: true,
        serviceRoot,
        codeWorkspace: workspace,
        hermes: {
          command: process.execPath,
          baseArgs: [fakeHermes],
          timeoutMs: 10_000,
        },
      })
      const outcome = await processFailedJob({
        id: 'job-no-result',
        status: 'failed',
        updatedAt: new Date().toISOString(),
        attempts: 6,
        automaticRetryCount: 5,
        productionBookId: 'file-book',
        productionRunDir: '/app/runs/file-book/run-one',
      }, policy)

      assert.equal(outcome.status, 'blocked')
      assert.match(outcome.result.rootCause, /Book already exists/)
      assert.match(outcome.result.summary, /without writing result\.json/)
      assert.match(outcome.result.summary, /resume import/)
    } finally {
      await rm(serviceRoot, { recursive: true, force: true })
    }
  })

  it('runs a mocked repair without forwarding the production console token', async () => {
    const serviceRoot = await mkdtemp(join(tmpdir(), 'hermes-rescue-integration-test-'))
    const previousToken = process.env.PRODUCTION_PIPELINE_CONSOLE_TOKEN
    try {
      process.env.PRODUCTION_PIPELINE_CONSOLE_TOKEN = 'console-secret-value'
      const workspace = join(serviceRoot, 'workspace')
      const runDir = join(serviceRoot, 'runs', 'file-book', 'run-one')
      await mkdir(join(workspace, 'production-pipeline'), { recursive: true })
      await mkdir(join(runDir, 'logs'), { recursive: true })
      await writeFile(join(workspace, 'production-pipeline', 'fix.mjs'), 'export const fixed = false\n')
      await execFileAsync('git', ['init'], { cwd: workspace })
      await execFileAsync('git', ['add', '.'], { cwd: workspace })
      await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline'], { cwd: workspace })
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ status: 'failed' }))
      await writeFile(join(runDir, 'logs', 'kg.log'), 'quality failed\n')

      const fakeHermes = join(serviceRoot, 'fake-hermes.mjs')
      await writeFile(fakeHermes, `
        import { appendFile, writeFile } from 'node:fs/promises'
        import { dirname, join } from 'node:path'
        const queryIndex = process.argv.indexOf('--query')
        const prompt = process.argv[queryIndex + 1]
        const resultPath = prompt.match(/结果文件：(.+)/)[1].trim()
        await appendFile(join(process.cwd(), 'production-pipeline', 'fix.mjs'), 'export const repaired = true\\n')
        await writeFile(join(dirname(resultPath), 'child-env.txt'), String(process.env.PRODUCTION_PIPELINE_CONSOLE_TOKEN || ''))
        await writeFile(resultPath, JSON.stringify({
          status: 'fixed',
          rootCause: 'mock failure',
          summary: 'mock fix',
          filesChanged: ['production-pipeline/fix.mjs'],
          tests: [],
          recommendedAction: 'deploy_and_resume',
          residualRisk: '',
        }))
      `)

      const policy = loadRescuePolicy({
        enabled: true,
        serviceRoot,
        codeWorkspace: workspace,
        hermes: {
          command: process.execPath,
          baseArgs: [fakeHermes],
          timeoutMs: 10_000,
        },
        repair: {
          allowedPathPrefixes: ['production-pipeline/'],
          verifyCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        },
      })
      const outcome = await processFailedJob({
        id: 'job-integration',
        status: 'failed',
        updatedAt: new Date().toISOString(),
        attempts: 6,
        automaticRetryCount: 5,
        error: 'quality failure',
        productionRunDir: '/app/runs/file-book/run-one',
      }, policy)

      assert.equal(outcome.status, 'fixed')
      assert.equal(outcome.verification.ok, true)
      assert.match(await readFile(join(workspace, 'production-pipeline', 'fix.mjs'), 'utf8'), /repaired = true/)
      assert.equal(await readFile(join(outcome.incidentDir, 'child-env.txt'), 'utf8'), '')
    } finally {
      if (previousToken === undefined) delete process.env.PRODUCTION_PIPELINE_CONSOLE_TOKEN
      else process.env.PRODUCTION_PIPELINE_CONSOLE_TOKEN = previousToken
      await rm(serviceRoot, { recursive: true, force: true })
    }
  })
})
