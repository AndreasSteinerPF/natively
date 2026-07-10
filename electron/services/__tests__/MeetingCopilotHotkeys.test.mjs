import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const compiledKeybindManagerPath = path.resolve(repoRoot, 'dist-electron/electron/services/KeybindManager.js');
const compiledHotkeysPath = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot/hotkeys.js');
const compiledActionConfigPath = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot/defaultActionConfig.js');
const mainSourcePath = path.resolve(repoRoot, 'electron/main.ts');

const realLoad = Module._load;

let currentUserDataDir = '';
let registrations = [];
let registrationLog = [];
let windows = [];
let applicationMenu = null;
let forcedRegistrationFailures = new Set();

function installElectronStub() {
  registrations = [];
  registrationLog = [];
  windows = [
    {
      isDestroyed: () => false,
      webContents: {
        send(channel, payload) {
          registrationLog.push({ channel, payload });
        },
      },
    },
  ];
  applicationMenu = null;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath(name) {
            if (name === 'userData') return currentUserDataDir;
            return currentUserDataDir;
          },
          name: 'Natively',
        },
        globalShortcut: {
          register(accelerator, callback) {
            if (forcedRegistrationFailures.has(accelerator)) {
              return true;
            }
            registrations.push({ accelerator, callback });
            return true;
          },
          isRegistered(accelerator) {
            return registrations.some((entry) => entry.accelerator === accelerator);
          },
          unregisterAll() {
            registrations = [];
          },
        },
        Menu: {
          buildFromTemplate(template) {
            applicationMenu = template;
            return template;
          },
          setApplicationMenu(menu) {
            applicationMenu = menu;
          },
        },
        BrowserWindow: {
          getAllWindows() {
            return windows;
          },
        },
        ipcMain: {
          removeHandler() {},
          handle() {},
          removeAllListeners() {},
          on() {},
        },
      };
    }
    return realLoad.call(this, request, parent, isMain);
  };
}

function uninstallElectronStub() {
  Module._load = realLoad;
}

async function loadKeybindManagerModule() {
  delete require.cache[compiledKeybindManagerPath];
  return import(pathToFileURL(compiledKeybindManagerPath).href);
}

async function loadHotkeysModule() {
  delete require.cache[compiledHotkeysPath];
  return import(pathToFileURL(compiledHotkeysPath).href);
}

async function loadActionConfigModule() {
  delete require.cache[compiledActionConfigPath];
  return import(pathToFileURL(compiledActionConfigPath).href);
}

beforeEach(() => {
  currentUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-hotkeys-'));
  forcedRegistrationFailures = new Set();
  installElectronStub();
});

afterEach(() => {
  uninstallElectronStub();
  if (currentUserDataDir) {
    fs.rmSync(currentUserDataDir, { recursive: true, force: true });
    currentUserDataDir = '';
  }
  try {
    const { KeybindManager } = require(compiledKeybindManagerPath);
    KeybindManager.instance = undefined;
  } catch {
    // Ignore if the module has not been loaded in this test.
  }
});

