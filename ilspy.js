import * as fs from 'fs/promises';
import * as path from 'path';
import { execAsync } from './utils.js';

function isWindows() {
  return process.platform === 'win32';
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
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

  if (await exists(localBin)) return localBin;
  throw new Error('Failed to resolve ilspycmd. Set ILSPY_CMD to its path or install dotnet tool.');
}


