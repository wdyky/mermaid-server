import { FilePlus2, Moon, Sun } from 'lucide-react'

interface Props {
  dark: boolean
  onToggleDark: () => void
  onOpen: () => void
}

export function Navbar({ dark, onToggleDark, onOpen }: Props) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 100 100" className="h-6 w-6" aria-hidden>
          <path
            d="M10 50 L35 25 L65 75 L90 50"
            fill="none"
            stroke="currentColor"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-rose-500"
          />
        </svg>
        <span className="text-sm font-semibold tracking-tight">mermaid-server</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
        >
          <FilePlus2 className="h-4 w-4" />
          Open
        </button>
        <button
          type="button"
          onClick={onToggleDark}
          title="Toggle theme"
          className="rounded-md p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  )
}
