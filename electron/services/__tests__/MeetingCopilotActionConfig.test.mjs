import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { DEFAULT_MEETING_COPILOT_CONFIG } = await import(
  pathToFileURL(path.join(distRoot, 'defaultActionConfig.js')).href
);
const { ActionConfigStore, validateMeetingCopilotConfig } = await import(
  pathToFileURL(path.join(distRoot, 'ActionConfigStore.js')).href
);

const REQUIRED_ACTION_IDS = [
  'quick-answer',
  'tech-solver',
  'deep-solution',
  'claim-check',
  'followups',
  'tech-solver-parallel',
];

const EXPECTED_DEFAULTS = {
  openrouterHeaders: {
    'HTTP-Referer': 'https://localhost/natively-private',
    'X-Title': 'Natively Private Fork',
  },
  actions: {
    'quick-answer': {
      model: 'google/gemini-3.5-flash',
      slash: '/quick',
      button: false,
      context_minutes: 2,
      max_tokens: 300,
      reasoning: 'low',
      temperature: 0.3,
      prompt: 'Using the recent transcript, give me a concise answer I can say out loud in 1-3 sentences. Prioritize speed and usefulness.',
    },
    'tech-solver': {
      model: 'anthropic/claude-opus-4.8-fast',
      slash: '/tech',
      button: false,
      max_tokens: 700,
      temperature: 0.25,
      max_tool_rounds: 2,
      max_tool_calls_per_round: 4,
      reasoning: 'low',
      prompt:
        'You are helping me during a live technical or AI/product meeting. Use the full transcript, pinned context, custom context, and any relevant code context. Give the best practical answer under time pressure: recommendation, key reasoning, tradeoffs/risks, and one sentence I can say out loud.',
    },
    'deep-solution': {
      model: 'anthropic/claude-opus-4.8-fast',
      slash: '/deep',
      button: false,
      max_tokens: 1200,
      temperature: 0.2,
      max_tool_rounds: 3,
      max_tool_calls_per_round: 6,
      reasoning: 'medium',
      prompt:
        'Analyze the technical/product problem deeply. Use the full transcript, pinned context, custom context, and any relevant code context. Propose the best solution, alternatives, assumptions, tradeoffs, risks, and next steps. Be specific and avoid generic advice.',
    },
    'claim-check': {
      model: 'perplexity/sonar-pro-search',
      slash: '/check',
      button: false,
      context_minutes: 5,
      max_tokens: 600,
      temperature: 0.1,
      prompt:
        'Check the last claim or proposal from the transcript. Say whether it is likely correct, uncertain, incomplete, or likely wrong. Flag assumptions, factual uncertainty, logical gaps, and what evidence would resolve it.',
    },
    followups: {
      model: 'google/gemini-3.5-flash',
      slash: '/followups',
      button: false,
      context_minutes: 3,
      max_tokens: 250,
      temperature: 0.4,
      reasoning: 'low',
      prompt:
        'Give me 3 sharp, non-confrontational follow-up questions to ask right now based on the recent transcript.',
    },
    'tech-solver-parallel': {
      slash: '/tech2',
      button: false,
      fast: {
        model: 'google/gemini-3.5-flash',
        context_minutes: 3,
        max_tokens: 350,
        temperature: 0.3,
        tools_enabled: false,
        reasoning: 'low',
        prompt:
          'Give me the fastest useful answer I can say out loud now. Keep it concise and practical.',
      },
      deep: {
        model: 'anthropic/claude-opus-4.8-fast',
        max_tokens: 900,
        temperature: 0.2,
        max_tool_rounds: 2,
        max_tool_calls_per_round: 4,
        tools_enabled: true,
        reasoning: 'medium',
        prompt:
          'Analyze more deeply. Improve, correct, or qualify the fast answer. Focus on technical correctness, AI-system design tradeoffs, hidden assumptions, and risks.',
      },
    },
  },
  code_context: {
    max_total_chars: 12000,
  },
};

let tempRoot = '';

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-config-test-'));
});

