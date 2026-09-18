import { useEffect, useRef } from 'react'
import { RotateCw, Save } from 'lucide-react'
import { monaco } from '../lib/monaco'
import type { Tab } from '../lib/types'

interface Props {
  tab: Tab
  dark: boolean
  onSave: () => void
  onReload: () => void
  onChange: (content: string) => void
}

export function EditorPane({ tab, dark, onSave, onReload, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  // True while we programmatically set the model value (tab switch / load /
  // reload). Monaco fires onDidChangeModelContent even for programmatic sets;
  // without this guard every load would mark the tab dirty.
  const programmaticRef = useRef(false)

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = monaco.editor.create(host, {
      value: '',
      language: 'mermaid',
      theme: dark ? 'mermaid-dark' : 'mermaid',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      tabSize: 2,
      padding: { top: 8 },
    })
    editorRef.current = editor
    editor.onDidChangeModelContent(() => {
      if (programmaticRef.current) return
      onChangeRef.current(editor.getValue())
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })
    return () => {
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load content when switching tabs.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (editor && model && model.getValue() !== tab.content) {
      programmaticRef.current = true
      model.setValue(tab.content)
      // setValue fires the change event synchronously; clear the flag for
      // any later (real) edits this or later ticks.
      queueMicrotask(() => {
        programmaticRef.current = false
      })
    }
  }, [tab.name, tab])

  // Follow the UI theme.
  useEffect(() => {
    monaco.editor.setTheme(dark ? 'mermaid-dark' : 'mermaid')
  }, [dark])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <span className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={tab.path}>
          {tab.path}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onReload}
            title="Reload from disk"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Reload
          </button>
          <button
            type="button"
            onClick={onSave}
            title="Save to disk (Ctrl+S)"
            className="flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-500"
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  )
}
