import 'dart:math' as math;
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'package:path/path.dart' as p;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:file_picker/file_picker.dart';
import 'package:pasteboard/pasteboard.dart';
import '../../models/chat_attachment.dart';
import '../../core/api_client.dart';
import '../../core/storage.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/ask_conversation.dart';
import '../../models/ask_turn.dart';
import '../../models/device.dart';
import '../../state/ask_state.dart';
import '../../state/device_state.dart';
import '../widgets/execution_card.dart';
import '../widgets/glass_card.dart';
import '../widgets/thinking_block.dart';
import '../widgets/app_markdown.dart';
import '../../models/agent_artifact.dart';
import '../../state/update_state.dart';
import '../widgets/artifact_card.dart';
import '../widgets/artifacts_workspace.dart';

class AskScreen extends ConsumerStatefulWidget {
  const AskScreen({super.key});

  @override
  ConsumerState<AskScreen> createState() => _AskScreenState();
}

const Map<String, List<Map<String, String>>> kFallbackAgentModels = {
  'codex': [
    {'id': '', 'name': '⚡ 默认模型 (跟随客户端配置)'},
    {'id': 'gpt-6-astra', 'name': 'GPT-6-Astra (最新旗舰)'},
    {'id': 'gpt-reserve', 'name': 'GPT-Reserve (极速主力)'},
    {'id': 'gpt-5.6-sol', 'name': 'GPT-5.6-Sol (日常主力)'},
    {'id': 'gpt-5.6-terra', 'name': 'GPT-5.6-Terra (日常均衡)'},
    {'id': 'gpt-5.6-luna', 'name': 'GPT-5.6-Luna (轻量极速)'},
    {'id': 'gpt-5.5', 'name': 'GPT-5.5 (经典稳定)'},
    {'id': 'o3', 'name': 'o3 (深度思维)'},
    {'id': 'o4-mini', 'name': 'o4-mini (极速推理)'},
  ],
  'claude': [
    {'id': '', 'name': '⚡ 默认模型 (跟随客户端配置)'},
    {'id': 'sonnet', 'name': 'sonnet (官方动态最新 Sonnet 别名)'},
    {'id': 'opus', 'name': 'opus (官方动态最新 Opus 别名)'},
    {'id': 'fable', 'name': 'fable (官方动态最新 Fable 别名)'},
    {'id': 'opus[1m]', 'name': 'opus[1m] (100万上下文增强版)'},
    {'id': 'haiku', 'name': 'haiku (官方动态最新 Haiku 别名)'},
    {'id': 'claude-fable-5-1', 'name': 'claude-fable-5-1 (Claude Fable 5.1)'},
    {'id': 'claude-opus-5', 'name': 'claude-opus-5 (Claude Opus 5)'},
    {'id': 'claude-sonnet-5', 'name': 'claude-sonnet-5 (Claude Sonnet 5)'},
    {'id': 'claude-opus-4-8', 'name': 'claude-opus-4-8 (Claude Opus 4.8)'},
    {'id': 'claude-opus-4-6', 'name': 'claude-opus-4-6 (Claude Opus 4.6)'},
    {'id': 'claude-sonnet-4-6', 'name': 'claude-sonnet-4-6 (Claude Sonnet 4.6)'},
    {'id': 'claude-opus-4-5-20251101', 'name': 'claude-opus-4-5-20251101 (Claude Opus 4.5)'},
    {'id': 'claude-sonnet-4-5-20250929', 'name': 'claude-sonnet-4-5-20250929 (Claude Sonnet 4.5)'},
    {'id': 'claude-haiku-4-5-20251001', 'name': 'claude-haiku-4-5-20251001 (Claude Haiku 4.5)'},
    {'id': 'claude-opus-4-1-20250805', 'name': 'claude-opus-4-1-20250805 (Claude Opus 4.1)'},
    {'id': 'claude-3-7-sonnet-20250219', 'name': 'claude-3-7-sonnet-20250219 (Claude 3.7 Sonnet)'},
    {'id': 'claude-3-5-sonnet-20241022', 'name': 'claude-3-5-sonnet-20241022 (Claude 3.5 Sonnet)'},
    {'id': 'claude-3-5-haiku-20241022', 'name': 'claude-3-5-haiku-20241022 (Claude 3.5 Haiku)'},
  ],
  'antigravity': [
    {'id': '', 'name': '⚡ 默认模型 (系统配置: Gemini 3.8 Flash)'},
    {'id': 'gemini-3.8-flash', 'name': 'Gemini 3.8 Flash (High, Fast)'},
    {'id': 'gemini-3.7-flash', 'name': 'Gemini 3.7 Flash (Medium, Fast)'},
    {'id': 'gemini-3.6-flash', 'name': 'Gemini 3.6 Flash (Fast)'},
    {'id': 'gemini-3.1-pro', 'name': 'Gemini 3.1 Pro (深度推理)'},
    {'id': 'claude-sonnet-4-6', 'name': 'Claude Sonnet 4.6 (Thinking)'},
    {'id': 'claude-opus-4-6', 'name': 'Claude Opus 4.6 (Thinking)'},
    {'id': 'gpt-oss-120b', 'name': 'GPT-OSS 120B (Medium)'},
    {'id': 'flash', 'name': 'Gemini Flash (快速推荐)'},
    {'id': 'pro', 'name': 'Gemini Pro (强力推理)'},
    {'id': 'flash_lite', 'name': 'Gemini Flash-Lite'},
  ],
};

