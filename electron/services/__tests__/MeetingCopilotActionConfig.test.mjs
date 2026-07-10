import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const {
  DEFAULT_MEETING_COPILOT_CONFIG,
  getDefaultMeetingCopilotConfig,
} = await import(
  pathToFileURL(path.join(distRoot, 'defaultActionConfig.js')).href
);
const { ActionConfigStore, validateMeetingCopilotConfig } = await import(
  pathToFileURL(path.join(distRoot, 'ActionConfigStore.js')).href
);

const REQUIRED_ACTION_IDS = [
  'quick-answer',
  'deep-answer',
  'tech-solver-parallel',
];

const SYSTEM_DESIGN_ACTION_IDS = [
  'guide-me',
  'go-deeper',
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
      context_minutes: 4,
      reasoning: 'low',
      temperature: 0.3,
      prompt: "Using the recent transcript, give me the single most helpful thing to say right now — answer the INTERVIEWER's pending question if there is one, otherwise whatever would actually help (a sharper point, a risk to flag, a natural next thing to say). Strictly 1-3 sentences I can say out loud immediately, even though the project docs contain much more detail than that — pick the single most important detail rather than trying to cover everything. Prioritize speed and usefulness over completeness.",
    },
    'deep-answer': {
      model: 'anthropic/claude-opus-4.8',
      slash: '/deep',
      button: false,
      temperature: 0.2,
      reasoning: 'medium',
      max_tool_rounds: 2,
      max_tool_calls_per_round: 4,
      prompt:
        'Give me a deep, thorough answer, grounded in the project docs and code tools (real numbers, names, decisions) instead of generic advice — this is likely a deep-dive, trade-off, or "what if you had done X instead" question about a system I built, or something I said that deserves scrutiny. Focus on technical correctness, design trade-offs, hidden assumptions, risks, and how I would defend or reconsider a choice under scrutiny. Keep it readable during a live interview: lead with the single most important point, then at most 2-3 short supporting points — do not write an essay, and stop once you have made the key points even if there is more you could say.',
    },
    'tech-solver-parallel': {
      slash: '/tech2',
      button: false,
      fast: {
        model: 'google/gemini-3.5-flash',
        context_minutes: 5,
        temperature: 0.3,
        tools_enabled: false,
        reasoning: 'low',
        prompt:
          "Give me the single most helpful thing to say right now — answer the INTERVIEWER's pending question if there is one, otherwise whatever would actually help (a sharper point, a risk to flag, a next thing to say) — that I can say out loud immediately. Keep it concise and practical.",
      },
      deep: {
        model: 'anthropic/claude-opus-4.8',
        temperature: 0.2,
        max_tool_rounds: 2,
        max_tool_calls_per_round: 4,
        tools_enabled: true,
        reasoning: 'medium',
        prompt:
          'Give me a deeper, more thorough take than a fast reflexive answer would give — you do not see the fast answer, so do not assume or refer to what it said; just go as deep as the situation calls for. If the INTERVIEWER has a pending question, challenge, trade-off, or "what if you had done X instead" scenario, answer it thoroughly, grounded in the project docs and code tools (real numbers, names, decisions) instead of generic advice. If nothing is pending, use the extra depth to surface a risk, trade-off, or angle on what I was just saying that a fast answer would miss. Focus on technical correctness, design trade-offs, hidden assumptions, risks, and how I would defend or reconsider the choice under scrutiny. Keep it readable during a live interview: lead with the single most important point, then at most 2-3 short supporting points — do not write an essay, and stop once you have made the key points even if there is more you could say.',
      },
    },
  },
  systemDesignActions: {
    'guide-me': {
      model: 'anthropic/claude-fable-5',
      reasoning: 'medium',
    },
    'go-deeper': {
      model: 'anthropic/claude-fable-5',
      reasoning: 'high',
    },
  },
  code_context: {
    max_total_chars: 12000,
  },
  transcript_context: {
    max_total_chars: 24000,
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

  test('system-design preset resolves to exactly guide-me and go-deeper actions', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    assert.deepEqual(Object.keys(config.actions), SYSTEM_DESIGN_ACTION_IDS);
  });

  test('system-design preset disables repo and project-doc defaults', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    assert.equal(config.code_context.enabled, false);
    assert.equal(config.project_context.enabled, false);
    assert.equal(config.actions['guide-me'].project_docs_enabled, undefined);
    assert.equal(config.actions['go-deeper'].web_search_enabled, undefined);
  });

  test('system-design preset uses Claude Fable 5 for both actions', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    for (const actionId of SYSTEM_DESIGN_ACTION_IDS) {
      const action = config.actions[actionId];
      const expected = EXPECTED_DEFAULTS.systemDesignActions[actionId];
      assert.equal(action.model, expected.model, `${actionId} model`);
      assert.equal(action.reasoning?.effort, expected.reasoning, `${actionId} reasoning`);
    }
  });

  test('system-design guide prompt encodes the full-step output shape', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    const prompt = config.actions['guide-me'].prompt;
    assert.match(prompt, /Step/);
    assert.match(prompt, /Goal/);
    assert.match(prompt, /Draw/);
    assert.match(prompt, /Say/);
    assert.match(prompt, /Key Decisions/);
    assert.match(prompt, /ADVANCE/);
    assert.match(prompt, /REPAIR/);
    assert.match(prompt, /pragmatic assumption/i);
    assert.match(prompt, /Do not hallucinate screenshot details/);
    assert.match(prompt, /8-14 bullets/);
    assert.match(prompt, /live interview/i);
    assert.match(prompt, /skimmable/i);
  });

  test('system-design guide prompt enforces the fixed interview phase ladder', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    const prompt = config.actions['guide-me'].prompt;

    assert.match(prompt, /The problem statement is usually given up front, but Requirements & Scope still must be the first interview phase/);
    assert.match(prompt, /Requirements & Scope -> Capacity & Constraints -> Core Entities & Data Model -> APIs & Access Patterns -> High-Level Architecture -> Deep Dives -> Reliability & Tradeoffs/);
    assert.match(prompt, /If the screenshot is a fresh problem statement and the transcript has no substantive progress, start at Requirements & Scope/);
    assert.match(prompt, /Do not skip to High-Level Architecture from an initial problem statement/);
    assert.match(prompt, /Only advance to the next single incomplete stage in the fixed flow/);
    assert.match(prompt, /Infer completed stages only from transcript, screenshot\/board state, and prior action history/);
    assert.match(prompt, /If there is no evidence that a stage was completed, treat it as not completed/);
  });

  test('system-design guide prompt prioritizes reasoning over forced board changes', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    const prompt = config.actions['guide-me'].prompt;

    assert.match(prompt, /Draw can be `No board change needed yet`/);
    assert.match(prompt, /Do not add redundant scope text just to fill Draw/);
    assert.match(prompt, /Use Draw heavily for entities, APIs, architecture, flows, and deep dives/);
    assert.match(prompt, /The interview is judged primarily on reasoning, tradeoffs, and grounded decision-making/);
    assert.match(prompt, /Key Decisions must explain why the choice fits the stated requirements/);
    assert.match(prompt, /name the tradeoff or risk it accepts/);
    assert.match(prompt, /Ground reasoning in screenshot\/transcript facts, scale numbers, constraints, or explicit assumptions/);
  });

  test('system-design deeper prompt is phase-aware and skimmable', () => {
    const config = getDefaultMeetingCopilotConfig('system-design-interview');
    const prompt = config.actions['go-deeper'].prompt;
    assert.match(prompt, /phase-aware/i);
    assert.match(prompt, /API/i);
    assert.match(prompt, /data model/i);
    assert.match(prompt, /architecture/i);
    assert.match(prompt, /reliability/i);
    assert.match(prompt, /VALIDATE/);
    assert.match(prompt, /REPAIR/);
    assert.match(prompt, /STRESS-TEST/);
    assert.match(prompt, /Excalidraw edits/);
    assert.match(prompt, /good enough for the interview/);
    assert.match(prompt, /Verdict/);
    assert.match(prompt, /Fixes/);
    assert.match(prompt, /Stress Test/);
    assert.match(prompt, /Say/);
    assert.match(prompt, /3-5 ranked concrete changes/);
    assert.match(prompt, /live interview/i);
    assert.match(prompt, /skimmable/i);
  });

  test('default config includes exactly the three required action IDs', () => {
    assert.deepEqual(Object.keys(DEFAULT_MEETING_COPILOT_CONFIG.actions), REQUIRED_ACTION_IDS);
  });

  test('default hotkeys match Command+Shift+1 through Command+Shift+3', () => {
    const hotkeys = REQUIRED_ACTION_IDS.map((id) => DEFAULT_MEETING_COPILOT_CONFIG.actions[id].trigger.hotkey);
    assert.deepEqual(hotkeys, [
      'Command+Shift+1',
      'Command+Shift+2',
      'Command+Shift+3',
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
    for (const actionId of ['quick-answer', 'deep-answer']) {
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

  test('quick-answer uses recent context; deep-answer uses full_cached', () => {
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['quick-answer'].context_mode, 'recent');
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['deep-answer'].context_mode, 'full_cached');
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

  test('tech-solver-parallel.deep has web search enabled', () => {
    const action = DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver-parallel'];
    assert.equal(action.parallel.deep.web_search_enabled, true);
    assert.equal(action.parallel.fast.web_search_enabled, undefined);
  });

  test('quick-answer has project docs enabled; tech-solver-parallel.fast does not', () => {
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['quick-answer'].project_docs_enabled, true);
    const parallel = DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver-parallel'];
    assert.equal(parallel.parallel.fast.project_docs_enabled, undefined);
  });

  test('no action sets a fixed max_tokens cap by default, to avoid truncating answers mid-sentence', () => {
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['quick-answer'].max_tokens, undefined);
    assert.equal(DEFAULT_MEETING_COPILOT_CONFIG.actions['deep-answer'].max_tokens, undefined);
    const parallel = DEFAULT_MEETING_COPILOT_CONFIG.actions['tech-solver-parallel'];
    assert.equal(parallel.parallel.fast.max_tokens, undefined);
    assert.equal(parallel.parallel.deep.max_tokens, undefined);
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

  test('transcript context limits match the brief defaults', () => {
    assert.equal(
      DEFAULT_MEETING_COPILOT_CONFIG.transcript_context.max_total_chars,
      EXPECTED_DEFAULTS.transcript_context.max_total_chars
    );
  });

  test('config file can select the system-design preset manually', async () => {
    const dir = writeOverride('system-design-preset', { preset: 'system-design-interview' });
    const store = new ActionConfigStore({ configDir: dir });
    const config = await store.load();
    assert.deepEqual(Object.keys(config.actions), SYSTEM_DESIGN_ACTION_IDS);
  });
});

describe('meeting-copilot action config validation', () => {
  test('invalid context mode is rejected with a useful path in the error', () => {
    const config = cloneConfig();
    config.actions['deep-answer'].context_mode = 'invalid-mode';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.deep-answer\.context_mode must be one of recent, full_cached/
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
    config.actions['deep-answer'].trigger.hotkey = config.actions['quick-answer'].trigger.hotkey;
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.deep-answer\.trigger\.hotkey must be unique; duplicate Command\+Shift\+1/
    );
  });

  test('normalized duplicate hotkeys are rejected', () => {
    const config = cloneConfig();
    config.actions['deep-answer'].trigger.hotkey = 'Shift+Command+1';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.deep-answer\.trigger\.hotkey must be unique; duplicate Shift\+Command\+1/
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

  test('invalid web_search_enabled is rejected', () => {
    const config = cloneConfig();
    config.actions['tech-solver-parallel'].parallel.deep.web_search_enabled = 'yes';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.tech-solver-parallel\.parallel\.deep\.web_search_enabled must be a boolean/
    );
  });

  test('invalid project_docs_enabled is rejected', () => {
    const config = cloneConfig();
    config.actions['quick-answer'].project_docs_enabled = 'yes';
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /actions\.quick-answer\.project_docs_enabled must be a boolean/
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

  test('invalid transcript context max_total_chars is rejected', () => {
    const config = cloneConfig();
    config.transcript_context.max_total_chars = -1;
    assert.throws(
      () => validateMeetingCopilotConfig(config),
      /transcript_context\.max_total_chars must be a positive integer/
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
    assert.equal(store.listActions().length, 3);

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
