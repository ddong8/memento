"""deploy.yml 的 bump 回写镜像 tag：别的 run 刚改过同一行也能推上去，而且不把线上退回旧提交。

2026-11-17：被取消的旧 run 在取消前已推出 server 的回写，新 run 改的是同一行，`git pull --rebase` 冲突，
三次重试都卡在冲突上，新提交没上线。这里用本地裸仓库和 docker / kustomize / gh 的桩，原样跑 bump 那一步的脚本。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy.yml"
IMAGES = ("memento-server", "memento-web")
KUSTOMIZATION = "images:\n" + "".join(
    f"- name: ghcr.io/ddong8/{i}\n  newName: ghcr.io/ddong8/{i}\n  newTag: 000000000000\n" for i in IMAGES
) + (
    # The TypeScript server: its own name, pushed into the public memento-server package as ts-<commit>
    "- name: ghcr.io/ddong8/memento-server-ts\n  newName: ghcr.io/ddong8/memento-server\n  newTag: ts-000000000000\n"
)
STUBS = {
    "docker": "#!/bin/bash\nexit 0\n",
    # kustomize edit set image NAME=NAME:TAG, run inside deploy/k8s
    "kustomize": """#!/bin/bash
spec="$4"; name="${spec%%=*}"; tag="${spec##*:}"
awk -v n="$name" -v t="$tag" '$1=="-" && $2=="name:" {cur=$3} $1=="newTag:" && cur==n {sub(/newTag: .*/, "newTag: " t)} {print}' \\
  kustomization.yaml > k.tmp && mv k.tmp kustomization.yaml
""",
    # gh api repos/o/r/compare/BASE...HEAD --jq .status, answered from the origin's history
    "gh": """#!/bin/bash
