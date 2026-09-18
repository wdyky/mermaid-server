import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUp,
  ChevronRight,
  File,
  FileText,
  Folder,
  Loader2,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { api, type BrowseResult } from '../lib/api'
import { loadLastDir, saveLastDir } from '../lib/storage'

interface Props {
  existingNames: string[]
  onClose: () => void
  onConfirm: (name: string, path: string) => Promise<void>
}

const joinPath = (dir: string, entry: string): string =>
  dir === '/' ? `/${entry}` : `${dir}/${entry}`

// Mounted only while open (parent renders it conditionally), so fresh state
// on every open — no reset effect needed.
export function OpenDialog({ existingNames, onClose, onConfirm }: Props) {
  const [dirInput, setDirInput] = useState('')
  const [data, setData] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true)
    setBrowseError(null)
    try {
      const res = await api.browse(dir)
      setData(res)
      setDirInput(res.path)
      saveLastDir(res.path)
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Load the starting directory on mount (fetch → setState is the
  // legitimate external-system case; the rule is a heuristic false positive).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDir(loadLastDir() ?? '')
  }, [loadDir])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const chooseFile = (file: string) => {
    if (!data) return
    const abs = joinPath(data.path, file)
    setSelected(abs)
    setName(file.replace(/\.(md|markdown|mmd)$/i, ''))
    setNameError(null)
  }

  const confirm = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Name is required')
      return
    }
    if (existingNames.includes(trimmed)) {
      setNameError(`Tab “${trimmed}” already exists`)
      return
    }
    if (!selected) return
    setSubmitting(true)
    setNameError(null)
    try {
      await onConfirm(trimmed, selected)
      onClose()
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls =
    'w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-rose-500 dark:border-zinc-700 dark:bg-zinc-900'
  const secondaryBtn =
    'flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">
            {selected ? 'Name the tab' : 'Open file'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!selected ? (
          <>
            <div className="flex items-center gap-2 px-4 pt-3">
              {data?.parent && (
                <button
                  type="button"
                  title="Up one level"
                  className="rounded-md border border-zinc-300 p-1.5 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => data.parent && void loadDir(data.parent)}
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
              <input
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadDir(dirInput)
                }}
                placeholder="/path/to/start"
                className={inputCls}
                spellCheck={false}
              />
              <button
                type="button"
                className={secondaryBtn}
                onClick={() => void loadDir(dirInput)}
              >
                Go
              </button>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {loading && (
                <div className="flex items-center gap-2 p-4 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              )}
              {browseError && <p className="p-2 text-sm text-red-600 dark:text-red-400">{browseError}</p>}
              {data && !loading && (
                <ul className="text-sm">
                  {data.dirs.map((d) => (
                    <li key={d}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        onClick={() => void loadDir(joinPath(data.path, d))}
                      >
                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                        <span className="truncate">{d}</span>
                        <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-400" />
                      </button>
                    </li>
                  ))}
                  {data.files.map((f) => (
                    <li key={f.name}>
                      <button
                        type="button"
                        disabled={!f.isMd}
                        onClick={() => chooseFile(f.name)}
                        className={clsx(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                          f.isMd
                            ? 'text-zinc-800 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800'
                            : 'cursor-default text-zinc-400 dark:text-zinc-600',
                        )}
                        title={f.isMd ? f.name : 'Only .md / .markdown / .mmd files can be opened'}
                      >
                        {f.isMd ? (
                          <FileText className="h-4 w-4 shrink-0 text-rose-500" />
                        ) : (
                          <File className="h-4 w-4 shrink-0 opacity-50" />
                        )}
                        <span className="truncate">{f.name}</span>
                      </button>
                    </li>
                  ))}
                  {data.dirs.length === 0 && data.files.length === 0 && (
                    <li className="p-2 text-zinc-500">Empty directory</li>
                  )}
                </ul>
              )}
            </div>
            <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">
                Pick a <code>.md</code>, <code>.markdown</code> or <code>.mmd</code> file containing
                mermaid code.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="px-4 pt-3">
              <p className="truncate rounded-md bg-zinc-100 px-2.5 py-1.5 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                {selected}
              </p>
            </div>
            <div className="px-4 pt-3">
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Tab name
              </label>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirm()
                }}
                autoFocus
                className={inputCls}
                spellCheck={false}
              />
              {nameError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{nameError}</p>}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3">
              <button type="button" className={secondaryBtn} onClick={() => setSelected(null)}>
                Back
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void confirm()}
                className="flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Open
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
