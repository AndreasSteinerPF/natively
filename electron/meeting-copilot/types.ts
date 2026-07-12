export type ContextMode = 'recent' | 'full_cached';
export type MeetingCopilotPreset = 'meeting-default' | 'system-design-interview';

export type TranscriptChunkSource = 'mic' | 'system' | 'mixed';

export type TranscriptMessageRole = 'assistant' | 'tool' | 'action';

export type CachePolicy =
    | 'none'
    | 'anthropic_explicit_5m'
    | 'anthropic_explicit_1h';

export type ReasoningEffort =
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max';

export type ActionBranch = 'single' | 'fast' | 'deep';
export type ActionPane = 'main' | 'fast' | 'deep';
export type FreshnessCategory =
    | 'model_availability'
    | 'model_pricing'
    | 'context_window'
    | 'api_behavior'
    | 'benchmark'
    | 'provider_status'
    | 'regulation'
    | 'recent_release'
    | 'company_announcement'
    | 'current_event';

export interface ReasoningConfig {
    effort?: ReasoningEffort;
}

export interface ActionTriggerConfig {
    hotkey: string;
    slash?: string;
    button?: boolean;
}

export interface ProjectContextPack {
    name: string;
    docsPath: string;
    linkedWorkspaceName?: string;
    enabled: boolean;
    includeByDefault: boolean;
    maxDocsChars: number;
}

export interface ProjectContextConfig {
    enabled: boolean;
    max_docs_chars_per_pack: number;
    max_total_docs_chars: number;
    packs: ProjectContextPack[];
}

export interface ProjectContextFile {
    packName: string;
    relativePath: string;
    chars: number;
    text: string;
}

export interface ProjectContextBundle {
    included: boolean;
    packNames: string[];
    files: ProjectContextFile[];
    text: string;
    chars: number;
    fileCount: number;
    warnings: string[];
    truncated: boolean;
}

export interface ActionBranchConfig {
    model: string;
    context_mode: ContextMode;
    cache_policy: CachePolicy;
    context_minutes?: number;
    /** Omit to let the provider use the model's own max output — avoids truncating
     *  responses mid-sentence when a branch has more to say than a fixed cap allows
     *  (e.g. project_docs_enabled giving a cheap model much more material to draw on). */
    max_tokens?: number;
    temperature: number;
    reasoning?: ReasoningConfig;
    tools_enabled?: boolean;
    max_tool_rounds?: number;
    max_tool_calls_per_round?: number;
    web_search_enabled?: boolean;
    /** Include the project docs pack even in `recent` context mode (normally docs are
     *  `full_cached`-only). Meant for cheap/fast models relying on Gemini-style implicit
     *  prompt caching — see ContextBuilder.ts's `recent` branch for the ordering this needs
     *  (docs must precede the per-call-varying transcript section to stay cache-eligible). */
    project_docs_enabled?: boolean;
    prompt: string;
}

export interface TranscriptChunk {
    id: string;
    meeting_id: string;
    start_ts: string;
    end_ts: string;
    text: string;
    source?: TranscriptChunkSource;
}

export interface TranscriptChunkInput {
    start_ts: string;
    end_ts: string;
    text: string;
    source?: TranscriptChunkSource;
}

export interface TranscriptMessageInput {
    role: TranscriptMessageRole;
    text: string;
}

export interface TranscriptSnapshot {
    meeting_id: string;
    chunks: TranscriptChunk[];
}

export type PromptSectionKey =
    | 'stable_instructions'
    | 'custom_context'
    | 'project_docs_context'
    | 'pinned_context'
    | 'recent_transcript'
    | 'meeting_transcript_so_far'
    | 'code_context'
    | 'dynamic_evidence_context'
    | 'action_history'
    | 'action_instructions'
    | 'current_action';

export type PromptSectionCacheScope = 'metadata' | 'data';

export interface PromptSectionCacheMetadata {
    cacheable: boolean;
    scope?: PromptSectionCacheScope;
}

export interface PromptSection {
    key: PromptSectionKey;
    content: string;
    cache?: PromptSectionCacheMetadata;
}

export interface BuildMeetingCopilotContextInput {
    mode: ContextMode;
    snapshot: TranscriptSnapshot;
    stableInstructions: string;
    customContext: string;
    projectDocsContext?: string;
    pinnedContext: string;
    currentAction: string;
    actionHistory?: string;
    freshnessGuidance?: string;
    dynamicEvidenceContext?: string;
    contextMinutes?: number;
    now?: string | Date;
    codeContext?: string;
}

