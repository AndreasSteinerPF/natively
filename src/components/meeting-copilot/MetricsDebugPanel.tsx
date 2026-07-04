import type { LlmCallMetrics } from '../../../electron/meeting-copilot/types';

const METRIC_FIELDS: Array<{
  key: keyof LlmCallMetrics;
  label: string;
  format?: (value: NonNullable<LlmCallMetrics[keyof LlmCallMetrics]>) => string;
}> = [
  { key: 'model', label: 'Model' },
  { key: 'context_mode', label: 'Context' },
  { key: 'cache_policy', label: 'Cache' },
  {
    key: 'project_context_included',
    label: 'Project Docs',
    format: (value) => (value ? 'Included' : 'No'),
  },
  {
    key: 'project_context_pack_names',
    label: 'Pack Names',
    format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
  },
  { key: 'project_context_chars', label: 'Docs Chars' },
  { key: 'project_context_file_count', label: 'Docs Files' },
  {
    key: 'freshness_check_used',
    label: 'Freshness Check',
    format: (value) => (value ? 'Used' : 'No'),
  },
  {
    key: 'freshness_sources',
    label: 'Freshness Sources',
    format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
  },
  { key: 'freshness_query_count', label: 'Freshness Queries' },
  { key: 'freshness_result_count', label: 'Freshness Results' },
  { key: 'freshness_verified_at', label: 'Verified At' },
  { key: 'freshness_error', label: 'Freshness Status' },
  { key: 'cached_tokens', label: 'Cached' },
  { key: 'cache_write_tokens', label: 'Cache Write' },
  { key: 'tool_rounds', label: 'Tool Rounds' },
  { key: 'tool_calls', label: 'Tool Calls' },
  {
    key: 'code_context_included',
    label: 'Code',
    format: (value) => (value ? 'Yes' : 'No'),
  },
  {
    key: 'time_to_first_token_ms',
    label: 'TTFT',
    format: (value) => `${value} ms`,
  },
  {
    key: 'total_latency_ms',
    label: 'Latency',
    format: (value) => `${value} ms`,
  },
];

export function MetricsDebugPanel({
  metrics,
}: {
  metrics?: LlmCallMetrics;
}) {
  if (!metrics) {
    return null;
  }

  const entries = METRIC_FIELDS.flatMap((field) => {
    const value = metrics[field.key];
    if (value === undefined || value === null || value === '') {
      return [];
    }

    const rendered = field.format
      ? field.format(value as NonNullable<typeof value>)
      : String(value);

    return [{ label: field.label, value: rendered }];
  });

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 border-t border-white/10 pt-2">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] leading-4 sm:grid-cols-3">
        {entries.map((entry) => (
          <div key={entry.label} className="min-w-0">
            <dt className="overlay-text-muted truncate">{entry.label}</dt>
            <dd className="overlay-text-primary truncate">{entry.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
