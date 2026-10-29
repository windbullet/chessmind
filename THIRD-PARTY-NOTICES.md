# Third-party notices

ChessMind is distributed under the **MIT License** (see `LICENSE`).

Two of the bundled components are not MIT but are permissive licences that are
compatible with it; their full notice texts are reproduced below and must be
kept alongside any redistributed copy of this software.

## Chess pieces — "Cburnett"

The SVG chess piece set used by ChessMind is the **Cburnett** set by
**Colin M.L. Burnett**.

- Source: <https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces>
- Offered by the author under **GFDL / GPL / BSD-3-Clause** (Wikimedia Commons
  file pages use the template `{{self|GFDL|migration=relicense|BSD|GPL}}`, e.g.
  <https://commons.wikimedia.org/wiki/File:Chess_klt45.svg>).
- **ChessMind uses the BSD 3-Clause option**, which is the permissive choice and
  is what keeps this project MIT-compatible. No GPL-licensed material is
  incorporated in ChessMind.
- The artwork is embedded unmodified in shape; only the flat fill/stroke colours
  are driven by CSS custom properties so the pieces work on both light and dark
  boards. The licence also appears in Lichess' copying notes:
  <https://github.com/lichess-org/lila/blob/master/COPYING.md>

BSD 3-Clause text, as offered by the author:

```
Copyright (c) 2006, Colin M.L. Burnett
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## chess.js

Rules engine — BSD-2-Clause, <https://github.com/jhlyba/chess.js>.

Copyright (c) 2025, Jeff Hlywa.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Fonts and icons

- UI icons: [Lucide](https://lucide.dev) — ISC License.

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

- Type: system font stack (`Inter` when available).

## Libraries

| Package | License |
| --- | --- |
| React, React DOM | MIT |
| Tauri (Rust crate + JS API + CLI) | MIT OR Apache-2.0 |
| Zustand | MIT |
| Vite | MIT |
| Vitest | MIT |
| TypeScript | Apache-2.0 |
| reqwest, tokio, serde, futures-util | MIT OR Apache-2.0 |

See `package-lock.json` and `src-tauri/Cargo.lock` for the exact versions and
transitive dependency tree. Full license texts are available in each package's
own repository and inside `node_modules/` for npm packages.
