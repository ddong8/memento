import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/ask_conversation.dart';
import '../../models/ask_turn.dart';
import '../../state/ask_state.dart';
import '../../state/device_state.dart';
import '../widgets/execution_card.dart';
import '../widgets/glass_card.dart';
import '../widgets/thinking_block.dart';
import '../widgets/app_markdown.dart';

class AskScreen extends ConsumerStatefulWidget {
  const AskScreen({super.key});

  @override
  ConsumerState<AskScreen> createState() => _AskScreenState();
}

const Map<String, List<Map<String, String>>> kFallbackAgentModels = {
  'codex': [
    {'id': '', 'name': '⚡ 默认模型 (跟随客户端配置)'},
    {'id': 'gpt-6-astra', 'name': 'GPT-6-Astra (最新)'},
    {'id': 'gpt-5.6-sol', 'name': 'GPT-5.6-Sol (主力编码)'},
    {'id': 'gpt-5.5', 'name': 'GPT-5.5 (官方推荐)'},
    {'id': 'o3', 'name': 'o3 (深度思维)'},
    {'id': 'o4-mini', 'name': 'o4-mini (极速推理)'},
  ],
  'claude': [
    {'id': '', 'name': '⚡ 默认模型 (跟随客户端配置)'},
    {'id': 'sonnet', 'name': 'sonnet (最新 Sonnet 别名)'},
    {'id': 'opus', 'name': 'opus (最新 Opus 别名 / 4.6)'},
    {'id': 'haiku', 'name': 'haiku (最新 Haiku 别名 / 4.5)'},
    {'id': 'claude-sonnet-4-6', 'name': 'Claude Sonnet 4.6'},
    {'id': 'claude-3-7-sonnet', 'name': 'Claude 3.7 Sonnet'},
  ],
  'antigravity': [
    {'id': '', 'name': '⚡ 默认模型 (系统配置)'},
    {'id': 'flash', 'name': 'Gemini Flash (快速平衡)'},
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
      _sessions = [];
      _projects = [];
    });
    if (['codex', 'claude', 'antigravity'].contains(id)) {
      _loadProjectsForMode(id);
      _loadCapabilitiesForMode(id);
    }
  }

  Future<void> _loadCapabilitiesForMode(String mode) async {
    try {
      final dev = ref.read(deviceProvider);
      final caps = await ApiClient().getAgentCapabilities(mode, deviceId: dev.selectedDeviceId);
      if (mounted && _executionMode == mode) {
        setState(() {
          _agentCapabilities = caps;
        });
      }
    } catch (_) {}
  }

  Future<void> _loadProjectsForMode(String mode) async {
    try {
      final toolId = mode == 'antigravity'
          ? 'antigravity'
          : (mode == 'claude' ? 'claude_code' : (mode == 'codex' ? 'codex' : null));
      final projs = await ApiClient().getProjects(toolId: toolId);
      if (mounted && _executionMode == mode) {
        setState(() {
          _projects = projs;
        });
      }
    } catch (e) {
      debugPrint('Failed to load projects: $e');
    }
  }

  Future<void> _handleProjectChange(String? projId) async {
    setState(() {
      _selectedProjectId = projId;
      _selectedSessionId = null;
      _sessions = [];
      _loadingSessions = projId != null && projId.isNotEmpty;
    });

    if (projId == null || projId.isEmpty) return;

    final proj = _projects.firstWhere(
      (p) => p['id']?.toString() == projId,
      orElse: () => {},
    );
    final sourcePath = proj['source_path']?.toString();
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
    }

    try {
      final res = await ApiClient().getProjectConversations(projId);
      final rawList = res['sessions'] as List<dynamic>? ?? [];
      if (mounted && _selectedProjectId == projId) {
        setState(() {
          _sessions = rawList.cast<Map<String, dynamic>>();
          _loadingSessions = false;
        });
      }
    } catch (e) {
      debugPrint('Failed to load project sessions: $e');
      if (mounted) {
        setState(() => _loadingSessions = false);
      }
    }
  }

  String _getHintText() {
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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkAutoRestoreLastConversation();
      // Auto-raise keyboard when entering first screen
      Future.delayed(const Duration(milliseconds: 300), () {
        if (mounted) {
          _inputFocusNode.requestFocus();
        }
      });
    });
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
            _scrollToBottom(force: true);
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

  DateTime _lastScrollTime = DateTime.now();

  void _scrollToBottom({bool force = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      final max = _scrollController.position.maxScrollExtent;
      final current = _scrollController.position.pixels;

      // Do not hijack scroll if user scrolled up to read earlier history
      if (!force && (max - current) > 140) {
        return;
      }

      final now = DateTime.now();
      if (force || now.difference(_lastScrollTime).inMilliseconds > 120) {
        _lastScrollTime = now;
        _scrollController.animateTo(
          max,
          duration: const Duration(milliseconds: 100),
          curve: Curves.easeOutQuad,
        );
      }
    });
  }

  void _showHistoryModal(BuildContext context) {
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
                    const SizedBox(height: 8),
                    const Divider(color: AuroraColors.border, height: 1),

                    // List
                    Expanded(
                      child: FutureBuilder<List<AskConversationSummary>>(
                        future: ApiClient().getAskConversations(),
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
                                      _scrollToBottom(force: true);
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

  void _handleSend() {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;

    final deviceState = ref.read(deviceProvider);
    final selectedDevice = deviceState.selectedDeviceId;
    final cwd = _showCwd ? _cwdController.text.trim() : null;

    ref.read(askProvider.notifier).sendQuestion(
          question: text,
          selectedDevice: selectedDevice,
          cwd: cwd,
          executionMode: _executionMode,
          model: _selectedModel,
          effort: _selectedEffort,
          projectId: _selectedProjectId,
          sessionId: _selectedSessionId,
        );

    _inputController.clear();
    _scrollToBottom(force: true);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AskState>(askProvider, (previous, next) {
      if (next.isStreaming) {
        _scrollToBottom();
      }
    });

    final askState = ref.watch(askProvider);
    final deviceState = ref.watch(deviceProvider);

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
          IconButton(
            icon: const Icon(Icons.history_rounded, size: 22),
            tooltip: '历史记录',
            onPressed: () => _showHistoryModal(context),
          ),
          IconButton(
            icon: const Icon(Icons.add, size: 22),
            tooltip: '新建对话',
            onPressed: () {
              ref.read(askProvider.notifier).newChat();
            },
          ),
          if (askState.turns.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.delete_outline, size: 20),
              tooltip: '清空当前对话',
              onPressed: () {
                ref.read(askProvider.notifier).clearChat();
              },
            ),
        ],
      ),
      body: Column(
        children: [
          if (askState.isLoadingHistory)
            const LinearProgressIndicator(
              minHeight: 2,
              backgroundColor: Colors.transparent,
              color: AuroraColors.accent,
            ),
          // Chat list
          Expanded(
            child: askState.turns.isEmpty
                ? _buildEmptyState()
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    itemCount: askState.turns.length,
                    itemBuilder: (context, index) {
                      final turn = askState.turns[index];
                      return _buildTurnItem(turn, index, askState.isStreaming);
                    },
                  ),
          ),

          // Bottom Console Toolbelt
          _buildBottomConsole(deviceState, askState),
        ],
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

  Widget _buildTurnItem(AskTurn turn, int index, bool isGlobalStreaming) {
    if (turn.role == 'user') {
      return RepaintBoundary(
        child: Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.only(bottom: 12, left: 40),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: AuroraColors.accentSoft,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AuroraColors.accent.withOpacity(0.3)),
            ),
            child: Text(
              turn.content,
              style: const TextStyle(
                fontSize: 14,
                color: AuroraColors.fg1,
                height: 1.45,
              ),
            ),
          ),
        ),
      );
    }

    // Assistant Card
    final isLastTurn = index == ref.read(askProvider).turns.length - 1;
    final isThinkingLive = isGlobalStreaming && isLastTurn && turn.content.isEmpty;

    return RepaintBoundary(
      child: Container(
        margin: const EdgeInsets.only(bottom: 16),
      child: GlassCard(
        padding: const EdgeInsets.all(14),
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
                    color: AuroraColors.chip,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AuroraColors.border),
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
              ...turn.toolCalls.map((call) => ExecutionCard(call: call)),

            // Assistant answer text
            if (turn.content.isNotEmpty)
              AppMarkdown(data: turn.content)
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
    ));
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
      decoration: BoxDecoration(
        color: AuroraColors.surfaceSolid,
        border: const Border(top: BorderSide(color: AuroraColors.borderStrong)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.3),
            blurRadius: 16,
            offset: const Offset(0, -4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Agent Mode Selector Toolbelt (AI / Claude Code / Codex / Antigravity / Shell)
          _buildAgentSelector(),
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
                      onChanged: (val) {
                        if (val != null) {
                          ref.read(deviceProvider.notifier).setSelectedDevice(val);
                        }
                      },
                      items: [
                        const DropdownMenuItem(
                          value: 'auto',
                          child: Text('🤖 自动调度', overflow: TextOverflow.ellipsis),
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
                    onTap: () => setState(() => _showCwd = false),
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
                                      setState(() => _selectedModel = val.trim().isEmpty ? null : val.trim());
                                    },
                                  ),
                                ),
                                InkWell(
                                  onTap: () => setState(() {
                                    _isCustomModel = false;
                                    _selectedModel = null;
                                    _customModelController.clear();
                                  }),
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
                                  } else {
                                    setState(() {
                                      _selectedModel = (val == null || val.isEmpty) ? null : val;
                                    });
                                  }
                                },
                                items: [
                                  ...(){
                                    final dynamic rawModels = _agentCapabilities?['models'];
                                    final List<Map<String, String>> currentModels = (rawModels is List && rawModels.isNotEmpty)
                                        ? rawModels.map<Map<String, String>>((m) => {
                                            'id': (m['id'] ?? '').toString(),
                                            'name': (m['name'] ?? m['id'] ?? '').toString(),
                                          }).toList()
                                        : (kFallbackAgentModels[_executionMode] ?? []);
                                    return currentModels.map((m) {
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
                                    });
                                  }(),
                                  DropdownMenuItem<String>(
                                    value: '__custom__',
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.edit_outlined, size: 12, color: AuroraColors.accent),
                                        const SizedBox(width: 4),
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
                          ..._projects.map((p) {
                            final id = p['id']?.toString() ?? '';
                            final title = (p['title'] ?? p['slug'] ?? id).toString();
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
                            setState(() {
                              _selectedEffort = opt['id']!.isEmpty ? null : opt['id'];
                            });
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
                      _loadingSessions ? '⏳ 加载历史会话中...' : '➕ 新建独立会话',
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
                    onChanged: (val) {
                      setState(() => _selectedSessionId = val);
                    },
                    items: [
                      const DropdownMenuItem<String>(
                        value: null,
                        child: Text('➕ 新建独立会话', overflow: TextOverflow.ellipsis),
                      ),
                      ..._sessions.map((s) {
                        final sid = (s['session_id'] ?? s['conversation_id'] ?? '').toString();
                        final title = (s['title'] ?? (sid.length > 12 ? sid.substring(0, 12) : sid)).toString();
                        return DropdownMenuItem<String>(
                          value: sid,
                          child: Text('💬 $title', overflow: TextOverflow.ellipsis),
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
              final totalCount = activeSession['message_count'] ?? msgs.length;
              final title = activeSession['title']?.toString() ?? _selectedSessionId!;

              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: AuroraColors.accentSoft,
                      borderRadius: BorderRadius.vertical(
                        top: const Radius.circular(8),
                        bottom: Radius.circular(_showSessionContext ? 0 : 8),
                      ),
                      border: Border.all(color: AuroraColors.accent.withOpacity(0.6)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.history_rounded, size: 14, color: AuroraColors.accent),
                        const SizedBox(width: 6),
                        const Text('续接会话: ', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AuroraColors.accent)),
                        Expanded(
                          child: Text(
                            '$title ($totalCount 条)',
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg1),
                          ),
                        ),
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
                                  style: const TextStyle(fontSize: 11, color: AuroraColors.accent, fontWeight: FontWeight.bold),
                                ),
                                Icon(
                                  _showSessionContext ? Icons.keyboard_arrow_up_rounded : Icons.keyboard_arrow_down_rounded,
                                  size: 14,
                                  color: AuroraColors.accent,
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                        InkWell(
                          onTap: () => setState(() => _selectedSessionId = null),
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
          const SizedBox(height: 8),

          // Prompt input row
          Row(
            children: [
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    color: AuroraColors.chip,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AuroraColors.border),
                  ),
                  child: TextField(
                    controller: _inputController,
                    focusNode: _inputFocusNode,
                    autofocus: true,
                    minLines: 1,
                    maxLines: 4,
                    style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                    decoration: InputDecoration(
                      hintText: _getHintText(),
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
                  icon: const Icon(Icons.stop, color: Colors.white, size: 20),
                )
              else
                IconButton.filled(
                  onPressed: _handleSend,
                  style: IconButton.styleFrom(backgroundColor: AuroraColors.accent),
                  icon: const Icon(Icons.send_rounded, color: Colors.black, size: 18),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
