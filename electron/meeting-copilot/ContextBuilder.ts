import {
    BuildMeetingCopilotContextInput,
    BuiltMeetingCopilotContext,
    PromptSection,
    PromptSectionCacheMetadata,
    PromptSectionKey,
    TranscriptChunk,
} from './types';
import { withFreshnessStableInstructions } from './FreshnessPolicy';
import { DEFAULT_PINNED_CONTEXT_TEMPLATE } from './PinnedContextStore';

const FULL_CACHE_RECENT_TRANSCRIPT_TAIL_CHUNKS = 12;
const TRANSCRIPT_CACHE_BLOCK_TARGET_CHARS = 8_000;

function toDate(value: string | Date): Date {
    return value instanceof Date ? value : new Date(value);
}

function section(
    key: PromptSectionKey,
    content: string,
    cache?: PromptSectionCacheMetadata
): PromptSection {
    return {
        key,
        content,
        cache,
    };
}

function normalizeOptionalContext(value: string): string {
    const trimmed = value.trim();
    return trimmed === DEFAULT_PINNED_CONTEXT_TEMPLATE.trim() ? '' : trimmed;
}

function parseSpeakerLine(text: string): { speaker?: string; body: string } {
    const match = text.match(/^\[(ME|INTERVIEWER)\]:\s*(.*)$/s);
    if (!match) {
        return { body: text };
    }

    return {
        speaker: match[1],
        body: match[2].trim(),
    };
}

function formatTranscript(chunks: TranscriptChunk[]): string {
    const groups: Array<{ key: string; speaker?: string; parts: string[] }> = [];

    for (const chunk of chunks) {
        const rawText = chunk.text.trim();
        if (rawText.length === 0) {
            continue;
        }

        const parsed = parseSpeakerLine(rawText);
        const body = parsed.body.trim();
        if (body.length === 0) {
            continue;
        }

        const key = parsed.speaker ?? chunk.source ?? 'transcript';
        const last = groups.at(-1);
        if (last?.key === key) {
            last.parts.push(body);
            continue;
        }

        groups.push({ key, speaker: parsed.speaker, parts: [body] });
    }

    return groups
        .map((group) => {
            const text = group.parts.join(' ');
            return group.speaker ? `[${group.speaker}]: ${text}` : text;
        })
        .join('\n');
}

function selectRecentChunks(
    chunks: TranscriptChunk[],
    contextMinutes: number,
    now: string | Date
): TranscriptChunk[] {
    const end = toDate(now).getTime();
    const start = end - contextMinutes * 60_000;

    return chunks.filter((chunk) => {
        const chunkEnd = new Date(chunk.end_ts).getTime();
        return chunkEnd >= start && chunkEnd <= end;
    });
}

function splitFullCachedTranscript(chunks: TranscriptChunk[]): {
    cacheableHistory: TranscriptChunk[];
    recentTail: TranscriptChunk[];
} {
    if (chunks.length <= FULL_CACHE_RECENT_TRANSCRIPT_TAIL_CHUNKS) {
        return {
            cacheableHistory: [],
            recentTail: chunks,
        };
    }

    return {
        cacheableHistory: chunks.slice(0, -FULL_CACHE_RECENT_TRANSCRIPT_TAIL_CHUNKS),
        recentTail: chunks.slice(-FULL_CACHE_RECENT_TRANSCRIPT_TAIL_CHUNKS),
    };
}

function splitTranscriptBlocks(content: string, targetChars: number): string[] {
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const blocks: string[] = [];
    let current = '';

    for (const line of lines) {
        const next = current.length === 0 ? line : `${current}\n${line}`;
        if (current.length > 0 && next.length > targetChars) {
            blocks.push(current);
            current = line;
            continue;
        }
        current = next;
    }

    if (current.length > 0) {
        blocks.push(current);
    }

    return blocks;
}

