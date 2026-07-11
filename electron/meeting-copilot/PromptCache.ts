import {
    BuiltMeetingCopilotContext,
    CachePolicy,
    OpenRouterCacheControl,
    OpenRouterContentBlock,
    OpenRouterMessage,
    OpenRouterTextContentBlock,
    PromptSection,
    PromptSectionKey,
} from './types';

const CACHEABLE_SECTION_KEYS = new Set<PromptSectionKey>([
    'stable_instructions',
    'custom_context',
    'project_docs_context',
    'pinned_context',
    'meeting_transcript_so_far',
]);
const MAX_EXPLICIT_CACHE_CONTROL_BLOCKS = 4;

function cloneBlock(block: OpenRouterContentBlock): OpenRouterContentBlock {
    if (block.type === 'image_url') {
        return { type: 'image_url', image_url: { ...block.image_url } };
    }

    return block.cache_control ? { ...block, cache_control: { ...block.cache_control } } : { ...block };
}

function cloneMessage(message: OpenRouterMessage): OpenRouterMessage {
    if (Array.isArray(message.content)) {
        return {
            ...message,
            content: message.content.map(cloneBlock),
        };
    }

    return { ...message };
}

function isCacheableSection(section: PromptSection): boolean {
    return Boolean(section.cache?.cacheable && CACHEABLE_SECTION_KEYS.has(section.key));
}

function buildContentBlock(section: PromptSection): OpenRouterTextContentBlock {
    return {
        type: 'text',
        text: section.content,
    };
}

export function cacheControlForPolicy(policy: CachePolicy): OpenRouterCacheControl | undefined {
    if (policy === 'anthropic_explicit_5m') {
        return { type: 'ephemeral' };
    }

    if (policy === 'anthropic_explicit_1h') {
        return { type: 'ephemeral', ttl: '1h' };
    }

    return undefined;
}

export function buildOpenRouterMessages(input: {
    context: BuiltMeetingCopilotContext;
    cachePolicy: CachePolicy;
}): {
    messages: OpenRouterMessage[];
    cacheable_block_count: number;
    cache_control_applied: boolean;
} {
    const cacheControl = cacheControlForPolicy(input.cachePolicy);
    const systemEntries: Array<{
        section: PromptSection;
        block: OpenRouterContentBlock;
    }> = [];
    const userBlocks: OpenRouterContentBlock[] = [];

    for (const section of input.context.sections) {
        // Skip empty/whitespace-only sections: Anthropic rejects requests whose
        // text content blocks are empty ("text content blocks must be non-empty"),
        // which otherwise 400s full_cached actions when e.g. the transcript is empty.
        if (!section.content || section.content.trim().length === 0) {
            continue;
        }

        if (section.key === 'current_action' || section.key === 'dynamic_evidence_context') {
            userBlocks.push({ type: 'text', text: section.content });
            continue;
        }

        if (section.key === 'code_context') {
            if (input.context.mode === 'full_cached') {
                userBlocks.push({ type: 'text', text: section.content });
            }
            continue;
        }

        systemEntries.push({
            section,
            block: buildContentBlock(section),
        });
    }

    if (cacheControl) {
        const cacheableEntries = systemEntries.filter((entry) => isCacheableSection(entry.section));
        for (const entry of cacheableEntries.slice(-MAX_EXPLICIT_CACHE_CONTROL_BLOCKS)) {
            if (entry.block.type === 'text') {
                entry.block.cache_control = cacheControl;
            }
        }
    }

    const systemBlocks = systemEntries.map((entry) => entry.block);

    const messages: OpenRouterMessage[] = [];
    if (systemBlocks.length > 0) {
        messages.push({
            role: 'system',
            content: systemBlocks,
        });
    }
    if (userBlocks.length > 0) {
        messages.push({
            role: 'user',
            content: userBlocks.length === 1 && userBlocks[0].type === 'text' ? userBlocks[0].text : userBlocks,
        });
    }

    return {
        messages,
        cacheable_block_count: systemBlocks.filter((block) => block.type === 'text' && block.cache_control !== undefined).length,
        cache_control_applied: cacheControl !== undefined && systemBlocks.some((block) => block.type === 'text' && block.cache_control !== undefined),
    };
}

export function stripCacheControlFromMessages(messages: OpenRouterMessage[]): OpenRouterMessage[] {
    return messages.map((message) => {
        if (!Array.isArray(message.content)) {
            return cloneMessage(message);
        }

        return {
            ...message,
            content: message.content.map((block) => {
                const cloned = cloneBlock(block);
                if (cloned.type === 'text') {
                    delete cloned.cache_control;
                }
                return cloned;
            }),
        };
    });
}

export function shouldRetryWithoutCacheControl(input: { status: number; message: string }): boolean {
    if (input.status !== 400 && input.status !== 422) {
        return false;
    }

    return /cache[\s_-]*control/i.test(input.message);
}