[ -n "$GH_BROKEN" ] && exit 1
c="${2##*/compare/}"; base="${c%%...*}"; head="${c##*...}"
cd "$SIM_ORIGIN" || exit 1
b=$(git rev-parse -q --verify "$base^{commit}") || exit 1; h=$(git rev-parse -q --verify "$head^{commit}") || exit 1
if [ "$b" = "$h" ]; then echo identical
elif git merge-base --is-ancestor "$b" "$h"; then echo ahead
elif git merge-base --is-ancestor "$h" "$b"; then echo behind
else echo diverged; fi
""",
}


def _bump_script() -> str:
    steps = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]["bump"]["steps"]
    return next(s["run"] for s in steps if s.get("id") == "pin")


@unittest.skipIf(sys.platform == "win32" or not shutil.which("bash") or not shutil.which("git"), "needs bash and git")
class DeployBumpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="bump-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        stubs = self.tmp / "stubs"
        stubs.mkdir()
        for name, body in STUBS.items():
            (stubs / name).write_text(body)
            (stubs / name).chmod(0o755)
        (self.tmp / "bump.sh").write_text(_bump_script())
        self.origin = self.tmp / "origin.git"
        self.env = {
            **os.environ, "HOME": str(self.tmp), "GIT_CONFIG_NOSYSTEM": "1",
            "PATH": f"{stubs}{os.pathsep}{os.environ.get('PATH', '')}",
            "SIM_ORIGIN": str(self.origin), "REGISTRY": "ghcr.io", "OWNER": "ddong8",
            "GITHUB_REPOSITORY": "ddong8/memento", "GH_TOKEN": "t",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
        }
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin), cwd=self.tmp)
        self.seed = self.tmp / "seed"
        self.git("clone", "-q", str(self.origin), str(self.seed), cwd=self.tmp)
        (self.seed / "deploy" / "k8s").mkdir(parents=True)
        (self.seed / "deploy" / "k8s" / "kustomization.yaml").write_text(KUSTOMIZATION)
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        self.git("push", "-q", "origin", "main")
        base = self.git("rev-parse", "HEAD")
        for image in IMAGES:  # production's tags are always commits
            self.bot_pin(image, base)

    def git(self, *args: str, cwd: Path | None = None) -> str:
        return subprocess.run(["git", *args], cwd=cwd or self.seed, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, msg: str) -> str:
        with open(self.seed / "code.txt", "a") as f:
            f.write(msg + "\n")
        self.git("add", "code.txt")
        self.git("commit", "-qm", msg)
        self.git("push", "-q", "origin", "main")
        return self.git("rev-parse", "HEAD")

    def bot_pin(self, image: str, sha: str) -> None:
        """Another run's bump already on main."""
        self.git("pull", "-q", "--rebase", "origin", "main")
        subprocess.run(["kustomize", "edit", "set", "image", f"ghcr.io/ddong8/{image}=ghcr.io/ddong8/{image}:{sha[:12]}"],
                       cwd=self.seed / "deploy" / "k8s", env=self.env, check=True)
        self.git("commit", "-qam", f"bot {image} -> {sha[:12]}")
        self.git("push", "-q", "origin", "main")

    def run_bump(self, sha: str, server: bool, web: bool, ts: bool = False, **env: str) -> tuple[int, dict, str]:
        """The bump step of the run for `sha`, checked out at that commit as Actions does."""
        self.runs = getattr(self, "runs", 0) + 1
        run = self.tmp / f"run-{self.runs}"
        self.git("clone", "-q", str(self.origin), str(run), cwd=self.tmp)
        self.git("checkout", "-q", "-B", "main", sha, cwd=run)
        self.git("branch", "-q", "-u", "origin/main", cwd=run)
        out = run / "github_output"
        out.write_text("")
        p = subprocess.run(["bash", "-eo", "pipefail", str(self.tmp / "bump.sh")], cwd=run, capture_output=True, text=True,
                           env={**self.env, "SHA": sha, "SERVER": str(server).lower(), "WEB": str(web).lower(), "TS": str(ts).lower(),
                                "GITHUB_OUTPUT": str(out), **env})
        outputs = dict(line.split("=", 1) for line in out.read_text().splitlines() if "=" in line)
        return p.returncode, outputs, p.stdout + p.stderr

    def tags_on_main(self, with_ts: bool = False) -> dict[str, str]:
        text = self.git("show", "main:deploy/k8s/kustomization.yaml", cwd=self.origin)
        tags, cur = {}, None
        for line in text.splitlines():
            parts = line.split()
            if parts[:2] == ["-", "name:"]:
                cur = parts[2].rsplit("/", 1)[-1]
            elif parts[:1] == ["newTag:"] and cur:
                tags[cur] = parts[1]
        if not with_ts:
            tags.pop("memento-server-ts", None)
        return tags

    def test_pins_the_images_it_built(self) -> None:
        c1 = self.commit("c1")
        code, outputs, log = self.run_bump(c1, server=True, web=True)
        self.assertEqual(code, 0, log)
        self.assertEqual(self.tags_on_main(), {"memento-server": c1[:12], "memento-web": c1[:12]})
        self.assertEqual(outputs, {"server": "true", "web": "true", "ts": "false"})

    def test_pins_the_typescript_server_as_ts_tag_of_the_server_package(self) -> None:
        c1 = self.commit("c1")
        code, outputs, log = self.run_bump(c1, server=False, web=False, ts=True)
        self.assertEqual(code, 0, log)
        tags = self.tags_on_main(with_ts=True)
        self.assertEqual(tags["memento-server-ts"], f"ts-{c1[:12]}")
        self.assertNotEqual(tags["memento-server"], c1[:12])  # the Python server untouched
        self.assertEqual(outputs, {"server": "false", "web": "false", "ts": "true"})
        # A later run that only built the Python server leaves the ts tag where it is
        self.git("pull", "-q", "--rebase", "origin", "main")
        c2 = self.commit("c2")
        code, outputs, log = self.run_bump(c2, server=True, web=False)
        self.assertEqual(code, 0, log)
        self.assertEqual(self.tags_on_main(with_ts=True)["memento-server-ts"], f"ts-{c1[:12]}")

    def test_goes_through_when_a_cancelled_run_pushed_the_same_line_first(self) -> None:
        c1, c2 = self.commit("c1"), self.commit("c2")
        self.bot_pin("memento-server", c1)  # the run for c1, cancelled by c2's push, got its bump out anyway
        code, outputs, log = self.run_bump(c2, server=True, web=True)
        self.assertEqual(code, 0, log)
        self.assertEqual(self.tags_on_main(), {"memento-server": c2[:12], "memento-web": c2[:12]})
        self.assertEqual(outputs, {"server": "true", "web": "true", "ts": "false"})

    def test_a_late_older_run_never_moves_production_back(self) -> None:
        c1, c2 = self.commit("c1"), self.commit("c2")
        self.bot_pin("memento-server", c2)
        code, outputs, log = self.run_bump(c1, server=True, web=True)
        self.assertEqual(code, 0, log)
        self.assertEqual(self.tags_on_main(), {"memento-server": c2[:12], "memento-web": c1[:12]})
        # verify waits only for what points at this run's commit
        self.assertEqual(outputs, {"server": "false", "web": "true", "ts": "false"})

        self.bot_pin("memento-web", c2)
        code, outputs, log = self.run_bump(c1, server=True, web=True)
        self.assertEqual(code, 0, log)
        self.assertEqual(self.tags_on_main(), {"memento-server": c2[:12], "memento-web": c2[:12]})
        self.assertEqual(outputs, {"server": "false", "web": "false", "ts": "false"})

    def test_stops_when_it_cannot_tell_which_commit_is_newer(self) -> None:
        c1, c2 = self.commit("c1"), self.commit("c2")
        self.bot_pin("memento-server", c1)
        code, _, log = self.run_bump(c2, server=True, web=False, GH_BROKEN="1")
        self.assertNotEqual(code, 0, log)
        self.assertEqual(self.tags_on_main()["memento-server"], c1[:12])


if __name__ == "__main__":
    unittest.main()
