import { runMcpStdio } from '../mcp.ts';

const served = runMcpStdio();
if (process.env.MCP_SENTINEL === '1') {
  console.log('MCP_SENTINEL_LOG');
  console.info('MCP_SENTINEL_INFO');
  console.warn('MCP_SENTINEL_WARN');
  console.error('MCP_SENTINEL_ERROR');
  console.dir({ sentinel: 'MCP_SENTINEL_DIR' });
  console.table([{ sentinel: 'MCP_SENTINEL_TABLE' }]);
  console.assert(false, 'MCP_SENTINEL_ASSERT');
  console.count('MCP_SENTINEL_COUNT');
  console.group('MCP_SENTINEL_GROUP');
  console.groupEnd();
  console.trace('MCP_SENTINEL_TRACE');
}
await served;
