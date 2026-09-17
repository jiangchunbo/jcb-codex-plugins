# Editor operations

`editorRead` and `editorPatch` require a precise `target`, including target.frame when needed.
Use observe to identify the editor container. Native text inputs/textareas and supported Monaco
instances are handled by adapters; editorRead returns the selected adapter explicitly.

`editorRead` defaults to 6000 text characters. Its hash represents the full value, not the preview.
A truncated read is insufficient to reconstruct the full document: use exact small replacements.
`editorPatch` requires oldText and newText; expectedHash can reject changes since the read.
Multiple occurrences are rejected. No regular expressions, implicit insertion, automatic Save,
or repeated mutation are performed.

Monaco adapter selection must associate an actual editor instance with the requested container.
A bounded compatibility path may inspect a React class wrapper's editor instance; this is not a
promise to support every React/Monaco version. Missing instances are unsupported, not a reason to
walk arbitrary application objects or copy a virtualized textarea as the complete source.

Local readback verifies editor contents only. Click Save only within the task's authorization,
check the application's response, and reload/read to verify persistence. A failure after a write
may leave a partial outcome; inspect before deciding on any next mutation.