export function buildMeetingCopilotContext(
    input: BuildMeetingCopilotContextInput
): BuiltMeetingCopilotContext {
    const stableInstructions = withFreshnessStableInstructions(input.stableInstructions);
    const actionHistory = input.actionHistory?.trim() ?? '';
    const customContext = normalizeOptionalContext(input.customContext);
    const pinnedContext = normalizeOptionalContext(input.pinnedContext);

    if (input.mode === 'recent') {
        const transcriptContent = formatTranscript(
            selectRecentChunks(
                input.snapshot.chunks,
                input.contextMinutes ?? 0,
                input.now ?? new Date()
            )
        );

        return {
            mode: 'recent',
            sections: [
                section('stable_instructions', stableInstructions),
                section('custom_context', customContext),
                // Placed before pinned_context/recent_transcript so it stays part of the
                // stable, byte-identical prefix across calls within a meeting — required for
                // Gemini-style implicit prompt caching to hit (only enabled per-branch via
                // project_docs_enabled; see ActionRunManager.ts's executeBranch()).
                ...(input.projectDocsContext && input.projectDocsContext.trim().length > 0
                    ? [section('project_docs_context', input.projectDocsContext, { cacheable: true, scope: 'data' })]
                    : []),
                section('pinned_context', pinnedContext),
                section('recent_transcript', transcriptContent),
                ...(input.dynamicEvidenceContext && input.dynamicEvidenceContext.trim().length > 0
                    ? [
                          section('dynamic_evidence_context', input.dynamicEvidenceContext, {
                              cacheable: false,
                          }),
                      ]
                    : []),
                ...(actionHistory.length > 0
                    ? [section('action_history', actionHistory, { cacheable: false })]
                    : []),
                section('current_action', input.currentAction),
                ...(input.freshnessGuidance && input.freshnessGuidance.trim().length > 0
                    ? [section('current_action', input.freshnessGuidance, { cacheable: false })]
                    : []),
            ],
        };
    }

    const fullCachedTranscript = splitFullCachedTranscript(input.snapshot.chunks);
    const transcriptHistoryBlocks = splitTranscriptBlocks(
        formatTranscript(fullCachedTranscript.cacheableHistory),
        TRANSCRIPT_CACHE_BLOCK_TARGET_CHARS
    );
    const transcriptHistorySections = transcriptHistoryBlocks.map((content, index) =>
        section('meeting_transcript_so_far', content, {
            cacheable: index < transcriptHistoryBlocks.length - 1,
            scope: 'data',
        })
    );
    const recentTranscriptContent = formatTranscript(fullCachedTranscript.recentTail);

    return {
        mode: 'full_cached',
        sections: [
            section('stable_instructions', stableInstructions, {
                cacheable: true,
                scope: 'metadata',
            }),
            section('custom_context', customContext, {
                cacheable: true,
                scope: 'metadata',
            }),
            ...(input.projectDocsContext && input.projectDocsContext.trim().length > 0
                ? [
                      section('project_docs_context', input.projectDocsContext, {
                          cacheable: true,
                          scope: 'data',
                      }),
                  ]
                : []),
            section('pinned_context', pinnedContext, {
                cacheable: true,
                scope: 'metadata',
            }),
            ...transcriptHistorySections,
            section('recent_transcript', recentTranscriptContent, {
                cacheable: false,
            }),
            section('code_context', input.codeContext ?? '', {
                cacheable: false,
            }),
            section('action_instructions', input.currentAction, {
                cacheable: true,
                scope: 'metadata',
            }),
            ...(input.dynamicEvidenceContext && input.dynamicEvidenceContext.trim().length > 0
                ? [
                      section('dynamic_evidence_context', input.dynamicEvidenceContext, {
                          cacheable: false,
                      }),
                  ]
                : []),
            ...(actionHistory.length > 0
                ? [section('action_history', actionHistory, { cacheable: false })]
                : []),
            section('current_action', 'Apply the action instructions to the current meeting context.', {
                cacheable: false,
            }),
            ...(input.freshnessGuidance && input.freshnessGuidance.trim().length > 0
                ? [
                      section('current_action', input.freshnessGuidance, {
                          cacheable: false,
                      }),
                  ]
                : []),
        ],
    };
}
