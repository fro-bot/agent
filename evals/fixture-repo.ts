import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

const FIXTURE_COMMIT_DATE = '2000-01-01T00:00:00.000Z'

export interface FixtureRepo {
  readonly path: string
  readonly headSha: string
}

function assertSafeRelativePath(root: string, filePath: string): string {
  const absolutePath = path.resolve(root, filePath)
  const relativePath = path.relative(root, absolutePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Fixture file path escapes repository root: ${filePath}`)
  }

  return absolutePath
}

export function createFixtureRepo(files: Readonly<Record<string, string>>): FixtureRepo {
  if (Object.keys(files).length === 0) {
    throw new Error('Fixture repository requires at least one file')
  }

  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'fro-bot-eval-repo-'))

  try {
    execFileSync('git', ['init', '-b', 'main'], {cwd: repoPath, stdio: 'pipe'})
    execFileSync('git', ['config', 'user.name', 'Fro Bot Eval'], {cwd: repoPath, stdio: 'pipe'})
    execFileSync('git', ['config', 'user.email', 'fro-bot-eval@example.test'], {cwd: repoPath, stdio: 'pipe'})
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {cwd: repoPath, stdio: 'pipe'})

    for (const [filePath, content] of Object.entries(files)) {
      const absolutePath = assertSafeRelativePath(repoPath, filePath)
      mkdirSync(path.dirname(absolutePath), {recursive: true})
      writeFileSync(absolutePath, content, 'utf8')
    }

    execFileSync('git', ['add', '--all'], {cwd: repoPath, stdio: 'pipe'})
    execFileSync('git', ['commit', '-m', 'fixture'], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE,
        GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE,
      },
      stdio: 'pipe',
    })
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoPath, encoding: 'utf8'}).trim()

    return {path: repoPath, headSha}
  } catch (error) {
    rmSync(repoPath, {recursive: true, force: true})
    throw error
  }
}

export function cleanupFixtureRepo(repo: FixtureRepo): void {
  rmSync(repo.path, {recursive: true, force: true})
}
