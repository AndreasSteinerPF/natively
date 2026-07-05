import { MeetingCopilotConfig } from './types';

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
    "If the INTERVIEWER has a pending question or challenge, answer it — even if my own [ME]",
    'lines since then were me thinking out loud, restating it, or partway through an answer;',
    'do not just react to the last line in the transcript. If the INTERVIEWER raised more than',
    'one thing, prioritize whatever I have not yet addressed.',
    'If nothing is pending, do not force an answer to a question that was not asked: instead',
    'give me whatever would actually help right now — a sharper way to phrase what I am saying,',
    'a detail I am at risk of forgetting, a gap or risk worth flagging, or a natural next point.',
].join('\n');

export const DEFAULT_MEETING_COPILOT_CONFIG: MeetingCopilotConfig = {
    openrouter: {
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
        default_headers: {
            'HTTP-Referer': 'https://localhost/natively-private',
            'X-Title': 'Natively Private Fork',
        },
    },
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
            max_tokens: 300,
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
            prompt: "Using the recent transcript, give me the single most helpful thing to say right now — answer the INTERVIEWER's pending question if there is one, otherwise whatever would actually help (a sharper point, a risk to flag, a natural next thing to say). 1-3 sentences I can say out loud immediately. Prioritize speed and usefulness over completeness.",
        },
        'claim-check': {
            label: 'Claim Check',
            trigger: {
                hotkey: 'Command+Shift+2',
                slash: '/check',
                button: false,
            },
            model: 'perplexity/sonar-pro-search',
            context_mode: 'recent',
            cache_policy: 'none',
            context_minutes: 5,
            max_tokens: 600,
            temperature: 0.1,
            prompt: "Check the most recent factual claim, number, or proposal in the transcript — mine or the INTERVIEWER's. Say whether it is likely correct, uncertain, incomplete, or likely wrong. Flag assumptions, factual uncertainty, logical gaps, and what evidence would resolve it.",
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
                    max_tokens: 350,
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
                    max_tokens: 900,
                    temperature: 0.2,
                    reasoning: {
                        effort: 'medium',
                    },
                    tools_enabled: true,
                    max_tool_rounds: 2,
                    max_tool_calls_per_round: 4,
                    web_search_enabled: true,
                    prompt: 'Give me a deeper, more thorough take than a fast reflexive answer would give — you do not see the fast answer, so do not assume or refer to what it said; just go as deep as the situation calls for. If the INTERVIEWER has a pending question, challenge, trade-off, or "what if you had done X instead" scenario, answer it thoroughly, grounded in the project docs and code tools (real numbers, names, decisions) instead of generic advice. If nothing is pending, use the extra depth to surface a risk, trade-off, or angle on what I was just saying that a fast answer would miss. Focus on technical correctness, design trade-offs, hidden assumptions, risks, and how I would defend or reconsider the choice under scrutiny.',
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
