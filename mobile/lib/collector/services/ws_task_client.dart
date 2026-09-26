import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:path/path.dart' as p;

import '../models/collector_config.dart';
import '../models/task_message.dart';
import 'agent_hook_bridge.dart';
import 'p2p_media_server.dart';

/// Represents a prepared command line ready to be spawned via Process.start.
class ResolvedExecution {
  final String executable;
  final List<String> arguments;
  final bool runInShell;

  const ResolvedExecution({
    required this.executable,
    required this.arguments,
    this.runInShell = false,
  });
}

/// WebSocket client for real-time task streaming and execution between server and device.
class WsTaskClient {
  final CollectorConfig config;
  final void Function(String message)? onLog;
  final void Function(bool online)? onConnectionStatus;

  bool _disposed = false;
  WebSocket? _ws;
  Timer? _pingTimer;
  P2pMediaServer? _p2pServer;
  final Map<String, Process> _runningTasks = {};
  final Map<String, StringBuffer> _activeStdoutBuffers = {};
  AgentHookBridge? _hookBridge;

  WsTaskClient({
    required this.config,
    this.onLog,
    this.onConnectionStatus,
  });

  void _log(String msg) {
    onLog?.call(msg);
    stdout.writeln('[WsTaskClient] $msg');
  }

  Future<void> _killTaskProcess(Process? proc) async {
    if (proc == null) return;
    try {
      if (Platform.isWindows) {
        // Recursively terminate entire process tree (node, python, git, powershell, etc.)
        final res = await Process.run('taskkill', ['/F', '/T', '/PID', proc.pid.toString()]);
        if (res.exitCode != 0) {
          proc.kill(ProcessSignal.sigkill);
        }
      } else {
        proc.kill(ProcessSignal.sigkill);
      }
    } catch (_) {
      try {
        proc.kill();
      } catch (_) {}
    }
  }

  void dispose() {
    _disposed = true;
    _pingTimer?.cancel();
    _ws?.close();
    unawaited(_p2pServer?.stop());
    _p2pServer = null;
    unawaited(_hookBridge?.stop());
    _hookBridge = null;
    // Kill any active tasks cleanly
    for (final entry in _runningTasks.entries) {
      _killTaskProcess(entry.value);
    }
    _runningTasks.clear();
    _activeStdoutBuffers.clear();
  }

  /// Start persistent connection loop with automatic reconnect.
  Future<void> start() async {
    int backoffSeconds = 2;

    // Start local IPv6 P2P Media Server for direct, zero-relay video streaming
    try {
      _p2pServer ??= P2pMediaServer(
        authToken: config.token,
        onLog: _log,
      );
      await _p2pServer!.start();
    } catch (e) {
      _log('Failed to start IPv6 P2P server: $e');
    }

    while (!_disposed) {
      try {
        onConnectionStatus?.call(false);
        final base = config.serverUrl
            .replaceFirst(RegExp(r'^http://'), 'ws://')
            .replaceFirst(RegExp(r'^https://'), 'wss://');
        final wsUri = Uri.parse('$base/api/tasks/ws/${config.deviceId}');

        _log('Connecting to WebSocket: $wsUri');

        final headers = <String, dynamic>{
          'x-collector-token': config.token,
          'x-device-id': config.deviceId,
          if (config.remoteExecKey != null) 'x-remote-exec-key': config.remoteExecKey!,
        };

        // Custom HttpClient to allow self-signed certs in dev
        final customClient = HttpClient()
          ..connectionTimeout = const Duration(seconds: 15)
          ..badCertificateCallback = (cert, host, port) => true;

        _ws = await WebSocket.connect(
          wsUri.toString(),
          headers: headers,
          customClient: customClient,
        );

        backoffSeconds = 2;
        _log('WebSocket transport connected, awaiting server handshake...');

        // Start 25-second periodic heartbeat ping to prevent idle timeouts & keep DB updated
        _startPingTimer();

        // Report agent capabilities
        _reportCapabilities();

        // Report IPv6 P2P streaming capabilities
        unawaited(_reportP2pInfo());

        // Listen for incoming server frames
        await for (final raw in _ws!) {
          try {
            final data = jsonDecode(raw.toString()) as Map<String, dynamic>;
            final type = data['type']?.toString();

            if (type == 'connected') {
              onConnectionStatus?.call(true);
              _log('Handshake verified by server (${data['device_name']})');
              unawaited(_reportP2pInfo());
            } else if (type == 'pong') {
              // Heartbeat ack from server
              continue;
            } else if (type == 'get_agent_capabilities') {
              _reportCapabilities();
              unawaited(_reportP2pInfo());
            } else if (type == 'task_dispatch') {
              final taskJson = data['task'] as Map<String, dynamic>?;
              if (taskJson != null) {
                final task = TaskDispatch.fromJson(taskJson);
                _log('Received task dispatch: ${task.id} (${task.action})');
                // Run task in background so stream listening isn't blocked
                unawaited(_executeTask(task));
              }
            } else if (type == 'task_cancel') {
              final taskId = data['task_id']?.toString();
              if (taskId != null && _runningTasks.containsKey(taskId)) {
                _log('Cancelling task $taskId');
                final proc = _runningTasks.remove(taskId);
                unawaited(_killTaskProcess(proc));
              }
            } else if (type == 'task_input') {
              final taskId = data['task_id']?.toString();
              final input = data['input']?.toString();
              if (taskId != null && input != null && _runningTasks.containsKey(taskId)) {
                final proc = _runningTasks[taskId];
                if (proc != null) {
                  try {
                    proc.stdin.writeln(input);
                    unawaited(proc.stdin.flush());
                    _log('Forwarded input to task $taskId: $input');

                    // Echo input to stream and active buffer so user sees immediate terminal feedback
                    final echoMsg = '\n[输入] $input\n';
                    _activeStdoutBuffers[taskId]?.write(echoMsg);
                    _sendJson(TaskChunk(
                      taskId: taskId,
                      stream: 'stdout',
                      text: echoMsg,
                    ).toJson());
                  } catch (e) {
                    _log('Failed to write input to task $taskId: $e');
                  }
                }
              }
            } else if (type == 'file_stat_req') {
              final reqId = data['req_id']?.toString() ?? '';
              final filePath = data['path']?.toString() ?? '';
              unawaited(_handleFileStat(reqId, filePath));
            } else if (type == 'file_chunk_req') {
              final reqId = data['req_id']?.toString() ?? '';
              final filePath = data['path']?.toString() ?? '';
              final offset = (data['offset'] as num?)?.toInt() ?? 0;
              final length = (data['length'] as num?)?.toInt() ?? (512 * 1024);
              unawaited(_handleFileChunk(reqId, filePath, offset, length));
            }
          } catch (e) {
            _log('Error processing frame: $e');
          }
        }

        if (_ws?.closeCode != null) {
          _log('WebSocket closed by server (code: ${_ws?.closeCode}, reason: ${_ws?.closeReason})');
          if (_ws?.closeCode == 4003) {
            _log('Server authentication rejected (4003 unauthorized). Re-verifying credentials...');
            backoffSeconds = 5;
          }
        }
      } catch (e) {
        _log('WebSocket disconnected or failed: $e (reconnecting in ${backoffSeconds}s)');
      } finally {
        _pingTimer?.cancel();
        _ws = null;
        onConnectionStatus?.call(false);
      }

      if (_disposed) break;
      await Future.delayed(Duration(seconds: backoffSeconds));
      backoffSeconds = (backoffSeconds * 2).clamp(2, 30);
    }
  }

