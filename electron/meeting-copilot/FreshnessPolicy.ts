import { ActionBranch, FreshnessCategory, FreshnessDecision } from './types'

export const FRESHNESS_STABLE_INSTRUCTION_LINES = [
    'When model/provider/pricing/API/ranking/legal/news/current-event facts may have changed, verify with a current source before making confident claims.',
    'If verification is unavailable, say the claim is unverified or currentness-uncertain.',
    'Do not use private meeting transcript or private code as a web search query.',
] as const

export const FRESHNESS_UNVERIFIED_CAVEAT =
    'This action may depend on current external facts. No freshness tool result is available, so mark those claims as unverified/currentness-uncertain.'

type ClassifierInput = {
    actionId: string
    branch?: ActionBranch
    prompt: string
    recentTranscriptText: string
    toolsAvailable?: boolean
}

type CategoryMatcher = {
    category: FreshnessCategory
    patterns: RegExp[]
}

const CATEGORY_MATCHERS: CategoryMatcher[] = [
    {
        category: 'model_availability',
        patterns: [
            /\bavailable\b.*\b(model|gpt|claude|gemini|openrouter|api)\b/i,
            /\b(waitlist|rollout|access|tier)\b.*\b(model|api|openrouter)\b/i,
        ],
    },
    {
        category: 'model_pricing',
        patterns: [
            /\b(pricing|price|cost|billing|per million tokens?|token price|credits?)\b/i,
        ],
    },
    {
        category: 'context_window',
        patterns: [
            /\b(context window|context length|max(?:imum)? context|max(?:imum)? input|token limit)\b/i,
        ],
    },
    {
        category: 'api_behavior',
        patterns: [
            /\b(api|sdk|responses api|chat completions?)\b.*\b(support|behavior|parameter|tool calls?|streaming|json mode|rate limit)\b/i,
            /\b(supported parameters?|parameter support|api behavior)\b/i,
        ],
    },
    {
        category: 'benchmark',
        patterns: [
            /\b(benchmark|leaderboard|lmsys|mmlu)\b/i,
            /\b(model|gpt|claude|gemini|openrouter|provider)\b.*\b(score|ranking|ranked)\b/i,
            /\b(score|ranking|ranked)\b.*\b(model|gpt|claude|gemini|openrouter|provider)\b/i,
        ],
    },
    {
        category: 'provider_status',
        patterns: [
            /\b(status|outage|degraded|incident|downtime|down)\b.*\b(openai|anthropic|openrouter|provider|api)\b/i,
            /\b(openai|anthropic|openrouter|provider|api)\b.*\b(status|outage|degraded|incident|downtime|down)\b/i,
        ],
    },
    {
        category: 'regulation',
        patterns: [
            /\b(regulation|law|legal|compliance)\b/i,
            /\b(eu ai act|gdpr|copyright law|executive order)\b/i,
        ],
    },
    {
        category: 'recent_release',
        patterns: [
            /\b(latest|newest|recent|released?|launch(?:ed)?|roll(?:ed)? out)\b.*\b(model|release|version|announce(?:d|ment)?)\b/i,
        ],
    },
    {
        category: 'company_announcement',
        patterns: [
            /\b(announced?|announcement|blog post|press release|earnings)\b/i,
            /\b(openai|anthropic|google|meta|microsoft|xai)\b.*\b(announced?|announcement|blog post|press release)\b/i,
        ],
    },
    {
        category: 'current_event',
        patterns: [
            /\b(today|yesterday|this week|this month|right now|breaking|news)\b/i,
            /\b(ai|model|provider|openai|anthropic|openrouter)\b.*\b(summit|conference|event)\b/i,
            /\b(summit|conference|event)\b.*\b(ai|model|provider|openai|anthropic|openrouter)\b/i,
            /\bcurrent events?\b/i,
        ],
    },
]

function toBoundedLowerText(...values: string[]): string {
    return values
        .join('\n')
        .slice(0, 8_000)
        .toLowerCase()
}

function detectCategories(text: string): FreshnessCategory[] {
    return CATEGORY_MATCHERS.filter((entry) => entry.patterns.some((pattern) => pattern.test(text))).map(
        (entry) => entry.category
    )
}

function actionAllowsFreshnessVerification(input: ClassifierInput): boolean {
    if (input.actionId === 'deep-answer') {
        return true
    }

    if (input.actionId === 'tech-solver-parallel' && input.branch === 'deep') {
        return true
    }

    return false
}

function canVerifyCurrentFacts(input: ClassifierInput): boolean {
    return input.toolsAvailable === true && actionAllowsFreshnessVerification(input)
}

function shouldOnlyCaveat(input: ClassifierInput): boolean {
    return (
        input.actionId === 'quick-answer' ||
        (input.actionId === 'tech-solver-parallel' && input.branch === 'fast')
    )
}

export function classifyFreshnessNeed(input: ClassifierInput): FreshnessDecision {
    const text = toBoundedLowerText(input.prompt, input.recentTranscriptText)
    const categories = detectCategories(text)

    if (categories.length === 0) {
        return {
            sensitivity: 'none',
            allowed: actionAllowsFreshnessVerification(input),
            shouldVerify: false,
            shouldCaveat: false,
            reason: 'No freshness-sensitive current external facts detected.',
            categories: [],
        }
    }

    const verifyCapable = canVerifyCurrentFacts(input)
    const allowed = actionAllowsFreshnessVerification(input)
    const mustCaveat = shouldOnlyCaveat(input) || !verifyCapable

    return {
        sensitivity: 'required',
        allowed,
        shouldVerify: verifyCapable && !mustCaveat,
        shouldCaveat: mustCaveat,
        reason: verifyCapable
            ? 'Current external facts detected and this action can verify them when a freshness tool exists.'
            : 'Current external facts detected, but freshness verification is unavailable so claims must stay unverified/currentness-uncertain.',
        categories,
    }
}

export function withFreshnessStableInstructions(stableInstructions: string): string {
    const base = stableInstructions.trim()
    const lines = [...FRESHNESS_STABLE_INSTRUCTION_LINES].filter(
        (line) => !base.includes(line)
    )

    if (lines.length === 0) {
        return stableInstructions
    }

    return [stableInstructions.trimEnd(), ...lines].filter((part) => part.length > 0).join('\n')
}
