import {
    TranscriptChunk,
    TranscriptChunkInput,
    TranscriptMessageInput,
    TranscriptSnapshot,
} from './types';

export interface TranscriptBufferOptions {
    meetingId: string;
}

function cloneChunk(chunk: TranscriptChunk): TranscriptChunk {
    return { ...chunk };
}

export class TranscriptBuffer {
    private readonly meetingId: string;
    private readonly chunks: TranscriptChunk[] = [];

    constructor(options: TranscriptBufferOptions) {
        this.meetingId = options.meetingId;
    }

    append(input: TranscriptChunkInput): TranscriptChunk {
        const chunk: TranscriptChunk = {
            id: `chunk:${String(this.chunks.length + 1).padStart(4, '0')}`,
            meeting_id: this.meetingId,
            start_ts: input.start_ts,
            end_ts: input.end_ts,
            text: input.text,
            source: input.source,
        };

        this.chunks.push(chunk);
        return cloneChunk(chunk);
    }

    appendMessage(input: TranscriptMessageInput): never {
        throw new Error(
            `Only meeting-only transcript chunks can be appended; received unsupported ${input.role} message`
        );
    }

    snapshot(): TranscriptSnapshot {
        return {
            meeting_id: this.meetingId,
            chunks: this.chunks.map(cloneChunk),
        };
    }
}
