# Üçüncü taraf bileşenler / Third-party notices

Tilki Studio aşağıdaki açık kaynak bileşenleri kullanır.
Tilki Studio uses the following open-source components.

## Electron

- Lisans / License: MIT
- Kaynak / Source: https://github.com/electron/electron
- Dağıtılan uygulamada `LICENSE.electron.txt` ve `LICENSES.chromium.html` dosyaları
  Electron ve Chromium lisanslarını içerir.

## Mediabunny

- Lisans / License: Mozilla Public License 2.0 (MPL-2.0)
- Kaynak / Source: https://github.com/Vanilagy/mediabunny
- Mediabunny, uygulamanın kayıt motoru paketine (`src/renderer/dist/worker.js`)
  değiştirilmeden derlenmiştir. Kaynak kodu yukarıdaki adreste ve npm üzerinde
  (`mediabunny`) MPL-2.0 koşullarıyla erişilebilir. Lisans metni:
  https://www.mozilla.org/MPL/2.0/
- Mediabunny is bundled unmodified into the recording engine bundle. Its source code
  is available at the address above and on npm under the terms of MPL-2.0.

## web-noise-suppressor (RNNoise)

- Lisans / License: MIT (web-noise-suppressor), BSD-3-Clause (RNNoise)
- Kaynak / Source: https://github.com/sapphi-red/web-noise-suppressor ,
  https://github.com/xiph/rnnoise
- Mikrofon için "Güçlü" gürültü engelleme seviyesinde kullanılır; değiştirilmeden
  `src/renderer/dist/rnnoise/` altına kopyalanır.
- Used for the "Strong" microphone noise suppression level; copied unmodified.

## Lisans uyumu / License compatibility

Tilki Studio GPL-3.0 ile lisanslanmıştır. MPL-2.0 (Mediabunny) ve MIT (Electron) lisansları
GPL-3.0 ile uyumludur; bu bileşenler kendi lisanslarını korur.
Tilki Studio is licensed under GPL-3.0. The MPL-2.0 (Mediabunny) and MIT (Electron)
licenses are GPL-3.0 compatible; these components keep their own licenses.
