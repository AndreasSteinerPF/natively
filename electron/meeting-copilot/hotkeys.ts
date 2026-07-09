import type { MeetingCopilotInvoke } from './types';

export interface MeetingCopilotHotkeyBinding {
    keybindId: string;
    actionId: string;
}

export const MEETING_COPILOT_HOTKEY_BINDINGS: MeetingCopilotHotkeyBinding[] = [
    { keybindId: 'meeting-copilot:quick-answer', actionId: 'quick-answer' },
    { keybindId: 'meeting-copilot:deep-answer', actionId: 'deep-answer' },
    { keybindId: 'meeting-copilot:tech-solver-parallel', actionId: 'tech-solver-parallel' },
];

const MEETING_COPILOT_HOTKEY_ACTIONS = new Map(
    MEETING_COPILOT_HOTKEY_BINDINGS.map((binding) => [binding.keybindId, binding.actionId] as const)
);

let meetingCopilotActionStarter:
    | ((payload: Extract<MeetingCopilotInvoke, { type: 'action:start' }>) => Promise<unknown> | unknown)
    | null = null;

export function setMeetingCopilotActionStarter(
    starter: ((payload: Extract<MeetingCopilotInvoke, { type: 'action:start' }>) => Promise<unknown> | unknown) | null,
): void {
    meetingCopilotActionStarter = starter;
}

export function toMeetingCopilotActionStartPayload(
    keybindId: string,
): Extract<MeetingCopilotInvoke, { type: 'action:start' }> | null {
    const actionId = MEETING_COPILOT_HOTKEY_ACTIONS.get(keybindId);
    if (!actionId) return null;
    return { type: 'action:start', actionId };
}

export async function startMeetingCopilotActionForKeybind(keybindId: string): Promise<boolean> {
    const payload = toMeetingCopilotActionStartPayload(keybindId);
    if (!payload || !meetingCopilotActionStarter) return false;
    await meetingCopilotActionStarter(payload);
    return true;
}
