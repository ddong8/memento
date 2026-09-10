import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
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

class AskScreen extends ConsumerStatefulWidget {
  const AskScreen({super.key});

  @override
  ConsumerState<AskScreen> createState() => _AskScreenState();
}

class _AskScreenState extends ConsumerState<AskScreen> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final _cwdController = TextEditingController();
  final _inputFocusNode = FocusNode();
  bool _showCwd = false;
  String _executionMode = 'ai';

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
            onTap: () {
              setState(() {
                _executionMode = id;
                if (id != 'ai') {
                  final dev = ref.read(deviceProvider);
                  if (dev.selectedDeviceId == 'ask_only') {
                    ref.read(deviceProvider.notifier).setSelectedDevice('auto');
                  }
                }
              });
            },
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
              MarkdownBody(
                data: turn.content,
                selectable: true,
                styleSheet: MarkdownStyleSheet(
                  p: const TextStyle(fontSize: 14, color: AuroraColors.fg1, height: 1.55),
                  code: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: AuroraColors.accent,
                    backgroundColor: Color(0x1F38BDF8),
                  ),
                  codeblockDecoration: BoxDecoration(
                    color: const Color(0xFF0F172A),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AuroraColors.borderStrong),
                  ),
                ),
              )
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