after(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function cloneConfig() {
  return structuredClone(DEFAULT_MEETING_COPILOT_CONFIG);
}

function writeOverride(dirName, value, fileName = 'meeting-copilot.config.json') {
  const dir = path.join(tempRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(value, null, 2));
  return dir;
}

describe('meeting-copilot action config defaults', () => {
  test('default config validates', () => {
    assert.doesNotThrow(() => validateMeetingCopilotConfig(cloneConfig()));
  });

  test('default config includes exactly the six required action IDs', () => {
    assert.deepEqual(Object.keys(DEFAULT_MEETING_COPILOT_CONFIG.actions), REQUIRED_ACTION_IDS);
  });

  test('default hotkeys match Command+Shift+1 through Command+Shift+6', () => {
    const hotkeys = REQUIRED_ACTION_IDS.map((id) => DEFAULT_MEETING_COPILOT_CONFIG.actions[id].trigger.hotkey);
    assert.deepEqual(hotkeys, [
      'Command+Shift+1',
      'Command+Shift+2',
      'Command+Shift+3',
      'Command+Shift+4',
      'Command+Shift+5',
      'Command+Shift+6',
    ]);
  });

  test('default hotkeys are unique', () => {
    const hotkeys = Object.values(DEFAULT_MEETING_COPILOT_CONFIG.actions).map((action) => action.trigger.hotkey);
    assert.equal(new Set(hotkeys).size, hotkeys.length);
  });

  test('default OpenRouter headers match the brief', () => {
    assert.deepEqual(
      DEFAULT_MEETING_COPILOT_CONFIG.openrouter.default_headers,
      EXPECTED_DEFAULTS.openrouterHeaders
    );
  });

  test('single-action defaults include brief model slugs, slash commands, button=false, and token/context limits', () => {
    for (const actionId of ['quick-answer', 'tech-solver', 'deep-solution', 'claim-check', 'followups']) {
      const action = DEFAULT_MEETING_COPILOT_CONFIG.actions[actionId];
      const expected = EXPECTED_DEFAULTS.actions[actionId];
      assert.equal(action.model, expected.model, `${actionId} model`);
      assert.equal(action.trigger.slash, expected.slash, `${actionId} slash`);
      assert.equal(action.trigger.button, expected.button, `${actionId} button`);
      assert.equal(action.max_tokens, expected.max_tokens, `${actionId} max_tokens`);
      assert.equal(action.temperature, expected.temperature, `${actionId} temperature`);
      assert.equal(action.prompt, expected.prompt, `${actionId} prompt`);
      if ('context_minutes' in expected) {
        assert.equal(action.context_minutes, expected.context_minutes, `${actionId} context_minutes`);
      }
      if ('max_tool_rounds' in expected) {
        assert.equal(action.max_tool_rounds, expected.max_tool_rounds, `${actionId} max_tool_rounds`);
      }
      if ('max_tool_calls_per_round' in expected) {
        assert.equal(
          action.max_tool_calls_per_round,
          expected.max_tool_calls_per_round,
          `${actionId} max_tool_calls_per_round`
        );
      }
      if ('reasoning' in expected) {
        assert.equal(action.reasoning?.effort, expected.reasoning, `${actionId} reasoning`);
      }
    }
  });

  test('quick-answer, claim-check, and followups use recent context', () => {
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['quick-answer'].context_mode, 'recent');
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['claim-check'].context_mode, 'recent');
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions.followups.context_mode, 'recent');
  });

  test('tech-solver and deep-solution use full_cached context', () => {
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver'].context_mode, 'full_cached');
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['deep-solution'].context_mode, 'full_cached');
  });

  test('tech-solver-parallel.fast uses recent context and has tools disabled', () => {
    const action = DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver-parallel'];
    const expected = EXPECTED_DEFAULTS.actions['tech-solver-parallel'].fast;
    assert.equal(action.parallel.fast.context_mode, 'recent');
    assert.equal(action.parallel.fast.model, expected.model);
    assert.equal(action.parallel.fast.context_minutes, expected.context_minutes);
    assert.equal(action.parallel.fast.max_tokens, expected.max_tokens);
    assert.equal(action.parallel.fast.temperature, expected.temperature);
    assert.equal(action.parallel.fast.reasoning?.effort, expected.reasoning);
    assert.equal(action.parallel.fast.prompt, expected.prompt);
    assert.equal(action.parallel.fast.tools_enabled, expected.tools_enabled);
  });

  test('tech-solver-parallel.deep uses full_cached context and has tools enabled', () => {
    const action = DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver-parallel'];
    const expected = EXPECTED_DEFAULTS.actions['tech-solver-parallel'].deep;
    assert.equal(action.parallel.deep.context_mode, 'full_cached');
    assert.equal(action.parallel.deep.model, expected.model);
    assert.equal(action.parallel.deep.max_tokens, expected.max_tokens);
    assert.equal(action.parallel.deep.temperature, expected.temperature);
    assert.equal(action.parallel.deep.max_tool_rounds, expected.max_tool_rounds);
    assert.equal(action.parallel.deep.max_tool_calls_per_round, expected.max_tool_calls_per_round);
    assert.equal(action.parallel.deep.reasoning?.effort, expected.reasoning);
    assert.equal(action.parallel.deep.prompt, expected.prompt);
    assert.equal(action.parallel.deep.tools_enabled, expected.tools_enabled);
  });

  test('parallel action trigger includes the brief slash command and button=false', () => {
    const action = DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver-parallel'];
    assert.equal(action.trigger.slash, EXPECTED_DEFAULTS.actions['tech-solver-parallel'].slash);
    assert.equal(action.trigger.button, EXPECTED_DEFAULTS.actions['tech-solver-parallel'].button);
  });

  test('code context limits match the brief defaults', () => {
    assert.equal(
      DEFAULT_MEETING_COPILOT_CONFIG.code_context.max_total_chars,
      EXPECTED_DEFAULTS.code_context.max_total_chars
    );
  });
});

