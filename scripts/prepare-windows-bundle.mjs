import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'win32') {
  process.exit(0);
}

const projectRoot = process.cwd();
const targetDir = path.join(projectRoot, 'src-tauri', 'target');
const releaseDir = path.join(targetDir, 'release');
const bundleDir = path.join(releaseDir, 'bundle');
const bundleTargets = [
  path.join(bundleDir, 'nsis'),
  path.join(bundleDir, 'msi'),
];

await ensureDirectories([targetDir, releaseDir, bundleDir, ...bundleTargets]);
await removeOldBundles(bundleTargets);
markNoIndex([targetDir, releaseDir, bundleDir, ...bundleTargets]);

async function ensureDirectories(directories) {
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }
}

async function removeOldBundles(directories) {
  for (const directory of directories) {
    const entries = await safeReadDir(directory);
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (!lowerName.endsWith('.exe') && !lowerName.endsWith('.msi')) {
        continue;
      }

      await safeUnlink(path.join(directory, entry.name));
    }
  }
}

function markNoIndex(directories) {
  for (const directory of directories) {
    spawnSync('attrib', ['+I', directory, '/S', '/D'], {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
  }
}

async function safeReadDir(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore stale or locked artifacts; the bundler can overwrite when unlocked.
  }
}