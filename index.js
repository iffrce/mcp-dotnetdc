#!/usr/bin/env node

import 'dotenv/config';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';
import { SERVER_NAME, PACKAGE_VERSION, CACHE_TTL_MS, CACHE_ROOT, MAX_CONCURRENCY, MAX_FILES, MAX_BYTES } from './constants.js';
import { execAsync, withConcurrencyLimitFactory, buildKey } from './utils.js';
import { createInMemoryCache } from './cache.js';
import { createServer } from './server.js';
import { createExecLimiter, decompileAndSplit, extractNamespaces } from './decompiler.js';
import { resolveIlspycmd } from './ilspy.js';

const withConcurrencyLimit = await withConcurrencyLimitFactory(MAX_CONCURRENCY);
const { maybeCached } = createInMemoryCache(CACHE_TTL_MS);
const runExec = createExecLimiter(withConcurrencyLimit);

class DecompilerService {
  async decompileDotnetAssembly(assemblyPath, { typeName = null, language = null } = {}) {
    const execPromise = promisify(exec);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnetdc-'));
    try {
      await fs.access(assemblyPath);

      const args = [];
      args.push(`-o "${tempDir}"`);
      if (typeName) {
        args.push(`-t "${typeName}"`);
      }

      const ilspy = await resolveIlspycmd();
      const cmd = `${ilspy} ${args.join(' ')} "${assemblyPath}"`;

      try {
        await execPromise(cmd);
      } catch (err) {
        throw new Error(
          `ilspycmd not available or failed to run. Please install .NET SDK and ilspycmd (dotnet tool install -g ilspycmd), then re-run this MCP tool. Do not call ilspycmd directly. Detail: ${err.message}`
        );
      }

      const collectedFiles = [];
      async function collect(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await collect(full);
          } else if (entry.isFile()) {
            const lower = entry.name.toLowerCase();
            if (lower.endsWith('.cs') || lower.endsWith('.il')) {
              collectedFiles.push(full);
            }
          }
        }
      }
      await collect(tempDir);

      if (collectedFiles.length === 0) {
        throw new Error('ilspycmd produced no source files');
      }

      const parts = [];
      for (const filePath of collectedFiles) {
        const code = await fs.readFile(filePath, 'utf8');
        parts.push(`// File: ${path.relative(tempDir, filePath)}\n${code}`);
      }

