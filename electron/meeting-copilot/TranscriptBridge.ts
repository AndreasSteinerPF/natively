import { mapSpeakerToRole } from '../SessionTracker';
import { TranscriptChunk, TranscriptChunkSource, TranscriptSnapshot } from './types';

export interface MeetingTranscriptSegment {
    speaker: string;
    text: string;
    timestamp: number;
}

export interface BuildTranscriptSnapshotInput {
    segments: MeetingTranscriptSegment[];
    meetingId: string;
    maxTotalChars: number;
}

const ROLE_LABELS: Record<'interviewer' | 'user', string> = {
    interviewer: 'INTERVIEWER',
    user: 'ME',
};

function toChunk(segment: MeetingTranscriptSegment, index: number, meetingId: string): TranscriptChunk | null {
    const role = mapSpeakerToRole(segment.speaker);
    if (role === 'assistant') {
        return null;
    }

    const isoTimestamp = new Date(segment.timestamp).toISOString();
    const source: TranscriptChunkSource = role === 'user' ? 'mic' : 'system';

    return {
        id: `chunk:${String(index + 1).padStart(4, '0')}`,
        meeting_id: meetingId,
        start_ts: isoTimestamp,
        end_ts: isoTimestamp,
        text: `[${ROLE_LABELS[role]}]: ${segment.text}`,
        source,
    };
}

function capToMostRecent(chunks: TranscriptChunk[], maxTotalChars: number): TranscriptChunk[] {
    if (maxTotalChars <= 0) {
        return [];
    }

    let totalChars = 0;
    let cutoffIndex = chunks.length;
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
        totalChars += chunks[i].text.length;
        if (totalChars > maxTotalChars) {
            cutoffIndex = i + 1;
            break;
        }
        cutoffIndex = i;
    }

    return chunks.slice(cutoffIndex);
}

export function buildTranscriptSnapshot(input: BuildTranscriptSnapshotInput): TranscriptSnapshot {
    const chunks: TranscriptChunk[] = [];
    input.segments.forEach((segment, index) => {
        const chunk = toChunk(segment, index, input.meetingId);
        if (chunk) {
            chunks.push(chunk);
        }
    });

    return {
        meeting_id: input.meetingId,
        chunks: capToMostRecent(chunks, input.maxTotalChars),
    };
}
