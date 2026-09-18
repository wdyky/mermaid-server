import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import { initEditor } from './monacoExtra'

// Only the core editor worker is needed: 'mermaid' is our only language and
// it is a plain Monarch definition (no language-specific worker).
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}

// Registers the 'mermaid' language (tokenizer, themes, config) — definition
// copied from the mermaid live editor.
initEditor(monaco)

export { monaco }
