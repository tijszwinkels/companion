/** Real native controls/broker + opaque API + capability service/FIFO, scripted model only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { deferred, frame, signal } from '../helpers.ts';
import { applicationFixture } from '../session-apps-runtime/fixture.ts';
import { waitForRelease } from '../session-apps-runtime/chat-send-fixture.ts';
import { offscreenPlatform } from '../window/offscreen.ts';

const execute = promisify(execFile);
const build = resolve('native/window/build');

test('native sending consent and recovery API reach the real FIFO without changing trusted drafts', async (context) => {
  const fixture = await applicationFixture(context);
  const { sessions, directory } = fixture;
  await fixture.bundle(
    'native-sender',
    {
      version: 1,
      description: 'Synthetic native sender',
      application: { capabilities: ['chat.send'] },
      parameters: { type: 'object' },
      actions: {},
      queries: {},
      example: {},
    },
    `let api,handle;let report={done:true};
    export function describe(props){
      if(props.operation){
        report={done:false};
        const operation=props.operation;
        void (async()=>{
          if(operation==='prepare'){handle=await api.chat.prepareSend();return handle;}
          if(operation==='send')return await api.chat.send(handle,'Synthetic native app request');
          if(operation==='receipt')return await api.chat.receipt(handle);
          if(operation==='read')return await api.chat.read();
          throw Error('Unknown fixture operation');
        })().then(value=>{report={done:true,value,handle};},error=>{report={done:true,error:error.message,handle};});
      }
      return JSON.stringify(report);
    }
    export function mount(root,value){api=value;return {update(){}};}`,
  );
  const id = sessions.start(frame, signal());
  fixture.script(id, async (turn) => {
    await turn.tool('companion_app_apply', {
      bundle: 'native-sender',
      expectedVersion: 0,
      eventMode: 'next-input',
    });
  });
  await sessions.idle();
  const held = deferred<void>();
  fixture.script(id, async (turn) => {
    assert.match(turn.text, /^\[Companion application message\]/);
    await waitForRelease(held, turn.signal);
  });
  const commands: any[] = [];
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk.toString();
      if (request.url === '/control' && text) {
        const command = JSON.parse(text);
        commands.push(command);
        if (command.action === 'set-application-chat-send') {
          assert.equal(command.id, id);
          await sessions.setApplicationChatSend(id, {
            applicationId: command.applicationId,
            version: command.version,
            revision: command.revision,
            allowed: command.allowed,
          });
        } else if (command.action === 'stop') {
          await sessions.stop(id);
        } else {
          throw Error('Unsupported fixture command');
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ session: fixture.view(id) }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  context.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const control = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/control';
  const runtime = join(directory, 'native-runtime');
  await mkdir(runtime, { mode: 0o700 });
  const template = await readFile(new URL('./send-ui.qml.in', import.meta.url), 'utf8');
  const qml = join(directory, 'tst_send_ui.qml');
  await writeFile(
    qml,
    template
      .replaceAll('@WINDOW@', new URL('../../integrations/window', import.meta.url).href)
      .replaceAll('@CONTROL_URL@', control)
      .replaceAll('@SESSION_ID@', id),
  );
  try {
    const result = await execute(
      join(build, 'companion-window-tests'),
      ['-input', qml, '-nocrashhandler'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: join(directory, 'config'),
          XDG_CACHE_HOME: join(directory, 'cache'),
          XDG_RUNTIME_DIR: runtime,
          QT_QPA_PLATFORM: await offscreenPlatform(directory),
          QT_QUICK_BACKEND: 'software',
          QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu',
          QML_IMPORT_PATH: join(build, 'qml'),
          COMPANION_TEST_SESSION_SURFACE: 'html',
        },
        timeout: 90000,
        killSignal: 'SIGKILL',
      },
    );
    assert.match(result.stdout, /Totals: 3 passed, 0 failed/);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw Error([String(error), output.stdout, output.stderr].join('\n'));
  }
  assert.equal(
    commands.filter((command) => command.action === 'set-application-chat-send' && command.allowed)
      .length,
    1,
  );
  assert.equal(
    fixture.turns.filter((turn) => turn.text.startsWith('[Companion application message]')).length,
    1,
  );
  assert.equal(fixture.view(id).application!.chatAccess!.send!.allowed, false);
});
