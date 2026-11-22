/**
 * The microphone permission of the gateway's page (src/remote/README.md,
 * "Microphone permission"):
 *
 * - without `allowMicrophone` every gateway response equals the recording
 *   made on the base revision (test/fixtures/gateway-base-output.json);
 * - with it, the gateway's own responses differ in exactly one header value,
 *   `microphone=(self)`;
 * - frame-origin responses keep `microphone=()` either way.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { frameFixture } from '../frame-fixture.ts';
import { recordGateway } from '../gateway-baseline.ts';

type Json = Record<string, any>;

const recordingPath = new URL('../fixtures/gateway-base-output.json', import.meta.url);

test('without --allow-microphone every gateway response equals the base recording', async () => {
  const recorded = JSON.parse(await readFile(recordingPath, 'utf8')) as Json;
  const current = await recordGateway();
  assert.deepEqual(current.http, recorded.http);
  for (const response of current.http) {
    const policy = response.headers.find(([name]: string[]) => name === 'permissions-policy');
    assert.deepEqual(policy, ['permissions-policy', 'camera=(), microphone=(), geolocation=()']);
  }
});

test('with --allow-microphone only the microphone value of Permissions-Policy differs', async () => {
  const recorded = JSON.parse(await readFile(recordingPath, 'utf8')) as Json;
  const current = await recordGateway({ allowMicrophone: true });

  const expected = structuredClone(recorded.http) as Json[];
  for (const response of expected) {
    for (const header of response.headers as string[][]) {
      if (header[0] === 'permissions-policy') {
        header[1] = 'camera=(), microphone=(self), geolocation=()';
      }
    }
  }
  assert.deepEqual(current.http, expected);
});

test('frame-origin responses keep microphone=() with --allow-microphone', async (context) => {
  const fixture = await frameFixture({ allowMicrophone: true });
  context.after(() => fixture.close());

  const gatewayPage = await fetch(fixture.origin + '/');
  await gatewayPage.arrayBuffer();
  assert.equal(
    gatewayPage.headers.get('permissions-policy'),
    'camera=(), microphone=(self), geolocation=()',
  );

  const frame = await fetch(`${fixture.frameOrigin}/f/${'a'.repeat(43)}/`);
  await frame.arrayBuffer();
  assert.equal(frame.status, 404);
  assert.equal(
    frame.headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=()',
  );
});
