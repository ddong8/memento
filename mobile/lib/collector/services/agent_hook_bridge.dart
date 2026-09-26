import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Loopback endpoint that Claude Code's PreToolUse hook posts each tool call to.
///
/// The hook is a single curl command, so there's no script to install and it runs
/// the same in any shell Claude Code uses. It never slows the agent down: the
/// bridge answers `{}` immediately ("no decision", so the run continues as before)
/// and forwards the call to the server, which decides whether it's worth a push.
class AgentHookBridge {
  final void Function(String taskId, Map<String, dynamic> toolUse) onToolUse;
  final String _secret = _randomToken();
  HttpServer? _server;

  AgentHookBridge({required this.onToolUse});

  static String _randomToken() {
    final r = Random.secure();
    return List.generate(24, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }

  Future<int> _ensureStarted() async {
    final existing = _server;
    if (existing != null) return existing.port;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen(_handle, onError: (_) {});
    _server = server;
    return server.port;
  }

  /// The `hooks` section of Claude Code `--settings` that reports each tool call
  /// of [taskId]. Null if the bridge can't listen; the task then runs unreported.
  Future<Map<String, dynamic>?> claudeHooks(String taskId) async {
    try {
      final port = await _ensureStarted();
      final url = 'http://127.0.0.1:$port/hook/$_secret/${Uri.encodeComponent(taskId)}';
      return {
        'PreToolUse': [
          {
            'matcher': 'Bash|Write|Edit|MultiEdit|NotebookEdit',
            'hooks': [
              {
                'type': 'command',
                // Nothing needs quoting, so bash, zsh and cmd all parse it the same.
                // "|| exit 0" keeps a missing curl from surfacing as a hook error.
                'command': 'curl -s -m 3 -X POST -H Content-Type:application/json --data-binary @- $url || exit 0',
                'timeout': 5,
              },
            ],
          },
        ],
      };
    } catch (_) {
      return null;
    }
  }

  Future<void> _handle(HttpRequest req) async {
    try {
      final segments = req.uri.pathSegments;
      if (req.method != 'POST' || segments.length != 3 || segments[0] != 'hook' || segments[1] != _secret) {
        req.response.statusCode = HttpStatus.notFound;
        return;
      }
      final data = jsonDecode(await utf8.decoder.bind(req).join());
      if (data is Map<String, dynamic>) {
        onToolUse(segments[2], summarizeToolUse(data));
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write('{}');
    } catch (_) {
      // Malformed hook input: still answer, so the agent carries on.
    } finally {
      await req.response.close();
    }
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }
}

/// What leaves the machine for one tool call: the tool, its command or target
/// path, and the working directory. Never file contents.
Map<String, dynamic> summarizeToolUse(Map<String, dynamic> hook) {
  final tool = hook['tool_name']?.toString() ?? '';
  final input = (hook['tool_input'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
  final kept = <String, dynamic>{};
  if (tool == 'Bash') {
    final cmd = input['command']?.toString() ?? '';
    kept['command'] = cmd.length > 2000 ? cmd.substring(0, 2000) : cmd;
  } else {
    for (final key in const ['file_path', 'notebook_path']) {
      if (input[key] != null) kept[key] = input[key].toString();
    }
  }
  return {'tool': tool, 'input': kept, 'cwd': hook['cwd']?.toString()};
}
