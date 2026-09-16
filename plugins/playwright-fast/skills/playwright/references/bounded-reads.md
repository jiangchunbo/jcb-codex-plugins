# Bounded extraction

Locate the actual log/results container first. For a read-only `evaluate`, adapt this function to
its observed selector and the relevant log window. It selects the last 80 lines and at most 6000
characters, preserving enough metadata to distinguish a bounded excerpt from a complete result.

```js
() => {
  const element = document.querySelector("[data-testid='logs']");
  if (!element) throw new Error("Observed log container is absent");
  const text = element.innerText;
  const lines = text.split("\n");
  const window = lines.slice(-80).join("\n");
  const excerpt = window.slice(-6000);
  return {
    excerpt,
    totalLines: lines.length,
    totalChars: text.length,
    returnedLines: excerpt ? excerpt.split("\n").length : 0,
    returnedChars: excerpt.length,
    truncated: excerpt.length < text.length,
    window: "tail: at most 80 lines and 6000 characters",
    startsMidLine: window.length > excerpt.length && window[window.length - excerpt.length - 1] !== "\n"
  };
}
```

For a filtered excerpt, report the filter and matching count as well. Do not assume omitted lines
contain no errors. For tables return named columns and row keys rather than `outerHTML`; for controls
return actual visible button/link/input/select attributes in the relevant container. Keep rows and
control counts bounded too. A full output artifact is a fallback for deliberate narrow inspection,
not a reason to request an unbounded page dump.
