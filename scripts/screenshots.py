"""README için tanıtım ekran görüntülerini üretir.

    python scripts/screenshots.py docs

Uygulama görünmez modda açılır, gerçek ekran yerine scripts/demo-source.js
içindeki demo sahnesi kullanılır. Kişisel ekran, dosya yolu ya da pencere
başlığı görüntülere girmez.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else "docs").resolve()
lang = sys.argv[2] if len(sys.argv) > 2 else "tr"
demo = (ROOT / "scripts" / "demo-source.js").read_text(encoding="utf-8")
FAKE_DIR = r"C:\Users\sibertilki\Videos\Tilki Studio"

wait = "new Promise(r=>setTimeout(r,{ms}))"
steps = [
    ["!demo", demo],
    ["!settle", wait.format(ms=1800)],
    ["studio", "1"],
    ["!rec", "document.getElementById('btnRec').click();" + wait.format(ms=4200)],
    ["recording", "1"],
    ["!stop", "document.getElementById('btnRec').click();" + wait.format(ms=1500)],
    ["!shot", "document.getElementById('btnShot').click();" + wait.format(ms=3500)],
    ["!replay", "document.getElementById('replayEnabled').click();" + wait.format(ms=4000)],
    ["replay", "1"],
    ["!replayoff", "document.getElementById('replayEnabled').click();" + wait.format(ms=800)],
    # Kütüphane yolu gerçek klasörü gösterir; görüntüde genel bir yol görünsün.
    ["!lib", f"setInterval(()=>{{const d=document.getElementById('libraryDir');if(d.textContent!=={json.dumps(FAKE_DIR)})d.textContent={json.dumps(FAKE_DIR)};"
     + "document.querySelectorAll('.toast').forEach(t=>t.remove())},50);"
     + "document.querySelector('[data-view=library]').click();" + wait.format(ms=2500)],
    ["library", "1"],
    ["!settings", "document.querySelector('[data-view=settings]').click();" + wait.format(ms=3000)],
    ["settings", "1"],
    ["closing", "@close"],
]

with tempfile.TemporaryDirectory() as tmp:
    env = dict(os.environ)
    env.update({
        "TILKI_SELFTEST_DIR": tmp,
        "TILKI_TEST_HIDDEN": "1",
        "TILKI_SHOT_STEPS": json.dumps(steps),
        "TILKI_SELFTEST_SETTINGS": json.dumps({"outputDir": FAKE_DIR, "language": lang}),
    })
    electron = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
    shots = Path(tmp) / "shots"
    proc = subprocess.run([str(electron), ".", f"--screenshots={shots}"], cwd=ROOT, env=env,
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    for line in (proc.stdout + proc.stderr).splitlines():
        if "[step" in line or "rror" in line:
            print(line[:200])
    out.mkdir(parents=True, exist_ok=True)
    for png in sorted(shots.glob("*.png")):
        target = out / (png.name if lang == "tr" else f"{png.stem}-{lang}.png")
        target.write_bytes(png.read_bytes())
        print("->", target)
