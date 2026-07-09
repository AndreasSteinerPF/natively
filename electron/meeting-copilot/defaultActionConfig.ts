import { MeetingCopilotConfig, MeetingCopilotPreset } from './types';

export const DEFAULT_MEETING_COPILOT_STABLE_INSTRUCTIONS = [
    'You are my live technical meeting copilot.',
    '',
    'Evidence hierarchy:',
    '1. Meeting transcript is the source of truth for what was said.',
    '2. Project docs are useful orientation and hypotheses.',
    '3. Actual repo code is the source of truth for implementation details.',
    '4. Fresh external sources are the source of truth for current public facts.',
    '5. LLM prior knowledge may be stale.',
    '',
    'Use project docs for orientation.',
    'Verify implementation-sensitive claims against code.',
    'When docs and code disagree, prefer code and say the docs appear stale, incomplete, or directionally correct only.',
    '',
    'Transcript lines are labeled [ME] (me, the user) or [INTERVIEWER] (the other person).',
    'Your job is to help me in the discussion generally, not just answer literal questions.',
    "A question or challenge from the INTERVIEWER is PENDING only until my own [ME] lines give",
    'it a real, substantive answer. While pending — I am thinking out loud, restating it, or only',
    'partway through a first attempt — address it, not whatever else I happen to be saying.',
    'The moment I have actually answered it, treat it as RESOLVED, even if no new INTERVIEWER',
    "line has followed. Do not re-answer a resolved question just because it's the last one",
    'asked — that is the most common mistake to avoid here. If the INTERVIEWER raised more than',
    'one thing, prioritize whatever is still pending, not whatever came first.',
    'Once resolved, or if nothing was ever asked, help me with whatever I am currently building',
    'on — a sharper way to phrase what I am saying, a detail I am at risk of forgetting, a gap or',
    'risk worth flagging, or a natural next point — not a stale question I already got through.',
].join('\n');

const DEFAULT_OPENROUTER_CONFIG: MeetingCopilotConfig['openrouter'] = {
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    default_headers: {
        'HTTP-Referer': 'https://localhost/natively-private',
        'X-Title': 'Natively Private Fork',
    },
};

const SYSTEM_DESIGN_GUIDE_PROMPT = [
    'You are my live system design interview copilot.',
    'Requirements are given up front. Do not default to discovery questions unless a critical ambiguity blocks the design.',
    'Infer the current design phase and likely problem pattern from the transcript, prior action history, and any screenshot-derived board context.',
    'Return exactly these sections in this order: Step, Goal, Draw, Say, Key Decisions.',
    'Guide one complete design phase, not a micro-step.',
    'Draw must be ordered Excalidraw actions I can execute directly.',
    'Say must be concise interview-ready lines I can speak while drawing.',
    'Key Decisions should capture the main assumptions, tradeoffs, or risks to mention for this phase.',
    'Prefer generic architecture language first, but bias toward Python, FastAPI or Sanic, Postgres by default, Redis for cache, Kafka/RabbitMQ/SQS when async messaging is useful, AWS familiarity, and simplicity over over-engineering.',
].join('\n');

const SYSTEM_DESIGN_DEEPER_PROMPT = [
    'You are my live system design interview reviewer.',
    'Use the transcript, prior action history, and any screenshot-derived board context to critique the current design.',
    'Build on the current design instead of restarting from scratch unless the current approach is fundamentally broken.',
    'Strengthen weak tradeoffs, identify missing components, call out bottlenecks or failure modes, and give sharper follow-up language I can use.',
    'Keep the response concise enough to use during a live interview.',
].join('\n');

