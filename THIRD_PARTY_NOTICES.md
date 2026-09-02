# Third-Party Notices

Sash itself is licensed under the MIT License in [`LICENSE`](./LICENSE). The built WebUI distributed in the npm package embeds code and selected assets from the components below. Those portions remain subject to their respective terms. Backend npm dependencies are installed as separate packages and retain their own package metadata and license files.

## Vue.js

- Package: `vue` 3.5.42 (including the bundled `@vue/runtime-*` modules)
- Project: <https://github.com/vuejs/core>
- License: MIT
- Copyright: Copyright (c) 2018-present, Yuxi (Evan) You

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Remix Icon

- Package: `@remixicon/vue` 4.9.0
- Project: <https://github.com/Remix-Design/remixicon>
- License: Remix Icon License v1.0
- Copyright: Copyright (c) 2017-2026 Remix Design

Sash embeds selected Remix Icon components as functional interface symbols. They are not used as the Sash logo or brand identity. The complete Remix Icon License v1.0 text is included in [`docs/remix-icon-license.txt`](./docs/remix-icon-license.txt).

## Runtime-downloaded Core

The upstream Core is not embedded in the Sash source tree or npm tarball. Sash downloads an unmodified release artifact at runtime from the upstream release project identified in the README attribution section.

Licensing is release-specific. The source tag currently used for Sash's tested contract, `v1.19.30`, carries the GNU General Public License v3.0; see the upstream [tag license](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/LICENSE) and [release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.30). Users selecting another release should review the license and notices accompanying that release.
