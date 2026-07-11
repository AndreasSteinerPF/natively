import type { MeetingCopilotActionConfig, MeetingCopilotInvoke } from './types';

export interface MeetingCopilotHotkeyBinding {
    keybindId: string;
    actionId: string;
    accelerator?: string;
}

export const MEETING_COPILOT_HOTKEY_BINDINGS: MeetingCopilotHotkeyBinding[] = [
    { keybindId: 'meeting-copilot:quick-answer', actionId: 'quick-answer', accelerator: 'Command+Shift+1' },
    { keybindId: 'meeting-copilot:deep-answer', actionId: 'deep-answer', accelerator: 'Command+Shift+2' },
    { keybindId: 'meeting-copilot:tech-solver-parallel', actionId: 'tech-solver-parallel', accelerator: 'Command+Option+3' },
];

let meetingCopilotHotkeyActions = new Map(
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

export function configureMeetingCopilotHotkeyBindings(bindings: MeetingCopilotHotkeyBinding[]): void {
    meetingCopilotHotkeyActions = new Map(
        bindings
            .filter((binding) => binding.keybindId.trim() && binding.actionId.trim())
            .map((binding) => [binding.keybindId, binding.actionId] as const)
    );
}

function normalizeAccelerator(accelerator: string): string {
    return accelerator
        .split('+')
        .map((part) => part.trim().toLowerCase())
        .sort()
        .join('+');
}

export function buildMeetingCopilotHotkeyBindings(
    actions: Record<string, MeetingCopilotActionConfig>,
): MeetingCopilotHotkeyBinding[] {
    const keybindIdsByAccelerator = new Map(
        MEETING_COPILOT_HOTKEY_BINDINGS
            .filter((binding) => binding.accelerator?.trim())
            .map((binding) => [normalizeAccelerator(binding.accelerator!), binding.keybindId] as const)
    );

    return Object.entries(actions).flatMap(([actionId, action]) => {
        const keybindId = keybindIdsByAccelerator.get(normalizeAccelerator(action.trigger.hotkey));
        return keybindId ? [{ keybindId, actionId }] : [];
    });
}

export function toMeetingCopilotActionStartPayload(
    keybindId: string,
): Extract<MeetingCopilotInvoke, { type: 'action:start' }> | null {
    const actionId = meetingCopilotHotkeyActions.get(keybindId);
    if (!actionId) return null;
    return { type: 'action:start', actionId };
}

export async function startMeetingCopilotActionForKeybind(keybindId: string): Promise<boolean> {
    const payload = toMeetingCopilotActionStartPayload(keybindId);
    if (!payload || !meetingCopilotActionStarter) return false;
    await meetingCopilotActionStarter(payload);
    return true;
}
