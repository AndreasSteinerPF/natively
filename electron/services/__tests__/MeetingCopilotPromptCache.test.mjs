// electron/services/__tests__/MeetingCopilotPromptCache.test.mjs
//
// Regression guard for buildOpenRouterMessages: empty/whitespace-only context
// sections must NOT become empty text content blocks. Anthropic rejects such
// requests with 400 "messages: text content blocks must be non-empty", which
// previously crashed full_cached actions (Tech Solver / Deep Solution) whenever
// the transcript was empty (e.g. an action fired before any speech).
//
// Run: node --test electron/services/__tests__/MeetingCopilotPromptCache.test.mjs

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const distRoot = path.resolve(repoRoot, 'dist-electron/electron/meeting-copilot');

const { buildOpenRouterMessages } = await import(
  pathToFileURL(path.join(distRoot, 'PromptCache.js')).href
);

// Collect every text content block across all messages (content may be a bare
// string or an array of blocks).
function collectTexts(messages) {
  const texts = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      texts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) texts.push(block.text);
    }
  }
  return texts;
}

describe('buildOpenRouterMessages — empty section handling', () => {
  test('empty sections do not produce empty text content blocks', () => {
    const context = {
      mode: 'full_cached',
      sections: [
        { key: 'pinned_context', content: 'Pinned info', cache: { cacheable: true } },
        { key: 'meeting_transcript_so_far', content: '', cache: { cacheable: true } }, // empty transcript
        { key: 'code_context', content: '   ' }, // whitespace-only user block
        { key: 'current_action', content: 'Answer the question.' },
      ],
    };

    const { messages } = buildOpenRouterMessages({
      context,
      cachePolicy: 'anthropic_explicit_1h',
    });

    const texts = collectTexts(messages);
    assert.ok(texts.length > 0, 'expected at least one content block');
    for (const t of texts) {
      assert.ok(typeof t === 'string' && t.trim().length > 0, `content block must be non-empty, got: ${JSON.stringify(t)}`);
    }
  });

  test('non-empty sections are preserved', () => {
    const context = {
      mode: 'full_cached',
      sections: [
        { key: 'pinned_context', content: 'Pinned info', cache: { cacheable: true } },
        { key: 'meeting_transcript_so_far', content: '', cache: { cacheable: true } },
        { key: 'current_action', content: 'Answer the question.' },
      ],
    };

    const { messages } = buildOpenRouterMessages({
      context,
      cachePolicy: 'anthropic_explicit_1h',
    });

    const allText = collectTexts(messages).join('\n');
    assert.ok(allText.includes('Pinned info'), 'pinned context should survive');
    assert.ok(allText.includes('Answer the question.'), 'current action (prompt) should survive');
    // A system message (cacheable sections) and a user message (the prompt) exist.
    assert.equal(messages.some((m) => m.role === 'system'), true);
    assert.equal(messages.some((m) => m.role === 'user'), true);
  });
});
