# MCP .NET Decompiler Server (mcp-dotnetdc)

A Model Context Protocol (MCP) server that decompiles .NET assemblies (.dll/.exe) using ILSpy's command-line tool (ilspycmd). Returns decompiled source code via MCP stdio.

[![npm version](https://img.shields.io/npm/v/%40iffrce%2Fmcp-dotnetdc.svg)](https://www.npmjs.com/package/@iffrce/mcp-dotnetdc)
[![npm downloads](https://img.shields.io/npm/dm/%40iffrce%2Fmcp-dotnetdc.svg)](https://www.npmjs.com/package/@iffrce/mcp-dotnetdc)

## Features

- Decompile entire .NET assemblies
- Target a specific type via fully qualified name
- Output language selectable (e.g., CSharp or IL) depending on ilspycmd support
- Write outputs by namespace or selected namespaces to a directory
- Generate a synthetic C# project layout (csproj + namespace/type folders)
- List namespaces present in an assembly (optionally scoped to a type)
- Clean temp directory management, basic output size/bytes limits, simple in-memory caching
- MCP stdio transport

## Prerequisites

- Node.js 16+
- .NET SDK
- ilspycmd
  - Resolution order: `ILSPY_CMD` env var > project-local `./tools/ilspycmd` > `ilspycmd` on PATH > attempt local install via `dotnet tool` into `./tools`
  - Optional global install: `dotnet tool install -g ilspycmd`

## Run

### Quick start (recommended)

Run without cloning the repo (npx will fetch the package and start the stdio server):

```bash
npx -y -p @iffrce/mcp-dotnetdc -- mcp-dotnetdc
```

Note: For scoped packages (e.g., `@scope/pkg`), modern npx (npm exec) works best when using `-p/--package` and explicitly specifying the bin name.

### Command quick reference

```bash
# Run temporarily (no install)
npx -y -p @iffrce/mcp-dotnetdc -- mcp-dotnetdc

# Global install and run
npm i -g @iffrce/mcp-dotnetdc
mcp-dotnetdc

# Local development (npm link)
npm link
mcp-dotnetdc

# MCP Inspector (from source)
npx @modelcontextprotocol/inspector node ./index.js

# Specify ilspycmd path (e.g., .NET global tool)
ILSPY_CMD="$HOME/.dotnet/tools/ilspycmd" npx -y -p @iffrce/mcp-dotnetdc -- mcp-dotnetdc
```

### Run from source

```bash
npm install
npm start
```

### As an MCP server

Use any MCP client and point it to run this server. Example with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node ./index.js
```

### Run via npx (MCP client example)

```json
{
  "command": "npx",
  "args": ["-y","@iffrce/mcp-dotnetdc"]
}
```

Note: Running `npx -y @iffrce/mcp-dotnetdc` from a directory having the same package name may resolve the local project and fail to find the bin. Prefer the explicit form above or run from outside the repo.

### Global install

```bash
npm i -g @iffrce/mcp-dotnetdc
mcp-dotnetdc
```

### Local development (source)

```bash
npm link
mcp-dotnetdc
```

## MCP Tools

### decompile-dotnet-assembly

- `assemblyPath` (required): Absolute path to .dll or .exe
- `typeName` (optional): Fully qualified type name (e.g., `Namespace.TypeName`)
- `language` (optional): Output language, e.g., `CSharp` or `IL`

### list-dotnet-namespaces

- `assemblyPath` (required)
- `typeName` (optional)

### decompile-per-namespace-to-dir

- `assemblyPath` (required)
- `outputDir` (required)
- `typeName` (optional)

### decompile-dotnet-assembly-to-dir

- `assemblyPath` (required)
- `outputDir` (required)
- `typeName` (optional)

### decompile-to-project-structure

- `assemblyPath` (required)
- `outputDir` (required)
- `typeName` (optional)
- `includeDocs` (optional, default true)

### decompile-selected-namespaces

- `assemblyPath` (required)
- `namespaces` (required, array of strings; exact or prefix match)
- `typeName` (optional)

### decompile-selected-namespaces-to-dir

- `assemblyPath` (required)
- `outputDir` (required)
- `namespaces` (required)
- `typeName` (optional)

> All results are returned over MCP stdio as text or JSON. If the output volume exceeds limits, an error is returned.

## Environment variables

- `ILSPY_CMD`: Path to the ilspycmd executable (highest precedence). Example: `/Users/you/.dotnet/tools/ilspycmd`
- `CACHE_TTL_MS`: In-memory cache TTL, default 5000
- `MAX_CONCURRENCY`: Max concurrent executions, default 2
- `MAX_FILES`: Max number of output files, default 5000
- `MAX_BYTES`: Max total output bytes, default 50MB

### .env support

From v0.1.4, the server loads environment variables from a `.env` file at process startup via `dotenv`.

Example `.env`:

```
ILSPY_CMD=/Users/you/.dotnet/tools/ilspycmd
CACHE_TTL_MS=10000
MAX_CONCURRENCY=4
```

## Cursor MCP config examples (.cursor/mcp.json)

```json
{
  "mcpServers": {
    "dotnetdc": {
      "command": "npx",
      "args": ["-y","@iffrce/mcp-dotnetdc"],
      "env": {
        "ILSPY_CMD": "/Users/you/.dotnet/tools/ilspycmd"
      }
    }
  }
}
```

## Notes

- Automatically resolves and ensures `ilspycmd` availability. If missing, the server attempts to install it as a local tool into `./tools`.
- Text output concatenates all produced `.cs`/`.il` files (with relative file headers as needed). Directory-writing tools return file lists and simple stats.

## Compatibility & platforms

- Node.js: >= 16 (recommend 18/20/22)
- .NET SDK: 8.0+ (ilspycmd must be available)
- Platforms: macOS, Linux, Windows (auto-resolves `ilspycmd.exe` on Windows)
- Limits: defaults `MAX_FILES=5000`, `MAX_BYTES≈50MB`; tunable via env vars

## Contributing

- Before PR: run `npm i`, `npm run lint`; keep formatting and style consistent.
- Commit messages: conventional style preferred (feat/fix/chore/docs).
- Issues: provide repro steps, OS, Node/.NET/package versions, and logs.

## FAQ

- Why does `npx -y @iffrce/mcp-dotnetdc` fail inside this repo?
  - When the directory name matches the package name, npx (npm exec) may resolve the local project and miss the bin. Use the explicit form `npx -y -p @iffrce/mcp-dotnetdc -- mcp-dotnetdc` or run outside the repo.
- "could not determine executable to run"?
  - Do not run `npx install -g ...`. That tries to execute a package named `install`. Use `npx -y -p @iffrce/mcp-dotnetdc -- mcp-dotnetdc` instead.
- How to specify the ilspycmd path?
  - Set `ILSPY_CMD=/absolute/path/to/ilspycmd`, or ensure `ilspycmd` is on PATH. If missing, the tool attempts a local install into `./tools`.
- How to pin an npx version?
  - `npx -y -p @iffrce/mcp-dotnetdc@0.1.4 -- mcp-dotnetdc`

## Troubleshooting

- npx error `could not determine executable to run`: avoid `npx install -g ...`; use the explicit npx form instead.
- npx `command not found`: likely running inside a same-named repo; use the explicit form or run outside.
- ilspycmd not found: set `ILSPY_CMD` or install .NET SDK and run `dotnet tool install -g ilspycmd`.
- Output too large: increase `MAX_FILES` / `MAX_BYTES`, or narrow the scope (namespace-based tools).

## License

ISC