const MEETING_DEFAULT_CONFIG: MeetingCopilotConfig = {
    openrouter: DEFAULT_OPENROUTER_CONFIG,
    actions: {
        'quick-answer': {
            label: 'Quick Answer',
            trigger: {
                hotkey: 'Command+Shift+1',
                slash: '/quick',
                button: false,
            },
            model: 'google/gemini-3.5-flash',
            context_mode: 'recent',
            cache_policy: 'none',
            context_minutes: 4,
            // No max_tokens: a fixed cap (previously 300) truncated answers mid-sentence once
            // project_docs_enabled gave the model enough material to want to write more than
            // that (finish_reason 'length', but the app had no way to detect that and
            // mislabeled the truncated answer "Complete"). Omitting it lets the provider use
            // the model's own max output; the prompt below is the real length control.
            temperature: 0.3,
            reasoning: {
                effort: 'low',
            },
            // Gemini 2.5+ gets automatic implicit prompt caching (90% off cache hits, no
            // cache_control needed) — repeated quick-answer presses within a few minutes
            // mostly hit cache for this section, since ContextBuilder places it before the
            // per-call-varying transcript. First press in a burst (or after a gap) still
            // pays full price/latency for the docs.
            project_docs_enabled: true,
            prompt: "Using the recent transcript, give me the single most helpful thing to say right now — answer the INTERVIEWER's pending question if there is one, otherwise whatever would actually help (a sharper point, a risk to flag, a natural next thing to say). Strictly 1-3 sentences I can say out loud immediately, even though the project docs contain much more detail than that — pick the single most important detail rather than trying to cover everything. Prioritize speed and usefulness over completeness.",
        },
        'deep-answer': {
            label: 'Deep Answer',
            trigger: {
                hotkey: 'Command+Shift+2',
                slash: '/deep',
                button: false,
            },
            model: 'anthropic/claude-opus-4.8',
            context_mode: 'full_cached',
            cache_policy: 'anthropic_explicit_1h',
            temperature: 0.2,
            reasoning: {
                effort: 'medium',
            },
            tools_enabled: true,
            max_tool_rounds: 2,
            max_tool_calls_per_round: 4,
            web_search_enabled: true,
            prompt: 'Give me a deep, thorough answer, grounded in the project docs and code tools (real numbers, names, decisions) instead of generic advice — this is likely a deep-dive, trade-off, or "what if you had done X instead" question about a system I built, or something I said that deserves scrutiny. Focus on technical correctness, design trade-offs, hidden assumptions, risks, and how I would defend or reconsider a choice under scrutiny. Keep it readable during a live interview: lead with the single most important point, then at most 2-3 short supporting points — do not write an essay, and stop once you have made the key points even if there is more you could say.',
        },
        'tech-solver-parallel': {
            label: 'Tech Solver: Fast + Deep',
            trigger: {
                hotkey: 'Command+Shift+3',
                slash: '/tech2',
                button: false,
            },
            parallel: {
                fast: {
                    model: 'google/gemini-3.5-flash',
                    context_mode: 'recent',
                    cache_policy: 'none',
                    context_minutes: 5,
                    temperature: 0.3,
                    reasoning: {
                        effort: 'low',
                    },
                    tools_enabled: false,
                    prompt: "Give me the single most helpful thing to say right now — answer the INTERVIEWER's pending question if there is one, otherwise whatever would actually help (a sharper point, a risk to flag, a next thing to say) — that I can say out loud immediately. Keep it concise and practical.",
                },
                deep: {
                    model: 'anthropic/claude-opus-4.8',
                    context_mode: 'full_cached',
                    cache_policy: 'anthropic_explicit_1h',
                    temperature: 0.2,
                    reasoning: {
                        effort: 'medium',
                    },
                    tools_enabled: true,
                    max_tool_rounds: 2,
                    max_tool_calls_per_round: 4,
                    web_search_enabled: true,
                    prompt: 'Give me a deeper, more thorough take than a fast reflexive answer would give — you do not see the fast answer, so do not assume or refer to what it said; just go as deep as the situation calls for. If the INTERVIEWER has a pending question, challenge, trade-off, or "what if you had done X instead" scenario, answer it thoroughly, grounded in the project docs and code tools (real numbers, names, decisions) instead of generic advice. If nothing is pending, use the extra depth to surface a risk, trade-off, or angle on what I was just saying that a fast answer would miss. Focus on technical correctness, design trade-offs, hidden assumptions, risks, and how I would defend or reconsider the choice under scrutiny. Keep it readable during a live interview: lead with the single most important point, then at most 2-3 short supporting points — do not write an essay, and stop once you have made the key points even if there is more you could say.',
                },
            },
        },
    },
    workspaces: [],
    code_context: {
        enabled: true,
        retrieval_mode: 'tool_loop',
        max_total_chars: 12000,
        include_file_paths: true,
        include_line_numbers: true,
    },
    transcript_context: {
        max_total_chars: 24_000,
    },
    project_context: {
        enabled: false,
        max_docs_chars_per_pack: 20_000,
        max_total_docs_chars: 40_000,
        packs: [],
    },
};

const SYSTEM_DESIGN_INTERVIEW_CONFIG: MeetingCopilotConfig = {
    openrouter: DEFAULT_OPENROUTER_CONFIG,
    actions: {
        'guide-me': {
            label: 'Guide Me',
            trigger: {
                hotkey: 'Command+Shift+1',
                slash: '/guide',
                button: false,
            },
            model: 'anthropic/claude-opus-4.8',
            context_mode: 'full_cached',
            cache_policy: 'anthropic_explicit_1h',
            temperature: 0.2,
            reasoning: {
                effort: 'medium',
            },
            prompt: SYSTEM_DESIGN_GUIDE_PROMPT,
        },
        'go-deeper': {
            label: 'Go Deeper',
            trigger: {
                hotkey: 'Command+Shift+2',
                slash: '/deeper',
                button: false,
            },
            model: 'anthropic/claude-opus-4.8',
            context_mode: 'full_cached',
            cache_policy: 'anthropic_explicit_1h',
            temperature: 0.2,
            reasoning: {
                effort: 'high',
            },
            prompt: SYSTEM_DESIGN_DEEPER_PROMPT,
        },
    },
    workspaces: [],
    code_context: {
        enabled: false,
        retrieval_mode: 'tool_loop',
        max_total_chars: 12000,
        include_file_paths: false,
        include_line_numbers: false,
    },
    transcript_context: {
        max_total_chars: 24_000,
    },
    project_context: {
        enabled: false,
        max_docs_chars_per_pack: 20_000,
        max_total_docs_chars: 40_000,
        packs: [],
    },
};

export function getDefaultMeetingCopilotConfig(
    preset: MeetingCopilotPreset = 'meeting-default'
): MeetingCopilotConfig {
    if (preset === 'system-design-interview') {
        return structuredClone(SYSTEM_DESIGN_INTERVIEW_CONFIG);
    }

    return structuredClone(MEETING_DEFAULT_CONFIG);
}

export const DEFAULT_MEETING_COPILOT_CONFIG: MeetingCopilotConfig = getDefaultMeetingCopilotConfig();
