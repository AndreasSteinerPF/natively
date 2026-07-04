import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';

type PinnedContextResponse = {
  value: string
}

function hasMeetingCopilotApi() {
  return Boolean(window.electronAPI?.meetingCopilot?.invoke)
}

export function PinnedContextEditor() {
  const api = window.electronAPI?.meetingCopilot
  const [savedValue, setSavedValue] = useState('')
  const [draftValue, setDraftValue] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedValueRef = useRef(savedValue)
  const draftValueRef = useRef(draftValue)

  useEffect(() => {
    savedValueRef.current = savedValue
  }, [savedValue])

  useEffect(() => {
    draftValueRef.current = draftValue
  }, [draftValue])

  useEffect(() => {
    if (!api?.invoke) {
      setIsLoading(false)
      return
    }

    let cancelled = false
    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.invoke({
          type: 'context:pin:get',
        }) as PinnedContextResponse
        if (cancelled) {
          return
        }
        setSavedValue(response.value)
        setDraftValue(response.value)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()

    const unsubscribe = api.onEvent?.((event) => {
      if (event.type !== 'context:pin:updated') {
        return
      }

      setSavedValue(event.value)
      setError(null)
      setIsSaving(false)
      if (draftValueRef.current === savedValueRef.current) {
        setDraftValue(event.value)
      }
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [api])

  const isDirty = useMemo(() => draftValue !== savedValue, [draftValue, savedValue])

  if (!hasMeetingCopilotApi()) {
    return null
  }

  const save = async () => {
    if (!api?.invoke || isSaving) {
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      const response = await api.invoke({
        type: 'context:pin:update',
        value: draftValue,
      }) as PinnedContextResponse
      setSavedValue(response.value)
      setDraftValue(response.value)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setIsSaving(false)
    }
  }

  const reset = async () => {
    if (!api?.invoke || isSaving) {
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      const response = await api.invoke({
        type: 'context:pin:reset',
      }) as PinnedContextResponse
      setSavedValue(response.value)
      setDraftValue(response.value)
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="relative no-drag mx-4 mt-2 mb-1">
      <details className="rounded-[14px] border border-white/10 overlay-subtle-surface">
        <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-medium overlay-text-primary">
          <div className="flex items-center justify-between gap-2">
            <span>Pinned context</span>
            <span className="text-[10px] overlay-text-muted">
              {isLoading ? 'Loading' : isSaving ? 'Saving' : isDirty ? 'Unsaved' : 'Saved'}
            </span>
          </div>
        </summary>
        <div className="border-t border-white/10 px-3 py-3">
          <textarea
            value={draftValue}
            onChange={(event) => setDraftValue(event.target.value)}
            disabled={isLoading || isSaving}
            className="min-h-[132px] w-full resize-y rounded-[10px] border border-white/10 bg-black/10 px-3 py-2 text-[11px] leading-5 overlay-text-primary outline-none transition-colors focus:border-white/20"
            spellCheck={false}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] overlay-text-muted">
              {draftValue.length} chars
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void reset()}
                disabled={isLoading || isSaving}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] overlay-text-primary transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={isLoading || isSaving || !isDirty}
                className="inline-flex items-center gap-1 rounded-md border border-sky-400/30 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </button>
            </div>
          </div>
          {error ? (
            <div className="mt-2 text-[10px] text-rose-300">
              {error}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  )
}
