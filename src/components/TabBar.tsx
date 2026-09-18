import { X } from 'lucide-react'
import clsx from 'clsx'
import type { Tab } from '../lib/types'

interface Props {
  tabs: Tab[]
  active: string | null
  dirty: ReadonlySet<string>
  onSelect: (name: string) => void
  onClose: (name: string) => void
}

export function TabBar({ tabs, active, dirty, onSelect, onClose }: Props) {
  if (tabs.length === 0) return null
  return (
    <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-zinc-200 bg-zinc-100 px-2 pt-1 dark:border-zinc-800 dark:bg-zinc-900">
      {tabs.map((tab) => {
        const isActive = tab.name === active
        return (
          <div
            key={tab.name}
            onClick={() => onSelect(tab.name)}
            className={clsx(
              'group flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-sm',
              isActive
                ? 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100'
                : 'border-transparent bg-zinc-200/60 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:bg-zinc-800',
            )}
          >
            <span className="max-w-48 truncate">{tab.name}</span>
            {dirty.has(tab.name) && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                title="Unsaved changes"
              />
            )}
            <button
              type="button"
              title="Close tab"
              className="rounded p-0.5 text-zinc-400 opacity-0 hover:bg-zinc-300 group-hover:opacity-100 dark:hover:bg-zinc-700"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.name)
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
