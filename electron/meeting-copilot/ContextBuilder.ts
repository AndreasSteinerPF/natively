import {
    BuildMeetingCopilotContextInput,
    BuiltMeetingCopilotContext,
    PromptSection,
    PromptSectionCacheMetadata,
    PromptSectionKey,
    TranscriptChunk,
} from './types';
import { withFreshnessStableInstructions } from './FreshnessPolicy';

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

function formatTranscript(chunks: TranscriptChunk[]): string {
    return chunks
        .map((chunk) => `[${chunk.id} start=${chunk.start_ts} end=${chunk.end_ts}]\n${chunk.text}`)
        .join('\n\n');
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

export function buildMeetingCopilotContext(
    input: BuildMeetingCopilotContextInput
): BuiltMeetingCopilotContext {
    const stableInstructions = withFreshnessStableInstructions(input.stableInstructions);
    const actionHistory = input.actionHistory?.trim() ?? '';

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
                section('custom_context', input.customContext),
                // Placed before pinned_context/recent_transcript so it stays part of the
                // stable, byte-identical prefix across calls within a meeting — required for
                // Gemini-style implicit prompt caching to hit (only enabled per-branch via
                // project_docs_enabled; see ActionRunManager.ts's executeBranch()).
                ...(input.projectDocsContext && input.projectDocsContext.trim().length > 0
                    ? [section('project_docs_context', input.projectDocsContext, { cacheable: true, scope: 'data' })]
                    : []),
                section('pinned_context', input.pinnedContext),
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

    return {
        mode: 'full_cached',
        sections: [
            section('stable_instructions', stableInstructions, {
                cacheable: true,
                scope: 'metadata',
            }),
            section('custom_context', input.customContext, {
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
            section('pinned_context', input.pinnedContext, {
                cacheable: true,
                scope: 'metadata',
            }),
            section('meeting_transcript_so_far', formatTranscript(input.snapshot.chunks), {
                cacheable: true,
                scope: 'data',
            }),
            section('code_context', input.codeContext ?? '', {
                cacheable: false,
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
            section('current_action', input.currentAction, {
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