export interface BuiltMeetingCopilotContext {
    mode: ContextMode;
    sections: PromptSection[];
}

export interface SingleActionConfig extends ActionBranchConfig {
    label: string;
    trigger: ActionTriggerConfig;
}

export interface ParallelActionConfig {
    label: string;
    trigger: ActionTriggerConfig;
    parallel: {
        fast: ActionBranchConfig;
        deep: ActionBranchConfig;
    };
}

export type MeetingCopilotActionConfig =
    | SingleActionConfig
    | ParallelActionConfig;

export interface OpenRouterConfig {
    base_url: string;
    api_key_env: string;
    default_headers?: Record<string, string>;
}

export type OpenRouterCacheControl = {
    type: 'ephemeral';
    ttl?: '1h';
};

export type OpenRouterTextContentBlock = {
    type: 'text';
    text: string;
    cache_control?: OpenRouterCacheControl;
};

export type OpenRouterImageContentBlock = {
    type: 'image_url';
    image_url: {
        url: string;
    };
};

export type OpenRouterContentBlock = OpenRouterTextContentBlock | OpenRouterImageContentBlock;

export type OpenRouterMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | OpenRouterContentBlock[];
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
};

export interface OpenRouterUsagePromptTokenDetails {
    cached_tokens?: number;
    cache_write_tokens?: number;
}

export interface OpenRouterUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: OpenRouterUsagePromptTokenDetails;
}

export interface OpenRouterChatCompletionRequest {
    model: string;
    messages: OpenRouterMessage[];
    tools?: unknown[];
    tool_choice?: 'auto' | 'none' | Record<string, unknown>;
    plugins?: unknown[];
    reasoning?: ReasoningConfig;
    max_tokens?: number;
    temperature: number;
    stream: boolean;
    session_id?: string;
    cache_policy?: CachePolicy;
    signal?: AbortSignal;
}

export interface OpenRouterChatCompletionResult {
    content: string;
    raw: unknown;
    warnings: string[];
    metrics: LlmCallMetrics;
    tool_calls?: unknown[];
    usage?: OpenRouterUsage;
    /** From the model's final chunk/response (e.g. 'stop', 'length', 'tool_calls').
     *  'length' means the response was cut off by max_tokens, not a natural stop. */
    finish_reason?: string;
}

export type OpenRouterStreamEvent =
    | { type: 'token'; token: string }
    | { type: 'done'; result: OpenRouterChatCompletionResult };

export type MeetingCopilotInvoke =
    | { type: 'action:start'; actionId: string; imagePaths?: string[] }
    | { type: 'action:cancel'; runId: string; branch?: 'fast' | 'deep' | 'all' }
    | { type: 'config:get' }
    | { type: 'context:pin:get' }
    | { type: 'context:pin:update'; value: string }
    | { type: 'context:pin:reset' }
    | { type: 'code:list_workspaces' }
    | { type: 'code:search'; query: string; workspace?: string }
    | { type: 'code:read'; path: string; workspace?: string; startLine?: number; endLine?: number };

export interface MeetingCopilotRendererConfig {
    actions: Array<{
        id: string;
        label: string;
        hotkey: string;
    }>;
}

export type MeetingCopilotEvent =
    | { type: 'action:started'; runId: string; actionId: string; label: string }
    | { type: 'action:token'; runId: string; pane: 'main' | 'fast' | 'deep'; token: string }
    | { type: 'action:tool_status'; runId: string; pane?: ActionPane; message: string }
    | { type: 'action:completed'; runId: string; metrics: LlmCallMetrics; warnings?: string[] }
    | { type: 'action:error'; runId: string; error: string; error_type?: string; pane?: ActionPane }
    | { type: 'action:cancelled'; runId: string; branch?: 'fast' | 'deep' | 'all' }
    | { type: 'metrics:update'; metrics: LlmCallMetrics }
    | { type: 'context:pin:updated'; value: string };

export type CodeToolName = 'list_workspaces' | 'search_repo' | 'read_file';

