import fs from 'node:fs';
import path from 'node:path';

import { LlmCallMetrics, TranscriptSnapshot } from './types';

export interface MeetingCopilotReviewLogEntry {
    type: 'action_completed';
    logged_at: string;
    meeting_id: string;
    run_id: string;
    action_id: string;
    branch: string;
    final_text: string;
    transcript_snapshot: TranscriptSnapshot;
    action_history_before: string;
    image_paths: string[];
    metrics: LlmCallMetrics;
}

export interface ReviewLogStoreOptions {
    baseDir: string;
    now?: () => Date;
}

function safeFilePart(value: string): string {
    return value
        .replace(/[^A-Za-z0-9_.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 96) || 'meeting';
}

export class ReviewLogStore {
    private readonly baseDir: string;
    private readonly now: () => Date;

    constructor(options: ReviewLogStoreOptions) {
        this.baseDir = options.baseDir;
        this.now = options.now ?? (() => new Date());
    }

    record(entry: Omit<MeetingCopilotReviewLogEntry, 'logged_at'>): void {
        fs.mkdirSync(this.baseDir, { recursive: true });
        const loggedAt = this.now().toISOString();
        const filePath = path.join(this.baseDir, `${safeFilePart(entry.meeting_id)}.jsonl`);
        const record: MeetingCopilotReviewLogEntry = {
            ...entry,
            logged_at: loggedAt,
        };
        fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    }
}