      return parts.join('\n\n');
    } catch (error) {
      throw new Error(`Failed to decompile .NET assembly: ${error.message}`);
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`Error cleaning up temporary directory: ${cleanupError.message}`);
      }
    }
  }

  async decompileDotnetAssemblyToDir(assemblyPath, outputDir, { typeName = null } = {}) {
    const execPromise = promisify(exec);
    try {
      await fs.access(assemblyPath);
      await fs.mkdir(outputDir, { recursive: true });

      const args = [];
      args.push(`-o "${outputDir}"`);
      if (typeName) {
        args.push(`-t "${typeName}"`);
      }
      const ilspy = await resolveIlspycmd();
      const cmd = `${ilspy} ${args.join(' ')} "${assemblyPath}"`;
      try {
        await execPromise(cmd);
      } catch (err) {
        throw new Error(
          `ilspycmd not available or failed to run. Please install .NET SDK and ilspycmd (dotnet tool install -g ilspycmd), then re-run this MCP tool. Do not call ilspycmd directly. Detail: ${err.message}`
        );
      }

      // Walk outputDir and list files
      const files = [];
      async function collect(dir, root) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await collect(full, root);
          } else if (entry.isFile()) {
            files.push(path.relative(root, full));
          }
        }
      }
      await collect(outputDir, outputDir);
      return files.sort();
    } catch (error) {
      throw new Error(`Failed to decompile .NET assembly to directory: ${error.message}`);
    }
  }

  async listNamespaces(assemblyPath, { typeName = null } = {}) {
    const { combined } = await decompileAndSplit({ assemblyPath, typeName, runExec });
    return Array.from(new Set(extractNamespaces(combined))).sort();
  }

  async decompilePerNamespaceToDir(assemblyPath, outputDir, { typeName = null } = {}) {
    const { usingLines, nsMap } = await decompileAndSplit({ assemblyPath, typeName, runExec });
    try {
      await fs.mkdir(outputDir, { recursive: true });
      const written = [];
      for (const [ns, code] of nsMap.entries()) {
        const safeName = ns === '(global)' ? 'global' : ns.replace(/\./g, '_');
        const filePath = path.join(outputDir, `${safeName}.cs`);
        const fileScoped = /;\s*$/.test(ns) ? ns : `namespace ${ns};`;
        const finalCode = `${usingLines}\n\n${fileScoped}\n\n${code}\n`;
        await fs.writeFile(filePath, finalCode, 'utf8');
        written.push(path.basename(filePath));
      }
      return written.sort();
    } catch (error) {
      throw new Error(`Failed to write per-namespace files: ${error.message}`);
    }
  }

  async decompileSelectedNamespaces(assemblyPath, namespaces, { typeName = null } = {}) {
    if (!Array.isArray(namespaces) || namespaces.length === 0) {
      throw new Error('namespaces must be a non-empty array');
    }
    const { usingLines, nsMap } = await decompileAndSplit({ assemblyPath, typeName, runExec });
    const selected = new Map();
    const want = new Set(namespaces);
    for (const [ns, code] of nsMap.entries()) {
      if ([...want].some(w => ns === w || ns.startsWith(w + '.'))) {
        selected.set(ns, code);
      }
    }
    if (selected.size === 0) {
      return '';
    }
    const parts = [];
    for (const [ns, code] of selected.entries()) {
      const fileScoped = /;\s*$/.test(ns) ? ns : `namespace ${ns};`;
      parts.push(`${usingLines}\n\n${fileScoped}\n\n${code}\n`);
    }
    return parts.join('\n');
  }

  async decompileSelectedNamespacesToDir(assemblyPath, outputDir, namespaces, { typeName = null } = {}) {
    if (!Array.isArray(namespaces) || namespaces.length === 0) {
      throw new Error('namespaces must be a non-empty array');
    }
    const { usingLines, nsMap } = await decompileAndSplit({ assemblyPath, typeName, runExec });
    await fs.mkdir(outputDir, { recursive: true });
    const written = [];
    for (const [ns, code] of nsMap.entries()) {
      if (namespaces.some(w => ns === w || ns.startsWith(w + '.'))) {
        const safeName = ns.replace(/\./g, '_');
        const filePath = path.join(outputDir, `${safeName}.cs`);
        const fileScoped = /;\s*$/.test(ns) ? ns : `namespace ${ns};`;
        const finalCode = `${usingLines}\n\n${fileScoped}\n\n${code}\n`;
        await fs.writeFile(filePath, finalCode, 'utf8');
        written.push(path.basename(filePath));
      }
    }
    return written.sort();
  }

  // moved to src/decompiler.js

  async decompileToProjectStructure(assemblyPath, outputDir, { typeName = null, includeDocs = true } = {}) {
    const { usingLines, nsMap } = await decompileAndSplit({ assemblyPath, typeName, runExec });
    const written = [];
    const typeMappings = [];
    await fs.mkdir(outputDir, { recursive: true });

    // Write a minimal csproj (incremental)
    const csproj = `<?xml version="1.0" encoding="utf-8"?>\n<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n  <ItemGroup>\n    <Compile Include="**/*.cs" />\n  </ItemGroup>\n</Project>\n`;
    await this._writeFileIfChanged(path.join(outputDir, 'Decompiled.csproj'), csproj, written, outputDir);

    for (const [ns, code] of nsMap.entries()) {
      const nsPath = ns === '(global)' ? path.join(outputDir, 'global') : path.join(outputDir, ...ns.split('.'));
      await fs.mkdir(nsPath, { recursive: true });
      const types = this._splitTypes(code);
      if (types.size === 0) {
        // Fallback: write entire namespace as a single file
        const name = ns === '(global)' ? 'Global.cs' : 'Namespace.cs';
        const fp = path.join(nsPath, name);
        const nsHeader = ns === '(global)' ? '' : `namespace ${ns};\n\n`;
        const finalCode = `${usingLines}\n\n${nsHeader}${code}\n`;
        await this._writeFileIfChanged(fp, finalCode, written, outputDir);
        continue;
      }
      for (const [typeName, typeCode] of types.entries()) {
        const fp = path.join(nsPath, `${typeName}.cs`);
        const nsHeader = ns === '(global)' ? '' : `namespace ${ns};\n\n`;
        const finalCode = `${usingLines}\n\n${nsHeader}${typeCode}\n`;
        await this._writeFileIfChanged(fp, finalCode, written, outputDir);
        typeMappings.push({ namespace: ns, typeName, file: path.relative(outputDir, fp) });
      }
    }
    // Copy XML docs if present (same basename as assembly)
    if (includeDocs) {
      const xmlPath = assemblyPath.replace(/\.(dll|exe)$/i, '.xml');
      try {
        const stat = await fs.stat(xmlPath);
        if (stat.isFile()) {
          await fs.mkdir(path.join(outputDir, 'Docs'), { recursive: true });
          const target = path.join(outputDir, 'Docs', path.basename(xmlPath));
          const xmlContent = await fs.readFile(xmlPath, 'utf8');
          await this._writeFileIfChanged(target, xmlContent, written, outputDir);
        }
      } catch {}
    }

    // Write manifest.json (incremental)
    try {
      const stat = await fs.stat(assemblyPath);
      const manifest = {
        tool: { name: SERVER_NAME, version: PACKAGE_VERSION },
        generatedAt: new Date().toISOString(),
        assembly: { path: assemblyPath, mtimeMs: stat.mtimeMs, size: stat.size },
        options: { typeName, includeDocs },
        files: written.slice().sort(),
        typeMappings,
        namespaces: Array.from(nsMap.keys()),
      };
      await this._writeFileIfChanged(path.join(outputDir, 'Decompiled.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', written, outputDir);
    } catch {}
    return written.sort();
  }

  _splitTypes(code) {
    // Very lightweight splitter for top-level types
    const result = new Map();
    const typeRegex = /(^|\n)\s*(?:public|internal|protected|private|sealed|abstract|static|partial|readonly|ref|unsafe|new|\s)*\s*(class|struct|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>]+>)?/g;
    let match;
    while ((match = typeRegex.exec(code)) !== null) {
      const start = match.index + (match[1] ? match[1].length : 0);
      const typeName = match[3];
      // Find matching braces from the first '{' after start; some records may be semicolon-ended
      let braceStart = code.indexOf('{', start);
      if (braceStart === -1) {
        // likely a record declaration without body; take until next semicolon
        const semi = code.indexOf(';', start);
        const nextIdx = semi === -1 ? code.length : semi + 1;
        const chunk = code.slice(start, nextIdx).trim();
        result.set(typeName, chunk);
        typeRegex.lastIndex = nextIdx;
        continue;
      }
      let depth = 0;
      let j = braceStart;
      while (j < code.length) {
        const ch = code[j++];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const nextIdx = j;
      const chunk = code.slice(start, nextIdx).trim();
      result.set(typeName, chunk);
      typeRegex.lastIndex = nextIdx;
    }
    return result;
  }

  buildFileTree(rootDir, relativeFiles) {
    const sep = path.sep;
    const root = { name: path.basename(rootDir) || '.', type: 'directory', children: [] };
    const index = new Map();
    index.set('', root);
    for (const rel of relativeFiles) {
      const parts = rel.split(/[\\/]+/g).filter(Boolean);
      let curPath = '';
      let curNode = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const nextPath = curPath ? curPath + '/' + part : part;
        const isFile = i === parts.length - 1 && /\.[A-Za-z0-9]+$/.test(part);
        if (!index.has(nextPath)) {
          const node = { name: part, type: isFile ? 'file' : 'directory' };
          if (!isFile) node.children = [];
          curNode.children.push(node);
          index.set(nextPath, node);
        }
        curNode = index.get(nextPath);
        curPath = nextPath;
      }
    }
    return root;
  }

  async _writeFileIfChanged(filePath, content, writtenCollector, rootDir) {
    try {
      const prev = await fs.readFile(filePath, 'utf8');
      if (prev === content) return false;
    } catch {}
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    if (writtenCollector) {
      writtenCollector.push(rootDir ? path.relative(rootDir, filePath) : filePath);
    }
    return true;
  }

  _splitByNamespace(text) {
    const result = new Map();
    const tokens = [];
    const nsRegex = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_\.]*)\s*(;|\{)/g;
    let match;
    while ((match = nsRegex.exec(text)) !== null) {
      tokens.push({ index: match.index, name: match[1], kind: match[2] === ';' ? 'file' : 'block' });
    }

    if (tokens.length === 0) {
      result.set('(global)', text);
      return result;
    }

    // Helper to push content into map
    const append = (ns, chunk) => {
      if (!chunk) return;
      const prev = result.get(ns) || '';
      result.set(ns, prev + chunk.trim() + '\n');
    };

    let cursor = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      // content before first namespace goes to global
      if (i === 0 && t.index > cursor) {
        append('(global)', text.slice(cursor, t.index));
      }

      if (t.kind === 'file') {
        // file-scoped: capture from after this declaration until next namespace or EOF
        const start = nsRegex.lastIndex; // after ';'
        const nextIdx = i + 1 < tokens.length ? tokens[i + 1].index : text.length;
        append(t.name, text.slice(start, nextIdx));
        cursor = nextIdx;
      } else {
        // block-scoped: find matching brace for this block
        let braceStart = text.indexOf('{', t.index);
        if (braceStart === -1) continue;
        let depth = 0;
        let j = braceStart;
        while (j < text.length) {
          const ch = text[j++];
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        const nextIdx = j;
        append(t.name, text.slice(braceStart + 1, nextIdx - 1));
        cursor = nextIdx;
      }
    }

    // tail after last namespace
    if (cursor < text.length) {
      append('(global)', text.slice(cursor));
    }

    return result;
  }
}