describe('meeting-copilot action config validation', () => {
  test('invalid context mode is rejected with a useful path in the error', () => {
    const config = cloneConfig();
    config.actions['tech-solver'].context_mode = 'invalid-mode';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.tech-solver\.context_mode must be one of recent, full_cached/
    );
  });

  test('invalid cache policy is rejected', () => {
    const config = cloneConfig();
    config.actions['quick-answer'].cache_policy = 'bad-cache-policy';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.quick-answer\.cache_policy must be one of none, anthropic_explicit_5m, anthropic_explicit_1h/
    );
  });

  test('duplicate hotkeys are rejected', () => {
    const config = cloneConfig();
    config.actions['followups'].trigger.hotkey = config.actions['quick-answer'].trigger.hotkey;
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.followups\.trigger\.hotkey must be unique; duplicate Command\+Shift\+1/
    );
  });

  test('empty model is rejected', () => {
    const config = cloneConfig();
    config.actions['quick-answer'].model = '';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.quick-answer\.model must be a non-empty string/
    );
  });

  test('missing parallel deep branch is rejected', () => {
    const config = cloneConfig();
    delete config.actions['tech-solver-parallel'].parallel.deep;
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.tech-solver-parallel\.parallel\.deep must be an object/
    );
  });

  test('invalid workspace path and name are rejected', () => {
    const config = cloneConfig();
    config.workspaces = [
      {
        name: '',
        path: '',
        enabled: true,
        max_snippets: 5,
        max_snippet_chars: 1200,
      },
    ];
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /workspaces\.0\.name must be a non-empty string/
    );
  });
});

describe('ActionConfigStore', () => {
  test('loading from an override file uses the supplied configDir, not Electron globals', async () => {
    const unusedDir = writeOverride('unused', {
      actions: {
        'quick-answer': {
          label: 'Wrong directory',
        },
      },
    });
    const usedDir = writeOverride('used', {
      actions: {
        'quick-answer': {
          label: 'Overridden Quick Answer',
          trigger: {
            slash: '/qa',
          },
        },
      },
      workspaces: [
        {
          name: 'repo',
          path: '/tmp/repo',
          enabled: true,
          max_snippets: 8,
          max_snippet_chars: 1600,
        },
      ],
    });

    const store = new ActionConfigStore({
      configDir: usedDir,
      fileName: 'meeting-copilot.config.json',
    });
    const config = await store.load();

    assert.equal(config.actions['quick-answer'].label, 'Overridden Quick Answer');
    assert.equal(config.actions['quick-answer'].trigger.hotkey, 'Command+Shift+1');
    assert.equal(config.actions['quick-answer'].trigger.slash, '/qa');
    assert.equal(config.workspaces[0].path, '/tmp/repo');
    assert.equal(store.getAction('quick-answer')?.label, 'Overridden Quick Answer');
    assert.equal(store.listActions().length, 6);

    const unusedStore = new ActionConfigStore({
      configDir: unusedDir,
      fileName: 'meeting-copilot.config.json',
    });
    const unusedConfig = await unusedStore.load();
    assert.equal(unusedConfig.actions['quick-answer'].label, 'Wrong directory');
  });

  test('loadSync uses the same local override merge and validation path as async load', () => {
    const usedDir = writeOverride('used-sync', {
      actions: {
        'quick-answer': {
          label: 'Sync Quick Answer',
        },
      },
      workspaces: [
        {
          name: 'repo-sync',
          path: '/tmp/repo-sync',
          enabled: true,
          max_snippets: 8,
          max_snippet_chars: 1600,
        },
      ],
      project_context: {
        enabled: true,
        max_docs_chars_per_pack: 20_000,
        max_total_docs_chars: 40_000,
        packs: [
          {
            name: 'docs-sync',
            docsPath: '/tmp/docs-sync',
            linkedWorkspaceName: 'repo-sync',
            enabled: true,
            includeByDefault: true,
            maxDocsChars: 10_000,
          },
        ],
      },
    });

    const store = new ActionConfigStore({
      configDir: usedDir,
      fileName: 'meeting-copilot.config.json',
    });
    const config = store.loadSync();

    assert.equal(config.actions['quick-answer'].label, 'Sync Quick Answer');
    assert.equal(config.workspaces[0].name, 'repo-sync');
    assert.equal(config.project_context.packs[0].linkedWorkspaceName, 'repo-sync');
    assert.equal(store.getAction('quick-answer')?.label, 'Sync Quick Answer');
  });
});
