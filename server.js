import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, PACKAGE_VERSION } from './constants.js';

export function createServer() {
  const server = new Server(
    { name: SERVER_NAME, version: PACKAGE_VERSION, description: 'MCP server for decompiling .NET assemblies' },
    { capabilities: { tools: {} } }
  );
  return { server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema };
}


