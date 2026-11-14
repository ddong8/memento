// What the generator and the daemon that runs it both need to know about it. Kept free of the
// generator itself, so the daemon can import it without bundling the scanners.

// Monotonically increasing generator version for cross-device OTA synchronization. Bump it with
// every change to what the generator writes: the daemon regenerates blueprints from older versions.
export const BLUEPRINT_SCRIPT_VERSION = 20261122;

export const BLUEPRINT_FILE = "PROJECT_BLUEPRINT.md";
/** What the project should do, tied to the code that does it (business.ts): written by people and agents */
export const BUSINESS_FILE = "BUSINESS_BLUEPRINT.md";
/** The generator's file name: scripts/ in a repo, ~/.memento/scripts, the app's assets */
export const SCRIPT_NAME = "project_blueprint.mjs";
/** The Python generator this replaces, still found in repos, hooks and ~/.memento/scripts */
export const LEGACY_SCRIPT_NAME = "project_blueprint.py";
// The footer every generated blueprint ends with: tells our files from hand-written ones
export const GENERATED_MARK = "_Auto-maintained by `scripts/project_blueprint.mjs`";
// The footer of blueprints from the Python generator: still ours
export const LEGACY_GENERATED_MARK = "_Auto-maintained by `scripts/project_blueprint.py`";
/** A generator footer of either kind, with the version it carries since 20261108 */
export const GENERATED_FOOTER_RE = /_Auto-maintained by `scripts\/project_blueprint\.(?:py|mjs)`(?: \(v(\d+)\))?/;
/** Version line of a generator script: the bundle's `var BLUEPRINT_SCRIPT_VERSION = N`, or the Python one's */
export const SCRIPT_VERSION_RE = /^(?:(?:export\s+)?(?:const|let|var)\s+)?BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)/m;
/** A string only the bundled generator contains: tells it from any other file served under its name */
export const SCRIPT_SIGNATURE = "Memento living blueprint generator";

// The HEAD the blueprint was last generated for, in the repo's git dir (the collector compares it)
export const HEAD_MARKER = ".memento_blueprint_head";
export const HOOK_MARKER_START = "# <<< Memento Blueprint Hook Start >>>";
export const HOOK_MARKER_END = "# <<< Memento Blueprint Hook End >>>";
/** The hooks the refresh block goes into */
export const MANAGED_GIT_HOOKS = ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite"];
/** Memento's Node for the hooks: Electron run as Node, written by the app (see blueprint-auto.ts) */
export const RUNTIME_NAME = "runtime";

/** The version a generator script declares, 0 when it isn't one. */
export function scriptVersionOf(content: string): number {
  const m = content.match(SCRIPT_VERSION_RE);
  return m ? Number(m[1]) : 0;
}
