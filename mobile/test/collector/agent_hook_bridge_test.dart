import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:memento_mobile/collector/services/agent_hook_bridge.dart';

void main() {
  test('summary keeps command and paths, never file contents', () {
    expect(
      summarizeToolUse({
        'tool_name': 'Write',
        'cwd': '/p',
        'tool_input': {'file_path': '/p/a.txt', 'content': 'SECRET'},
      }),
      {'tool': 'Write', 'input': {'file_path': '/p/a.txt'}, 'cwd': '/p'},
    );
    final long = summarizeToolUse({
      'tool_name': 'Bash',
      'tool_input': {'command': 'x' * 5000},
    });
    expect((long['input'] as Map)['command'].length, 2000);
  });

  group('bridge', () {
    late AgentHookBridge bridge;
    late List<(String, Map<String, dynamic>)> received;

    setUp(() {
      received = [];
      bridge = AgentHookBridge(onToolUse: (tid, use) => received.add((tid, use)));
    });
    tearDown(() => bridge.stop());

    String hookCommand(Map<String, dynamic> hooks) =>
        ((hooks['PreToolUse'] as List).first['hooks'] as List).first['command'] as String;

    test('the generated curl hook reaches the bridge through a real shell', () async {
      final hooks = await bridge.claudeHooks('task-123');
      final payload = jsonEncode({
        'hook_event_name': 'PreToolUse',
        'tool_name': 'Bash',
        'tool_input': {'command': 'git push origin main'},
        'cwd': '/Users/me/p',
      });
      final proc = await Process.start('/bin/sh', ['-c', hookCommand(hooks!)]);
      proc.stdin.write(payload);
      await proc.stdin.close();
      final out = await proc.stdout.transform(utf8.decoder).join();

      expect(await proc.exitCode, 0);
      expect(out, '{}');
      expect(received, hasLength(1));
      expect(received.single.$1, 'task-123');
      expect(received.single.$2, {
        'tool': 'Bash',
        'input': {'command': 'git push origin main'},
        'cwd': '/Users/me/p',
      });
    }, skip: Platform.isWindows ? 'uses /bin/sh' : false);

    test('requests without the secret are refused', () async {
      final hooks = await bridge.claudeHooks('t');
      final url = Uri.parse(RegExp(r'http://\S+').firstMatch(hookCommand(hooks!))!.group(0)!);
      final forged = url.replace(pathSegments: ['hook', 'wrong-secret', 't']);
      final client = HttpClient();
      final req = await client.postUrl(forged);
      req.write('{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}');
      final resp = await req.close();
      await resp.drain();
      client.close();

      expect(resp.statusCode, HttpStatus.notFound);
      expect(received, isEmpty);
    });

    test('hook command stays quote-free so every shell parses it alike', () async {
      final cmd = hookCommand((await bridge.claudeHooks('00000000-0000-0000-0000-000000000000'))!);
      expect(cmd.contains('"'), isFalse);
      expect(cmd.contains("'"), isFalse);
      expect(cmd.contains('&'), isFalse);
    });
  });
}
