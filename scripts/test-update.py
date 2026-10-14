"""Exercise the real updater against a disposable Git repo; host services are fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="revenda-update-test-") as directory:
    root = Path(directory)
    scripts = root / "scripts"
    scripts.mkdir()
    (root / "secrets").mkdir()
    (root / "data").mkdir()
    shutil.copyfile(source / "update.sh", scripts / "update.sh")
    (scripts / "common.sh").write_text('''set -euo pipefail
cd "${BASH_SOURCE[0]%/*}/.."
root_required() { :; }
load_env() { [[ -s .env ]]; }
error() { echo "$*" >&2; exit 1; }
dc() { printf '%s\\n' "$*" >> operations; }
''')
    (scripts / "backup.sh").write_text('''set -euo pipefail
[[ -s .env && -s secrets/key && -s data/database && -s data/whatsapp ]]
echo backup >> operations
cp .env secrets/env-snapshot
''')
    (scripts / "healthcheck.sh").write_text('echo health >> operations\n')
    (root / ".gitignore").write_text('.env\nsecrets/\ndata/\noperations\n')
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
    git("init", "-q")
    git("config", "user.name", "Installer test")
    git("config", "user.email", "installer@test.invalid")
    git("remote", "add", "origin", str(root))
    for version in ["1.0.0", "1.0.1"]:
        (root / "package.json").write_text(json.dumps({"version": version}))
        git("add", ".")
        git("commit", "-qm", version)
        git("tag", "v" + version)
    git("checkout", "--detach", "v1.0.0")
    previous = git("rev-parse", "HEAD")
    sentinels = {".env": b"APP_DOMAIN=existing.example\nENCRYPTION_KEY=TEST_ONLY\n",
                 "secrets/key": b"existing-secret", "data/database": b"existing-customers-and-settings",
                 "data/whatsapp": b"existing-session"}
    for name, content in sentinels.items():
        (root / name).write_bytes(content)
    (root / "secrets/installed-version").write_text("1.0.0\n")
    def update():
        return subprocess.run(["bash", "scripts/update.sh", "v1.0.1"], cwd=root, capture_output=True, text=True)
    result = update()
    assert result.returncode == 0, result.stdout + result.stderr
    assert git("describe", "--exact-match", "--tags") == "v1.0.1"
    assert (root / "secrets/installed-version").read_text().strip() == "1.0.1"
    assert (root / "secrets/rollback-commit").read_text().strip() == previous
    assert (root / "secrets/env-snapshot").read_bytes() == sentinels[".env"]
    assert (root / "operations").read_text().splitlines() == ["backup", "stop -t 90 api worker", "build api admin", "run --rm migrate", "up -d", "health"]
    for name, content in sentinels.items():
        assert (root / name).read_bytes() == content, name + " was modified"
    result = update()
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / "operations").read_text().splitlines()[-2:] == ["health", "health"]
    assert (root / "operations").read_text().count("backup") == 1
    (root / "package.json").write_text('{"version":"local-change"}')
    assert update().returncode != 0, "Dirty checkout must stop before changing services"
    assert (root / "operations").read_text().count("backup") == 1
    print("UPDATE PASS: backup before checkout; configuration, data, sessions and secrets preserved; repeat is harmless; local edits rejected.")
