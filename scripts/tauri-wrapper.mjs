import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const isWindowsBuild = process.platform === 'win32' && args[0] === 'build';
const buildStartedAt = Date.now();
const expectedBundles = await resolveExpectedBundles(args);

const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
const commandArgs =
  process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', 'tauri', ...args] : ['tauri', ...args];
const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  stdio: ['inherit', 'pipe', 'pipe'],
});

let combinedOutput = '';

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  combinedOutput += text;
  process.stdout.write(text);
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  combinedOutput += text;
  process.stderr.write(text);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('close', async (code) => {
  if (code === 0 || !isWindowsBuild) {
    process.exit(code ?? 0);
    return;
  }

  const hasLockError = /os error 32|另一个程序正在使用此文件/.test(combinedOutput);
  if (!hasLockError) {
    process.exit(code ?? 1);
    return;
  }

  const artifacts = await findRecentBundleArtifacts(buildStartedAt, expectedBundles);
  if (!artifacts) {
    process.exit(code ?? 1);
    return;
  }

  const unlocked = await waitForUnlockedArtifacts(artifacts, 12, 500);
  if (!unlocked) {
    process.exit(code ?? 1);
    return;
  }

  console.warn(
    `Windows bundle file lock detected after artifact generation; using produced artifacts: ${artifacts.map((artifact) => artifact.relativePath).join(', ')}`,
  );
  process.exit(0);
});

async function resolveExpectedBundles(cliArgs) {
  const requestedBundles = parseBundlesFromArgs(cliArgs);
  if (requestedBundles) {
    return requestedBundles;
  }

  const configPath = path.join(process.cwd(), 'src-tauri', 'tauri.conf.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    const targets = config?.bundle?.targets;
    if (targets === 'all') {
      return ['nsis'];
    }

    if (typeof targets === 'string') {
      return [targets];
    }
  } catch {
    return ['nsis'];
  }

  return ['nsis'];
}

function parseBundlesFromArgs(cliArgs) {
  const bundleFlagIndex = cliArgs.findIndex((arg) => arg === '--bundles' || arg === '-b');
  if (bundleFlagIndex === -1) {
    return null;
  }

  const bundleArg = cliArgs[bundleFlagIndex + 1];
  if (!bundleArg) {
    return null;
  }

  return bundleArg
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function findRecentBundleArtifacts(startTime, bundles) {
  const bundleDir = path.join(process.cwd(), 'src-tauri', 'target', 'release', 'bundle');
  const artifacts = [];

  for (const bundle of bundles) {
    const dir = path.join(bundleDir, bundle);
    const entries = await safeReadDir(dir);
    let latest = null;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const stat = await safeStat(fullPath);
      if (!stat || stat.mtimeMs < startTime) {
        continue;
      }

      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = {
          fullPath,
          bundle,
          relativePath: path.relative(process.cwd(), fullPath),
          mtimeMs: stat.mtimeMs,
        };
      }
    }

    if (!latest) {
      return null;
    }

    artifacts.push(latest);
  }

  return artifacts;
}

async function waitForUnlockedArtifacts(artifacts, attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let allUnlocked = true;
    for (const artifact of artifacts) {
      const handle = await tryOpen(artifact.fullPath);
      if (!handle) {
        allUnlocked = false;
        break;
      }

      await handle.close();
    }

    if (allUnlocked) {
      return true;
    }

    await delay(delayMs);
  }

  return false;
}

async function tryOpen(filePath) {
  try {
    return await fs.open(filePath, 'r+');
  } catch {
    return null;
  }
}

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}