describe('meeting-copilot hotkeys', () => {
  test('default keybinds include the three Meeting Copilot accelerators', async () => {
    const { KeybindManager } = await loadKeybindManagerModule();
    KeybindManager.instance = undefined;
    const manager = KeybindManager.getInstance();

    assert.deepEqual(
      [
        manager.getKeybind('meeting-copilot:quick-answer'),
        manager.getKeybind('meeting-copilot:deep-answer'),
        manager.getKeybind('meeting-copilot:tech-solver-parallel'),
      ],
      [
        'Command+Shift+1',
        'Command+Shift+2',
        'Command+Shift+3',
      ]
    );
  });

  test('persisted overrides still load for Meeting Copilot keybind ids', async () => {
    fs.writeFileSync(
      path.join(currentUserDataDir, 'keybinds.json'),
      JSON.stringify(
        [
          { id: 'meeting-copilot:quick-answer', accelerator: 'Command+Shift+9' },
          { id: 'meeting-copilot:deep-answer', accelerator: 'Command+Shift+0' },
        ],
        null,
        2,
      )
    );

    const { KeybindManager } = await loadKeybindManagerModule();
    KeybindManager.instance = undefined;
    const manager = KeybindManager.getInstance();

    assert.equal(manager.getKeybind('meeting-copilot:quick-answer'), 'Command+Shift+9');
    assert.equal(manager.getKeybind('meeting-copilot:deep-answer'), 'Command+Shift+0');
  });

  test('launcher mode registers Meeting Copilot shortcuts through registerGlobalShortcuts', async () => {
    const { KeybindManager } = await loadKeybindManagerModule();
    KeybindManager.instance = undefined;
    const manager = KeybindManager.getInstance();

    manager.setMode('launcher');
    manager.registerGlobalShortcuts();

    const shortcutIds = registrations.map((entry) => entry.accelerator);
    assert.ok(shortcutIds.includes('Command+Shift+1'));
    assert.ok(shortcutIds.includes('Command+Shift+3'));

    const meetingCopilotIds = [
      'meeting-copilot:quick-answer',
      'meeting-copilot:deep-answer',
      'meeting-copilot:tech-solver-parallel',
    ];
    for (const id of meetingCopilotIds) {
      assert.ok(
        registrations.some((entry) => entry.callback && manager.getKeybind(id) === entry.accelerator),
        `expected ${id} to be registered in launcher mode`
      );
    }
  });

  test('registration-failed events include the failed Meeting Copilot hotkey id and accelerator', async () => {
    forcedRegistrationFailures = new Set(['Command+Shift+1']);
    const { KeybindManager } = await loadKeybindManagerModule();
    KeybindManager.instance = undefined;
    const manager = KeybindManager.getInstance();

    manager.setMode('launcher');
    manager.registerGlobalShortcuts();

    assert.equal(registrations.some((entry) => entry.accelerator === 'Command+Shift+1'), false);
    assert.deepEqual(registrationLog[0], {
      channel: 'keybinds:registration-failed',
      payload: {
        id: 'meeting-copilot:quick-answer',
        accelerator: 'Command+Shift+1',
      },
    });
  });

  test('hotkey ids map to Meeting Copilot action:start payloads', async () => {
    const { toMeetingCopilotActionStartPayload, MEETING_COPILOT_HOTKEY_BINDINGS } = await loadHotkeysModule();

    assert.deepEqual(MEETING_COPILOT_HOTKEY_BINDINGS.map((binding) => binding.actionId), [
      'quick-answer',
      'deep-answer',
      'tech-solver-parallel',
    ]);
    assert.deepEqual(toMeetingCopilotActionStartPayload('meeting-copilot:quick-answer'), {
      type: 'action:start',
      actionId: 'quick-answer',
    });
    assert.deepEqual(toMeetingCopilotActionStartPayload('meeting-copilot:tech-solver-parallel'), {
      type: 'action:start',
      actionId: 'tech-solver-parallel',
    });
    assert.equal(toMeetingCopilotActionStartPayload('chat:whatToAnswer'), null);
  });

  test('active Meeting Copilot config can remap hotkey slots to preset-specific action ids', async () => {
    const {
      MEETING_COPILOT_HOTKEY_BINDINGS,
      configureMeetingCopilotHotkeyBindings,
      setMeetingCopilotActionStarter,
      startMeetingCopilotActionForKeybind,
      toMeetingCopilotActionStartPayload,
    } = await loadHotkeysModule();
    const started = [];

    configureMeetingCopilotHotkeyBindings([
      { keybindId: 'meeting-copilot:quick-answer', actionId: 'guide-me' },
      { keybindId: 'meeting-copilot:deep-answer', actionId: 'go-deeper' },
    ]);
    setMeetingCopilotActionStarter((payload) => {
      started.push(payload);
    });

    assert.deepEqual(toMeetingCopilotActionStartPayload('meeting-copilot:quick-answer'), {
      type: 'action:start',
      actionId: 'guide-me',
    });
    assert.equal(await startMeetingCopilotActionForKeybind('meeting-copilot:quick-answer'), true);
    assert.deepEqual(started, [{ type: 'action:start', actionId: 'guide-me' }]);

    configureMeetingCopilotHotkeyBindings(MEETING_COPILOT_HOTKEY_BINDINGS);
    setMeetingCopilotActionStarter(null);
  });

  test('system-design preset maps Command+Shift hotkey slots to guide-me and go-deeper', async () => {
    const { buildMeetingCopilotHotkeyBindings } = await loadHotkeysModule();
    const { getDefaultMeetingCopilotConfig } = await loadActionConfigModule();
    const config = getDefaultMeetingCopilotConfig('system-design-interview');

    assert.deepEqual(buildMeetingCopilotHotkeyBindings(config.actions), [
      { keybindId: 'meeting-copilot:quick-answer', actionId: 'guide-me' },
      { keybindId: 'meeting-copilot:deep-answer', actionId: 'go-deeper' },
    ]);
  });

  test('Meeting Copilot hotkey slot accelerators stay in sync with KeybindManager defaults', async () => {
    const { MEETING_COPILOT_HOTKEY_BINDINGS } = await loadHotkeysModule();
    const { DEFAULT_KEYBINDS } = await loadKeybindManagerModule();
    const defaultAcceleratorsById = new Map(
      DEFAULT_KEYBINDS.map((keybind) => [keybind.id, keybind.defaultAccelerator])
    );

    for (const binding of MEETING_COPILOT_HOTKEY_BINDINGS) {
      assert.equal(binding.accelerator, defaultAcceleratorsById.get(binding.keybindId));
    }
  });
});

test('main source routes Meeting Copilot hotkeys through the hotkey helper', async () => {
  const source = fs.readFileSync(mainSourcePath, 'utf8');
  assert.match(source, /startMeetingCopilotActionForKeybind/);
  assert.match(source, /startMeetingCopilotActionForKeybind\(actionId\)/);
});