  void _startPingTimer() {
    _pingTimer?.cancel();
    int pingCount = 0;
    _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      if (_ws != null && _ws!.readyState == WebSocket.open) {
        try {
          _ws!.add(jsonEncode({'type': 'ping'}));
        } catch (_) {}

        pingCount++;
        // Refresh and report P2P IPv6 status every ~5 minutes (12 pings)
        if (pingCount % 12 == 0) {
          unawaited(_reportP2pInfo());
        }
      }
    });
  }

  Future<void> _reportP2pInfo() async {
    if (_p2pServer == null || !_p2pServer!.isRunning) return;
    try {
      final ipv6 = await _p2pServer!.refreshIpv6Address();
      final port = _p2pServer!.port;
      if (port != null && ipv6 != null && ipv6.isNotEmpty) {
        _sendJson({
          'type': 'p2p_network_info',
          'ipv6': ipv6,
          'port': port,
          'token': config.token,
        });
        _log('Registered IPv6 P2P streaming endpoint with coordinator: [$ipv6]:$port');
      }
    } catch (e) {
      _log('Failed to report P2P info: $e');
    }
  }

  void _sendJson(Map<String, dynamic> data) {
    if (_ws != null && _ws!.readyState == WebSocket.open) {
      try {
        _ws!.add(jsonEncode(data));
      } catch (e) {
        _log('Failed to send frame: $e');
      }
    }
  }

  Future<void> _reportCapabilities() async {
    final caps = await _probeCapabilities();
    _sendJson({
      'type': 'agent_capabilities',
      'capabilities': caps,
    });
    _log('Reported agent capabilities: ${caps.keys.join(", ")}');
  }

  Future<Map<String, dynamic>> _probeCapabilities() async {
    final caps = <String, dynamic>{};
    final home = CollectorConfig.homeDir;

    // 1. Claude Code
    final claudePath = await _findExecutable(['claude', 'claude-code']);
    if (claudePath != null) {
      String defaultModel = '';
      String defaultEffort = '';
      try {
        final settingsFile = File('$home/.claude/settings.json');
        if (await settingsFile.exists()) {
          final content = await settingsFile.readAsString();
          final data = jsonDecode(content);
          if (data is Map) {
            defaultModel = (data['model'] ?? '').toString().trim();
            defaultEffort = (data['effortLevel'] ?? '').toString().trim();
          }
        }
      } catch (_) {}

      final List<Map<String, dynamic>> claudeModels = [
        {
          'id': '',
          'name': defaultModel.isNotEmpty
              ? '⚡ 默认模型 (跟随客户端配置: $defaultModel)'
              : '⚡ 默认模型 (跟随客户端/CLI配置)',
          'desc': defaultModel.isNotEmpty
              ? '当前本地配置: $defaultModel'
              : '使用本地 Claude Code 配置的默认模型',
          'is_default': true,
        },
        {
          'id': 'sonnet',
          'name': 'sonnet (官方动态最新 Sonnet 别名)',
          'desc': '官方推荐别名，自动指向最新主力 (当前为 Claude Sonnet 5)',
        },
        {
          'id': 'opus',
          'name': 'opus (官方动态最新 Opus 别名)',
          'desc': '官方推荐别名，极高智能与超长上下文 (当前为 Claude Opus 5)',
        },
        {
          'id': 'fable',
          'name': 'fable (官方动态最新 Fable 别名)',
          'desc': '官方推荐别名，最强智能体与高阶科学推理 (当前为 Claude Fable 5.1)',
        },
        {
          'id': 'opus[1m]',
          'name': 'opus[1m] (100万上下文增强版)',
          'desc': 'Claude Opus 深度思维 / 100万 Token 超大上下文',
        },
        {
          'id': 'haiku',
          'name': 'haiku (官方动态最新 Haiku 别名)',
          'desc': '官方推荐别名，极速轻量 (当前为 Claude Haiku 4.5)',
        },
      ];

      final seenClaudeIds = <String>{'', 'sonnet', 'opus', 'fable', 'opus[1m]', 'haiku'};
      if (defaultModel.isNotEmpty && !seenClaudeIds.contains(defaultModel)) {
        claudeModels.add({
          'id': defaultModel,
          'name': '$defaultModel (当前本地配置)',
          'desc': '本地 ~/.claude/settings.json 中配置的模型',
        });
        seenClaudeIds.add(defaultModel);
      }

      final discoveredClaudeSlugs = <String>[];
      final scannedSeen = <String>{};
      final candidateClaudePaths = <String>[];

      try {
        final vscodeExtDir = Directory('$home/.vscode/extensions');
        if (await vscodeExtDir.exists()) {
          for (final entity in vscodeExtDir.listSync()) {
            if (entity is Directory && entity.path.contains('anthropic.claude-code')) {
              final binFile = File('${entity.path}/resources/native-binary/claude');
              if (binFile.existsSync()) candidateClaudePaths.add(binFile.path);
            }
          }
        }
      } catch (_) {}

      candidateClaudePaths.addAll([
        '$home/.claude/local/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
        '$home/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js',
        '$home/.claude/local/claude',
        '$home/.local/bin/claude',
        claudePath,
      ]);

      for (final p in candidateClaudePaths) {
        final cFile = File(p);
        if (!await cFile.exists()) continue;
        final realPath = await cFile.resolveSymbolicLinks().catchError((_) => p);
        final targets = {p, realPath};
        for (final target in targets) {
          final tFile = File(target);
          if (!await tFile.exists()) continue;
          try {
            final bytes = await tFile.readAsBytes();
            final text = latin1.decode(bytes);
            final matches = RegExp(r'(?:id|default|firstParty|voice_model):["\x27](claude-[a-z0-9\.\-]+)["\x27]').allMatches(text);
            for (final m in matches) {
              final slug = m.group(1);
              if (slug == null) continue;
              final sl = slug.toLowerCase();
              if (!sl.contains('fable') && !sl.contains('mythos') && !sl.contains('opus') && !sl.contains('sonnet') && !sl.contains('haiku')) {
                continue;
              }
              if (sl.contains('token') || sl.contains('key') || sl.contains('dist') || sl.contains('header') || sl.contains('release')) {
                continue;
              }
              if (!scannedSeen.contains(slug)) {
                scannedSeen.add(slug);
                discoveredClaudeSlugs.add(slug);
              }
            }
          } catch (_) {}
        }
      }

      int modelPriority(String m) {
        int score = 0;
        final ml = m.toLowerCase();
        if (RegExp(r'5[_\-\.]1').hasMatch(ml)) {
          score += 800;
        } else if (RegExp(r'(?<![0-9])[_\-\.]5(?:$|[_\-\.])').hasMatch(ml)) {
          score += 700;
        } else if (RegExp(r'4[_\-\.][678]').hasMatch(ml)) {
          score += 600;
        } else if (RegExp(r'4[_\-\.]5').hasMatch(ml)) {
          score += 500;
        } else if (RegExp(r'4[_\-\.]1').hasMatch(ml)) {
          score += 400;
        } else if (RegExp(r'4[_\-\.]0').hasMatch(ml) || ml.contains('opus-4') || ml.contains('sonnet-4')) {
          score += 300;
        } else if (RegExp(r'3[_\-\.]7').hasMatch(ml)) {
          score += 200;
        } else if (RegExp(r'3[_\-\.]5').hasMatch(ml)) {
          score += 100;
        }

        if (ml.contains('fable')) {
          score += 25;
        } else if (ml.contains('mythos')) {
          score += 22;
        } else if (ml.contains('opus')) {
          score += 20;
        } else if (ml.contains('sonnet')) {
          score += 15;
        } else if (ml.contains('haiku')) {
          score += 10;
        }
        return -score;
      }

      discoveredClaudeSlugs.sort((a, b) => modelPriority(a).compareTo(modelPriority(b)));

      if (discoveredClaudeSlugs.isEmpty) {
        discoveredClaudeSlugs.addAll([
          'claude-fable-5-1',
          'claude-opus-5',
          'claude-sonnet-5',
          'claude-opus-4-8',
          'claude-opus-4-6',
          'claude-sonnet-4-6',
          'claude-opus-4-5-20251101',
          'claude-sonnet-4-5-20250929',
          'claude-haiku-4-5-20251001',
          'claude-opus-4-1-20250805',
          'claude-sonnet-4-20250514',
          'claude-opus-4-20250514',
          'claude-3-7-sonnet-20250219',
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
        ]);
      }

      for (final slug in discoveredClaudeSlugs) {
        if (seenClaudeIds.contains(slug)) continue;
        seenClaudeIds.add(slug);
        final dname = _formatClaudeDisplayName(slug);
        claudeModels.add({
          'id': slug,
          'name': '$slug ($dname)',
          'desc': '官方支持模型',
        });
      }

      final effortOptions = [
        {
          'id': '',
          'name': defaultEffort.isNotEmpty
              ? '⚡ 默认 Effort (跟随配置: $defaultEffort)'
              : '⚡ 默认 Effort (跟随CLI配置)',
          'desc': defaultEffort.isNotEmpty
              ? '使用本地配置的 effortLevel ($defaultEffort)'
              : '使用客户端配置的思考量',
        },
        {'id': 'low', 'name': 'Low (快速 / 低思考量)', 'desc': '轻量思考，极速响应，节省 Token'},
        {'id': 'medium', 'name': 'Medium (标准思考量)', 'desc': '平衡速度与推理质量，适合日常编程'},
        {'id': 'high', 'name': 'High (深度推理 / 高思考量)', 'desc': '深入思维链，攻坚复杂架构与排错'},
        {'id': 'max', 'name': 'Max (最大思考量)', 'desc': '顶级复杂任务深度多步探索'},
      ];

      final claudeInfo = {
        'tool': 'claude',
        'available': true,
        'path': claudePath,
        'models': claudeModels,
        'default_model': defaultModel,
        'supports_effort': true,
        'default_effort': defaultEffort.isNotEmpty ? defaultEffort : 'max',
        'effort_options': effortOptions,
      };
      caps['claude'] = claudeInfo;
      caps['claude_code'] = claudeInfo;
    }

    // 2. Codex
    final codexPath = await _findExecutable(['codex', 'codex-cli']);
    if (codexPath != null) {
      String defaultModel = '';
      String defaultEffort = 'medium';
      try {
        final configFile = File('$home/.codex/config.toml');
        if (await configFile.exists()) {
          final lines = await configFile.readAsLines();
          for (final line in lines) {
            final tr = line.trim();
            if (tr.startsWith('model =')) {
              defaultModel = tr.split('=')[1].trim().replaceAll('"', '').replaceAll("'", '');
            } else if (tr.startsWith('model_reasoning_effort =')) {
              defaultEffort = tr.split('=')[1].trim().replaceAll('"', '').replaceAll("'", '');
            }
          }
        }
      } catch (_) {}

      final List<Map<String, dynamic>> codexModels = [
        {
          'id': '',
          'name': defaultModel.isNotEmpty
              ? '⚡ 默认模型 (跟随CLI配置: $defaultModel)'
              : '⚡ 默认模型 (跟随客户端配置)',
          'desc': defaultModel.isNotEmpty ? '当前配置: $defaultModel' : '使用本地默认配置模型',
          'is_default': true,
        }
      ];

      final Set<String> foundSlugs = {};
      try {
        final cacheFile = File('$home/.codex/models_cache.json');
        if (await cacheFile.exists()) {
          final cdata = jsonDecode(await cacheFile.readAsString());
          if (cdata is Map && cdata['models'] is List) {
            final raw = List<dynamic>.from(cdata['models']);
            raw.sort((a, b) => ((a['priority'] ?? 999) as num).compareTo((b['priority'] ?? 999) as num));
            for (final m in raw) {
              if (m is Map) {
                final slug = (m['slug'] ?? '').toString();
                if (slug.isEmpty || slug == 'codex-auto-review' || foundSlugs.contains(slug)) continue;
                foundSlugs.add(slug);
                final dname = (m['display_name'] ?? slug).toString();
                final desc = (m['description'] ?? '').toString();
                final isActive = (slug == defaultModel);
                codexModels.add({
                  'id': slug,
                  'name': isActive ? '$dname (当前主力)' : dname,
                  'desc': desc,
                });
              }
            }
          }
        }
      } catch (_) {}

      if (codexModels.length == 1) {
        codexModels.addAll([
          {'id': 'gpt-6-astra', 'name': 'GPT-6-Astra (最新旗舰)', 'desc': '前沿深度多步推理模型，复杂编码首选'},
          {'id': 'gpt-reserve', 'name': 'GPT-Reserve (极速主力)', 'desc': '高性价比快速编码与日常任务'},
          {'id': 'gpt-5.6-sol', 'name': 'GPT-5.6-Sol (日常主力)', 'desc': '可靠的主力 Agent 编码模型'},
          {'id': 'gpt-5.6-terra', 'name': 'GPT-5.6-Terra', 'desc': '均衡的高性价比日常模型'},
          {'id': 'gpt-5.6-luna', 'name': 'GPT-5.6-Luna', 'desc': '极速响应日常编码模型'},
          {'id': 'gpt-5.5', 'name': 'GPT-5.5 (经典稳定)', 'desc': '经典全能编码与推理模型'},
          {'id': 'o3', 'name': 'o3 (深度思维)', 'desc': 'OpenAI 深度思维链'},
          {'id': 'o4-mini', 'name': 'o4-mini', 'desc': '轻量高速响应'},
        ]);
      }

      final codexEffortOptions = [
        {
          'id': '',
          'name': '⚡ 默认 Effort ($defaultEffort)',
          'desc': '使用本地配置的 reasoning_effort ($defaultEffort)',
        },
        {'id': 'low', 'name': 'Low (快速 / 低思考量)', 'desc': '轻量思考，极速响应，节省 Token'},
        {'id': 'medium', 'name': 'Medium (标准思考量)', 'desc': '平衡速度与推理质量，适合日常编程'},
        {'id': 'high', 'name': 'High (深度推理 / 高思考量)', 'desc': '深入思维链，攻坚复杂架构与疑难排错'},
      ];

      caps['codex'] = {
        'tool': 'codex',
        'available': true,
        'path': codexPath,
        'models': codexModels,
        'default_model': defaultModel,
        'supports_effort': true,
        'default_effort': defaultEffort,
        'effort_options': codexEffortOptions,
      };
    }

    // 3. Antigravity (agy)
    await _ensureAgyCliInstalled();
    final agyPath = await _findExecutable(['agy', 'agy_cli.py', 'agentapi']);
    if (agyPath != null) {
      final agyModels = [
        {
          'id': '',
          'name': '⚡ 默认模型 (系统配置: Gemini 3.8 Flash)',
          'desc': '使用当前 Antigravity 默认模型配置',
          'is_default': true,
        },
        {
          'id': 'gemini-3.8-flash',
          'name': 'Gemini 3.8 Flash (High, Fast)',
          'desc': '最新高智能极速响应模型 (Antigravity 默认推荐)',
        },
        {
          'id': 'gemini-3.7-flash',
          'name': 'Gemini 3.7 Flash (Medium, Fast)',
          'desc': '极速日常编码与高吞吐分析',
        },
        {
          'id': 'gemini-3.6-flash',
          'name': 'Gemini 3.6 Flash (Fast)',
          'desc': '轻量超低延迟模型',
        },
        {
          'id': 'gemini-3.1-pro',
          'name': 'Gemini 3.1 Pro (深度推理)',
          'desc': '高复杂度架构攻坚与深度逻辑推演',
        },
        {
          'id': 'claude-sonnet-4-6',
          'name': 'Claude Sonnet 4.6 (Thinking)',
          'desc': '原生嵌入 Antigravity 的高阶思维模型',
        },
        {
          'id': 'claude-opus-4-6',
          'name': 'Claude Opus 4.6 (Thinking)',
          'desc': '顶级架构分析与复杂逻辑推演',
        },
        {
          'id': 'gpt-oss-120b',
          'name': 'GPT-OSS 120B (Medium)',
          'desc': '开源高性价比大模型',
        },
        {
          'id': 'flash',
          'name': 'Gemini Flash (快速推荐)',
          'desc': '标准 Flash 阶梯 (自动映射最新 Gemini 3.8 Flash)',
        },
        {
          'id': 'pro',
          'name': 'Gemini Pro (强力推理)',
          'desc': '标准 Pro 阶梯 (自动映射最新 Gemini 3.1 Pro / Claude)',
        },
        {
          'id': 'flash_lite',
          'name': 'Gemini Flash-Lite (超轻量)',
          'desc': '超轻量阶梯 (自动映射 Gemini 3.6 Flash)',
        },
      ];

      caps['antigravity'] = {
        'tool': 'antigravity',
        'available': true,
        'path': agyPath,
        'models': agyModels,
        'default_model': 'gemini-3.8-flash',
        'supports_effort': false,
        'default_effort': '',
        'effort_options': [],
      };
    }

    return caps;
  }

  static String _formatClaudeDisplayName(String modelId) {
    final m = modelId.toLowerCase();
    if (m.contains('fable-5-1') || m.contains('fable-5.1')) return 'Claude Fable 5.1';
    if (m.contains('mythos-5-1') || m.contains('mythos-5.1')) return 'Claude Mythos 5.1';
    if (m.contains('fable-5')) return 'Claude Fable 5';
    if (m.contains('mythos-5')) return 'Claude Mythos 5';
    if (RegExp(r'(?<![0-9])opus-5').hasMatch(m)) return 'Claude Opus 5';
    if (RegExp(r'(?<![0-9])sonnet-5').hasMatch(m)) return 'Claude Sonnet 5';
    if (m.contains('opus-4-8')) return 'Claude Opus 4.8';
    if (m.contains('opus-4-7')) return 'Claude Opus 4.7';
    if (m.contains('opus-4-6')) return 'Claude Opus 4.6';
    if (m.contains('sonnet-4-6') || m.contains('sonnet-4.6')) return 'Claude Sonnet 4.6';
    if (m.contains('opus-4-5')) return 'Claude Opus 4.5';
    if (m.contains('sonnet-4-5')) return 'Claude Sonnet 4.5';
    if (m.contains('haiku-4-5')) return 'Claude Haiku 4.5';
    if (m.contains('opus-4-1')) return 'Claude Opus 4.1';
    if (m.contains('opus-4')) return 'Claude Opus 4';
    if (m.contains('sonnet-4')) return 'Claude Sonnet 4';
    if (m.contains('3-7-sonnet')) return 'Claude 3.7 Sonnet';
    if (m.contains('3-5-sonnet')) return 'Claude 3.5 Sonnet';
    if (m.contains('3-5-haiku')) return 'Claude 3.5 Haiku';
    if (m.contains('opus')) return 'Claude Opus';
    return modelId;
  }

  static Map<String, String>? _cachedExecutionEnv;

  /// Sniff critical API keys from user shell configs (~/.zshrc, ~/.bash_profile, etc.)
  /// on macOS/Linux where GUI desktop apps lack interactive login environment.
  Future<Map<String, String>> _buildExecutionEnvironment() async {
    if (_cachedExecutionEnv != null) return _cachedExecutionEnv!;

    final env = Map<String, String>.from(Platform.environment);
    env['PYTHONUNBUFFERED'] = '1';

    // Strip Antigravity subagent session metadata so dispatched tasks aren't mistakenly treated
    // as subagents of a dead parent Antigravity conversation (which leads to "sender conversation not found")
    env.remove('ANTIGRAVITY_SOURCE_METADATA');
    env.remove('ANTIGRAVITY_CONVERSATION_ID');
    env.remove('ANTIGRAVITY_AGENT');
    env.remove('ANTIGRAVITY_TRAJECTORY_ID');

    if (Platform.isMacOS || Platform.isLinux) {
      final home = CollectorConfig.homeDir;
      final shellFiles = [
        '$home/.zshrc',
        '$home/.bash_profile',
        '$home/.bashrc',
        '$home/.profile',
      ];

      final targetKeys = {
        'DASHSCOPE_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'DEEPSEEK_API_KEY',
        'OPENAI_BASE_URL',
        'CODEX_HOME',
        'CLAUDE_CONFIG_DIR',
      };

      for (final sf in shellFiles) {
        final f = File(sf);
        if (await f.exists()) {
          try {
            final lines = await f.readAsLines();
            for (final line in lines) {
              final trimmed = line.trim();
              if (trimmed.isEmpty || trimmed.startsWith('#')) continue;
              var lineContent = trimmed;
              if (lineContent.startsWith('export ')) {
                lineContent = lineContent.substring(7).trim();
              }
              final eqIdx = lineContent.indexOf('=');
              if (eqIdx > 0) {
                final k = lineContent.substring(0, eqIdx).trim();
                var v = lineContent.substring(eqIdx + 1).trim();
                // Strip inline comments or semicolons
                if (v.contains(';')) {
                  v = v.substring(0, v.indexOf(';')).trim();
                }
                if ((v.startsWith('"') && v.endsWith('"')) ||
                    (v.startsWith("'") && v.endsWith("'"))) {
                  if (v.length >= 2) {
                    v = v.substring(1, v.length - 1).trim();
                  }
                }
                if (targetKeys.contains(k) && !env.containsKey(k) && v.isNotEmpty) {
                  env[k] = v;
                }
              }
            }
          } catch (_) {}
        }
      }
      // Enrich PATH for macOS/Linux GUI apps where launchd provides only minimal PATH
      final currentPath = env['PATH'] ?? '';
      final parts = currentPath.split(':').where((p) => p.isNotEmpty).toList();

      // 1. Try to inherit the user's interactive login shell PATH (fast probe with 1.5s timeout)
      try {
        final shell = Platform.environment['SHELL'] ?? (await File('/bin/zsh').exists() ? '/bin/zsh' : '/bin/sh');
        final res = await Process.run(
          shell,
          ['-ilc', 'echo -n "\$PATH"'],
        ).timeout(const Duration(milliseconds: 1500));
        if (res.exitCode == 0) {
          final shellPath = res.stdout.toString().trim();
          for (final sp in shellPath.split(':')) {
            if (sp.isNotEmpty && !parts.contains(sp) && Directory(sp).existsSync()) {
              parts.insert(0, sp);
            }
          }
        }
      } catch (_) {}

      // 2. Add all standard tool & runtime directories
      final extraDirs = [
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '$home/.local/bin',
        '$home/.cargo/bin',
        '$home/go/bin',
        '$home/.npm-global/bin',
        '$home/.volta/bin',
        '$home/.fnm/current/bin',
        '$home/.asdf/shims',
        '$home/.gemini/antigravity/bin',
        '$home/.antigravity/antigravity/bin',
        '/Applications/ChatGPT.app/Contents/Resources',
      ];

      // Scan dynamic nvm / asdf node directories
      final nvmDir = Directory('$home/.nvm/versions/node');
      if (await nvmDir.exists()) {
        try {
          final entries = await nvmDir.list().toList();
          for (final entry in entries) {
            if (entry is Directory) {
              extraDirs.add('${entry.path}/bin');
            }
          }
        } catch (_) {}
      }
      final asdfNodeDir = Directory('$home/.asdf/installs/nodejs');
      if (await asdfNodeDir.exists()) {
        try {
          final entries = await asdfNodeDir.list().toList();
          for (final entry in entries) {
            if (entry is Directory) {
              extraDirs.add('${entry.path}/bin');
            }
          }
        } catch (_) {}
      }

      for (final ed in extraDirs) {
        if (!parts.contains(ed) && Directory(ed).existsSync()) {
          parts.insert(0, ed);
        }
      }
      env['PATH'] = parts.join(':');
    } else if (Platform.isWindows) {
      final home = CollectorConfig.homeDir;
      final extraDirs = [
        '$home\\AppData\\Roaming\\npm',
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        '$home\\AppData\\Local\\Programs\\node',
        '$home\\AppData\\Local\\agy\\bin',
        '$home\\AppData\\Local\\Programs\\Antigravity',
        '$home\\AppData\\Local\\Programs',
        '$home\\.gemini\\antigravity\\bin',
        '$home\\.antigravity\\bin',
        '$home\\.cargo\\bin',
        '$home\\go\\bin',
        '$home\\.local\\bin',
        '$home\\AppData\\Local\\fnm_multishells\\current\\bin',
      ];
      final currentPath = env['PATH'] ?? '';
      final parts = currentPath.split(';');
      for (final ed in extraDirs) {
        if (!parts.any((p) => p.toLowerCase() == ed.toLowerCase()) && Directory(ed).existsSync()) {
          parts.insert(0, ed);
        }
      }
      env['PATH'] = parts.join(';');
    }

    _cachedExecutionEnv = env;
    return env;
  }

  Future<String?> _findExecutable(List<String> names) async {
    final execEnv = await _buildExecutionEnvironment();
    final pathSeparator = Platform.isWindows ? ';' : ':';
    final envPath = execEnv['PATH'] ?? '';
    final paths = envPath.split(pathSeparator).where((p) => p.isNotEmpty).toList();

    final extensions = Platform.isWindows ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];

    for (final name in names) {
      for (final ext in extensions) {
        final targetName = name.toLowerCase().endsWith(ext.toLowerCase()) ? name : '$name$ext';
        for (final dir in paths) {
          if (dir.isEmpty) continue;
          final file = File('$dir${Platform.pathSeparator}$targetName');
          if (await file.exists()) {
            return file.path;
          }
        }
      }
    }
    return null;
  }

  /// Prepare command execution on current OS.
  /// On Windows, handles:
  /// 1. Node.js batch scripts (npm CLI wrappers like codex.cmd, claude.cmd) -> runs node.exe directly with script.
  /// 2. Python batch scripts (like agy.cmd) -> runs python directly with script.
  /// 3. Other batch files (.cmd/.bat) -> runs via %COMSPEC% /d /c call "exe" to avoid cmd whitespace split bugs.
  /// 4. Executables with spaces -> runs directly with runInShell: false.
  static Future<ResolvedExecution> prepareCommand(
    String exe,
    List<String> args, {
    bool? isWindowsOverride,
    String? comSpecOverride,
    Future<String?> Function(String path)? fileReaderOverride,
    bool Function(String path)? fileExistsOverride,
  }) async {
    final isWindows = isWindowsOverride ?? Platform.isWindows;
    if (!isWindows) {
      return ResolvedExecution(executable: exe, arguments: args, runInShell: false);
    }

    final lowerExe = exe.toLowerCase();
    final isBatch = lowerExe.endsWith('.cmd') || lowerExe.endsWith('.bat');

    if (isBatch) {
      // 1. Try to resolve npm / node or python batch scripts directly to avoid cmd.exe altogether
      try {
        final exists = fileExistsOverride != null ? fileExistsOverride(exe) : await File(exe).exists();
        if (exists) {
          final content = fileReaderOverride != null
              ? await fileReaderOverride(exe) ?? ''
              : await File(exe).readAsString();
          final pathContext = isWindows ? p.windows : p.posix;
          final dir = pathContext.dirname(exe);

          // Check for node.js script: "%dp0%\node_modules\..." or "%~dp0\node_modules\..."
          final nodeMatch = RegExp(r'["\x27]?%(?:~)?dp0%?\\([^"\r\n\x27]+\.js)["\x27]?').firstMatch(content);
          if (nodeMatch != null) {
            final relJs = nodeMatch.group(1)!.replaceAll('/', pathContext.separator).replaceAll('\\', pathContext.separator);
            final fullJs = pathContext.normalize(pathContext.join(dir, relJs));
            final jsExists = fileExistsOverride != null ? fileExistsOverride(fullJs) : await File(fullJs).exists();
            if (jsExists) {
              final localNodePath = pathContext.join(dir, 'node.exe');
              final localNodeExists = fileExistsOverride != null ? fileExistsOverride(localNodePath) : await File(localNodePath).exists();
              final nodeExe = localNodeExists ? localNodePath : 'node';
              return ResolvedExecution(
                executable: nodeExe,
                arguments: [fullJs, ...args],
                runInShell: false,
              );
            }
          }

          // Check for python script: python "...\script.py" %*
          final pyMatch = RegExp(r'python(?:\.exe)?\s+["\x27]?([^"\r\n\x27]+\.py)["\x27]?').firstMatch(content);
          if (pyMatch != null) {
            final pyPath = pyMatch.group(1)!;
            final pyExists = fileExistsOverride != null ? fileExistsOverride(pyPath) : await File(pyPath).exists();
            if (pyExists) {
              return ResolvedExecution(
                executable: 'python',
                arguments: [pyPath, ...args],
                runInShell: false,
              );
            }
          }
        }
      } catch (_) {}

      // 2. If it is a batch file and couldn't be resolved directly to node/python:
      // On Windows, running batch files with spaces in path via Dart's `runInShell: true`
      // fails with "'C:\Program' is not recognized..." because Dart does not quote the executable.
      // Instead, explicitly invoke %COMSPEC% with /d /c call "exe" to preserve quotes and prevent splitting on whitespace.
      final comSpec = comSpecOverride ?? Platform.environment['COMSPEC'] ?? 'cmd.exe';
      return ResolvedExecution(
        executable: comSpec,
        arguments: ['/d', '/c', 'call', exe, ...args],
        runInShell: false,
      );
    }

    return ResolvedExecution(executable: exe, arguments: args, runInShell: false);
  }

  Future<Process> _startSafeProcess({
    required String exe,
    required List<String> args,
    String? workingDirectory,
    Map<String, String>? environment,
  }) async {
    final prep = await prepareCommand(exe, args);
    return Process.start(
      prep.executable,
      prep.arguments,
      workingDirectory: workingDirectory,
      environment: environment,
      runInShell: prep.runInShell,
    );
  }

  static Map<String, String>? _cachedAntigravityEnv;
  static DateTime? _cachedAntigravityTime;

  /// Ensure ~/.gemini/antigravity/bin/agy_cli.py exists and wrapper is available.
  static Future<void> _ensureAgyCliInstalled() async {
    try {
      final home = CollectorConfig.homeDir;
      final agyDir = Directory('$home/.gemini/antigravity/bin');
      if (!await agyDir.exists()) {
        await agyDir.create(recursive: true);
      }
      final pyScript = File('${agyDir.path}/agy_cli.py');
      bool needsWrite = true;
      if (await pyScript.exists()) {
        try {
          final content = await pyScript.readAsString();
          if (content.contains('_auto_discover_antigravity_ls') &&
              content.contains('gemini-3.8-flash') &&
              content.contains('--timeout') &&
              content.contains('ANTIGRAVITY_SOURCE_METADATA') &&
              content.contains('last_error_message') &&
              content.contains('if __name__ == "__main__":')) {
            needsWrite = false;
          }
        } catch (_) {}
      }
      if (needsWrite) {
        await pyScript.writeAsString(_kEmbeddedAgyCliPy);
        if (Platform.isMacOS || Platform.isLinux) {
          await Process.run('chmod', ['+x', pyScript.path]);
        }
      }

      // Also ensure ~/.local/bin/agy wrapper exists on Mac / Linux
      if (Platform.isMacOS || Platform.isLinux) {
        final localBin = Directory('$home/.local/bin');
        if (!await localBin.exists()) {
          await localBin.create(recursive: true);
        }
        final agyBin = File('${localBin.path}/agy');
        if (!await agyBin.exists()) {
          await agyBin.writeAsString('#!/bin/sh\nexec python3 "${pyScript.path}" "\$@"\n');
          await Process.run('chmod', ['+x', agyBin.path]);
        }
      } else if (Platform.isWindows) {
        final winBin = Directory('$home\\AppData\\Local\\agy\\bin');
        if (!await winBin.exists()) {
          await winBin.create(recursive: true);
        }
        final agyCmd = File('${winBin.path}\\agy.cmd');
        if (!await agyCmd.exists()) {
          await agyCmd.writeAsString('@echo off\r\npython "${pyScript.path}" %*\r\n');
        }
      }
    } catch (_) {}
  }

  /// Discover running Antigravity language_server port, CSRF token, and Project ID.
  static Future<Map<String, String>?> discoverAntigravityEnv({bool forceRefresh = false}) async {
    if (!forceRefresh && _cachedAntigravityEnv != null && _cachedAntigravityTime != null) {
      if (DateTime.now().difference(_cachedAntigravityTime!).inSeconds < 30) {
        return _cachedAntigravityEnv;
      }
    }

    try {
      String? pid;
      String? csrfToken;

      if (Platform.isMacOS || Platform.isLinux) {
        final res = await Process.run('ps', ['-eo', 'pid,command']);
        if (res.exitCode == 0) {
          final lines = res.stdout.toString().split('\n');
          for (final line in lines) {
            if (line.contains('language_server') &&
                line.contains('antigravity') &&
                !line.contains('grep')) {
              final pidMatch = RegExp(r'^\s*(\d+)').firstMatch(line);
              if (pidMatch != null) {
                pid = pidMatch.group(1);
              }
              final tokenMatch = RegExp(r'--csrf_token\s+([^\s]+)').firstMatch(line);
              if (tokenMatch != null) {
                csrfToken = tokenMatch.group(1);
              }
              break;
            }
          }
        }

        if (pid == null) {
          if (Platform.isMacOS) {
            final appDir = Directory('/Applications/Antigravity.app');
            if (await appDir.exists()) {
              await Process.run('open', ['-a', 'Antigravity']);
              await Future.delayed(const Duration(seconds: 3));
              final retryRes = await Process.run('ps', ['-eo', 'pid,command']);
              if (retryRes.exitCode == 0) {
                for (final line in retryRes.stdout.toString().split('\n')) {
                  if (line.contains('language_server') &&
                      line.contains('antigravity') &&
                      !line.contains('grep')) {
                    final pidMatch = RegExp(r'^\s*(\d+)').firstMatch(line);
                    if (pidMatch != null) pid = pidMatch.group(1);
                    final tokenMatch = RegExp(r'--csrf_token\s+([^\s]+)').firstMatch(line);
                    if (tokenMatch != null) csrfToken = tokenMatch.group(1);
                    break;
                  }
                }
              }
            }
          }
          if (pid == null) {
            _cachedAntigravityEnv = null;
            return null;
          }
        }

        final lsofRes = await Process.run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pid]);
        final ports = <int>[];
        if (lsofRes.exitCode == 0) {
          final lsofLines = lsofRes.stdout.toString().split('\n');
          for (final line in lsofLines) {
            final portMatch = RegExp(r'TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)').firstMatch(line);
            if (portMatch != null) {
              final pVal = int.tryParse(portMatch.group(1)!);
              if (pVal != null && !ports.contains(pVal)) {
                ports.add(pVal);
              }
            }
          }
        }

        int? validPort;
        final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 1500);
        for (final port in ports) {
          try {
            final req = await client.getUrl(Uri.parse('http://127.0.0.1:$port/'));
            req.headers.set('User-Agent', 'Antigravity-Probe');
            final resp = await req.close().timeout(const Duration(milliseconds: 1500));
            if (resp.statusCode == 200) {
              final body = await resp.transform(utf8.decoder).join();
              if (body.contains('antigravity') || body.contains('csrfToken')) {
                validPort = port;
                if (csrfToken == null || csrfToken.isEmpty) {
                  final m = RegExp(r'"csrfToken":"([^"]+)"').firstMatch(body);
                  if (m != null) csrfToken = m.group(1);
                }
                break;
              }
            }
          } catch (_) {}
        }
        client.close(force: true);

        if (validPort == null) {
          _cachedAntigravityEnv = null;
          return null;
        }

        String? projectId;
        final home = CollectorConfig.homeDir;
        final storageFiles = [
          File('$home/Library/Application Support/Antigravity/app_storage.json'),
          File('$home/.config/Antigravity/app_storage.json'),
        ];
        for (final f in storageFiles) {
          if (await f.exists()) {
            try {
              final jsonStr = await f.readAsString();
              final map = jsonDecode(jsonStr);
              if (map is Map && map['lastCreatedProjectId'] != null) {
                projectId = map['lastCreatedProjectId'].toString();
                break;
              }
            } catch (_) {}
          }
        }

        final result = <String, String>{
          'ANTIGRAVITY_LS_ADDRESS': 'localhost:$validPort',
        };
        if (csrfToken != null && csrfToken.isNotEmpty) {
          result['ANTIGRAVITY_CSRF_TOKEN'] = csrfToken;
        }
        if (projectId != null && projectId.isNotEmpty) {
          result['ANTIGRAVITY_PROJECT_ID'] = projectId;
        }
        _cachedAntigravityEnv = result;
        _cachedAntigravityTime = DateTime.now();
        return result;
      } else if (Platform.isWindows) {
        final psRes = await Process.run('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name LIKE \'%language_server%\'" | Select-Object -Property ProcessId, CommandLine | ConvertTo-Json',
        ]);
        if (psRes.exitCode == 0) {
          final raw = psRes.stdout.toString().trim();
          if (raw.isNotEmpty) {
            try {
              final decoded = jsonDecode(raw);
              final list = decoded is List ? decoded : [decoded];
              for (final item in list) {
                if (item is Map) {
                  final cmd = item['CommandLine']?.toString() ?? '';
                  if (cmd.contains('antigravity')) {
                    pid = item['ProcessId']?.toString();
                    final tokenMatch = RegExp(r'--csrf_token\s+([^\s]+)').firstMatch(cmd);
                    if (tokenMatch != null) {
                      csrfToken = tokenMatch.group(1);
                    }
                    break;
                  }
                }
              }
            } catch (_) {}
          }
        }

        if (pid == null) {
          _cachedAntigravityEnv = null;
          return null;
        }

        final netstatRes = await Process.run('cmd', ['/c', 'netstat -ano | findstr $pid']);
        final ports = <int>[];
        if (netstatRes.exitCode == 0) {
          final lines = netstatRes.stdout.toString().split('\n');
          for (final line in lines) {
            if (line.contains('LISTENING')) {
              final m = RegExp(r'127\.0\.0\.1:(\d+)').firstMatch(line);
              if (m != null) {
                final pVal = int.tryParse(m.group(1)!);
                if (pVal != null && !ports.contains(pVal)) {
                  ports.add(pVal);
                }
              }
            }
          }
        }

        int? validPort;
        final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 1500);
        for (final port in ports) {
          try {
            final req = await client.getUrl(Uri.parse('http://127.0.0.1:$port/'));
            req.headers.set('User-Agent', 'Antigravity-Probe');
            final resp = await req.close().timeout(const Duration(milliseconds: 1500));
            if (resp.statusCode == 200) {
              final body = await resp.transform(utf8.decoder).join();
              if (body.contains('antigravity') || body.contains('csrfToken')) {
                validPort = port;
                if (csrfToken == null || csrfToken.isEmpty) {
                  final m = RegExp(r'"csrfToken":"([^"]+)"').firstMatch(body);
                  if (m != null) csrfToken = m.group(1);
                }
                break;
              }
            }
          } catch (_) {}
        }
        client.close(force: true);

        if (validPort == null) {
          _cachedAntigravityEnv = null;
          return null;
        }

        String? projectId;
        final appData = Platform.environment['APPDATA'] ?? '';
        final storageFile = File('$appData\\Antigravity\\app_storage.json');
        if (await storageFile.exists()) {
          try {
            final jsonStr = await storageFile.readAsString();
            final map = jsonDecode(jsonStr);
            if (map is Map && map['lastCreatedProjectId'] != null) {
              projectId = map['lastCreatedProjectId'].toString();
            }
          } catch (_) {}
        }

        final result = <String, String>{
          'ANTIGRAVITY_LS_ADDRESS': 'localhost:$validPort',
        };
        if (csrfToken != null && csrfToken.isNotEmpty) {
          result['ANTIGRAVITY_CSRF_TOKEN'] = csrfToken;
        }
        if (projectId != null && projectId.isNotEmpty) {
          result['ANTIGRAVITY_PROJECT_ID'] = projectId;
        }
        _cachedAntigravityEnv = result;
        _cachedAntigravityTime = DateTime.now();
        return result;
      }
    } catch (_) {}
    return null;
  }

  /// On macOS, check if /Volumes/<name> is currently mounted to avoid triggering TCC network volume prompts.
  static bool isVolumeMountedOnMac(String path) {
    if (!Platform.isMacOS || !path.startsWith('/Volumes/')) return true;
    try {
      final parts = path.split('/');
      if (parts.length < 3) return false;
      final volName = parts[2];
      if (volName.isEmpty) return false;
      final volDir = Directory('/Volumes');
      if (!volDir.existsSync()) return false;
      final mounted = volDir.listSync().map((e) => p.basename(e.path)).toSet();
      return mounted.contains(volName);
    } catch (_) {
      return false;
    }
  }

  Future<String?> _resolveWorkingDir(String? rawCwd, Map<String, dynamic> payload) async {
    String? candidate = rawCwd?.trim();
    final home = Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];

    if (candidate != null && candidate.isNotEmpty) {
      if (candidate.startsWith('~') && home != null) {
        candidate = candidate.replaceFirst('~', home);
      }
      if (Platform.isMacOS && candidate.startsWith('/Volumes/') && !isVolumeMountedOnMac(candidate)) {
        _log('Skipping unmounted macOS volume path: $candidate');
        candidate = null;
      } else {
        try {
          if (await Directory(candidate).exists()) {
            return candidate;
          }
        } catch (_) {}
      }
    }

    // Candidate does not exist directly on this machine (e.g. cross-platform Windows path on Mac or vice versa)
    String? projectName;
    if (rawCwd != null && rawCwd.isNotEmpty) {
      final clean = rawCwd.replaceAll(r'\', '/').replaceAll(RegExp(r'/+$'), '');
      final parts = clean.split('/');
      if (parts.isNotEmpty && parts.last.isNotEmpty) {
        projectName = parts.last;
      }
    }

    if (projectName != null && projectName.isNotEmpty && home != null) {
      final probePaths = [
        '$home/$projectName',
        '$home/dev/$projectName',
        '$home/Projects/$projectName',
        '$home/Documents/$projectName',
        '$home/Workspace/$projectName',
        '$home/Desktop/$projectName',
        '$home/code/$projectName',
        '$home/src/$projectName',
      ];
      if (Platform.isWindows) {
        probePaths.addAll([
          'D:/dev/$projectName',
          'D:/Projects/$projectName',
          'E:/dev/$projectName',
          'C:/dev/$projectName',
        ]);
      }
      for (final p in probePaths) {
        try {
          if (await Directory(p).exists()) {
            _log('Auto-aligned CWD to local directory: $p');
            return p;
          }
        } catch (_) {}
      }
    }

    // Safety fallback: User home directory (NEVER fall back to root "/" on macOS/Linux)
    if (home != null) {
      try {
        if (await Directory(home).exists()) {
          _log('CWD fallback to user home directory: $home');
          return home;
        }
      } catch (_) {}
    }

    return null;
  }

  Future<void> _executeTask(TaskDispatch task) async {
    final taskId = task.id;
    final action = task.action;
    final payload = task.payload;
    final cwd = payload['cwd']?.toString().trim();
    final workingDir = await _resolveWorkingDir(cwd, payload);

    String exe = '';
    List<String> args = [];
    bool isAntigravity = false;

    if (action == 'shell') {
      final command = payload['command']?.toString() ?? '';
      if (Platform.isWindows) {
        exe = 'powershell.exe';
        args = ['-NoProfile', '-NonInteractive', '-Command', command];
      } else {
        exe = await File('/bin/zsh').exists() ? '/bin/zsh' : '/bin/sh';
        args = ['-c', command];
      }
    } else {
      // action == 'agent'
      final binary = (payload['binary']?.toString() ?? 'claude').toLowerCase();
      final prompt = payload['prompt']?.toString() ?? '';
      final sessionId = payload['session_id']?.toString() ?? '';
      final model = payload['model']?.toString() ?? '';
      final effort = payload['effort']?.toString() ?? '';
      final sysAppend = payload['system_prompt_append']?.toString() ?? '';

      isAntigravity = binary.contains('agy') || binary.contains('antigravity');
      if (isAntigravity) {
        await _ensureAgyCliInstalled();
      }

      final candidates = <String>[binary];
      if (binary == 'agy') {
        candidates.addAll(['agy_cli.py', 'agentapi']);
      } else if (binary == 'antigravity') {
        candidates.addAll(['agy', 'agy_cli.py', 'agentapi']);
      }

      final resolvedExe = await _findExecutable(candidates);
      if (resolvedExe == null) {
        String installTip = '';
        if (binary.contains('agy') || binary.contains('antigravity')) {
          installTip = Platform.isWindows
              ? '\n💡 Antigravity CLI 未安装，请在 PowerShell 中执行以下命令进行安装：\nirm https://antigravity.google/cli/install.ps1 | iex'
              : '\n💡 Antigravity CLI 未安装，请在终端中执行以下命令进行安装：\ncurl -fsSL https://antigravity.google/cli/install.sh | bash';
        } else if (binary.contains('claude')) {
          installTip = '\n💡 请运行 npm install -g @anthropic-ai/claude-code 安装 Claude Code CLI';
        } else if (binary.contains('codex')) {
          installTip = '\n💡 请运行 pip install openai-codex 或参考 Codex 官方文档安装 Codex CLI';
        }
        _sendJson(TaskFinished(
          taskId: taskId,
          status: 'failed',
          exitCode: 1,
          error: 'Agent CLI executable not found on device: $binary$installTip',
        ).toJson());
        return;
      }
      exe = resolvedExe;

      if (binary.contains('claude')) {
        args = ['-p'];
        if (sessionId.isNotEmpty) args.addAll(['-r', sessionId]);
        if (sysAppend.isNotEmpty) args.addAll(['--append-system-prompt', sysAppend]);
        args.addAll(['--output-format', 'text', '--dangerously-skip-permissions']);
        if (model.isNotEmpty) args.addAll(['--model', model]);
        final settings = <String, dynamic>{};
        if (effort.isNotEmpty) settings['effortLevel'] = effort;
        // Report each tool call to the server, which pushes risky ones to the phone.
        final hooks = await (_hookBridge ??= AgentHookBridge(
          onToolUse: (tid, use) => _sendJson({'type': 'agent_tool_use', 'task_id': tid, ...use}),
        )).claudeHooks(taskId);
        if (hooks != null) settings['hooks'] = hooks;
        if (settings.isNotEmpty) args.addAll(['--settings', jsonEncode(settings)]);
        args.add(prompt);
      } else if (binary.contains('codex')) {
        args = [];
        if (workingDir != null && workingDir.isNotEmpty) {
          args.addAll(['-C', workingDir]);
        }
        args.add('exec');
        final isFork = payload['fork'] == true;
        String effectiveSessionId = sessionId;
        if (sessionId.isNotEmpty) {
          final uuidMatch = RegExp(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').firstMatch(sessionId);
          if (uuidMatch != null) {
            effectiveSessionId = uuidMatch.group(0)!;
          }
          args.add(isFork ? 'fork' : 'resume');
        }
        args.addAll([
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
        ]);
        if (effort.isNotEmpty) args.addAll(['-c', 'model_reasoning_effort="$effort"']);
        if (model.isNotEmpty) args.addAll(['-m', model]);
        if (effectiveSessionId.isNotEmpty) args.add(effectiveSessionId);
        args.add(prompt);
      } else {
        // agy / antigravity
        args = [];
        if (sessionId.isNotEmpty) {
          args.addAll(['--resume', sessionId]);
        }
        if (model.isNotEmpty) {
          args.addAll(['--model', model]);
        }
        if (task.timeoutSeconds > 0) {
          args.addAll(['--timeout', task.timeoutSeconds.toString()]);
        }
        args.addAll(['-p', prompt]);
      }
    }

    _sendJson({
      'type': 'task_progress',
      'task_id': taskId,
      'status': 'running',
    });

    final stdoutBuf = StringBuffer();
    final stderrBuf = StringBuffer();
    _activeStdoutBuffers[taskId] = stdoutBuf;
    Process? proc;

    try {
      final executionEnv = await _buildExecutionEnvironment();

      // Ensure the directory of the resolved executable is at the front of PATH so shebangs like #!/usr/bin/env node succeed
      final exeDir = p.dirname(exe);
      final currentPath = executionEnv['PATH'] ?? '';
      final sep = Platform.isWindows ? ';' : ':';
      final pathParts = currentPath.split(sep).where((x) => x.isNotEmpty).toList();
      if (exeDir.isNotEmpty && !pathParts.contains(exeDir) && Directory(exeDir).existsSync()) {
        pathParts.insert(0, exeDir);
        executionEnv['PATH'] = pathParts.join(sep);
      }

      if (isAntigravity) {
        final agEnv = await discoverAntigravityEnv();
        if (agEnv != null) {
          executionEnv.addAll(agEnv);
        } else {
          _sendJson(TaskFinished(
            taskId: taskId,
            status: 'failed',
            exitCode: 1,
            error: '💡 未检测到正在运行的 Antigravity 应用服务。\n\n'
                   'Antigravity 需在本地保持运行以便通过 language_server 进行通信。\n'
                   '请先启动 Antigravity 客户端应用后再试。',
          ).toJson());
          return;
        }
      }
      proc = await _startSafeProcess(
        exe: exe,
        args: args,
        workingDirectory: workingDir,
        environment: executionEnv,
      );
      _runningTasks[taskId] = proc;
      try {
        await proc.stdin.close();
      } catch (_) {}

      const decoder = Utf8Decoder(allowMalformed: true);

      // Stream stdout chunks
      proc.stdout.transform(decoder).listen((chunk) {
        stdoutBuf.write(chunk);
        _sendJson(TaskChunk(
          taskId: taskId,
          stream: 'stdout',
          text: chunk,
        ).toJson());
      });

      // Stream stderr chunks
      proc.stderr.transform(decoder).listen((chunk) {
        stderrBuf.write(chunk);
        _sendJson(TaskChunk(
          taskId: taskId,
          stream: 'stderr',
          text: chunk,
        ).toJson());
      });

      // Wait for process completion or timeout
      var exitCode = await proc.exitCode.timeout(
        Duration(seconds: task.timeoutSeconds),
        onTimeout: () {
          _killTaskProcess(proc);
          return -999;
        },
      );

      var fullOut = stdoutBuf.toString().trim();
      var fullErr = stderrBuf.toString().trim();

      // Reactive retry 0: Antigravity language_server port binding failure
      if (exitCode != 0 &&
          action != 'shell' &&
          isAntigravity &&
          (fullErr.contains('ANTIGRAVITY_LS_ADDRESS is not set') ||
           fullOut.contains('ANTIGRAVITY_LS_ADDRESS is not set'))) {
        const agyNotice = '\n⚡ [环境自愈] 正在重新检测并绑定本地 Antigravity 运行端口...\n\n';
        stderrBuf.write(agyNotice);
        _sendJson(TaskChunk(taskId: taskId, stream: 'stderr', text: agyNotice).toJson());

        final agEnv = await discoverAntigravityEnv(forceRefresh: true);
        if (agEnv != null) {
          executionEnv.addAll(agEnv);
          final retryProc = await _startSafeProcess(
            exe: exe,
            args: args,
            workingDirectory: workingDir,
            environment: executionEnv,
          );
          try {
            await retryProc.stdin.close();
          } catch (_) {}
          _runningTasks[taskId] = retryProc;
          retryProc.stdout.transform(decoder).listen((chunk) {
            stdoutBuf.write(chunk);
            _sendJson(TaskChunk(taskId: taskId, stream: 'stdout', text: chunk).toJson());
          });
          retryProc.stderr.transform(decoder).listen((chunk) {
            stderrBuf.write(chunk);
            _sendJson(TaskChunk(taskId: taskId, stream: 'stderr', text: chunk).toJson());
          });
          exitCode = await retryProc.exitCode.timeout(
            Duration(seconds: task.timeoutSeconds),
            onTimeout: () {
              _killTaskProcess(retryProc);
              return -999;
            },
          );
          fullOut = stdoutBuf.toString().trim();
          fullErr = stderrBuf.toString().trim();
        }
      }

      // Reactive retry 1: if resume hit ChatGPT.app active writer lock on Mac, auto fork & retry
      if (exitCode != 0 &&
          action != 'shell' &&
          (payload['binary']?.toString() ?? '').toLowerCase().contains('codex') &&
          (payload['session_id']?.toString() ?? '').isNotEmpty &&
          payload['fork'] != true &&
          fullErr.contains('already has an active writer')) {
        const notice = '\n⚡ [自动重试] 该会话当前正被 ChatGPT 客户端占用锁定，已自动无缝切换为 Fork 分支模式重新执行（完整继承上下文记忆）...\n\n';
        stderrBuf.write(notice);
        _sendJson(TaskChunk(
          taskId: taskId,
          stream: 'stderr',
          text: notice,
        ).toJson());

        final sId = payload['session_id'].toString();
        final uuidMatch = RegExp(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').firstMatch(sId);
        final cleanSid = uuidMatch != null ? uuidMatch.group(0)! : sId;
        final pText = payload['prompt']?.toString() ?? '';
        final mModel = payload['model']?.toString() ?? '';
        final mEffort = payload['effort']?.toString() ?? '';

        final retryArgs = <String>[];
        if (workingDir != null && workingDir.isNotEmpty) {
          retryArgs.addAll(['-C', workingDir]);
        }
        retryArgs.addAll([
          'exec',
          'fork',
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
        ]);
        if (mEffort.isNotEmpty) retryArgs.addAll(['-c', 'model_reasoning_effort="$mEffort"']);
        if (mModel.isNotEmpty) retryArgs.addAll(['-m', mModel]);
        retryArgs.addAll([cleanSid, pText]);

        final retryProc = await _startSafeProcess(
          exe: exe,
          args: retryArgs,
          workingDirectory: workingDir,
          environment: executionEnv,
        );
        await retryProc.stdin.close();
        _runningTasks[taskId] = retryProc;

        retryProc.stdout.transform(decoder).listen((chunk) {
          stdoutBuf.write(chunk);
          _sendJson(TaskChunk(taskId: taskId, stream: 'stdout', text: chunk).toJson());
        });
        retryProc.stderr.transform(decoder).listen((chunk) {
          stderrBuf.write(chunk);
          _sendJson(TaskChunk(taskId: taskId, stream: 'stderr', text: chunk).toJson());
        });

        exitCode = await retryProc.exitCode.timeout(
          Duration(seconds: task.timeoutSeconds),
          onTimeout: () {
            _killTaskProcess(retryProc);
            return -999;
          },
        );
        fullOut = stdoutBuf.toString().trim();
        fullErr = stderrBuf.toString().trim();
      }

      // Reactive retry 2: cross-device session missing or corrupted (no rollout found, session not found, etc.)
      final isSessionNotFound = fullErr.contains('no rollout found') ||
          fullErr.contains('thread not found') ||
          fullErr.contains('session not found') ||
          fullErr.contains('conversation not found') ||
          (fullErr.contains('conversation') && fullErr.contains('not found')) ||
          fullErr.contains('Error resuming conversation') ||
          fullErr.contains('failed to resume') ||
          fullErr.contains('cannot resume') ||
          fullErr.contains('unable to resume') ||
          fullErr.contains('No conversation found') ||
          fullErr.contains('could not find session') ||
          fullErr.contains('no recorded session') ||
          fullErr.contains('unexpected argument') ||
          fullErr.contains('invalid value') ||
          fullErr.contains('Usage: codex exec') ||
          fullErr.contains('Usage: agy');

      if (exitCode != 0 &&
          action != 'shell' &&
          (payload['session_id']?.toString() ?? '').isNotEmpty &&
          isSessionNotFound) {
        const resetNotice = '\n⚡ [自动自愈] 本地未找到历史会话（跨设备远程调度常见），已自动重置为全新会话重新执行...\n\n';
        stderrBuf.write(resetNotice);
        _sendJson(TaskChunk(
          taskId: taskId,
          stream: 'stderr',
          text: resetNotice,
        ).toJson());

        final binary = (payload['binary']?.toString() ?? 'claude').toLowerCase();
        final pText = payload['prompt']?.toString() ?? '';
        final mModel = payload['model']?.toString() ?? '';
        final mEffort = payload['effort']?.toString() ?? '';
        final sysAppend = payload['system_prompt_append']?.toString() ?? '';

        List<String> freshArgs = [];
        if (binary.contains('claude')) {
          freshArgs = ['-p'];
          if (sysAppend.isNotEmpty) freshArgs.addAll(['--append-system-prompt', sysAppend]);
          freshArgs.addAll(['--output-format', 'text', '--dangerously-skip-permissions']);
          if (mModel.isNotEmpty) freshArgs.addAll(['--model', mModel]);
          freshArgs.add(pText);
        } else if (binary.contains('codex')) {
          freshArgs = [];
          if (workingDir != null && workingDir.isNotEmpty) {
            freshArgs.addAll(['-C', workingDir]);
          }
          freshArgs.addAll([
            'exec',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
          ]);
          if (mEffort.isNotEmpty) freshArgs.addAll(['-c', 'model_reasoning_effort="$mEffort"']);
          if (mModel.isNotEmpty) freshArgs.addAll(['-m', mModel]);
          freshArgs.add(pText);
        } else {
          freshArgs = [];
          if (mModel.isNotEmpty) freshArgs.addAll(['--model', mModel]);
          freshArgs.addAll(['-p', pText]);
        }

        final freshProc = await _startSafeProcess(
          exe: exe,
          args: freshArgs,
          workingDirectory: workingDir,
          environment: executionEnv,
        );
        try {
          await freshProc.stdin.close();
        } catch (_) {}
        _runningTasks[taskId] = freshProc;

        freshProc.stdout.transform(decoder).listen((chunk) {
          stdoutBuf.write(chunk);
          _sendJson(TaskChunk(taskId: taskId, stream: 'stdout', text: chunk).toJson());
        });
        freshProc.stderr.transform(decoder).listen((chunk) {
          stderrBuf.write(chunk);
          _sendJson(TaskChunk(taskId: taskId, stream: 'stderr', text: chunk).toJson());
        });

        exitCode = await freshProc.exitCode.timeout(
          Duration(seconds: task.timeoutSeconds),
          onTimeout: () {
            _killTaskProcess(freshProc);
            return -999;
          },
        );
        fullOut = stdoutBuf.toString().trim();
        fullErr = stderrBuf.toString().trim();
      }

      if (exitCode != 0 &&
          (fullErr.contains('Operation not permitted') || fullErr.contains('Permission denied')) &&
          Platform.isMacOS) {
        const hint = '\n💡 [权限提示] 检测到 macOS 磁盘访问受限。请在「系统设置 -> 隐私与安全性 -> 完全磁盘访问权限」中添加并开启 Memento.app。\n';
        stderrBuf.write(hint);
        _sendJson(TaskChunk(taskId: taskId, stream: 'stderr', text: hint).toJson());
        fullErr = stderrBuf.toString().trim();
      }

      final isTimeout = exitCode == -999;
      final isPromptTooLong = fullErr.contains('Prompt is too long') || fullOut.contains('Prompt is too long');

      final status = isTimeout
          ? 'timeout'
          : (exitCode == 0 ? 'succeeded' : 'failed');

      final errorMsg = isTimeout
          ? 'Task timed out after ${task.timeoutSeconds}s'
          : (exitCode != 0 ? (fullErr.isNotEmpty ? fullErr : 'Exit code $exitCode') : null);

      // Extract session ID from stdout / stderr
      String? extractedSessionId;
      final sidMatch = RegExp(r'session id:\s*([0-9a-fA-F-]+)', caseSensitive: false).firstMatch(fullOut) ??
          RegExp(r'session id:\s*([0-9a-fA-F-]+)', caseSensitive: false).firstMatch(fullErr) ??
          RegExp(r'thread[_-]id:\s*([0-9a-fA-F-]+)', caseSensitive: false).firstMatch(fullOut);
      if (sidMatch != null) {
        extractedSessionId = sidMatch.group(1);
      }
      final resolvedSessionId = extractedSessionId ??
          (payload['session_id']?.toString().isNotEmpty == true ? payload['session_id'].toString() : null);

      _sendJson(TaskFinished(
        taskId: taskId,
        status: status,
        exitCode: exitCode,
        stdout: fullOut,
        stderr: fullErr,
        error: errorMsg,
        errorType: isPromptTooLong ? 'prompt_too_long' : null,
        sessionId: resolvedSessionId,
      ).toJson());
    } catch (e) {
      _sendJson(TaskFinished(
        taskId: taskId,
        status: 'failed',
        exitCode: 1,
        error: 'Execution failed to start: $e',
      ).toJson());
    } finally {
      _activeStdoutBuffers.remove(taskId);
      final active = _runningTasks.remove(taskId);
      try {
        await active?.stdin.close();
      } catch (_) {}
    }
  }

  Future<void> _handleFileStat(String reqId, String rawPath) async {
    try {
      final clean = rawPath.replaceFirst(RegExp(r'^file://'), '');
      final file = File(clean);
      if (await file.exists()) {
        final size = await file.length();
        _sendJson({
          'type': 'file_stat_resp',
          'req_id': reqId,
          'exists': true,
          'total_size': size,
        });
      } else {
        _sendJson({
          'type': 'file_stat_resp',
          'req_id': reqId,
          'exists': false,
          'error': 'File not found on device: $clean',
        });
      }
    } catch (e) {
      _sendJson({
        'type': 'file_stat_resp',
        'req_id': reqId,
        'exists': false,
        'error': e.toString(),
      });
    }
  }

  Future<void> _handleFileChunk(String reqId, String rawPath, int offset, int length) async {
    RandomAccessFile? raf;
    try {
      final clean = rawPath.replaceFirst(RegExp(r'^file://'), '');
      final file = File(clean);
      if (!await file.exists()) {
        _sendJson({
          'type': 'file_chunk_resp',
          'req_id': reqId,
          'error': 'File not found: $clean',
        });
        return;
      }
      raf = await file.open(mode: FileMode.read);
      await raf.setPosition(offset);
      final bytes = await raf.read(length);
      final b64 = base64Encode(bytes);
      _sendJson({
        'type': 'file_chunk_resp',
        'req_id': reqId,
        'data_b64': b64,
        'bytes_read': bytes.length,
      });
    } catch (e) {
      _sendJson({
        'type': 'file_chunk_resp',
        'req_id': reqId,
        'error': e.toString(),
      });
    } finally {
      try {
        await raf?.close();
      } catch (_) {}
    }
  }

  /// Open macOS System Settings directly to Full Disk Access (FDA) panel.
  static Future<bool> openMacFullDiskAccessPreferences() async {
    if (!Platform.isMacOS) return false;
    try {
      final res = await Process.run('open', [
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      ]);
      return res.exitCode == 0;
    } catch (_) {
      return false;
    }
  }
}

const String _kEmbeddedAgyCliPy = r'''#!/usr/bin/env python3
"""Antigravity CLI runner: communicates with the running Antigravity language_server."""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def _auto_discover_antigravity_ls():
    """Auto-detect ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN if not explicitly exported."""
    if os.environ.get("ANTIGRAVITY_LS_ADDRESS") and os.environ.get("ANTIGRAVITY_CSRF_TOKEN"):
        return

    try:
        if sys.platform in ("darwin", "linux"):
            out = subprocess.check_output(["ps", "-eo", "pid,command"], text=True)
            pid = None
            csrf_token = None
            for line in out.splitlines():
                if "language_server" in line and "antigravity" in line and "grep" not in line:
                    m_pid = re.match(r"^\s*(\d+)", line)
                    if m_pid:
                        pid = m_pid.group(1)
                    m_token = re.search(r"--csrf_token\s+([^\s]+)", line)
                    if m_token:
                        csrf_token = m_token.group(1)
                    break
            if not pid:
                return

            lsof_out = subprocess.check_output(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid], text=True)
            ports = []
            for pline in lsof_out.splitlines():
                m_port = re.search(r"TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)", pline)
                if m_port:
                    ports.append(int(m_port.group(1)))

            for port in ports:
                try:
                    url = f"http://127.0.0.1:{port}/"
                    req = urllib.request.Request(url, headers={"User-Agent": "Antigravity-Probe"})
                    with urllib.request.urlopen(req, timeout=1) as resp:
                        if resp.status == 200:
                            content = resp.read(2048).decode("utf-8", errors="ignore")
                            if "antigravity" in content or "csrfToken" in content:
                                if not csrf_token:
                                    m_c = re.search(r'"csrfToken":"([^"]+)"', content)
                                    if m_c:
                                        csrf_token = m_c.group(1)
                                os.environ["ANTIGRAVITY_LS_ADDRESS"] = f"localhost:{port}"
                                if csrf_token:
                                    os.environ["ANTIGRAVITY_CSRF_TOKEN"] = csrf_token

                                if not os.environ.get("ANTIGRAVITY_PROJECT_ID"):
                                    storage_paths = [
                                        Path.home() / "Library" / "Application Support" / "Antigravity" / "app_storage.json",
                                        Path.home() / ".config" / "Antigravity" / "app_storage.json",
                                        Path(os.environ.get("APPDATA", "")) / "Antigravity" / "app_storage.json",
                                    ]
                                    for sp in storage_paths:
                                        if sp.exists():
                                            try:
                                                with open(sp, "r", encoding="utf-8") as sf:
                                                    sdata = json.load(sf)
                                                    pid_val = sdata.get("lastCreatedProjectId")
                                                    if pid_val:
                                                        os.environ["ANTIGRAVITY_PROJECT_ID"] = str(pid_val)
                                                        break
                                            except Exception:
                                                pass
                                return
                except Exception:
                    pass
        elif sys.platform == "win32":
            try:
                ps_cmd = [
                    "powershell", "-NoProfile", "-Command",
                    'Get-CimInstance Win32_Process -Filter "Name LIKE \'%language_server%\'" | Select-Object -Property ProcessId, CommandLine | ConvertTo-Json'
                ]
                raw = subprocess.check_output(ps_cmd, text=True, timeout=3)
                data = json.loads(raw)
                items = data if isinstance(data, list) else [data]
                pid = None
                csrf_token = None
                for item in items:
                    cmd_line = item.get("CommandLine") or ""
                    if "antigravity" in cmd_line.lower():
                        pid = str(item.get("ProcessId"))
                        m_token = re.search(r"--csrf_token\s+([^\s]+)", cmd_line)
                        if m_token:
                            csrf_token = m_token.group(1)
                        break
                if pid:
                    net_out = subprocess.check_output(f"netstat -ano | findstr {pid}", shell=True, text=True)
                    ports = []
                    for pline in net_out.splitlines():
                        if "LISTENING" in pline:
                            m_port = re.search(r"127\.0\.0\.1:(\d+)", pline)
                            if m_port:
                                ports.append(int(m_port.group(1)))
                    for port in ports:
                        try:
                            url = f"http://127.0.0.1:{port}/"
                            req = urllib.request.Request(url, headers={"User-Agent": "Antigravity-Probe"})
                            with urllib.request.urlopen(req, timeout=1) as resp:
                                if resp.status == 200:
                                    cnt = resp.read(2048).decode("utf-8", errors="ignore")
                                    if "antigravity" in cnt or "csrfToken" in cnt:
                                        if not csrf_token:
                                            m_c = re.search(r'"csrfToken":"([^"]+)"', cnt)
                                            if m_c:
                                                csrf_token = m_c.group(1)
                                        os.environ["ANTIGRAVITY_LS_ADDRESS"] = f"localhost:{port}"
                                        if csrf_token:
                                            os.environ["ANTIGRAVITY_CSRF_TOKEN"] = csrf_token
                                        break
                        except Exception:
                            pass
            except Exception:
                pass
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Antigravity CLI Runner")
    parser.add_argument("-p", "--prompt", dest="prompt_flag", help="Prompt to send to Antigravity")
    parser.add_argument("--resume", dest="resume_id", default="", help="Resume an existing conversation by ID")
    parser.add_argument("--model", dest="model", default="", help="Model tier: flash_lite, flash, or pro")
    parser.add_argument("--title", dest="title", default="", help="Conversation title")
    parser.add_argument("--timeout", type=int, default=1800, help="Timeout in seconds")
    parser.add_argument("prompt_pos", nargs="*", help="Positional prompt words")

    args, unknown = parser.parse_known_args()

    prompt_parts = []
    if args.prompt_flag:
        prompt_parts.append(args.prompt_flag)
    if args.prompt_pos:
        prompt_parts.extend(args.prompt_pos)

    prompt = " ".join(prompt_parts).strip()
    if not prompt:
        if not sys.stdin.isatty():
            try:
                prompt = sys.stdin.read().strip()
            except Exception:
                pass

    if not prompt:
        print("Error: empty prompt", file=sys.stderr)
        sys.exit(1)

    agentapi = Path.home() / ".gemini" / "antigravity" / "bin" / ("agentapi.cmd" if sys.platform == "win32" else "agentapi")
    if not agentapi.exists():
        ls_candidates = [
            Path("/Applications/Antigravity.app/Contents/Resources/bin/language_server"),
            Path.home() / "AppData" / "Local" / "Programs" / "Antigravity" / "resources" / "bin" / "language_server.exe",
            Path("C:/Program Files/Antigravity/resources/bin/language_server.exe"),
        ]
        for c in ls_candidates:
            if c.exists():
                agentapi.parent.mkdir(parents=True, exist_ok=True)
                if sys.platform == "win32":
                    with open(agentapi, "w", encoding="utf-8") as f:
                        f.write(f'@echo off\r\n"{c}" agentapi %*\r\n')
                else:
                    with open(agentapi, "w", encoding="utf-8") as f:
                        f.write(f'#!/bin/sh\nexec "{c}" agentapi "$@"\n')
                    agentapi.chmod(0o755)
                break

    if not agentapi.exists():
        print(f"Error: agentapi not found at {agentapi}", file=sys.stderr)
        sys.exit(1)

    # Auto-detect Antigravity language_server address and CSRF token if not set
    if not os.environ.get("ANTIGRAVITY_LS_ADDRESS"):
        _auto_discover_antigravity_ls()

    if not os.environ.get("ANTIGRAVITY_LS_ADDRESS"):
        print("💡 未检测到正在运行的 Antigravity 应用服务。请先启动 Antigravity 应用后再试。", file=sys.stderr)
        sys.exit(1)

    # Strip any inherited Antigravity parent session/subagent environment variables
    # to avoid "sender conversation not found" errors when calling agentapi
    for k in (
        "ANTIGRAVITY_SOURCE_METADATA",
        "ANTIGRAVITY_CONVERSATION_ID",
        "ANTIGRAVITY_AGENT",
        "ANTIGRAVITY_TRAJECTORY_ID",
    ):
        os.environ.pop(k, None)

    # Normalize model tier
    model_arg = (args.model or "").lower().strip()
    if model_arg in ("flash_lite", "flash-lite", "gemini-3.6-flash", "gemini-2.5-flash-lite"):
        model = "flash_lite"
    elif model_arg in ("pro", "gemini-3.1-pro", "gemini-2.5-pro", "claude-sonnet-4-6", "claude-opus-4-6", "claude-3-7-sonnet"):
        model = "pro"
    elif model_arg in ("flash", "gemini-3.8-flash", "gemini-3.7-flash"):
        model = "flash"
    else:
        model = "flash"

    title = args.title or prompt[:40]
    conv_id = args.resume_id.strip()
    start_pos = 0

    if conv_id:
        # Resume existing conversation
        target_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript_full.jsonl"
        fallback_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript.jsonl"
        if target_log.exists():
            start_pos = target_log.stat().st_size
        elif fallback_log.exists():
            start_pos = fallback_log.stat().st_size

        cmd = [
            str(agentapi),
            "send-message",
            f"--title={title}",
            conv_id,
            prompt,
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ))
            if res.returncode != 0:
                err_text = (res.stderr or res.stdout or "").strip()
                print(f"Error resuming conversation via Antigravity: {err_text}", file=sys.stderr)
                sys.exit(1)
        except Exception as e:
            print(f"Error resuming conversation via Antigravity: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Start new conversation
        cmd = [
            str(agentapi),
            "new-conversation",
            f"--model={model}",
            f"--title={title}",
            prompt,
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ))
            if res.returncode != 0:
                err_text = (res.stderr or res.stdout or "").strip()
                print(f"Error initiating conversation via Antigravity: {err_text}", file=sys.stderr)
                sys.exit(1)
            out_json = json.loads(res.stdout)
            conv_id = out_json["response"]["newConversation"]["conversationId"]
        except Exception as e:
            print(f"Error initiating conversation via Antigravity: {e}", file=sys.stderr)
            sys.exit(1)

    sys.stderr.write(f"session id: {conv_id}\n")
    sys.stderr.flush()

    target_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript_full.jsonl"
    fallback_log = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs" / "transcript.jsonl"

    # Wait for transcript file to appear
    wait_start = time.time()
    while not target_log.exists() and not fallback_log.exists():
        if time.time() - wait_start > 20:
            print("Timed out waiting for Antigravity response log.", file=sys.stderr)
            sys.exit(1)
        time.sleep(0.1)

    transcript_file = target_log if target_log.exists() else fallback_log

    start_time = time.time()
    idle_count = 0
    completed = False
    last_error_message = ""
    with open(transcript_file, "r", encoding="utf-8") as f:
        if start_pos > 0:
            f.seek(start_pos)

        while True:
            if time.time() - start_time > args.timeout:
                sys.stderr.write(f"\n[Agent timeout: 任务执行已达到安全上限（{args.timeout}s）]\n")
                sys.stderr.flush()
                sys.exit(124)

            line = f.readline()
            if not line:
                time.sleep(0.2)
                idle_count += 1
                if last_error_message and idle_count > 75:  # 15s idle after error
                    sys.stderr.write(f"\nAntigravity Error: {last_error_message}\n")
                    sys.stderr.flush()
                    sys.exit(1)
                if idle_count > 1200:  # 4 minutes idle timeout
                    sys.stderr.write("\n[Agent timeout: 任务空闲超过 240s 无响应]\n")
                    sys.stderr.flush()
                    sys.exit(124)
                continue

            idle_count = 0
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except Exception:
                continue

            source = data.get("source")
            step_type = data.get("type")
            content = data.get("content") or ""
            tool_calls = data.get("tool_calls") or []

            # Filter out non-model steps and internal tool output dumps
            if step_type in ("USER_INPUT", "CHECKPOINT", "GENERIC", "SYSTEM_MESSAGE"):
                continue

            if step_type == "ERROR_MESSAGE":
                err_msg = data.get("error") or data.get("message") or data.get("content") or ""
                # Filter out transient API retry messages (e.g. attempt 1 failure) where Antigravity retries upstream
                is_transient = any(kw in err_msg.lower() for kw in (
                    "attempt 1", "attempt 2", "connection reset", "eof", "broken pipe",
                    "timeout", "handshake", "temporarily unavailable"
                ))
                if is_transient:
                    continue
                last_error_message = err_msg
                continue

            if source == "MODEL" and step_type == "PLANNER_RESPONSE":
                last_error_message = ""
                # Render tool action badges if any tools were invoked
                if tool_calls:
                    for tc in tool_calls:
                        tc_name = tc.get("name", "tool")
                        tc_args = tc.get("args") or {}
                        if isinstance(tc_args, str):
                            try:
                                tc_args = json.loads(tc_args)
                            except Exception:
                                tc_args = {}
                        action = tc_args.get("toolAction") or tc_args.get("toolSummary") or tc_name
                        if isinstance(action, str):
                            action = action.strip('"\'')
                        sys.stdout.write(f"\n⚡ [{action}]\n")
                        sys.stdout.flush()

                # Render assistant content
                if content and content.strip():
                    sys.stdout.write(content.strip() + "\n\n")
                    sys.stdout.flush()

                    if not tool_calls:
                        # Final response produced, turn completed!
                        completed = True
                        break

    if not completed:
        sys.exit(124)


if __name__ == "__main__":
    main()
''';

