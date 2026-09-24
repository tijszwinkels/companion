import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { BridgeTool } from '../../src/agents/claude/bridge-tools.ts';
import { McpStdioServer } from '../../src/agents/claude/mcp-stdio.ts';
import {
  maximumToolImageBase64Length,
  type ToolOutput,
} from '../../src/agents/claude/tool-output.ts';

/** A tool returning a fixed output, with an empty argument schema. */
function fixedTool(name: string, output: string | ToolOutput): BridgeTool {
  return {
    name,
    description: `Synthetic ${name}`,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return output;
    },
  };
}

/** The real stdio server over in-memory streams, answering one call. */
async function callTool(tools: BridgeTool[], name: string): Promise<Record<string, any>> {
  const input = new PassThrough();
  const lines: string[] = [];
  const server = new McpStdioServer(tools, '', {
    input,
    write: (line) => {
      lines.push(line);
    },
  });
  const served = server.serve();

  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_synthetic' } },
    }) + '\n',
  );

  // The call resolves asynchronously; wait for its reply, then end stdin.
  while (lines.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  input.end();
  await served;

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  return JSON.parse(lines[0]) as Record<string, any>;
}

const syntheticPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');

test('text results keep their single text block', async () => {
  const reply = await callTool([fixedTool('plain', 'hello')], 'plain');
  assert.deepEqual(reply.result, { content: [{ type: 'text', text: 'hello' }] });
});

test('image results send the text block, then standard MCP image blocks', async () => {
  const output: ToolOutput = {
    text: '{"region":"0,0 10x10"}',
    images: [
      { mimeType: 'image/png', data: syntheticPng },
      { mimeType: 'image/jpeg', data: '/9j/AA==' },
    ],
  };

  const reply = await callTool([fixedTool('picture', output)], 'picture');
  assert.deepEqual(reply.result, {
    content: [
      { type: 'text', text: '{"region":"0,0 10x10"}' },
      { type: 'image', data: syntheticPng, mimeType: 'image/png' },
      { type: 'image', data: '/9j/AA==', mimeType: 'image/jpeg' },
    ],
  });
});

test('images over the size bound are refused as a tool failure, not truncated', async () => {
  const exactlyAtLimit: ToolOutput = {
    text: 'at limit',
    images: [{ mimeType: 'image/png', data: 'A'.repeat(maximumToolImageBase64Length) }],
  };
  const atLimit = await callTool([fixedTool('big', exactlyAtLimit)], 'big');
  assert.equal(atLimit.result.isError, undefined);
  assert.equal(atLimit.result.content[1].data.length, maximumToolImageBase64Length);

  // The bound covers the sum of all images in one result.
  const overLimit: ToolOutput = {
    text: 'too large',
    images: [
      { mimeType: 'image/png', data: 'A'.repeat(maximumToolImageBase64Length - 10) },
      { mimeType: 'image/png', data: 'A'.repeat(11) },
    ],
  };
  const refused = await callTool([fixedTool('huge', overLimit)], 'huge');
  assert.deepEqual(refused.result, {
    content: [{ type: 'text', text: "The tool's images exceed the 5 MiB result limit." }],
    isError: true,
  });
});

test('unsupported image types are refused', async () => {
  const output = {
    text: 'svg',
    images: [{ mimeType: 'image/svg+xml', data: 'PHN2Zy8+' }],
  } as unknown as ToolOutput;

  const reply = await callTool([fixedTool('vector', output)], 'vector');
  assert.deepEqual(reply.result, {
    content: [{ type: 'text', text: 'The tool returned an unsupported image.' }],
    isError: true,
  });
});
