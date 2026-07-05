import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { classifyFreshnessNeed } = await import(
  pathToFileURL(path.join(distRoot, 'FreshnessPolicy.js')).href
);

function classify(input) {
  return classifyFreshnessNeed({
    actionId: 'quick-answer',
    branch: 'single',
    recentTranscriptText: '',
    toolsAvailable: false,
    ...input,
  });
}

describe('MeetingCopilot FreshnessPolicy', () => {
  test('detects the expected freshness-sensitive external fact categories', () => {
    const cases = [
      ['model_availability', 'Is GPT-5 available in OpenRouter for tier 2 accounts yet?'],
      ['model_pricing', 'What is the current Claude pricing per million input tokens?'],
      ['context_window', 'What context window does Gemini 3.5 Flash support now?'],
      ['api_behavior', 'Does the OpenAI Responses API currently support parallel tool calls?'],
      ['benchmark', 'Which model is leading the latest LMSYS benchmark right now?'],
      ['provider_status', 'Is OpenRouter down today or reporting an outage?'],
      ['regulation', 'What does the EU AI Act require for foundation models this month?'],
      ['recent_release', 'What are the latest model releases from Anthropic this week?'],
      ['company_announcement', 'What did OpenAI announce yesterday about enterprise pricing?'],
      ['current_event', 'What happened in today’s AI safety summit?'],
    ];

    for (const [category, prompt] of cases) {
      const result = classify({ prompt });
      assert.notEqual(result.sensitivity, 'none', prompt);
      assert.equal(result.categories.includes(category), true, prompt);
      assert.equal(result.shouldCaveat, true, prompt);
    }
  });

  test('does not trigger freshness for ordinary internal implementation questions', () => {
    const prompts = [
      'In ActionRunManager, should project context warnings merge before or after tool loop warnings?',
      'This policy object controls internal feature flags in the repo.',
      'The event emitter should rank callbacks by insertion order.',
      'The test score calculation happens in our local evaluator class.',
      'The architecture conference room notes mention the rollout plan.',
    ];

    for (const prompt of prompts) {
      const result = classify({
        prompt,
        recentTranscriptText:
          'We need to keep ContextBuilder section ordering compatible with the current repo code.',
      });

      assert.equal(result.sensitivity, 'none', prompt);
      assert.deepEqual(result.categories, [], prompt);
      assert.equal(result.shouldVerify, false, prompt);
      assert.equal(result.shouldCaveat, false, prompt);
    }
  });

  test('quick-answer and fast branch caveat rather than verify', () => {
    const single = classify({
      actionId: 'quick-answer',
      branch: 'single',
      prompt: 'What is the latest OpenAI model pricing?',
      toolsAvailable: true,
    });
    const fast = classify({
      actionId: 'tech-solver-parallel',
      branch: 'fast',
      prompt: 'Which model currently has the best benchmark score?',
      toolsAvailable: true,
    });

    assert.equal(single.shouldVerify, false);
    assert.equal(single.shouldCaveat, true);
    assert.equal(single.allowed, false);
    assert.equal(fast.shouldVerify, false);
    assert.equal(fast.shouldCaveat, true);
    assert.equal(fast.allowed, false);
  });

  test('claim-check and tech-solver-parallel deep branch can request verification when tools are available', () => {
    const claimCheck = classify({
      actionId: 'claim-check',
      branch: 'single',
      prompt: 'Check whether OpenRouter is currently degraded.',
      toolsAvailable: true,
    });
    const deepSolution = classify({
      actionId: 'tech-solver-parallel',
      branch: 'deep',
      prompt: 'Compare current pricing and context windows across providers.',
      toolsAvailable: true,
    });

    assert.equal(claimCheck.shouldVerify, true);
    assert.equal(claimCheck.shouldCaveat, false);
    assert.equal(claimCheck.allowed, true);
    assert.equal(deepSolution.shouldVerify, true);
    assert.equal(deepSolution.shouldCaveat, false);
    assert.equal(deepSolution.allowed, true);
  });

  test('without tools, sensitive prompts stay unverified and currentness-uncertain', () => {
    const result = classify({
      actionId: 'tech-solver-parallel',
      branch: 'deep',
      prompt: 'What are the latest Anthropic model releases and prices?',
      toolsAvailable: false,
    });

    assert.notEqual(result.sensitivity, 'none');
    assert.equal(result.allowed, true);
    assert.equal(result.shouldVerify, false);
    assert.equal(result.shouldCaveat, true);
    assert.match(result.reason, /unverified|currentness|tool/i);
  });
});