export interface ToolLoopCodeTools {
    listWorkspaces: () => Promise<unknown>;
    searchRepo: (input: { query: string; workspace?: string }) => Promise<unknown>;
    readFileSlice: (input: {
        path: string;
        workspace?: string;
        startLine?: number;
        endLine?: number;
    }) => Promise<unknown>;
}

export interface ToolLoopBranchConfig extends Pick<
    ActionBranchConfig,
    | 'model'
    | 'max_tokens'
    | 'temperature'
    | 'reasoning'
    | 'cache_policy'
    | 'max_tool_rounds'
    | 'max_tool_calls_per_round'
> {}

export interface ToolLoopRunInput {
    runId: string;
    pane?: ActionPane;
    messages: OpenRouterMessage[];
    branchConfig: ToolLoopBranchConfig;
    session_id: string;
    signal?: AbortSignal;
    emitStatus?: (message: string) => void;
    codeContextMaxChars: number;
}

export interface ToolLoopResult {
    messages: OpenRouterMessage[];
    evidenceText: string;
    metrics: {
        tool_rounds: number;
        tool_calls: number;
        code_context_included: boolean;
    };
    warnings?: string[];
}

export interface ActionRunToolLoop {
    run: (input: ToolLoopRunInput) => Promise<ToolLoopResult>;
}

export interface WorkspaceConfig {
    name: string;
    path: string;
    enabled: boolean;
    max_snippets: number;
    max_snippet_chars: number;
}

export interface CodeContextConfig {
    enabled: boolean;
    retrieval_mode: 'tool_loop';
    max_total_chars: number;
    include_file_paths: boolean;
    include_line_numbers: boolean;
}

export interface TranscriptContextConfig {
    max_total_chars: number;
}

export interface ReviewLogConfig {
    enabled: boolean;
    max_transcript_chars: number;
}

export interface ProjectContextMetrics {
    project_context_included?: boolean;
    project_context_pack_names?: string[];
    project_context_chars?: number;
    project_context_file_count?: number;
}

export interface FreshnessDecision {
    sensitivity: 'none' | 'possible' | 'required';
    allowed: boolean;
    shouldVerify: boolean;
    shouldCaveat: boolean;
    reason: string;
    categories: FreshnessCategory[];
}

export interface FreshnessMetrics {
    freshness_check_used?: boolean;
    freshness_sources?: string[];
    freshness_query_count?: number;
    freshness_result_count?: number;
    freshness_verified_at?: string;
    freshness_error?: string;
}

export type ModelInfo = {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: Record<string, unknown>;
    supported_parameters?: string[];
    source: 'openrouter';
    checked_at: string;
};

export type WebSearchResult = {
    title: string;
    url: string;
    domain: string;
    snippet?: string;
    checked_at: string;
};

export type FreshnessEvidence = {
    used: boolean;
    sources: string[];
    queries: string[];
    resultCount: number;
    verifiedAt?: string;
    dynamicContextText: string;
    warnings: string[];
};

export interface MeetingCopilotConfig {
    openrouter: OpenRouterConfig;
    actions: Record<string, MeetingCopilotActionConfig>;
    workspaces: WorkspaceConfig[];
    code_context: CodeContextConfig;
    transcript_context: TranscriptContextConfig;
    review_log: ReviewLogConfig;
    project_context: ProjectContextConfig;
}

export interface MeetingCopilotConfigFile extends Partial<MeetingCopilotConfig> {
    preset?: MeetingCopilotPreset;
}

export interface LlmCallMetrics extends FreshnessMetrics {
    meeting_id?: string;
    action_id?: string;
    branch?: ActionBranch;
    model?: string;
    context_mode?: ContextMode;
    cache_policy?: CachePolicy;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_control_retry?: boolean;
    tool_rounds?: number;
    tool_calls?: number;
    time_to_first_token_ms?: number;
    total_latency_ms?: number;
    code_context_included?: boolean;
    project_context_included?: boolean;
    project_context_pack_names?: string[];
    project_context_chars?: number;
    project_context_file_count?: number;
    success?: boolean;
    error?: string;
    error_type?: string;
}

export interface CodeSource {
    workspace?: string;
    path: string;
    startLine?: number;
    endLine?: number;
    content?: string;
}

export interface SearchHit {
    workspace?: string;
    path: string;
    line: number;
    preview: string;
}

export interface FileSlice {
    workspace?: string;
    path: string;
    startLine: number;
    endLine: number;
    content: string;
}
