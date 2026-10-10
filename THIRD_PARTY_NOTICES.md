# Third-party notices

claude-soma-lite adapts ideas from the third-party project below. As attribution, its copyright
notice and permission notice are reproduced here in full.

## loop-engineering

- **Project:** <https://github.com/cobusgreyling/loop-engineering>
- **Licence:** MIT
- **Licence text:** copied verbatim from the project's `LICENSE` file at commit
  `0978edd85966d77703522ca3a7974314db92d5d4`, retrieved on 2026-10-09 (UTC):
  <https://github.com/cobusgreyling/loop-engineering/blob/0978edd85966d77703522ca3a7974314db92d5d4/LICENSE>
- **What claude-soma-lite adapted:** the H1 to H6 loop-harness registry (`prompts/harnesses.json`,
  read by `bin/lib/harness.mjs`). The registry's concept, vocabulary and some field names (e.g.
  the circuit-breaker knobs `max_iterations`, `stagnation` and `no_progress`, after the options of
  upstream's `loop-context` tool) follow upstream; no text was copied, and a comparison of the two
  projects found no shared passages.

```text
MIT License

Copyright (c) 2026 Cobus Greyling and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trademarks

Claude and Claude Code are trademarks of Anthropic, PBC. claude-soma-lite is an independent project
and is not affiliated with, endorsed by or sponsored by Anthropic. The project's name refers to the
software it works with; it is descriptive, not a claim of affiliation. Elsewhere, Claude and Claude
Code are named only to say what this tool works with, and never appear as a logo.
