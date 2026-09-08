# Third-party notices

This project directly depends on selected packages from
[`earendil-works/pi`](https://github.com/earendil-works/pi) at commit
`2e4d23959485279aa2da1a45103de2ea22d46395`.

Pi is licensed under the MIT License, Copyright (c) 2025 Mario Zechner:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The query-centered snippet logic adapts Reasonix's `MakeSnippet`, licensed
under the same MIT terms above, Copyright (c) 2026 Reasonix Contributors.

OpenAI Codex, TencentDB Agent Memory, and Unlimited-OCR are not distributed in
this project. Their pinned commits and licenses are recorded in
`references.lock.yaml`. The explicit worker bootstrap may fetch the pinned
TencentDB Agent Memory and Unlimited-OCR checkouts plus Unlimited-OCR's upstream
Apache-2.0 SGLang wheel into a separate worker directory. On Apple Silicon it
may instead install MLX-VLM 0.6.8 (MIT, Copyright © 2025 Prince Canuma) and the
MIT-licensed `mlx-community/Unlimited-OCR-mxfp8` model at the recorded revision.
These external runtimes are not copied into a Codetonomy release; the SGLang
wheel checksum and top-level MLX package version are verified, and model weights
are never packaged.

The optional Python workers depend on openpyxl and python-pptx (MIT), Pillow
(HPND), and pypdfium2 (Apache-2.0 OR BSD-3-Clause). pypdfium2 wheels commonly
bundle PDFium and its dependency license files; those files must remain with any
redistributed wheel. Codetonomy uses pypdfium2 instead of Unlimited-OCR's
PyMuPDF rendering example so the worker does not introduce PyMuPDF's AGPL or
commercial-license requirement.

The pnpm patch in `patches/@earendil-works__pi-ai@0.84.1.patch` modifies Pi
0.84.1 provider finalization, argument validation, and provider retry telemetry.
The MIT copyright and permission notice above apply to these modifications.
