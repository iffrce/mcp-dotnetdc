import * as fs from 'fs/promises';
import * as path from 'path';
import { execAsync } from './utils.js';

function isWindows() {
  return process.platform === 'win32';
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function resolveBinAbsoluteFromPath() {
  try {
    const cmd = isWindows() ? 'where ilspycmd' : 'command -v ilspycmd';
    const { stdout } = await execAsync(cmd);
    const first = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (!first) return null;
    if (await exists(first)) return first;
    return null;
  } catch {
    return null;
  }
}

async function persistIlspyEnv(resolvedPath) {
  try {
    if (!resolvedPath) return;
    // Set for current process
    process.env.ILSPY_CMD = resolvedPath;

    const envFile = path.join(process.cwd(), '.env');
    let lines = [];
    try {
      const content = await fs.readFile(envFile, 'utf8');
      lines = content.split(/\r?\n/);
    } catch {}
    const key = 'ILSPY_CMD';
    const newLine = `${key}=${resolvedPath}`;
    let replaced = false;
    const out = lines
      .map(line => {
        if (line.trim().startsWith(key + '=')) {
          replaced = true;
          return newLine;
        }
        return line;
      })
      .filter((_, idx, arr) => !(idx === arr.length - 1 && arr[idx] === '' && arr.length > 1));
    if (!replaced) out.push(newLine);
    await fs.writeFile(envFile, out.join('\n') + '\n', 'utf8');
  } catch {
    // best-effort; ignore errors
  }
}

export async function resolveIlspycmd() {
  // 1) explicit env override
  const envPath = process.env.ILSPY_CMD;
  if (envPath && await exists(envPath)) return envPath;

  // 2) project local tool under ./tools
  const toolsDir = path.join(process.cwd(), 'tools');
  const localBin = path.join(toolsDir, isWindows() ? 'ilspycmd.exe' : 'ilspycmd');
  if (await exists(localBin)) return localBin;

  // 3) try global PATH first
  try {
    await execAsync('ilspycmd --version');
    const abs = await resolveBinAbsoluteFromPath();
    if (abs) {
      await persistIlspyEnv(abs);
      return abs;
    }
    return 'ilspycmd';
  } catch {}

  // 4) ensure dotnet exists
  try {
    await execAsync('dotnet --version');
  } catch {
    throw new Error('dotnet SDK not found. Please install .NET SDK or set ILSPY_CMD to ilspycmd path.');
  }

  // 5) install local tool to ./tools
  await fs.mkdir(toolsDir, { recursive: true });
  try {
    await execAsync(`dotnet tool install ilspycmd --tool-path "${toolsDir}"`);
  } catch {
    // maybe already installed -> try update
    try { await execAsync(`dotnet tool update ilspycmd --tool-path "${toolsDir}"`); } catch {}
  }

  if (await exists(localBin)) {
    await persistIlspyEnv(localBin);
    return localBin;
  }
  throw new Error('Failed to resolve ilspycmd. Set ILSPY_CMD to its path or install dotnet tool.');
}