class _AskScreenState extends ConsumerState<AskScreen> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final _cwdController = TextEditingController();
  final _customModelController = TextEditingController();
  final _inputFocusNode = FocusNode();
  bool _showCwd = false;
  String _executionMode = 'ai';

  String? _selectedModel;
  String? _selectedEffort;
  Map<String, dynamic>? _agentCapabilities;
  bool _isCustomModel = false;
  List<Map<String, dynamic>> _projects = [];
  String? _selectedProjectId;
  List<Map<String, dynamic>> _sessions = [];
  String? _selectedSessionId;
  bool _loadingSessions = false;
  bool _showSessionContext = true;
  bool _isConfigCollapsed = true;
  bool _compactMode = false;
  int? _selectedTimeoutSeconds;
  bool _isUserScrolledUp = false;
  bool _isAutoScrolling = false;
  bool _isWorkspaceRestored = false;

  // Artifacts Workspace State
  bool _isWorkspaceOpen = false;
  AgentArtifact? _selectedWorkspaceArtifact;

  // Chat Attachments (Images, Screenshots, Code/Text files)
  final List<ChatAttachment> _attachedFiles = [];

  String? _findTurnDeviceId(AskTurn turn) {
    for (final call in turn.toolCalls.reversed) {
      final resDev = call.result?.deviceId;
      if (resDev != null && resDev.isNotEmpty && resDev != 'auto') return resDev;
      final argDev = call.args['device_id']?.toString();
      if (argDev != null && argDev.isNotEmpty && argDev != 'auto') return argDev;
    }
    final currentDev = ref.read(deviceProvider).selectedDeviceId;
    if (currentDev != 'auto' && currentDev != 'ask_only') return currentDev;
    return null;
  }

  List<AgentArtifact> _collectAllArtifacts(List<AskTurn> turns) {
    // 1. Discover the most relevant execution device across the entire conversation
    String? conversationDeviceId;
    for (final turn in turns.reversed) {
      final dev = _findTurnDeviceId(turn);
      if (dev != null && dev.isNotEmpty && dev != 'auto') {
        conversationDeviceId = dev;
        break;
      }
    }
    if (conversationDeviceId == null || conversationDeviceId.isEmpty) {
      final currentDev = ref.read(deviceProvider).selectedDeviceId;
      if (currentDev != 'auto' && currentDev != 'ask_only') {
        conversationDeviceId = currentDev;
      }
    }

    final List<AgentArtifact> list = [];
    final Set<String> seenPaths = {};
    for (final turn in turns) {
      if (turn.content.isNotEmpty) {
        final devId = _findTurnDeviceId(turn) ?? conversationDeviceId;
        final arts = AgentArtifact.extractArtifacts(turn.content, defaultDeviceId: devId);
        for (final a in arts) {
          if (!seenPaths.contains(a.rawPath)) {
            seenPaths.add(a.rawPath);
            list.add(a);
          }
        }
      }
    }
    return list;
  }

  void _openArtifactWorkspace(AgentArtifact artifact, List<AgentArtifact> allArtifacts) {
    setState(() {
      _selectedWorkspaceArtifact = artifact;
      _isWorkspaceOpen = true;
    });

    final width = MediaQuery.of(context).size.width;
    if (width < 900) {
      showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (ctx) => DraggableScrollableSheet(
          initialChildSize: 0.88,
          minChildSize: 0.5,
          maxChildSize: 0.96,
          builder: (ctx, scrollController) => ClipRRect(
            borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
            child: ArtifactsWorkspace(
              artifacts: allArtifacts,
              initialSelected: artifact,
              onClose: () => Navigator.of(ctx).pop(),
            ),
          ),
        ),
      );
    }
  }

  void _handleModeChange(String id) {
    setState(() {
      _executionMode = id;
      if (id != 'ai') {
        final dev = ref.read(deviceProvider);
        if (dev.selectedDeviceId == 'ask_only') {
          ref.read(deviceProvider.notifier).setSelectedDevice('auto');
        }
      }
      _selectedModel = null;
      _selectedEffort = null;
      _agentCapabilities = null;
      _isCustomModel = false;
      _customModelController.clear();
      _selectedProjectId = null;
      _selectedSessionId = null;
      _compactMode = false;
      _sessions = [];
      _projects = [];
    });
    AppStorage.setLastExecutionMode(id);
    AppStorage.setLastProjectId(null);
    AppStorage.setLastSessionId(null);
    AppStorage.setLastModel(null);
    AppStorage.setLastIsCustomModel(false);
    AppStorage.setLastEffort(null);
    if (['codex', 'claude', 'antigravity'].contains(id)) {
      _loadProjectsForMode(id);
      _loadCapabilitiesForMode(id);
    }
  }

  Future<void> _loadCapabilitiesForMode(String mode, {String? deviceId}) async {
    try {
      final dev = ref.read(deviceProvider);
      final devId = deviceId ?? dev.selectedDeviceId;
      final caps = await ApiClient().getAgentCapabilities(mode, deviceId: devId);
      if (mounted && _executionMode == mode) {
        setState(() {
          _agentCapabilities = caps;
        });
      }
    } catch (_) {}
  }

  Future<List<Map<String, dynamic>>> _loadProjectsForMode(String mode, {String? deviceId}) async {
    try {
      final toolId = mode == 'antigravity'
          ? 'antigravity'
          : (mode == 'claude' ? 'claude_code' : (mode == 'codex' ? 'codex' : null));
      final dev = ref.read(deviceProvider);
      final devId = deviceId ?? dev.selectedDeviceId;
      final projs = await ApiClient().getProjects(
        toolId: toolId,
        deviceId: devId,
      );
      if (mounted && _executionMode == mode) {
        setState(() {
          _projects = projs;
        });
      }
      return projs;
    } catch (e) {
      debugPrint('Failed to load projects: $e');
      return [];
    }
  }

  Future<void> _handleDeviceChange(String? newDevId) async {
    if (newDevId == null) return;
    ref.read(deviceProvider.notifier).setSelectedDevice(newDevId);

    // 1. Reload agent capabilities for this new device
    _loadCapabilitiesForMode(_executionMode, deviceId: newDevId);

    // 2. Reload projects for this new device
    final toolId = _executionMode == 'antigravity'
        ? 'antigravity'
        : (_executionMode == 'claude' ? 'claude_code' : (_executionMode == 'codex' ? 'codex' : null));
    try {
      final projs = await ApiClient().getProjects(
        toolId: toolId,
        deviceId: newDevId,
      );
      if (!mounted) return;

      setState(() {
        _projects = projs;
      });

      // 3. If a project was already selected, smartly realign its CWD on the new device
      if (_selectedProjectId != null && _selectedProjectId!.isNotEmpty) {
        final currentProj = projs.firstWhere(
          (p) => p['id']?.toString() == _selectedProjectId,
          orElse: () => {},
        );
        if (currentProj.isNotEmpty) {
          final sourcePath = currentProj['source_path']?.toString();
          if (sourcePath != null && sourcePath.isNotEmpty) {
            String clean = sourcePath.trim();
            final match = RegExp(r'((?:[a-zA-Z]:[/\\]|/)[a-zA-Z0-9_\.-]+(?:[/\\][a-zA-Z0-9_\.-]+)*)').firstMatch(clean);
            if (match != null) {
              clean = match.group(1)!.replaceAll(RegExp(r'[/\\]+$'), '');
            } else {
              clean = clean.split(RegExp(r'[\r\n",]'))[0].trim().replaceAll(RegExp(r'[/\\]+$'), '');
            }
            _cwdController.text = clean;
            _showCwd = true;
            AppStorage.setLastCwd(clean);
          }
        } else {
          _cwdController.clear();
          AppStorage.setLastCwd(null);
        }
        // Re-fetch sessions strictly for the newly selected device
        _handleProjectChange(_selectedProjectId);
      }
    } catch (e) {
      debugPrint('Failed to realign projects on device change: $e');
    }
  }

  Future<void> _handleProjectChange(String? projId, {String? restoreSessionId}) async {
    setState(() {
      _selectedProjectId = projId;
      _selectedSessionId = restoreSessionId ?? (projId == null ? null : _selectedSessionId);
      _sessions = [];
      _loadingSessions = projId != null && projId.isNotEmpty;
    });
    AppStorage.setLastExecutionMode(_executionMode);
    AppStorage.setLastProjectId(projId);
    if (restoreSessionId != null) {
      AppStorage.setLastSessionId(restoreSessionId);
    } else if (projId == null) {
      AppStorage.setLastSessionId(null);
    }

    if (projId == null || projId.isEmpty) {
      ref.read(askProvider.notifier).newChat();
      return;
    }

    final proj = _projects.firstWhere(
      (p) => p['id']?.toString() == projId,
      orElse: () => {},
    );
    final sourcePath = proj['source_path']?.toString();
    if (sourcePath != null && sourcePath.isNotEmpty) {
      if (_cwdController.text.trim().isEmpty) {
        String clean = sourcePath.trim();
        final match = RegExp(r'((?:[a-zA-Z]:[/\\]|/)[a-zA-Z0-9_\.-]+(?:[/\\][a-zA-Z0-9_\.-]+)*)').firstMatch(clean);
        if (match != null) {
          clean = match.group(1)!.replaceAll(RegExp(r'[/\\]+$'), '');
        } else {
          clean = clean.split(RegExp(r'[\r\n",]'))[0].trim().replaceAll(RegExp(r'[/\\]+$'), '');
        }
        _cwdController.text = clean;
        _showCwd = true;
        AppStorage.setLastCwd(clean);
      }
    }

    try {
      final dev = ref.read(deviceProvider);
      var res = await ApiClient().getProjectConversations(
        projId,
        maxMessagesPerSession: 5,
        deviceId: dev.selectedDeviceId,
      );
      var rawList = res['sessions'] as List<dynamic>? ?? [];

      if (mounted && _selectedProjectId == projId) {
        final sessionsList = rawList.cast<Map<String, dynamic>>();
        setState(() {
          _sessions = sessionsList;
          _loadingSessions = false;
        });

        if (restoreSessionId != null && restoreSessionId.isNotEmpty) {
          await _handleSelectSession(restoreSessionId);
        }
      }
    } catch (e) {
      debugPrint('Failed to load project sessions: $e');
      if (mounted) {
        setState(() => _loadingSessions = false);
      }
    }
  }

  Future<void> _handleSelectSession(String? sid) async {
    AppStorage.setLastExecutionMode(_executionMode);
    AppStorage.setLastSessionId(sid);
    if (sid == null || sid.isEmpty) {
      setState(() {
        _selectedSessionId = null;
        _compactMode = false;
      });
      ref.read(askProvider.notifier).newChat();
      return;
    }
    final targetSession = _sessions.firstWhere(
      (s) => (s['session_id'] ?? s['conversation_id'])?.toString() == sid,
      orElse: () => <String, dynamic>{},
    );

    final count = (targetSession['message_count'] as num?)?.toInt() ?? 0;
    final bytes = (targetSession['file_size_bytes'] as num?)?.toInt() ?? 0;
    final compactRecommended = targetSession['compact_recommended'] == true;
    final isHeavy = compactRecommended || bytes > 300000 || count > 35;

    setState(() {
      _selectedSessionId = sid;
      _compactMode = isHeavy;
    });

    List<AskTurn> turns = [];
    if (!Platform.isAndroid && !Platform.isIOS) {
      turns = await _tryLoadLocalSessionTurns(sid);
    }

    if (turns.isEmpty) {
      List<dynamic> rawMsgs = (targetSession['messages'] as List<dynamic>?) ?? [];
      final docId = targetSession['conversation_id']?.toString() ?? sid;
      if (docId.isNotEmpty) {
        try {
          final firstPage = await ApiClient().getConversationMessages(docId, limit: 100, offset: 0);
          final total = (firstPage['total'] as num?)?.toInt() ?? 0;
          if (total > 100) {
            final tailOffset = (total - 100).clamp(0, total);
            final tailPage = await ApiClient().getConversationMessages(docId, limit: 100, offset: tailOffset);
            final tailMsgs = tailPage['messages'] as List<dynamic>?;
            if (tailMsgs != null && tailMsgs.isNotEmpty) {
              rawMsgs = tailMsgs;
            }
          } else {
            final firstMsgs = firstPage['messages'] as List<dynamic>?;
            if (firstMsgs != null && firstMsgs.isNotEmpty) {
              rawMsgs = firstMsgs;
            }
          }
        } catch (e) {
          debugPrint('Failed to load full conversation messages: $e');
        }
      }

      turns = rawMsgs
          .whereType<Map<String, dynamic>>()
          .where((m) => m['role'] == 'user' || m['role'] == 'assistant')
          .map((m) => AskTurn(
                role: m['role']?.toString() ?? 'user',
                content: m['content']?.toString() ?? '',
                thinking: m['thinking']?.toString(),
              ))
          .toList();
    }

    final title = targetSession['title']?.toString();
    ref.read(askProvider.notifier).setSessionTurns(turns, title: title);
    _scrollToBottom(force: true, smooth: true);
  }

  Future<List<AskTurn>> _tryLoadLocalSessionTurns(String sid) async {
    try {
      final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '';
      if (home.isEmpty) return [];

      File? targetFile;
      if (_executionMode == 'antigravity') {
        final f = File(p.join(home, '.gemini', 'antigravity', 'brain', sid, '.system_generated', 'logs', 'transcript.jsonl'));
        if (await f.exists()) targetFile = f;
      } else if (_executionMode == 'claude') {
        final claudeDir = Directory(p.join(home, '.claude', 'projects'));
        if (await claudeDir.exists()) {
          await for (final entity in claudeDir.list()) {
            if (entity is Directory) {
              final cand = File(p.join(entity.path, '$sid.jsonl'));
              if (await cand.exists()) {
                targetFile = cand;
                break;
              }
            }
          }
        }
      } else if (_executionMode == 'codex') {
        final sessDir = Directory(p.join(home, '.codex', 'sessions'));
        if (await sessDir.exists()) {
          await for (final entity in sessDir.list(recursive: true)) {
            if (entity is File && entity.path.endsWith('$sid.jsonl')) {
              targetFile = entity;
              break;
            }
          }
        }
      }

      if (targetFile == null || !await targetFile.exists()) return [];

      final rawTurns = await Isolate.run(
        () => _parseLocalSessionTurnsInIsolate(
          _LocalSessionParseArgs(targetFile!.path, _executionMode),
        ),
      );

      return rawTurns
          .map((m) => AskTurn(
                role: m['role'] ?? 'user',
                content: m['content'] ?? '',
                thinking: m['thinking'],
              ))
          .toList();
    } catch (e) {
      debugPrint('Error reading local session turns in isolate: $e');
      return [];
    }
  }

  String _getHintText() {
    if (_attachedFiles.isNotEmpty) {
      return '输入关于附件的问题，或直接点击发送分析附件...';
    }
    switch (_executionMode) {
      case 'claude':
        return '向 Claude Code 派发编码任务...';
      case 'codex':
        return '向 OpenAI Codex 派发任务...';
      case 'antigravity':
        return '向 Antigravity 派发任务...';
      case 'shell':
        return '在电脑上执行 Shell 命令...';
      case 'ai':
      default:
        return '向电脑下发命令或提问...';
    }
  }

  Widget _buildAgentSelector() {
    final modes = [
      {'id': 'ai', 'label': 'AI 编排', 'icon': Icons.psychology_rounded, 'color': AuroraColors.accent},
      {'id': 'claude', 'label': 'Claude Code', 'icon': Icons.auto_awesome, 'color': const Color(0xFFE5855E)},
      {'id': 'codex', 'label': 'Codex', 'icon': Icons.code_rounded, 'color': const Color(0xFF10A37F)},
      {'id': 'antigravity', 'label': 'Antigravity', 'icon': Icons.rocket_launch_rounded, 'color': const Color(0xFF9D67EF)},
      {'id': 'shell', 'label': 'Shell', 'icon': Icons.terminal_rounded, 'color': const Color(0xFF38BDF8)},
    ];

    return SizedBox(
      height: 28,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: modes.length,
        separatorBuilder: (_, __) => const SizedBox(width: 6),
        itemBuilder: (context, index) {
          final m = modes[index];
          final id = m['id'] as String;
          final isSelected = _executionMode == id;
          final color = m['color'] as Color;

          return InkWell(
            onTap: () => _handleModeChange(id),
            borderRadius: BorderRadius.circular(14),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: isSelected ? color.withOpacity(0.18) : AuroraColors.chip,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: isSelected ? color.withOpacity(0.8) : AuroraColors.border,
                  width: isSelected ? 1.2 : 1.0,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    m['icon'] as IconData,
                    size: 13,
                    color: isSelected ? color : AuroraColors.fg3,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    m['label'] as String,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: isSelected ? FontWeight.w700 : FontWeight.normal,
                      color: isSelected ? color : AuroraColors.fg2,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    _inputFocusNode.onKeyEvent = _handleKeyEvent;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(deviceProvider.notifier).loadDevices();
      _restoreLastWorkspaceState();
      // Auto-raise keyboard when entering first screen (Desktop only)
      if (!Platform.isIOS && !Platform.isAndroid) {
        Future.delayed(const Duration(milliseconds: 300), () {
          if (mounted) {
            _inputFocusNode.requestFocus();
          }
        });
      }
    });
  }

  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) {
      return KeyEventResult.ignored;
    }

    final key = event.logicalKey;

    // 快捷键检测：Ctrl+V (Windows/Linux) 或 Cmd+V (macOS) 检查并粘贴剪贴板截图
    final isControl = HardwareKeyboard.instance.isControlPressed;
    final isMeta = HardwareKeyboard.instance.isMetaPressed;
    if ((isControl || isMeta) && key == LogicalKeyboardKey.keyV) {
      _tryPasteImageFromClipboard();
      // 不返回 handled，让系统同时尝试文本粘贴；若剪贴板仅为图像，TextField 不会产生文字
      return KeyEventResult.ignored;
    }

    if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter) {
      // 1. 若正在使用拼音等输入法（处于选词上屏 Composing 状态），不拦截回车，避免误触发送
      final isComposing = _inputController.value.composing.isValid &&
          !_inputController.value.composing.isCollapsed;
      if (isComposing) {
        return KeyEventResult.ignored;
      }

      // 2. 检查修饰键：Shift+Enter 或 Alt+Enter 视为换行
      final isShift = HardwareKeyboard.instance.isShiftPressed;
      final isAlt = HardwareKeyboard.instance.isAltPressed;
      if (isShift || isAlt) {
        _insertNewline();
        return KeyEventResult.handled;
      }

      // 3. 单独按 Enter，或 Ctrl+Enter / Meta(Cmd)+Enter：发送消息
      if (ref.read(askProvider).isStreaming) {
        return KeyEventResult.handled;
      }

      _handleSend();
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  void _insertNewline() {
    final text = _inputController.text;
    final selection = _inputController.selection;
    if (selection.isValid && selection.start >= 0 && selection.end >= 0) {
      final newText = text.replaceRange(selection.start, selection.end, '\n');
      _inputController.value = TextEditingValue(
        text: newText,
        selection: TextSelection.collapsed(offset: selection.start + 1),
      );
    } else {
      final newText = '$text\n';
      _inputController.value = TextEditingValue(
        text: newText,
        selection: TextSelection.collapsed(offset: newText.length),
      );
    }
  }

  // 附件操作：拍照、相册选图、文件/代码选取、剪贴板截图
  Future<void> _pickFromCamera() async {
    try {
      final picker = ImagePicker();
      final photo = await picker.pickImage(
        source: ImageSource.camera,
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
      );
      if (photo != null) {
        final file = File(photo.path);
        final att = await ChatAttachment.fromFile(file, isImageOverride: true);
        if (mounted) {
          setState(() {
            _attachedFiles.add(att);
          });
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('拍照失败: $e'), backgroundColor: AuroraColors.danger),
        );
      }
    }
  }

  Future<void> _pickFromGallery() async {
    try {
      final picker = ImagePicker();
      final images = await picker.pickMultiImage(
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
      );
      if (images.isNotEmpty) {
        for (final img in images) {
          final att = await ChatAttachment.fromFile(File(img.path), isImageOverride: true);
          if (mounted) {
            setState(() {
              _attachedFiles.add(att);
            });
          }
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('选择图片失败: $e'), backgroundColor: AuroraColors.danger),
        );
      }
    }
  }

  Future<void> _pickFiles() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        allowMultiple: true,
        withData: true,
      );
      if (result != null && result.files.isNotEmpty) {
        for (final f in result.files) {
          ChatAttachment? att;
          if (f.path != null) {
            att = await ChatAttachment.fromFile(File(f.path!));
          } else if (f.bytes != null) {
            final isImg = const ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
                .any((ext) => f.name.toLowerCase().endsWith(ext));
            att = ChatAttachment(
              id: 'att_${DateTime.now().millisecondsSinceEpoch}_${f.name.hashCode}',
              name: f.name,
              type: isImg ? AttachmentType.image : AttachmentType.file,
              size: f.size,
              bytes: f.bytes,
              mimeType: isImg ? null : 'application/octet-stream',
            );
          }
          if (att != null && mounted) {
            setState(() {
              _attachedFiles.add(att!);
            });
          }
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('选择文件失败: $e'), backgroundColor: AuroraColors.danger),
        );
      }
    }
  }

  Future<bool> _tryPasteImageFromClipboard() async {
    try {
      final imageBytes = await Pasteboard.image;
      if (imageBytes != null && imageBytes.isNotEmpty) {
        final att = ChatAttachment.fromImageBytes(imageBytes);
        if (mounted) {
          setState(() {
            _attachedFiles.add(att);
          });
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('已从剪贴板添加截图附件'),
              duration: Duration(seconds: 1),
            ),
          );
        }
        return true;
      }
    } catch (e) {
      debugPrint('读取剪贴板图片错误: $e');
    }
    return false;
  }

  void _showMobileAttachmentSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AuroraColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 8),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: AuroraColors.border,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: AuroraColors.chip,
                    child: Icon(Icons.camera_alt_rounded, color: AuroraColors.accent),
                  ),
                  title: const Text('拍照', style: TextStyle(color: AuroraColors.fg1, fontWeight: FontWeight.w500)),
                  subtitle: const Text('使用系统相机拍摄照片', style: TextStyle(color: AuroraColors.fg3, fontSize: 12)),
                  onTap: () {
                    Navigator.pop(ctx);
                    _pickFromCamera();
                  },
                ),
                ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: AuroraColors.chip,
                    child: Icon(Icons.photo_library_rounded, color: AuroraColors.accent),
                  ),
                  title: const Text('从相册选择', style: TextStyle(color: AuroraColors.fg1, fontWeight: FontWeight.w500)),
                  subtitle: const Text('支持选择单张或多张图片', style: TextStyle(color: AuroraColors.fg3, fontSize: 12)),
                  onTap: () {
                    Navigator.pop(ctx);
                    _pickFromGallery();
                  },
                ),
                ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: AuroraColors.chip,
                    child: Icon(Icons.folder_open_rounded, color: AuroraColors.accent),
                  ),
                  title: const Text('浏览文件 / 代码', style: TextStyle(color: AuroraColors.fg1, fontWeight: FontWeight.w500)),
                  subtitle: const Text('选取本地文档、日志、代码文件等', style: TextStyle(color: AuroraColors.fg3, fontSize: 12)),
                  onTap: () {
                    Navigator.pop(ctx);
                    _pickFiles();
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _showImagePreviewDialog(BuildContext context, {String? imageSource, Uint8List? imageBytes}) {
    showDialog(
      context: context,
      barrierColor: Colors.black87,
      builder: (ctx) {
        Widget content;
        if (imageBytes != null) {
          content = Image.memory(imageBytes, fit: BoxFit.contain);
        } else if (imageSource != null) {
          if (imageSource.startsWith('data:image/')) {
            try {
              final b64 = imageSource.split(',').last;
              content = Image.memory(base64Decode(b64), fit: BoxFit.contain);
            } catch (_) {
              content = const Center(child: Text('无法解析图片数据', style: TextStyle(color: Colors.white)));
            }
          } else if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
            content = Image.network(imageSource, fit: BoxFit.contain);
          } else {
            final f = File(imageSource);
            if (f.existsSync()) {
              content = Image.file(f, fit: BoxFit.contain);
            } else {
              content = const Center(child: Text('图片文件不存在', style: TextStyle(color: Colors.white)));
            }
          }
        } else {
          content = const SizedBox.shrink();
        }

        return Dialog(
          backgroundColor: Colors.transparent,
          insetPadding: const EdgeInsets.all(12),
          child: Stack(
            alignment: Alignment.center,
            children: [
              InteractiveViewer(
                minScale: 0.5,
                maxScale: 4.0,
                child: Center(child: content),
              ),
              Positioned(
                top: 10,
                right: 10,
                child: IconButton(
                  onPressed: () => Navigator.of(ctx).pop(),
                  style: IconButton.styleFrom(backgroundColor: Colors.black54),
                  icon: const Icon(Icons.close, color: Colors.white, size: 20),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  static String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  Future<void> _restoreLastWorkspaceState() async {
    final askState = ref.read(askProvider);
    if (askState.turns.isNotEmpty || askState.activeConversationId != null) {
      _isWorkspaceRestored = true;
      return;
    }

    try {
      final savedMode = await AppStorage.getLastExecutionMode();
      final savedProjectId = await AppStorage.getLastProjectId();
      final savedSessionId = await AppStorage.getLastSessionId();
      final savedModel = await AppStorage.getLastModel();
      final savedIsCustom = await AppStorage.getLastIsCustomModel() ?? false;
      final savedEffort = await AppStorage.getLastEffort();
      final savedTimeout = await AppStorage.getLastTimeoutSeconds();
      final savedCwd = await AppStorage.getLastCwd();
      final savedAskConvId = await AppStorage.getLastAskConversationId();
      final savedDeviceId = await AppStorage.getLastDeviceId();

      if (!mounted) return;

      if (savedDeviceId != null && savedDeviceId.isNotEmpty) {
        ref.read(deviceProvider.notifier).setSelectedDevice(savedDeviceId);
      }

      // If savedMode is missing/ai but a project was saved, infer that the user was in an agent mode (defaulting to claude)
      String mode = (savedMode != null && savedMode.isNotEmpty) ? savedMode : 'ai';
      if ((savedMode == null || savedMode == 'ai') && savedProjectId != null && savedProjectId.isNotEmpty) {
        mode = 'claude';
      }

      setState(() {
        _executionMode = mode;
        if (savedModel != null && savedModel.isNotEmpty) {
          _selectedModel = savedModel;
          _isCustomModel = savedIsCustom;
          if (savedIsCustom) {
            _customModelController.text = savedModel;
          }
        }
        if (savedEffort != null && savedEffort.isNotEmpty) {
          _selectedEffort = savedEffort;
        }
        if (savedTimeout != null && savedTimeout > 0) {
          _selectedTimeoutSeconds = savedTimeout;
        }
        if (savedCwd != null && savedCwd.isNotEmpty) {
          _cwdController.text = savedCwd;
          _showCwd = true;
        }
        if (savedProjectId != null && savedProjectId.isNotEmpty) {
          _selectedProjectId = savedProjectId;
        }
        if (savedSessionId != null && savedSessionId.isNotEmpty) {
          _selectedSessionId = savedSessionId;
        }
      });

      if (['codex', 'claude', 'antigravity'].contains(mode)) {
        await _loadCapabilitiesForMode(mode);
        final projs = await _loadProjectsForMode(mode);
        if (!mounted) return;

        // If the project tool_id can be inferred from loaded projects, align mode
        if (savedProjectId != null && savedProjectId.isNotEmpty) {
          final matchedProj = projs.firstWhere(
            (p) => p['id']?.toString() == savedProjectId,
            orElse: () => {},
          );
          if (matchedProj.isNotEmpty) {
            final tId = matchedProj['tool_id']?.toString();
            if (tId == 'claude_code' && mode != 'claude') {
              mode = 'claude';
              setState(() => _executionMode = 'claude');
              AppStorage.setLastExecutionMode('claude');
            } else if (tId == 'codex' && mode != 'codex') {
              mode = 'codex';
              setState(() => _executionMode = 'codex');
              AppStorage.setLastExecutionMode('codex');
            } else if (tId == 'antigravity' && mode != 'antigravity') {
              mode = 'antigravity';
              setState(() => _executionMode = 'antigravity');
              AppStorage.setLastExecutionMode('antigravity');
            }
          }

          // Unconditionally load project sessions and restore session
          await _handleProjectChange(savedProjectId, restoreSessionId: savedSessionId);
        }
      } else {
        // AI / Shell mode: restore last conversation
        if (savedAskConvId != null && savedAskConvId.isNotEmpty) {
          try {
            await ref.read(askProvider.notifier).loadConversation(
              savedAskConvId,
              onMetaLoaded: (deviceId, cwd) {
                if (deviceId != null && deviceId.isNotEmpty) {
                  ref.read(deviceProvider.notifier).setSelectedDevice(deviceId);
                }
                if (cwd != null && cwd.isNotEmpty) {
                  setState(() {
                    _cwdController.text = cwd;
                    _showCwd = true;
                  });
                }
                _scrollToBottom(force: true, smooth: true);
              },
            );
          } catch (_) {
            _checkAutoRestoreLastConversation();
          }
        } else {
          _checkAutoRestoreLastConversation();
        }
      }
    } catch (e) {
      debugPrint('Error restoring workspace state: $e');
      _checkAutoRestoreLastConversation();
    } finally {
      if (mounted) {
        _isWorkspaceRestored = true;
      }
    }
  }

  void _checkAutoRestoreLastConversation() async {
    final askState = ref.read(askProvider);
    if (askState.turns.isNotEmpty || askState.activeConversationId != null) return;
    try {
      final list = await ApiClient().getAskConversations();
      if (list.isNotEmpty && mounted) {
        final last = list.first;
        ref.read(askProvider.notifier).loadConversation(
          last.id,
          onMetaLoaded: (deviceId, cwd) {
            if (deviceId != null && deviceId.isNotEmpty) {
              ref.read(deviceProvider.notifier).setSelectedDevice(deviceId);
            }
            if (cwd != null && cwd.isNotEmpty) {
              setState(() {
                _cwdController.text = cwd;
                _showCwd = true;
              });
            }
            _scrollToBottom(force: true, smooth: true);
          },
        );
      }
    } catch (_) {}
  }

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    _cwdController.dispose();
    _customModelController.dispose();
    _inputFocusNode.dispose();
    super.dispose();
  }

  void _scrollToBottom({bool force = false, bool smooth = false}) {
    if (force) {
      _isUserScrolledUp = false;
    }
    // 如果用户主动向上滚动查看历史，且非强制，则不抢夺滚动位置
    if (_isUserScrolledUp && !force) {
      return;
    }

    void doScroll() {
      if (!_scrollController.hasClients) return;
      final position = _scrollController.position;
      final target = position.maxScrollExtent;
      if (target <= 0) return;

      if (!smooth) {
        // 高频流式输出：直接对齐到底部，避免动画堆叠和打断卡死
        _scrollController.jumpTo(target);
      } else {
        if (_isAutoScrolling) {
          _scrollController.jumpTo(target);
          return;
        }
        _isAutoScrolling = true;
        _scrollController
            .animateTo(
          target,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
        )
            .then((_) {
          _isAutoScrolling = false;
          if (_scrollController.hasClients && !_isUserScrolledUp) {
            final newMax = _scrollController.position.maxScrollExtent;
            if (newMax > target) {
              _scrollController.jumpTo(newMax);
            }
          }
        }).catchError((_) {
          _isAutoScrolling = false;
        });
      }
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      doScroll();
      // 对于复杂布局/Markdown/富文本异步排版，如果强制滚动，做二次轻微延迟重测
      if (force) {
        Future.delayed(const Duration(milliseconds: 60), () {
          if (mounted && !_isUserScrolledUp) {
            doScroll();
          }
        });
        Future.delayed(const Duration(milliseconds: 200), () {
          if (mounted && !_isUserScrolledUp) {
            doScroll();
          }
        });
      }
    });
  }

  void _showHistoryModal(BuildContext context) {
    final devState = ref.read(deviceProvider);
    final hasSpecificDevice = devState.selectedDeviceId != 'auto' &&
        devState.selectedDeviceId != 'ask_only' &&
        devState.selectedDeviceId.isNotEmpty;
    bool filterCurrentDevice = hasSpecificDevice;
    final targetDevice = devState.devices.firstWhere(
      (d) => d.deviceId == devState.selectedDeviceId,
      orElse: () => Device(deviceId: '', name: '当前设备'),
    );
    final targetDeviceName = targetDevice.name;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AuroraColors.surfaceElevated,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return DraggableScrollableSheet(
              initialChildSize: 0.75,
              minChildSize: 0.4,
              maxChildSize: 0.92,
              expand: false,
              builder: (context, scrollController) {
                return Column(
                  children: [
                    // Handle bar
                    const SizedBox(height: 10),
                    Center(
                      child: Container(
                        width: 36,
                        height: 4,
                        decoration: BoxDecoration(
                          color: AuroraColors.fg4.withOpacity(0.5),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),

                    // Header Row
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 18),
                      child: Row(
                        children: [
                          const Icon(Icons.history_rounded, size: 20, color: AuroraColors.accent),
                          const SizedBox(width: 8),
                          const Text(
                            '历史对话',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                              color: AuroraColors.fg1,
                            ),
                          ),
                          const Spacer(),
                          TextButton.icon(
                            onPressed: () {
                              Navigator.pop(sheetContext);
                              ref.read(askProvider.notifier).newChat();
                            },
                            style: TextButton.styleFrom(
                              foregroundColor: AuroraColors.accent,
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                              backgroundColor: AuroraColors.accentSoft,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                            ),
                            icon: const Icon(Icons.add, size: 16),
                            label: const Text('新建对话', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                          ),
                        ],
                      ),
                    ),
                    if (hasSpecificDevice) ...[
                      const SizedBox(height: 8),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 18),
                        child: Row(
                          children: [
                            InkWell(
                              onTap: () => setModalState(() => filterCurrentDevice = true),
                              borderRadius: BorderRadius.circular(12),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                decoration: BoxDecoration(
                                  color: filterCurrentDevice ? AuroraColors.accentSoft : AuroraColors.chip,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: filterCurrentDevice ? AuroraColors.accent : AuroraColors.border,
                                  ),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Icon(Icons.devices, size: 12, color: AuroraColors.accent),
                                    const SizedBox(width: 4),
                                    Text(
                                      '当前设备: $targetDeviceName',
                                      style: TextStyle(
                                        fontSize: 11,
                                        fontWeight: filterCurrentDevice ? FontWeight.w600 : FontWeight.normal,
                                        color: filterCurrentDevice ? AuroraColors.accent : AuroraColors.fg2,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            InkWell(
                              onTap: () => setModalState(() => filterCurrentDevice = false),
                              borderRadius: BorderRadius.circular(12),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                decoration: BoxDecoration(
                                  color: !filterCurrentDevice ? AuroraColors.accentSoft : AuroraColors.chip,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: !filterCurrentDevice ? AuroraColors.accent : AuroraColors.border,
                                  ),
                                ),
                                child: Text(
                                  '全部设备',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: !filterCurrentDevice ? FontWeight.w600 : FontWeight.normal,
                                    color: !filterCurrentDevice ? AuroraColors.accent : AuroraColors.fg2,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 8),
                    const Divider(color: AuroraColors.border, height: 1),

                    // List
                    Expanded(
                      child: FutureBuilder<List<AskConversationSummary>>(
                        future: ApiClient().getAskConversations(
                          deviceId: filterCurrentDevice ? devState.selectedDeviceId : null,
                        ),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState == ConnectionState.waiting) {
                            return const Center(
                              child: CircularProgressIndicator(strokeWidth: 2, color: AuroraColors.accent),
                            );
                          }
                          if (snapshot.hasError) {
                            return Center(
                              child: Text(
                                '加载历史记录失败: ${snapshot.error}',
                                style: const TextStyle(color: AuroraColors.danger, fontSize: 13),
                              ),
                            );
                          }
                          final list = snapshot.data ?? [];
                          if (list.isEmpty) {
                            return const Center(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.chat_bubble_outline, size: 40, color: AuroraColors.fg4),
                                  SizedBox(height: 12),
                                  Text(
                                    '暂无历史对话',
                                    style: TextStyle(fontSize: 14, color: AuroraColors.fg2, fontWeight: FontWeight.bold),
                                  ),
                                  SizedBox(height: 6),
                                  Text(
                                    '向 AI 发送提问后，对话将自动在此归档',
                                    style: TextStyle(fontSize: 12, color: AuroraColors.fg3),
                                  ),
                                ],
                              ),
                            );
                          }

                          final currentId = ref.read(askProvider).activeConversationId;

                          return ListView.separated(
                            controller: scrollController,
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                            itemCount: list.length,
                            separatorBuilder: (_, __) => const SizedBox(height: 8),
                            itemBuilder: (context, idx) {
                              final item = list[idx];
                              final isCurrent = item.id == currentId;

                              return InkWell(
                                onTap: () {
                                  Navigator.pop(sheetContext);
                                  ref.read(askProvider.notifier).loadConversation(
                                    item.id,
                                    onMetaLoaded: (devId, cwd) {
                                      if (devId != null && devId.isNotEmpty) {
                                        ref.read(deviceProvider.notifier).setSelectedDevice(devId);
                                      }
                                      if (cwd != null && cwd.isNotEmpty) {
                                        setState(() {
                                          _cwdController.text = cwd;
                                          _showCwd = true;
                                        });
                                      }
                                      _scrollToBottom(force: true, smooth: true);
                                    },
                                  );
                                },
                                borderRadius: BorderRadius.circular(12),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                                  decoration: BoxDecoration(
                                    color: isCurrent ? AuroraColors.accentSoft.withOpacity(0.2) : AuroraColors.chip,
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: isCurrent ? AuroraColors.accent.withOpacity(0.5) : AuroraColors.border,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(
                                        isCurrent ? Icons.chat_bubble : Icons.chat_bubble_outline,
                                        size: 18,
                                        color: isCurrent ? AuroraColors.accent : AuroraColors.fg3,
                                      ),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Row(
                                              children: [
                                                Expanded(
                                                  child: Text(
                                                    item.title,
                                                    maxLines: 1,
                                                    overflow: TextOverflow.ellipsis,
                                                    style: TextStyle(
                                                      fontSize: 13.5,
                                                      fontWeight: isCurrent ? FontWeight.bold : FontWeight.w500,
                                                      color: isCurrent ? AuroraColors.accent : AuroraColors.fg1,
                                                    ),
                                                  ),
                                                ),
                                                if (isCurrent) ...[
                                                  const SizedBox(width: 6),
                                                  Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                    decoration: BoxDecoration(
                                                      color: AuroraColors.accent,
                                                      borderRadius: BorderRadius.circular(4),
                                                    ),
                                                    child: const Text(
                                                      '当前',
                                                      style: TextStyle(fontSize: 9.5, color: Colors.black, fontWeight: FontWeight.bold),
                                                    ),
                                                  ),
                                                ],
                                              ],
                                            ),
                                            const SizedBox(height: 4),
                                            Row(
                                              children: [
                                                Text(
                                                  item.timeFormatted,
                                                  style: const TextStyle(fontSize: 11, color: AuroraColors.fg3),
                                                ),
                                                if (item.deviceId != null && item.deviceId!.isNotEmpty) ...[
                                                  const SizedBox(width: 6),
                                                  Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                                    decoration: BoxDecoration(
                                                      color: AuroraColors.chip,
                                                      borderRadius: BorderRadius.circular(4),
                                                      border: Border.all(color: AuroraColors.border),
                                                    ),
                                                    child: Text(
                                                      item.deviceId!.length > 8 ? item.deviceId!.substring(0, 8) : item.deviceId!,
                                                      style: const TextStyle(fontSize: 10, color: AuroraColors.fg3),
                                                    ),
                                                  ),
                                                ],
                                                if (item.messageCount > 0) ...[
                                                  const SizedBox(width: 8),
                                                  Text(
                                                    '${item.messageCount} 条消息',
                                                    style: const TextStyle(fontSize: 11, color: AuroraColors.fg4),
                                                  ),
                                                ],
                                              ],
                                            ),
                                          ],
                                        ),
                                      ),
                                      IconButton(
                                        icon: const Icon(Icons.delete_outline, size: 18, color: AuroraColors.fg4),
                                        tooltip: '删除对话',
                                        onPressed: () async {
                                          final confirmed = await showDialog<bool>(
                                            context: context,
                                            builder: (dialogCtx) => AlertDialog(
                                              backgroundColor: AuroraColors.surfaceSolid,
                                              title: const Text('删除对话', style: TextStyle(color: AuroraColors.fg1, fontSize: 16)),
                                              content: Text('确定删除对话「${item.title}」吗？', style: const TextStyle(color: AuroraColors.fg2, fontSize: 13)),
                                              actions: [
                                                TextButton(
                                                  onPressed: () => Navigator.pop(dialogCtx, false),
                                                  child: const Text('取消', style: TextStyle(color: AuroraColors.fg3)),
                                                ),
                                                TextButton(
                                                  onPressed: () => Navigator.pop(dialogCtx, true),
                                                  child: const Text('删除', style: TextStyle(color: AuroraColors.danger)),
                                                ),
                                              ],
                                            ),
                                          );
                                          if (confirmed == true) {
                                            await ref.read(askProvider.notifier).deleteConversation(item.id);
                                            setModalState(() {});
                                          }
                                        },
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            },
                          );
                        },
                      ),
                    ),
                  ],
                );
              },
            );
          },
        );
      },
    );
  }

  String? _getEffectiveCwd() {
    final direct = _cwdController.text.trim();
    if (direct.isNotEmpty) return direct;
    if (_selectedProjectId != null && _selectedProjectId!.isNotEmpty) {
      final proj = _projects.firstWhere(
        (p) => p['id']?.toString() == _selectedProjectId,
        orElse: () => {},
      );
      final sp = proj['source_path']?.toString().trim();
      if (sp != null && sp.isNotEmpty) {
        _cwdController.text = sp;
        return sp;
      }
    }
    return null;
  }

  void _handleSend() {
    if (ref.read(askProvider).isStreaming) return;
    final text = _inputController.text.trim();
    if (text.isEmpty && _attachedFiles.isEmpty) return;

    final deviceState = ref.read(deviceProvider);
    final selectedDevice = deviceState.selectedDeviceId;
    final cwd = _getEffectiveCwd();
    final attachmentsToSend = List<ChatAttachment>.from(_attachedFiles);

    // Save entire active workspace context on message send
    AppStorage.setLastExecutionMode(_executionMode);
    AppStorage.setLastProjectId(_selectedProjectId);
    AppStorage.setLastSessionId(_selectedSessionId);
    AppStorage.setLastModel(_selectedModel);
    AppStorage.setLastIsCustomModel(_isCustomModel);
    AppStorage.setLastEffort(_selectedEffort);
    AppStorage.setLastTimeoutSeconds(_selectedTimeoutSeconds);
    if (cwd != null && cwd.isNotEmpty) {
      AppStorage.setLastCwd(cwd);
    }

    ref.read(askProvider.notifier).sendQuestion(
          question: text,
          selectedDevice: selectedDevice,
          cwd: cwd,
          executionMode: _executionMode,
          model: _selectedModel,
          effort: _selectedEffort,
          projectId: _selectedProjectId,
          sessionId: _selectedSessionId,
          compactMode: _compactMode,
          timeoutSeconds: _selectedTimeoutSeconds,
          attachments: attachmentsToSend.isNotEmpty ? attachmentsToSend : null,
        );

    _inputController.clear();
    setState(() {
      _attachedFiles.clear();
    });
    // iOS/Android: 发送消息后自动收起键盘
    if (Platform.isIOS || Platform.isAndroid) {
      _inputFocusNode.unfocus();
      FocusScope.of(context).unfocus();
    }
    _scrollToBottom(force: true, smooth: true);
  }

  void _handleSmartCompactAndRetry([String? targetSid]) {
    final sidToUse = targetSid ?? _selectedSessionId;
    setState(() {
      if (sidToUse != null && sidToUse.isNotEmpty) {
        _selectedSessionId = sidToUse;
      }
      _compactMode = true;
    });

    final turns = ref.read(askProvider).turns;
    final lastUserTurn = turns.reversed.firstWhere(
      (t) => t.role == 'user' && t.content.trim().isNotEmpty,
      orElse: () => AskTurn(role: 'user', content: ''),
    );
    if (lastUserTurn.content.trim().isNotEmpty) {
      final deviceState = ref.read(deviceProvider);
      final selectedDevice = deviceState.selectedDeviceId;
      final cwd = _getEffectiveCwd();

      ref.read(askProvider.notifier).sendQuestion(
            question: lastUserTurn.content,
            selectedDevice: selectedDevice,
            cwd: cwd,
            executionMode: _executionMode,
            model: _selectedModel,
            effort: _selectedEffort,
            projectId: _selectedProjectId,
            sessionId: sidToUse,
            compactMode: true,
            timeoutSeconds: _selectedTimeoutSeconds,
          );
      if (Platform.isIOS || Platform.isAndroid) {
        _inputFocusNode.unfocus();
        FocusScope.of(context).unfocus();
      }
      _scrollToBottom(force: true, smooth: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AskState>(askProvider, (previous, next) {
      // 1. 新回合插入或切换会话（turns 数量改变，如发送消息、载入历史、清空对话）
      if (previous?.turns.length != next.turns.length) {
        _scrollToBottom(force: true, smooth: true);
        return;
      }

      // 2. 流式响应期间内容增量吐出
      if (next.isStreaming) {
        _scrollToBottom(smooth: false);
        return;
      }

      // 3. 流式响应刚结束，进行平滑收尾对齐
      if (previous?.isStreaming == true && !next.isStreaming) {
        _scrollToBottom(force: false, smooth: true);
      }

      // 4. 自动捕获最新任务回传的 session_id，无缝绑定为当前会话续接状态
      if (next.turns.isNotEmpty) {
        final lastTurn = next.turns.last;
        for (final call in lastTurn.toolCalls.reversed) {
          final sid = call.result?.sessionId;
          if (sid != null && sid.isNotEmpty && sid != _selectedSessionId) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) {
                setState(() {
                  _selectedSessionId = sid;
                });
                AppStorage.setLastSessionId(sid);
              }
            });
            break;
          }
        }
      }
    });

    ref.listen<DeviceState>(deviceProvider, (previous, next) {
      if (!_isWorkspaceRestored) return;
      if (previous == null || previous.selectedDeviceId == next.selectedDeviceId) return;

      setState(() {
        _selectedProjectId = null;
        _selectedSessionId = null;
        _sessions = [];
      });
      AppStorage.setLastProjectId(null);
      AppStorage.setLastSessionId(null);
      if (['codex', 'claude', 'antigravity'].contains(_executionMode)) {
        _loadProjectsForMode(_executionMode);
        _loadCapabilitiesForMode(_executionMode);
      }
    });

    final askState = ref.watch(askProvider);
    final deviceState = ref.watch(deviceProvider);
    final allArtifacts = _collectAllArtifacts(askState.turns);
    final screenWidth = MediaQuery.of(context).size.width;
    final isWideScreen = screenWidth >= 900;

    final chatPane = Column(
      children: [
        if (askState.isLoadingHistory)
          const LinearProgressIndicator(
            minHeight: 2,
            backgroundColor: Colors.transparent,
            color: AuroraColors.accent,
          ),
        // Chat list
        Expanded(
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onTap: () {
              if (Platform.isIOS || Platform.isAndroid) {
                _inputFocusNode.unfocus();
                FocusScope.of(context).unfocus();
              }
            },
            child: askState.turns.isEmpty
                ? _buildEmptyState()
                : Stack(
                    children: [
                      NotificationListener<ScrollNotification>(
                        onNotification: (notification) {
                          if (!_scrollController.hasClients) return false;
                          final metrics = notification.metrics;
                          if (metrics.maxScrollExtent <= 0) return false;
                          final distanceFromBottom =
                              metrics.maxScrollExtent - metrics.pixels;

                          if (distanceFromBottom <= 50) {
                            if (_isUserScrolledUp) {
                              setState(() {
                                _isUserScrolledUp = false;
                              });
                            }
                          } else if (notification is UserScrollNotification) {
                            if (notification.direction == ScrollDirection.forward &&
                                distanceFromBottom > 80) {
                              if (!_isUserScrolledUp) {
                                setState(() {
                                  _isUserScrolledUp = true;
                                });
                              }
                            }
                          } else if (notification is ScrollUpdateNotification &&
                              notification.dragDetails != null) {
                            if (distanceFromBottom > 80 && !_isUserScrolledUp) {
                              setState(() {
                                _isUserScrolledUp = true;
                              });
                            }
                          }
                          return false;
                        },
                        child: LayoutBuilder(
                          builder: (context, constraints) => ListView.builder(
                            controller: _scrollController,
                            keyboardDismissBehavior:
                                ScrollViewKeyboardDismissBehavior.onDrag,
                            // Keep a readable line length on wide windows: center a
                            // column of at most ~860 px instead of spanning the page.
                            padding: EdgeInsets.symmetric(
                                horizontal: math.max(16, (constraints.maxWidth - 860) / 2),
                                vertical: 12),
                            itemCount: askState.turns.length,
                            itemBuilder: (context, index) {
                              final turn = askState.turns[index];
                              return _buildTurnItem(
                                  turn, index, askState.isStreaming);
                            },
                          ),
                        ),
                      ),
                      if (_isUserScrolledUp)
                        Positioned(
                          right: 18,
                          bottom: 14,
                          child: _buildScrollToBottomFab(askState),
                        ),
                    ],
                  ),
          ),
        ),

        // Bottom Console Toolbelt
        _buildBottomConsole(deviceState, askState),
      ],
    );

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('问 AI'),
            if (askState.activeConversationTitle != null)
              Text(
                askState.activeConversationTitle!,
                style: const TextStyle(fontSize: 11, color: AuroraColors.fg3, fontWeight: FontWeight.normal),
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ),
        actions: [
          // Background Update Pill Button
          Consumer(
            builder: (context, ref, _) {
              final updateState = ref.watch(appUpdateProvider);
              final v = updateState.info?.version ?? '';

              // 1. Ready to install -> Restart button
              if (updateState.isReadyToInstall) {
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                  child: Tooltip(
                    message: '新版本 ${v.isNotEmpty ? "v$v " : ""}已下载就绪，点击立即重启升级',
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF6366F1),
                        foregroundColor: Colors.white,
                        elevation: 2,
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        visualDensity: VisualDensity.compact,
                      ),
                      icon: const Icon(Icons.bolt_rounded, size: 16, color: Colors.white),
                      label: Text(
                        v.isNotEmpty ? '重启更新 (v$v)' : '重启更新',
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white),
                      ),
                      onPressed: () => ref.read(appUpdateProvider.notifier).applyUpdateAndRestart(
                        onFeedback: (msg) {
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(msg),
                                backgroundColor: const Color(0xFFEF4444),
                                duration: const Duration(seconds: 4),
                              ),
                            );
                          }
                        },
                      ),
                    ),
                  ),
                );
              }

              // 2. Downloading -> Progress pill
              if (updateState.isDownloading) {
                final percent = (updateState.progress * 100).toInt();
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                  child: Tooltip(
                    message: '正在后台下载新版本 ${v.isNotEmpty ? "v$v " : ""}($percent%)',
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: AuroraColors.chip,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AuroraColors.border),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(strokeWidth: 1.5, color: AuroraColors.accent),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            v.isNotEmpty ? '下载 v$v ($percent%)' : '下载中 ($percent%)',
                            style: const TextStyle(fontSize: 11, color: AuroraColors.fg2),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              }

              // 3. Error with update -> Retry button
              if (updateState.hasUpdate && updateState.status == AppUpdateStatus.error) {
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                  child: Tooltip(
                    message: '更新下载中断，点击重试',
                    child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFFF59E0B),
                        side: const BorderSide(color: Color(0xFFF59E0B), width: 1),
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 0),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        visualDensity: VisualDensity.compact,
                      ),
                      icon: const Icon(Icons.refresh_rounded, size: 14, color: Color(0xFFF59E0B)),
                      label: Text(
                        v.isNotEmpty ? '重试更新 (v$v)' : '重试更新',
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFFF59E0B)),
                      ),
                      onPressed: () => ref.read(appUpdateProvider.notifier).retry(),
                    ),
                  ),
                );
              }

              return const SizedBox.shrink();
            },
          ),
          if (allArtifacts.isNotEmpty)
            IconButton(
              icon: Badge.count(
                count: allArtifacts.length,
                backgroundColor: AuroraColors.accent,
                textColor: Colors.white,
                child: Icon(
                  Icons.dashboard_customize_rounded,
                  size: 20,
                  color: _isWorkspaceOpen ? AuroraColors.accent : AuroraColors.fg2,
                ),
              ),
              tooltip: _isWorkspaceOpen ? '收起 Artifacts 工作台' : '展开 Artifacts 工作台 (${allArtifacts.length})',
              onPressed: () {
                if (isWideScreen) {
                  setState(() {
                    _isWorkspaceOpen = !_isWorkspaceOpen;
                    if (_isWorkspaceOpen && _selectedWorkspaceArtifact == null) {
                      _selectedWorkspaceArtifact = allArtifacts.first;
                    }
                  });
                } else {
                  _openArtifactWorkspace(_selectedWorkspaceArtifact ?? allArtifacts.first, allArtifacts);
                }
              },
            ),
          IconButton(
            icon: const Icon(Icons.history_rounded, size: 22),
            tooltip: '历史记录',
            onPressed: () => _showHistoryModal(context),
          ),
          IconButton(
            icon: const Icon(Icons.add, size: 22),
            tooltip: '新建对话',
            onPressed: () {
              setState(() {
                _isWorkspaceOpen = false;
                _selectedWorkspaceArtifact = null;
                _selectedSessionId = null;
              });
              AppStorage.setLastSessionId(null);
              ref.read(askProvider.notifier).newChat();
            },
          ),
          if (askState.turns.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.delete_outline, size: 20),
              tooltip: '清空当前对话',
              onPressed: () {
                setState(() {
                  _isWorkspaceOpen = false;
                  _selectedWorkspaceArtifact = null;
                });
                ref.read(askProvider.notifier).clearChat();
              },
            ),
        ],
      ),
      body: isWideScreen && _isWorkspaceOpen && allArtifacts.isNotEmpty
          ? Row(
              children: [
                Expanded(child: chatPane),
                SizedBox(
                  width: (screenWidth * 0.44).clamp(440.0, 720.0),
                  child: ArtifactsWorkspace(
                    artifacts: allArtifacts,
                    initialSelected: _selectedWorkspaceArtifact,
                    onClose: () => setState(() => _isWorkspaceOpen = false),
                  ),
                ),
              ],
            )
          : chatPane,
    );
  }

  Widget _buildScrollToBottomFab(AskState askState) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () {
          _scrollToBottom(force: true, smooth: true);
        },
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            color: AuroraColors.surfaceElevated.withOpacity(0.92),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AuroraColors.border, width: 1),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withOpacity(0.25),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (askState.isStreaming) ...[
                Container(
                  width: 7,
                  height: 7,
                  margin: const EdgeInsets.only(right: 6),
                  decoration: const BoxDecoration(
                    color: AuroraColors.accent,
                    shape: BoxShape.circle,
                  ),
                ),
              ],
              const Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 18,
                color: AuroraColors.fg1,
              ),
              const SizedBox(width: 4),
              Text(
                askState.isStreaming ? '最新消息' : '回到底部',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: AuroraColors.fg1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: GlassCard(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: AuroraColors.accentSoft,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: const Icon(Icons.terminal, color: AuroraColors.accent, size: 26),
              ),
              const SizedBox(height: 14),
              const Text(
                '跨设备终端控制与记忆问答',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: AuroraColors.fg1,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                '向连接的 Mac / PC 下发指令、查询历史代码上下文，或协同执行任务。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  color: AuroraColors.fg3,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 20),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.center,
                children: [
                  _buildQuickPill('检查 git 状态', Icons.code),
                  _buildQuickPill('查看系统端口', Icons.wifi),
                  _buildQuickPill('总结今天代码', Icons.auto_awesome),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildQuickPill(String text, IconData icon) {
    return InkWell(
      onTap: () {
        _inputController.text = text;
        _handleSend();
      },
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: AuroraColors.chip,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AuroraColors.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 13, color: AuroraColors.accent),
            const SizedBox(width: 5),
            Text(
              text,
              style: const TextStyle(fontSize: 12, color: AuroraColors.fg2),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildUserTurnMedia(AskTurn turn) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (turn.images.isNotEmpty)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.end,
            children: turn.images.map((img) {
              return GestureDetector(
                onTap: () => _showImagePreviewDialog(context, imageSource: img),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                    width: 140,
                    height: 105,
                    decoration: BoxDecoration(
                      color: AuroraColors.chip,
                      border: Border.all(color: AuroraColors.border),
                    ),
                    child: _buildImageThumbnail(img),
                  ),
                ),
              );
            }).toList(),
          ),
        if (turn.attachments.isNotEmpty) ...[
          if (turn.images.isNotEmpty) const SizedBox(height: 6),
          ...turn.attachments
              .where((att) => att['type'] != 'image')
              .map((att) {
            final name = att['name']?.toString() ?? '文件附件';
            final size = att['size'] is int ? att['size'] as int : null;
            return Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AuroraColors.surface.withOpacity(0.6),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AuroraColors.border),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.insert_drive_file_outlined, size: 16, color: AuroraColors.accent),
                  const SizedBox(width: 6),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 200),
                    child: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: AuroraColors.fg1),
                    ),
                  ),
                  if (size != null && size > 0) ...[
                    const SizedBox(width: 6),
                    Text(
                      _formatSize(size),
                      style: const TextStyle(fontSize: 10, color: AuroraColors.fg3),
                    ),
                  ],
                ],
              ),
            );
          }),
        ],
      ],
    );
  }

  Widget _buildImageThumbnail(String source) {
    if (source.startsWith('data:image/')) {
      try {
        final b64 = source.split(',').last;
        final bytes = base64Decode(b64);
        return Image.memory(bytes, fit: BoxFit.cover);
      } catch (_) {
        return const Center(child: Icon(Icons.broken_image, color: AuroraColors.fg3));
      }
    } else if (source.startsWith('http://') || source.startsWith('https://')) {
      return Image.network(
        source,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => const Center(child: Icon(Icons.broken_image, color: AuroraColors.fg3)),
      );
    } else {
      final file = File(source);
      if (file.existsSync()) {
        return Image.file(file, fit: BoxFit.cover);
      }
      return const Center(child: Icon(Icons.image, color: AuroraColors.fg3));
    }
  }

  Widget _buildTurnItem(AskTurn turn, int index, bool isGlobalStreaming) {
    if (turn.role == 'user') {
      final hasMedia = turn.images.isNotEmpty || turn.attachments.isNotEmpty;
      return RepaintBoundary(
        child: Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.only(bottom: 18, left: 48),
            constraints: const BoxConstraints(maxWidth: 640),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: const BoxDecoration(
              color: AuroraColors.surfaceElevated,
              borderRadius: BorderRadius.only(
                topLeft: Radius.circular(18),
                topRight: Radius.circular(18),
                bottomLeft: Radius.circular(18),
                bottomRight: Radius.circular(6),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (hasMedia) ...[
                  _buildUserTurnMedia(turn),
                  if (turn.content.isNotEmpty) const SizedBox(height: 8),
                ],
                if (turn.content.isNotEmpty)
                  SelectableText(
                    turn.content,
                    style: const TextStyle(
                      fontSize: 14.5,
                      color: AuroraColors.fg1,
                      height: 1.5,
                    ),
                  ),
              ],
            ),
          ),
        ),
      );
    }

    // Assistant turn: no card of its own. The answer reads as plain text on the
    // page; only tool executions get a surface.
    final isLastTurn = index == ref.read(askProvider).turns.length - 1;
    final isThinkingLive = isGlobalStreaming && isLastTurn && turn.content.isEmpty;

    return RepaintBoundary(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 24, right: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Sources Pill if available
            if (turn.sources.isNotEmpty) ...[
              Align(
                alignment: Alignment.centerRight,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  margin: const EdgeInsets.only(bottom: 8),
                  decoration: BoxDecoration(
                    color: AuroraColors.accentSoft,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.menu_book, size: 12, color: AuroraColors.accent),
                      const SizedBox(width: 4),
                      Text(
                        '引用 ${turn.sources.length} 篇记忆',
                        style: const TextStyle(fontSize: 11, color: AuroraColors.accent),
                      ),
                    ],
                  ),
                ),
              ),
            ],

            // Thinking block
            if ((turn.thinking != null && turn.thinking!.isNotEmpty) || isThinkingLive)
              ThinkingBlock(
                thinking: turn.thinking ?? '',
                isLive: isThinkingLive,
              ),

            // Tool execution cards
            if (turn.toolCalls.isNotEmpty)
              ...turn.toolCalls.map((call) => ExecutionCard(
                    call: call,
                    onSmartCompactAndRetry: _handleSmartCompactAndRetry,
                  )),

            // Assistant answer text
            if (turn.content.isNotEmpty) ...[
              AppMarkdown(data: turn.content),
              ...() {
                final devId = _findTurnDeviceId(turn);
                final artifacts = AgentArtifact.extractArtifacts(turn.content, defaultDeviceId: devId);
                if (artifacts.isEmpty) return <Widget>[];
                return artifacts.map((art) => Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: ArtifactCard(
                    artifact: art,
                    onOpenWorkspace: () {
                      final allArts = _collectAllArtifacts(ref.read(askProvider).turns);
                      _openArtifactWorkspace(art, allArts.isNotEmpty ? allArts : [art]);
                    },
                  ),
                )).toList();
              }(),
            ]
            else if (turn.toolCalls.isEmpty && (turn.thinking == null || turn.thinking!.isEmpty))
              const Row(
                children: [
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AuroraColors.accent),
                  ),
                  SizedBox(width: 8),
                  Text('思考中...', style: TextStyle(fontSize: 13, color: AuroraColors.fg3)),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildCollapsedSummaryBar(DeviceState deviceState) {
    final modes = [
      {'id': 'ai', 'label': 'AI 编排', 'icon': Icons.psychology_rounded, 'color': AuroraColors.accent},
      {'id': 'claude', 'label': 'Claude Code', 'icon': Icons.auto_awesome, 'color': const Color(0xFFE5855E)},
      {'id': 'codex', 'label': 'Codex', 'icon': Icons.code_rounded, 'color': const Color(0xFF10A37F)},
      {'id': 'antigravity', 'label': 'Antigravity', 'icon': Icons.rocket_launch_rounded, 'color': const Color(0xFF9D67EF)},
      {'id': 'shell', 'label': 'Shell', 'icon': Icons.terminal_rounded, 'color': const Color(0xFF38BDF8)},
    ];
    final currentMode = modes.firstWhere(
      (m) => m['id'] == _executionMode,
      orElse: () => modes[0],
    );
    final modeColor = currentMode['color'] as Color;

    String deviceLabel = '自动调度';
    if (deviceState.selectedDeviceId == 'ask_only') {
      deviceLabel = '仅提问';
    } else if (deviceState.selectedDeviceId != 'auto') {
      try {
        final dev = deviceState.devices.firstWhere(
          (d) => d.deviceId == deviceState.selectedDeviceId,
        );
        deviceLabel = dev.name;
      } catch (_) {
        deviceLabel = deviceState.selectedDeviceId.length > 8
            ? deviceState.selectedDeviceId.substring(0, 8)
            : deviceState.selectedDeviceId;
      }
    }

    String? projectTitle;
    if (_selectedProjectId != null && _selectedProjectId!.isNotEmpty) {
      try {
        final proj = _projects.firstWhere(
          (p) => p['id']?.toString() == _selectedProjectId,
        );
        projectTitle = (proj['title'] ?? proj['slug'] ?? _selectedProjectId).toString();
      } catch (_) {
        projectTitle = _selectedProjectId;
      }
    }

    return InkWell(
      onTap: () => setState(() => _isConfigCollapsed = false),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Row(
          children: [
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Mode Chip
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: modeColor.withValues(alpha: 0.16),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(currentMode['icon'] as IconData, size: 12, color: modeColor),
                          const SizedBox(width: 4),
                          Text(
                            currentMode['label'] as String,
                            style: TextStyle(fontSize: 11, color: modeColor, fontWeight: FontWeight.w600),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 6),

                    // Device Chip
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: AuroraColors.surface,
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: AuroraColors.border, width: 0.8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.devices_rounded, size: 11, color: AuroraColors.accent),
                          const SizedBox(width: 4),
                          Text(
                            deviceLabel,
                            style: const TextStyle(fontSize: 11, color: AuroraColors.fg2),
                          ),
                        ],
                      ),
                    ),

                    // Project Chip
                    if (projectTitle != null && projectTitle.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: AuroraColors.surface,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: AuroraColors.border, width: 0.8),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.folder_outlined, size: 11, color: AuroraColors.fg3),
                            const SizedBox(width: 4),
                            Text(
                              projectTitle,
                              style: const TextStyle(fontSize: 11, color: AuroraColors.fg2),
                            ),
                          ],
                        ),
                      ),
                    ],

                    // Session Chip (if resuming)
                    if (_selectedSessionId != null && _selectedSessionId!.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: _compactMode ? const Color(0x1E10B981) : AuroraColors.accentSoft,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(
                            color: _compactMode ? const Color(0xFF10B981) : AuroraColors.accent,
                            width: 0.8,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              _compactMode ? Icons.auto_awesome : Icons.access_time_rounded,
                              size: 11,
                              color: _compactMode ? const Color(0xFF10B981) : AuroraColors.accent,
                            ),
                            const SizedBox(width: 3),
                            Text(
                              _compactMode ? '瘦身续接' : '续接中',
                              style: TextStyle(
                                fontSize: 10.5,
                                color: _compactMode ? const Color(0xFF10B981) : AuroraColors.accent,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],

                    // Custom Timeout Chip (if set)
                    if (_selectedTimeoutSeconds != null && _selectedTimeoutSeconds! > 0) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: AuroraColors.surface,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: AuroraColors.border, width: 0.8),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.timer_outlined, size: 11, color: AuroraColors.accent),
                            const SizedBox(width: 3),
                            Text(
                              '${(_selectedTimeoutSeconds! ~/ 60)}m',
                              style: const TextStyle(fontSize: 10.5, color: AuroraColors.accent, fontWeight: FontWeight.w600),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(width: 6),
            // Expand button
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.tune_rounded, size: 14, color: AuroraColors.fg3),
                  SizedBox(width: 4),
                  Text(
                    '配置',
                    style: TextStyle(fontSize: 12, color: AuroraColors.fg3, fontWeight: FontWeight.w500),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBottomConsole(DeviceState deviceState, AskState askState) {
    return Container(
      padding: EdgeInsets.only(
        left: 14,
        right: 14,
        top: 8,
        bottom: MediaQuery.of(context).viewInsets.bottom > 0
            ? MediaQuery.of(context).viewInsets.bottom + 10
            : MediaQuery.of(context).padding.bottom + 10,
      ),
      decoration: const BoxDecoration(
        color: AuroraColors.bg,
        border: Border(top: BorderSide(color: AuroraColors.border)),
      ),
      // Same column as the conversation above it on wide windows.
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 892),
        child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_isConfigCollapsed)
            _buildCollapsedSummaryBar(deviceState)
          else ...[
            // Agent Mode Selector Toolbelt with Collapse button
            Row(
              children: [
                Expanded(child: _buildAgentSelector()),
                const SizedBox(width: 6),
                InkWell(
                  onTap: () => setState(() => _isConfigCollapsed = true),
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                    decoration: BoxDecoration(
                      color: AuroraColors.chip,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AuroraColors.border),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.keyboard_arrow_up, size: 14, color: AuroraColors.fg3),
                        SizedBox(width: 2),
                        Text(
                          '收起',
                          style: TextStyle(fontSize: 11, color: AuroraColors.fg3, fontWeight: FontWeight.w500),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

          // Device & CWD toolbelt
          Row(
            children: [
              // Target Device Dropdown
              Expanded(
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  decoration: BoxDecoration(
                    color: AuroraColors.chip,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AuroraColors.border),
                  ),
                  child: DropdownButtonHideUnderline(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: deviceState.selectedDeviceId,
                      dropdownColor: AuroraColors.surfaceElevated,
                      icon: const Icon(Icons.keyboard_arrow_down, size: 16, color: AuroraColors.fg3),
                      style: const TextStyle(fontSize: 12, color: AuroraColors.fg1),
                      onChanged: _handleDeviceChange,
                      items: [
                        const DropdownMenuItem(
                          value: 'auto',
                          child: Text('🤖 自动调度', overflow: TextOverflow.ellipsis),
                        ),
                        if (deviceState.selectedDeviceId != 'auto' &&
                            deviceState.selectedDeviceId != 'ask_only' &&
                            !deviceState.devices.any((d) => d.deviceId == deviceState.selectedDeviceId))
                          DropdownMenuItem(
                            value: deviceState.selectedDeviceId,
                            child: Text(
                              '⚪ ${deviceState.selectedDeviceId.length > 8 ? deviceState.selectedDeviceId.substring(0, 8) : deviceState.selectedDeviceId}',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ...deviceState.devices.map(
                          (d) => DropdownMenuItem(
                            value: d.deviceId,
                            child: Text(
                              '${d.isOnline ? "🟢" : "⚪"} ${d.name} (${d.deviceId.length > 6 ? d.deviceId.substring(0, 6) : d.deviceId})',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ),
                        const DropdownMenuItem(
                          value: 'ask_only',
                          child: Text('✨ 仅提问不执行', overflow: TextOverflow.ellipsis),
                        ),
                      ],
                    ),
                  ),
                ),
              ),

              // CWD Toggle Button
              if (deviceState.selectedDeviceId != 'ask_only') ...[
                const SizedBox(width: 8),
                InkWell(
                  onTap: () => setState(() => _showCwd = !_showCwd),
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                    height: 32,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: _showCwd ? AuroraColors.accentSoft : AuroraColors.chip,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: _showCwd ? AuroraColors.accent : AuroraColors.border,
                      ),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          _showCwd ? Icons.folder_open : Icons.folder_outlined,
                          size: 13,
                          color: _showCwd ? AuroraColors.accent : AuroraColors.fg3,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '路径',
                          style: TextStyle(
                            fontSize: 12,
                            color: _showCwd ? AuroraColors.accent : AuroraColors.fg3,
                            fontWeight: _showCwd ? FontWeight.w600 : FontWeight.normal,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),

          // CWD Path Input (when expanded)
          if (_showCwd && deviceState.selectedDeviceId != 'ask_only') ...[
            const SizedBox(height: 6),
            Container(
              height: 32,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: BoxDecoration(
                color: AuroraColors.chip,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AuroraColors.accent.withOpacity(0.5)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.folder_open, size: 14, color: AuroraColors.accent),
                  const SizedBox(width: 6),
                  Expanded(
                    child: TextField(
                      controller: _cwdController,
                      style: const TextStyle(
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                        color: AuroraColors.fg1,
                      ),
                      onChanged: (val) {
                        final trimmed = val.trim();
                        AppStorage.setLastCwd(trimmed.isEmpty ? null : trimmed);
                      },
                      decoration: const InputDecoration(
                        isDense: true,
                        contentPadding: EdgeInsets.zero,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        hintText: '工作目录路径，如 ~/project',
                        hintStyle: TextStyle(fontSize: 11, color: AuroraColors.fg4),
                      ),
                    ),
                  ),
                  InkWell(
                    onTap: () {
                      setState(() => _showCwd = false);
                      AppStorage.setLastCwd(null);
                    },
                    child: const Icon(Icons.close, size: 13, color: AuroraColors.fg3),
                  ),
                ],
              ),
            ),
          ],

          // Agent Specific Toolbelt (Model, Project, Historical Session)
          if (['codex', 'claude', 'antigravity'].contains(_executionMode)) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                // Model Dropdown or Custom Input
                if (['codex', 'claude', 'antigravity'].contains(_executionMode))
                  Flexible(
                    flex: 4,
                    child: _isCustomModel
                        ? Container(
                            height: 32,
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            decoration: BoxDecoration(
                              color: AuroraColors.chip,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: AuroraColors.accent),
                            ),
                            child: Row(
                              children: [
                                const Icon(Icons.auto_awesome, size: 12, color: AuroraColors.accent),
                                const SizedBox(width: 4),
                                Expanded(
                                  child: TextField(
                                    controller: _customModelController,
                                    autofocus: true,
                                    style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg1),
                                    decoration: const InputDecoration(
                                      isDense: true,
                                      contentPadding: EdgeInsets.zero,
                                      border: InputBorder.none,
                                      hintText: '输入模型标识符...',
                                      hintStyle: TextStyle(fontSize: 11, color: AuroraColors.fg4),
                                    ),
                                    onChanged: (val) {
                                      final trimmed = val.trim();
                                      setState(() => _selectedModel = trimmed.isEmpty ? null : trimmed);
                                      AppStorage.setLastModel(trimmed.isEmpty ? null : trimmed);
                                      AppStorage.setLastIsCustomModel(true);
                                    },
                                  ),
                                ),
                                InkWell(
                                  onTap: () {
                                    setState(() {
                                      _isCustomModel = false;
                                      _selectedModel = null;
                                      _customModelController.clear();
                                    });
                                    AppStorage.setLastModel(null);
                                    AppStorage.setLastIsCustomModel(false);
                                  },
                                  child: const Icon(Icons.close, size: 13, color: AuroraColors.fg3),
                                ),
                              ],
                            ),
                          )
                        : Container(
                            height: 32,
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            decoration: BoxDecoration(
                              color: _selectedModel != null && _selectedModel!.isNotEmpty
                                  ? AuroraColors.accentSoft
                                  : AuroraColors.chip,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: _selectedModel != null && _selectedModel!.isNotEmpty
                                    ? AuroraColors.accent
                                    : AuroraColors.border,
                              ),
                            ),
                            child: DropdownButtonHideUnderline(
                              child: DropdownButton<String>(
                                isExpanded: true,
                                value: (_selectedModel == null || _selectedModel!.isEmpty) ? '' : _selectedModel,
                                dropdownColor: AuroraColors.surfaceElevated,
                                icon: const Icon(Icons.keyboard_arrow_down, size: 14, color: AuroraColors.fg3),
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: _selectedModel != null && _selectedModel!.isNotEmpty
                                      ? AuroraColors.accent
                                      : AuroraColors.fg1,
                                  fontWeight: _selectedModel != null && _selectedModel!.isNotEmpty
                                      ? FontWeight.w600
                                      : FontWeight.normal,
                                ),
                                onChanged: (val) {
                                  if (val == '__custom__') {
                                    setState(() {
                                      _isCustomModel = true;
                                      _selectedModel = null;
                                    });
                                    AppStorage.setLastModel(null);
                                    AppStorage.setLastIsCustomModel(true);
                                  } else {
                                    final chosen = (val == null || val.isEmpty) ? null : val;
                                    setState(() {
                                      _selectedModel = chosen;
                                    });
                                    AppStorage.setLastModel(chosen);
                                    AppStorage.setLastIsCustomModel(false);
                                  }
                                },
                                items: [
                                  ...(){
                                    final dynamic rawModels = _agentCapabilities?['models'];
                                    final List<Map<String, String>> currentModels = (rawModels is List && rawModels.isNotEmpty)
                                        ? rawModels.map<Map<String, String>>((m) => {
                                            'id': (m is Map ? (m['id'] ?? '') : m).toString(),
                                            'name': (m is Map ? (m['name'] ?? m['id'] ?? '') : m).toString(),
                                          }).toList()
                                        : (kFallbackAgentModels[_executionMode] ?? []);
                                    final items = currentModels.map((m) {
                                      return DropdownMenuItem<String>(
                                        value: m['id'],
                                        child: Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Icon(
                                              Icons.auto_awesome,
                                              size: 12,
                                              color: _selectedModel == m['id']
                                                  ? AuroraColors.accent
                                                  : AuroraColors.fg3,
                                            ),
                                            const SizedBox(width: 4),
                                            Flexible(child: Text(m['name']!, overflow: TextOverflow.ellipsis)),
                                          ],
                                        ),
                                      );
                                    }).toList();
                                    if (_selectedModel != null &&
                                        _selectedModel!.isNotEmpty &&
                                        !_isCustomModel &&
                                        !currentModels.any((m) => m['id'] == _selectedModel)) {
                                      items.insert(
                                        0,
                                        DropdownMenuItem<String>(
                                          value: _selectedModel,
                                          child: Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              const Icon(Icons.auto_awesome, size: 12, color: AuroraColors.accent),
                                              const SizedBox(width: 4),
                                              Flexible(child: Text('🤖 $_selectedModel', overflow: TextOverflow.ellipsis)),
                                            ],
                                          ),
                                        ),
                                      );
                                    }
                                    return items;
                                  }(),
                                  const DropdownMenuItem<String>(
                                    value: '__custom__',
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.edit_outlined, size: 12, color: AuroraColors.accent),
                                        SizedBox(width: 4),
                                        Text('✏️ 自定义输入模型...', style: TextStyle(color: AuroraColors.accent), overflow: TextOverflow.ellipsis),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                  ),
                const SizedBox(width: 6),
                // Project Dropdown
                Flexible(
                  flex: 5,
                  child: Container(
                    height: 32,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(
                      color: AuroraColors.chip,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AuroraColors.border),
                    ),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        isExpanded: true,
                        value: _selectedProjectId,
                        hint: const Text('📁 关联项目...', style: TextStyle(fontSize: 11.5, color: AuroraColors.fg3), overflow: TextOverflow.ellipsis),
                        dropdownColor: AuroraColors.surfaceElevated,
                        icon: const Icon(Icons.keyboard_arrow_down, size: 14, color: AuroraColors.fg3),
                        style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg1),
                        onChanged: (val) => _handleProjectChange(val),
                        items: [
                          const DropdownMenuItem<String>(
                            value: null,
                            child: Text('📁 不指定项目', overflow: TextOverflow.ellipsis),
                          ),
                          if (_selectedProjectId != null &&
                              _selectedProjectId!.isNotEmpty &&
                              !_projects.any((p) => p['id']?.toString() == _selectedProjectId))
                            DropdownMenuItem<String>(
                              value: _selectedProjectId,
                              child: Text('📁 $_selectedProjectId', overflow: TextOverflow.ellipsis),
                            ),
                          ..._projects.map((p) {
                            final id = p['id']?.toString() ?? '';
                            final title = (p['title'] ?? p['slug'] ?? id).toString().replaceAll('"', '').replaceAll("'", '').trim();
                            return DropdownMenuItem<String>(
                              value: id,
                              child: Text('📁 $title', overflow: TextOverflow.ellipsis),
                            );
                          }),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
            // Agent Reasoning Effort (Low / Medium / High)
            if (['codex', 'claude', 'antigravity'].contains(_executionMode) &&
                (_executionMode == 'codex' || _agentCapabilities?['supports_effort'] == true)) ...[
              const SizedBox(height: 6),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    const Icon(Icons.psychology_outlined, size: 14, color: AuroraColors.fg3),
                    const SizedBox(width: 4),
                    const Text('Effort:', style: TextStyle(fontSize: 11, color: AuroraColors.fg3, fontWeight: FontWeight.w500)),
                    const SizedBox(width: 6),
                    ...[
                      {'id': '', 'name': '⚡ 默认'},
                      {'id': 'low', 'name': 'Low (快速/低思考)'},
                      {'id': 'medium', 'name': 'Medium (标准)'},
                      {'id': 'high', 'name': 'High (深度推理)'},
                    ].map((opt) {
                      final isSelected = (_selectedEffort == null || _selectedEffort!.isEmpty)
                          ? opt['id'] == ''
                          : _selectedEffort == opt['id'];
                      return Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(6),
                          onTap: () {
                            final chosen = opt['id']!.isEmpty ? null : opt['id'];
                            setState(() {
                              _selectedEffort = chosen;
                            });
                            AppStorage.setLastEffort(chosen);
                          },
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(
                              color: isSelected ? AuroraColors.accentSoft : AuroraColors.chip,
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(
                                color: isSelected ? AuroraColors.accent : AuroraColors.border,
                                width: 1,
                              ),
                            ),
                            child: Text(
                              opt['name']!,
                              style: TextStyle(
                                fontSize: 10.5,
                                color: isSelected ? AuroraColors.accent : AuroraColors.fg2,
                                fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
                              ),
                            ),
                          ),
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ],

            // Execution Timeout Row (Smart Auto, 5m, 15m, 30m, 60m)
            const SizedBox(height: 6),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  const Icon(Icons.timer_outlined, size: 13, color: AuroraColors.fg3),
                  const SizedBox(width: 4),
                  const Text('超时:', style: TextStyle(fontSize: 11, color: AuroraColors.fg3, fontWeight: FontWeight.w500)),
                  const SizedBox(width: 6),
                  ...[
                    {'id': 0, 'name': '⚡ 智能自适应 (默认 10~30m)'},
                    {'id': 300, 'name': '⏱️ 5 分钟 (快速)'},
                    {'id': 900, 'name': '⏱️ 15 分钟 (常规)'},
                    {'id': 1800, 'name': '⏱️ 30 分钟 (大文件/迁移)'},
                    {'id': 3600, 'name': '⏱️ 60 分钟 (超长)'},
                  ].map((opt) {
                    final isSelected = (_selectedTimeoutSeconds == null || _selectedTimeoutSeconds == 0)
                        ? opt['id'] == 0
                        : _selectedTimeoutSeconds == opt['id'];
                    return Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(6),
                        onTap: () {
                          final val = opt['id'] as int;
                          final chosen = val == 0 ? null : val;
                          setState(() {
                            _selectedTimeoutSeconds = chosen;
                          });
                          AppStorage.setLastTimeoutSeconds(chosen);
                        },
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3.5),
                          decoration: BoxDecoration(
                            color: isSelected ? AuroraColors.accentSoft : AuroraColors.chip,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(
                              color: isSelected ? AuroraColors.accent : AuroraColors.border,
                              width: 1,
                            ),
                          ),
                          child: Text(
                            opt['name'] as String,
                            style: TextStyle(
                              fontSize: 10.5,
                              color: isSelected ? AuroraColors.accent : AuroraColors.fg2,
                              fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
                            ),
                          ),
                        ),
                      ),
                    );
                  }),
                ],
              ),
            ),
            // Session selector under the selected project
            if (_selectedProjectId != null && _selectedProjectId!.isNotEmpty) ...[
              const SizedBox(height: 6),
              Container(
                height: 32,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  color: _selectedSessionId != null ? AuroraColors.accentSoft : AuroraColors.chip,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: _selectedSessionId != null ? AuroraColors.accent : AuroraColors.border,
                  ),
                ),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: _selectedSessionId,
                    hint: Text(
                      _loadingSessions
                          ? '⏳ 加载历史会话中...'
                          : (_sessions.isEmpty ? '➕ 新建独立会话 (该设备暂无历史)' : '➕ 新建独立会话'),
                      style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg2),
                      overflow: TextOverflow.ellipsis,
                    ),
                    dropdownColor: AuroraColors.surfaceElevated,
                    icon: const Icon(Icons.keyboard_arrow_down, size: 14, color: AuroraColors.fg3),
                    style: TextStyle(
                      fontSize: 11.5,
                      color: _selectedSessionId != null ? AuroraColors.accent : AuroraColors.fg1,
                      fontWeight: _selectedSessionId != null ? FontWeight.w600 : FontWeight.normal,
                    ),
                    onChanged: _handleSelectSession,
                    items: [
                      const DropdownMenuItem<String>(
                        value: null,
                        child: Text('➕ 新建独立会话', overflow: TextOverflow.ellipsis),
                      ),
                      if (_selectedSessionId != null &&
                          _selectedSessionId!.isNotEmpty &&
                          !_sessions.any((s) => (s['session_id'] ?? s['conversation_id'])?.toString() == _selectedSessionId))
                        DropdownMenuItem<String>(
                          value: _selectedSessionId,
                          child: Text('💬 $_selectedSessionId', overflow: TextOverflow.ellipsis),
                        ),
                      ..._sessions.map((s) {
                        final sid = (s['session_id'] ?? s['conversation_id'] ?? '').toString();
                        final title = (s['title'] ?? (sid.length > 12 ? sid.substring(0, 12) : sid)).toString();
                        final count = (s['message_count'] as num?)?.toInt() ?? 0;
                        final bytes = (s['file_size_bytes'] as num?)?.toInt() ?? 0;
                        final compactRecommended = s['compact_recommended'] == true;
                        final isHeavy = compactRecommended || bytes > 300000 || count > 35;
                        final tag = isHeavy ? ' [⚠️ 建议瘦身]' : '';
                        return DropdownMenuItem<String>(
                          value: sid,
                          child: Text('💬 $title$tag', overflow: TextOverflow.ellipsis),
                        );
                      }),
                    ],
                  ),
                ),
              ),
            ],
          ],

          // Active Resume Session Banner & Historical Context Preview
          if (_selectedSessionId != null && _selectedSessionId!.isNotEmpty) ...[
            const SizedBox(height: 8),
            (() {
              final activeSession = _sessions.firstWhere(
                (s) => (s['session_id'] ?? s['conversation_id'])?.toString() == _selectedSessionId,
                orElse: () => {'title': _selectedSessionId},
              );
              final rawMsgs = (activeSession['messages'] as List<dynamic>?) ?? [];
              final msgs = rawMsgs.cast<Map<String, dynamic>>();
              final previewMsgs = msgs.length > 4 ? msgs.sublist(msgs.length - 4) : msgs;
              final totalCount = (activeSession['message_count'] as num?)?.toInt() ?? msgs.length;
              final bytes = (activeSession['file_size_bytes'] as num?)?.toInt() ?? 0;
              final compactRecommended = activeSession['compact_recommended'] == true;
              final isHeavy = compactRecommended || bytes > 300000 || totalCount > 35;
              final title = activeSession['title']?.toString() ?? _selectedSessionId!;

              final bannerColor = _compactMode
                  ? const Color(0x1410B981)
                  : AuroraColors.accentSoft;
              final borderColor = _compactMode
                  ? const Color(0x7F10B981)
                  : AuroraColors.accent.withOpacity(0.6);
              final accentTextColor = _compactMode
                  ? const Color(0xFF10B981)
                  : AuroraColors.accent;

              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: bannerColor,
                      borderRadius: BorderRadius.vertical(
                        top: const Radius.circular(8),
                        bottom: Radius.circular(_showSessionContext ? 0 : 8),
                      ),
                      border: Border.all(color: borderColor),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          _compactMode ? Icons.auto_awesome : Icons.history_rounded,
                          size: 14,
                          color: accentTextColor,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          _compactMode ? '🌟 智能瘦身续接: ' : '续接会话: ',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.bold,
                            color: accentTextColor,
                          ),
                        ),
                        Expanded(
                          child: Text(
                            '$title ($totalCount 条)',
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg1),
                          ),
                        ),
                        if (isHeavy) ...[
                          Container(
                            margin: const EdgeInsets.symmetric(horizontal: 4),
                            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                            decoration: BoxDecoration(
                              color: const Color(0x26F59E0B),
                              borderRadius: BorderRadius.circular(4),
                              border: Border.all(color: const Color(0x7FF59E0B), width: 0.8),
                            ),
                            child: const Text(
                              '⚠️ 建议瘦身',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFFF59E0B),
                              ),
                            ),
                          ),
                        ],
                        InkWell(
                          onTap: () => setState(() => _compactMode = !_compactMode),
                          borderRadius: BorderRadius.circular(4),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: _compactMode ? const Color(0x2810B981) : AuroraColors.chip,
                              border: Border.all(
                                color: _compactMode ? const Color(0xFF10B981) : AuroraColors.border,
                                width: 0.8,
                              ),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  _compactMode ? Icons.auto_awesome : Icons.history_rounded,
                                  size: 11,
                                  color: _compactMode ? const Color(0xFF10B981) : AuroraColors.fg2,
                                ),
                                const SizedBox(width: 3),
                                Text(
                                  _compactMode ? '智能瘦身' : '原生续接',
                                  style: TextStyle(
                                    fontSize: 10.5,
                                    fontWeight: _compactMode ? FontWeight.bold : FontWeight.w500,
                                    color: _compactMode ? const Color(0xFF10B981) : AuroraColors.fg2,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                        InkWell(
                          onTap: () => setState(() => _showSessionContext = !_showSessionContext),
                          borderRadius: BorderRadius.circular(4),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  _showSessionContext ? '收起' : '预览',
                                  style: TextStyle(
                                    fontSize: 11,
                                    color: accentTextColor,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                                Icon(
                                  _showSessionContext ? Icons.keyboard_arrow_up_rounded : Icons.keyboard_arrow_down_rounded,
                                  size: 14,
                                  color: accentTextColor,
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                        InkWell(
                          onTap: () => _handleSelectSession(null),
                          borderRadius: BorderRadius.circular(4),
                          child: const Padding(
                            padding: EdgeInsets.all(2.0),
                            child: Icon(Icons.close, size: 14, color: AuroraColors.fg3),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (_showSessionContext)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: AuroraColors.surface,
                        borderRadius: const BorderRadius.vertical(bottom: Radius.circular(8)),
                        border: Border(
                          left: BorderSide(color: AuroraColors.accent.withOpacity(0.6)),
                          right: BorderSide(color: AuroraColors.accent.withOpacity(0.6)),
                          bottom: BorderSide(color: AuroraColors.accent.withOpacity(0.6)),
                        ),
                      ),
                      constraints: const BoxConstraints(maxHeight: 180),
                      child: previewMsgs.isEmpty
                          ? const Center(
                              child: Padding(
                                padding: EdgeInsets.all(8.0),
                                child: Text('暂无历史文本消息记录', style: TextStyle(fontSize: 11, color: AuroraColors.fg3)),
                              ),
                            )
                          : SingleChildScrollView(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: previewMsgs.map((m) {
                                  final isUser = m['role'] == 'user';
                                  final content = (m['content'] ?? '').toString().trim();
                                  final subName = m['subagent_name']?.toString();
                                  final roleLabel = isUser
                                      ? '👤 用户'
                                      : (subName != null && subName.isNotEmpty
                                          ? '🔀 $subName'
                                          : (_executionMode == 'claude'
                                              ? '🤖 Claude'
                                              : _executionMode == 'codex'
                                                  ? '🤖 Codex'
                                                  : _executionMode == 'antigravity'
                                                      ? '🤖 Antigravity'
                                                      : '🤖 AI'));

                                  return Container(
                                    margin: const EdgeInsets.only(bottom: 6),
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                                    decoration: BoxDecoration(
                                      color: isUser ? AuroraColors.chip : AuroraColors.surface,
                                      borderRadius: BorderRadius.circular(6),
                                      border: Border.all(
                                        color: isUser ? Colors.transparent : AuroraColors.border,
                                        width: 0.8,
                                      ),
                                    ),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          roleLabel,
                                          style: TextStyle(
                                            fontSize: 10.5,
                                            fontWeight: FontWeight.w600,
                                            color: isUser ? AuroraColors.accent : AuroraColors.fg2,
                                          ),
                                        ),
                                        const SizedBox(height: 2),
                                        Text(
                                          content,
                                          maxLines: 3,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 11, color: AuroraColors.fg1, height: 1.3),
                                        ),
                                      ],
                                    ),
                                  );
                                }).toList(),
                              ),
                            ),
                    ),
                ],
              );
            })(),
          ],
        ],
        const SizedBox(height: 8),

        if (_attachedFiles.isNotEmpty) ...[
          _buildAttachedFilesBar(),
          const SizedBox(height: 6),
        ],

        // Prompt input row
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            _buildAttachmentMenuButton(),
            const SizedBox(width: 6),
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: AuroraColors.surfaceElevated,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: TextField(
                  controller: _inputController,
                  focusNode: _inputFocusNode,
                  autofocus: !Platform.isIOS && !Platform.isAndroid,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                  decoration: InputDecoration(
                    hintText: _getHintText(),
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                  ),
                  onSubmitted: (_) => _handleSend(),
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (askState.isStreaming)
              IconButton.filled(
                onPressed: () => ref.read(askProvider.notifier).abort(),
                style: IconButton.styleFrom(backgroundColor: AuroraColors.danger),
                tooltip: '中止生成',
                icon: const Icon(Icons.stop, color: Colors.white, size: 20),
              )
            else
              IconButton.filled(
                onPressed: _handleSend,
                style: IconButton.styleFrom(backgroundColor: AuroraColors.accent),
                tooltip: '发送消息 (Enter，Shift+Enter 换行)',
                icon: const Icon(Icons.send_rounded, color: Colors.black, size: 18),
              ),
          ],
        ),
      ],
    ),
      ),
  );
}

  Widget _buildAttachedFilesBar() {
    return Container(
      height: 70,
      margin: const EdgeInsets.only(bottom: 4),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: _attachedFiles.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final att = _attachedFiles[index];
          return Stack(
            clipBehavior: Clip.none,
            children: [
              GestureDetector(
                onTap: att.isImage
                    ? () => _showImagePreviewDialog(
                          context,
                          imageBytes: att.bytes,
                          imageSource: att.path,
                        )
                    : null,
                child: Container(
                  width: att.isImage ? 70 : 140,
                  height: 70,
                  decoration: BoxDecoration(
                    color: AuroraColors.chip,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AuroraColors.border),
                  ),
                  clipBehavior: Clip.antiAlias,
                  child: att.isImage
                      ? (att.bytes != null
                          ? Image.memory(att.bytes!, fit: BoxFit.cover)
                          : (att.path != null && File(att.path!).existsSync()
                              ? Image.file(File(att.path!), fit: BoxFit.cover)
                              : const Icon(Icons.image, color: AuroraColors.fg3)))
                      : Padding(
                          padding: const EdgeInsets.all(8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(Icons.insert_drive_file_outlined, size: 20, color: AuroraColors.accent),
                              const SizedBox(height: 4),
                              Text(
                                att.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 11, color: AuroraColors.fg1, fontWeight: FontWeight.w500),
                              ),
                              Text(
                                att.formattedSize,
                                style: const TextStyle(fontSize: 9, color: AuroraColors.fg3),
                              ),
                            ],
                          ),
                        ),
                ),
              ),
              Positioned(
                top: -4,
                right: -4,
                child: GestureDetector(
                  onTap: () {
                    setState(() {
                      _attachedFiles.removeAt(index);
                    });
                  },
                  child: Container(
                    padding: const EdgeInsets.all(2),
                    decoration: const BoxDecoration(
                      color: AuroraColors.danger,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.close, size: 12, color: Colors.white),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildAttachmentMenuButton() {
    final isMobile = Platform.isIOS || Platform.isAndroid;

    if (isMobile) {
      return Container(
        height: 44,
        width: 40,
        alignment: Alignment.center,
        child: IconButton(
          onPressed: _showMobileAttachmentSheet,
          tooltip: '拍照 / 选图 / 附件',
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(),
          icon: const Icon(Icons.add_circle_outline_rounded, color: AuroraColors.accent, size: 24),
        ),
      );
    }

    return Container(
      height: 44,
      width: 40,
      alignment: Alignment.center,
      child: PopupMenuButton<String>(
        tooltip: '添加附件 / 截图',
        offset: const Offset(0, -120),
        color: AuroraColors.surface,
        elevation: 4,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: const BorderSide(color: AuroraColors.border),
        ),
        onSelected: (value) {
          if (value == 'paste') {
            _tryPasteImageFromClipboard();
          } else if (value == 'image') {
            _pickFromGallery();
          } else if (value == 'file') {
            _pickFiles();
          }
        },
        itemBuilder: (context) => [
          const PopupMenuItem(
            value: 'paste',
            height: 36,
            child: Row(
              children: [
                Icon(Icons.content_paste_rounded, size: 16, color: AuroraColors.accent),
                SizedBox(width: 8),
                Text('粘贴剪贴板截图 (Ctrl+V)', style: TextStyle(fontSize: 12.5, color: AuroraColors.fg1)),
              ],
            ),
          ),
          const PopupMenuItem(
            value: 'image',
            height: 36,
            child: Row(
              children: [
                Icon(Icons.image_outlined, size: 16, color: AuroraColors.accent),
                SizedBox(width: 8),
                Text('选择图片...', style: TextStyle(fontSize: 12.5, color: AuroraColors.fg1)),
              ],
            ),
          ),
          const PopupMenuItem(
            value: 'file',
            height: 36,
            child: Row(
              children: [
                Icon(Icons.attach_file_rounded, size: 16, color: AuroraColors.accent),
                SizedBox(width: 8),
                Text('选择文件 / 代码...', style: TextStyle(fontSize: 12.5, color: AuroraColors.fg1)),
              ],
            ),
          ),
        ],
        child: const Icon(Icons.add_circle_outline_rounded, color: AuroraColors.accent, size: 24),
      ),
    );
  }
}

class _LocalSessionParseArgs {
  final String filePath;
  final String executionMode;
  const _LocalSessionParseArgs(this.filePath, this.executionMode);
}

List<Map<String, String?>> _parseLocalSessionTurnsInIsolate(_LocalSessionParseArgs args) {
  final file = File(args.filePath);
  if (!file.existsSync()) return [];

  final lines = file.readAsLinesSync();
  final List<Map<String, String?>> turns = [];

  if (args.executionMode == 'antigravity') {
    for (final line in lines) {
      if (line.trim().isEmpty) continue;
      try {
        final obj = jsonDecode(line);
        if (obj is! Map<String, dynamic>) continue;
        final mtype = obj['type']?.toString();
        final source = obj['source']?.toString();

        if (mtype == 'USER_INPUT' || source == 'USER_EXPLICIT') {
          final raw = obj['content']?.toString() ?? '';
          final reqMatch = RegExp(r'<USER_REQUEST>([\s\S]*?)</USER_REQUEST>').firstMatch(raw);
          final content = reqMatch != null ? reqMatch.group(1)!.trim() : raw.trim();
          if (content.isNotEmpty) {
            turns.add({'role': 'user', 'content': content, 'thinking': null});
          }
        } else if (mtype == 'SYSTEM_MESSAGE') {
          final raw = obj['content']?.toString() ?? '';
          final m = RegExp(
            r'\[Message\]\s+(?:timestamp=[^\s]+\s+)?(?:sender=([^\s]+)\s+)?(?:priority=[^\s]+\s+)?content=([\s\S]*)',
          ).firstMatch(raw);
          if (m != null) {
            final sender = (m.group(1) ?? '').toLowerCase();
            var body = m.group(2)!.trim();
            if (body.endsWith('</SYSTEM_MESSAGE>')) {
              body = body.substring(0, body.length - '</SYSTEM_MESSAGE>'.length).trim();
            }
            final isTask = sender.contains('task-') ||
                body.toLowerCase().contains('task id ') ||
                sender.contains('subagent') ||
                body.startsWith('[Notice]') ||
                body.startsWith('Task id ');
            if (!isTask && body.isNotEmpty) {
              turns.add({'role': 'user', 'content': body, 'thinking': null});
            }
          }
        } else if (mtype == 'PLANNER_RESPONSE') {
          final toolCalls = obj['tool_calls'] as List?;
          if (toolCalls == null || toolCalls.isEmpty) {
            final c = (obj['content']?.toString() ?? '').trim();
            final th = (obj['thinking']?.toString() ?? '').trim();
            if (c.isNotEmpty || th.isNotEmpty) {
              turns.add({
                'role': 'assistant',
                'content': c.isNotEmpty ? c : '[AI 思考过程]',
                'thinking': th.isNotEmpty ? th : null,
              });
            }
          }
        }
      } catch (_) {}
    }
  } else if (args.executionMode == 'claude') {
    for (final line in lines) {
      if (line.trim().isEmpty) continue;
      try {
        final obj = jsonDecode(line);
        if (obj is! Map<String, dynamic>) continue;
        final message = obj['message'];
        if (message is Map<String, dynamic>) {
          final role = message['role']?.toString();
          final rawContent = message['content'];
          String text = '';
          if (rawContent is String) {
            text = rawContent;
          } else if (rawContent is List) {
            for (final item in rawContent) {
              if (item is Map && item['type'] == 'text') {
                text += (item['text']?.toString() ?? '');
              }
            }
          }
          if (role != null && text.trim().isNotEmpty) {
            turns.add({'role': role, 'content': text.trim(), 'thinking': null});
          }
        }
      } catch (_) {}
    }
  } else if (args.executionMode == 'codex') {
    for (final line in lines) {
      if (line.trim().isEmpty) continue;
      try {
        final obj = jsonDecode(line);
        if (obj is! Map<String, dynamic>) continue;
        final mtype = obj['type']?.toString();
        final payload = obj['payload'];
        if (payload is Map<String, dynamic>) {
          final role = payload['role']?.toString() ?? mtype;
          final content = payload['content']?.toString() ?? '';
          if (role != null && (role == 'user' || role == 'assistant') && content.trim().isNotEmpty) {
            turns.add({'role': role, 'content': content.trim(), 'thinking': null});
          }
        }
      } catch (_) {}
    }
  }

  return turns;
}
