import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execAsync } from './utils.js';
import { resolveIlspycmd } from './ilspy.js';
import { MAX_BYTES, MAX_FILES } from './constants.js';

export function createExecLimiter(withConcurrencyLimit) {
  return (cmd, signal) => withConcurrencyLimit(() => execAsync(cmd, { signal }));
}

export async function decompileAndSplit({ assemblyPath, typeName, runExec }) {
  await fs.stat(assemblyPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnetdc-'));
  try {
    const pdb = assemblyPath.replace(/\.(dll|exe)$/i, '.pdb');
    try { const st = await fs.stat(pdb); if (st.isFile()) await fs.copyFile(pdb, path.join(tempDir, path.basename(pdb))); } catch {}
    const ilspy = await resolveIlspycmd();
    const args = [];
    args.push(`-o "${tempDir}"`);
    if (typeName) args.push(`-t "${typeName}"`);
    const cmd = `${ilspy} ${args.join(' ')} "${assemblyPath}"`;
    await runExec(cmd);
    const files = [];
    await collectCs(tempDir, files);
  if (files.length > MAX_FILES) throw new Error(`Output too large: ${files.length} files exceeds limit ${MAX_FILES}`);
  const contents = [];
  let total = 0;
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8');
    total += text.length;
    if (total > MAX_BYTES) throw new Error(`Output too large: ${total} bytes exceeds limit ${MAX_BYTES}`);
    contents.push(text);
  }
  const combined = contents.join('\n');
  const firstNsIdx = combined.search(/\bnamespace\b/);
  const headerBlock = firstNsIdx > 0 ? combined.slice(0, firstNsIdx) : '';
  const usingLines = (headerBlock.match(/^using\s+[^;]+;\s*$/gm) || []).join('\n');
  const nsMap = splitByNamespace(combined);
  return { usingLines, nsMap, combined };
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function dirExists(p) {
  try { const s = await fs.stat(p); return s.isDirectory(); } catch { return false; }
}

async function collectCs(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectCs(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.cs')) out.push(full);
  }
}

export function splitByNamespace(text) {
  const result = new Map();
  const tokens = [];
  const nsRegex = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_\.]*)\s*(;|\{)/g;
  let match;
  while ((match = nsRegex.exec(text)) !== null) {
    tokens.push({ index: match.index, name: match[1], kind: match[2] === ';' ? 'file' : 'block' });
  }
  if (tokens.length === 0) { result.set('(global)', text); return result; }
  const append = (ns, chunk) => { if (!chunk) return; const prev = result.get(ns) || ''; result.set(ns, prev + chunk.trim() + '\n'); };
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i === 0 && t.index > cursor) append('(global)', text.slice(cursor, t.index));
    if (t.kind === 'file') {
      const start = nsRegex.lastIndex;
      const nextIdx = i + 1 < tokens.length ? tokens[i + 1].index : text.length;
      append(t.name, text.slice(start, nextIdx));
      cursor = nextIdx;
    } else {
      let braceStart = text.indexOf('{', t.index);
      if (braceStart === -1) continue;
      let depth = 0; let j = braceStart;
      while (j < text.length) { const ch = text[j++]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) break; } }
      const nextIdx = j; append(t.name, text.slice(braceStart + 1, nextIdx - 1)); cursor = nextIdx;
    }
  }
  if (cursor < text.length) append('(global)', text.slice(cursor));
  return result;
}

export function extractNamespaces(text) {
  const namespaces = [];
  const re = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_\.]*)\s*(?:;|\{)/g;
  let m;
  while ((m = re.exec(text)) !== null) namespaces.push(m[1]);
  return namespaces;
}