const decompilerService = new DecompilerService();

const { server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = createServer();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'decompile-dotnet-assembly',
        description: 'Decompiles a .NET assembly (.dll/.exe). Optionally target a specific type.',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: {
              type: 'string',
              description: 'Absolute path to the .NET assembly (.dll or .exe)',
            },
            typeName: {
              type: 'string',
              description: 'Optional fully qualified type name to decompile (e.g., Namespace.TypeName)',
            },
            language: {
              type: 'string',
              description: 'Optional language for output (e.g., CSharp or IL) if supported by ilspycmd',
            },
          },
          required: ['assemblyPath'],
        },
      },
      {
        name: 'list-dotnet-namespaces',
        description: 'Lists namespaces found in a .NET assembly (optionally restrict to a type).',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: { type: 'string', description: 'Absolute path to the .NET assembly' },
            typeName: { type: 'string', description: 'Optional fully qualified type name' }
          },
          required: ['assemblyPath']
        }
      },
      {
        name: 'decompile-selected-namespaces',
        description: 'Decompiles only selected namespaces and returns merged text output.',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: { type: 'string' },
            namespaces: { type: 'array', items: { type: 'string' } },
            typeName: { type: 'string' }
          },
          required: ['assemblyPath', 'namespaces']
        }
      },
      {
        name: 'decompile-selected-namespaces-to-dir',
        description: 'Decompiles only selected namespaces and writes one file per namespace into outputDir.',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: { type: 'string' },
            outputDir: { type: 'string' },
            namespaces: { type: 'array', items: { type: 'string' } },
            typeName: { type: 'string' }
          },
          required: ['assemblyPath', 'outputDir', 'namespaces']
        }
      },
      {
        name: 'decompile-to-project-structure',
        description: 'Decompile an assembly into a synthetic C# project layout (csproj + namespace/type folders).',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: { type: 'string' },
            outputDir: { type: 'string' },
            typeName: { type: 'string' },
            includeDocs: { type: 'boolean', description: 'Copy XML doc file if found (default: true)' }
          },
          required: ['assemblyPath', 'outputDir']
        }
      },
      {
        name: 'decompile-per-namespace-to-dir',
        description: 'Decompile and write one file per namespace into outputDir.',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: { type: 'string' },
            outputDir: { type: 'string' },
            typeName: { type: 'string' }
          },
          required: ['assemblyPath', 'outputDir']
        }
      },
      {
        name: 'decompile-dotnet-assembly-to-dir',
        description: 'Decompiles a .NET assembly to the specified output directory, preserving multi-file structure.',
        inputSchema: {
          type: 'object',
          properties: {
            assemblyPath: {
              type: 'string',
              description: 'Absolute path to the .NET assembly (.dll or .exe)',
            },
            outputDir: {
              type: 'string',
              description: 'Directory to write decompiled files into (will be created if missing)'
            },
            typeName: {
              type: 'string',
              description: 'Optional fully qualified type name to decompile (e.g., Namespace.TypeName)'
            }
          },
          required: ['assemblyPath', 'outputDir']
        }
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name: tool, arguments: args } = request.params;

  switch (tool) {
    case 'decompile-dotnet-assembly': {
      const { assemblyPath, typeName = null, language = null } = args;
      if (!assemblyPath) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Missing assemblyPath parameter',
            },
          ],
        };
      }

      try {
        const decompiled = await maybeCached('decompile', { assemblyPath, typeName, language }, () =>
          decompilerService.decompileDotnetAssembly(assemblyPath, { typeName, language })
        );
        return {
          content: [{ type: 'text', text: decompiled }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
        };
      }
    }

    case 'list-dotnet-namespaces': {
      const { assemblyPath, typeName = null } = args;
      if (!assemblyPath) {
        return { content: [{ type: 'text', text: 'Error: Missing assemblyPath parameter' }] };
      }
      try {
        const namespaces = await maybeCached('listNamespaces', { assemblyPath, typeName }, () =>
          decompilerService.listNamespaces(assemblyPath, { typeName })
        );
        return { content: [{ type: 'text', text: namespaces.join('\n') || '(none)' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    }

    case 'decompile-per-namespace-to-dir': {
      const { assemblyPath, outputDir, typeName = null } = args;
      if (!assemblyPath || !outputDir) {
        return { content: [{ type: 'text', text: 'Error: Missing assemblyPath or outputDir parameter' }] };
      }
      try {
        const files = await maybeCached('perNamespace', { assemblyPath, outputDir, typeName }, () =>
          decompilerService.decompilePerNamespaceToDir(assemblyPath, outputDir, { typeName })
        );
        const summary = `Wrote ${files.length} files to ${outputDir}\n` + files.map(f => ` - ${f}`).join('\n');
        return { content: [{ type: 'text', text: summary }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    }
    case 'decompile-dotnet-assembly-to-dir': {
      const { assemblyPath, outputDir, typeName = null } = args;
      if (!assemblyPath || !outputDir) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Missing assemblyPath or outputDir parameter',
            },
          ],
        };
      }

      try {
        const files = await maybeCached('decompileToDir', { assemblyPath, outputDir, typeName }, () =>
          decompilerService.decompileDotnetAssemblyToDir(assemblyPath, outputDir, { typeName })
        );
        const summary = `Wrote ${files.length} files to ${outputDir}\n` + files.map(f => ` - ${f}`).join('\n');
        return { content: [{ type: 'text', text: summary }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
        };
      }
    }

    case 'decompile-to-project-structure': {
      const { assemblyPath, outputDir, typeName = null, includeDocs = true } = args;
      if (!assemblyPath || !outputDir) {
        return { content: [{ type: 'text', text: 'Error: Missing assemblyPath or outputDir parameter' }] };
      }
      try {
        const files = await maybeCached('toProject', { assemblyPath, outputDir, typeName, includeDocs }, () =>
          decompilerService.decompileToProjectStructure(assemblyPath, outputDir, { typeName, includeDocs })
        );
        const tree = decompilerService.buildFileTree(outputDir, files);
        const summary = `Wrote ${files.length} files to ${outputDir}`;
        return {
          content: [
            { type: 'text', text: summary },
            { type: 'json', data: { outputDir, files, tree, stats: { fileCount: files.length, cacheRoot: CACHE_ROOT, maxFiles: MAX_FILES, maxBytes: MAX_BYTES } } }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    }

    case 'decompile-selected-namespaces': {
      const { assemblyPath, namespaces, typeName = null } = args;
      if (!assemblyPath || !Array.isArray(namespaces) || namespaces.length === 0) {
        return { content: [{ type: 'text', text: 'Error: Missing assemblyPath or namespaces[]' }] };
      }
      try {
        const text = await maybeCached('selectedNs', { assemblyPath, namespaces, typeName }, () =>
          decompilerService.decompileSelectedNamespaces(assemblyPath, namespaces, { typeName })
        );
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    }

    case 'decompile-selected-namespaces-to-dir': {
      const { assemblyPath, outputDir, namespaces, typeName = null } = args;
      if (!assemblyPath || !outputDir || !Array.isArray(namespaces) || namespaces.length === 0) {
        return { content: [{ type: 'text', text: 'Error: Missing assemblyPath, outputDir or namespaces[]' }] };
      }
      try {
        const files = await maybeCached('selectedNsDir', { assemblyPath, outputDir, namespaces, typeName }, () =>
          decompilerService.decompileSelectedNamespacesToDir(assemblyPath, outputDir, namespaces, { typeName })
        );
        const summary = `Wrote ${files.length} files to ${outputDir}\n` + files.map(f => ` - ${f}`).join('\n');
        return { content: [{ type: 'text', text: summary }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Error: Unknown tool ${tool}` }],
      };
  }
});

async function main() {
  try {
    console.error(`
---------------------------------------------
MCP .NET Decompiler Server v${PACKAGE_VERSION}
---------------------------------------------
Model Context Protocol (MCP) server that
decompiles .NET assemblies into readable source
---------------------------------------------
`);

    console.error('Starting in stdio mode...');
    console.error('Use this mode when connecting through an MCP client');

    const transport = new StdioServerTransport();

    await server.connect(transport);

    console.error('MCP .NET Decompiler server running on stdio');

    process.on('SIGINT', () => {
      console.error('\nShutting down MCP .NET Decompiler server...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error('\nShutting down MCP .NET Decompiler server...');
      process.exit(0);
    });
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});


