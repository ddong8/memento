import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/ask_turn.dart';
import '../../models/device.dart';
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
  bool _showCwd = false;

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    _cwdController.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
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
        );

    _inputController.clear();
    _scrollToBottom();
  }

  @override
  Widget build(BuildContext context) {
    final askState = ref.watch(askProvider);
    final deviceState = ref.watch(deviceProvider);

    // Auto scroll when streaming updates
    if (askState.isStreaming) {
      _scrollToBottom();
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('问 AI'),
        actions: [
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
              tooltip: '清空对话',
              onPressed: () {
                ref.read(askProvider.notifier).clearChat();
              },
            ),
        ],
      ),
      body: Column(
        children: [
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
      return Align(
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
      );
    }

    // Assistant Card
    final isLastTurn = index == ref.read(askProvider).turns.length - 1;
    final isThinkingLive = isGlobalStreaming && isLastTurn && turn.content.isEmpty;

    return Container(
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
              Row(
                children: const [
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
        children: [
          // Device & CWD toolbelt
          Row(
            children: [
              // Target Device Dropdown
              Container(
                height: 32,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  color: AuroraColors.chip,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AuroraColors.border),
                ),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
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
                        child: Text('🤖 自动调度'),
                      ),
                      ...deviceState.devices.map(
                        (d) => DropdownMenuItem(
                          value: d.deviceId,
                          child: Text(
                            '🖥️ ${d.name} (${d.deviceId.length > 6 ? d.deviceId.substring(0, 6) : d.deviceId})',
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                      const DropdownMenuItem(
                        value: 'ask_only',
                        child: Text('✨ 仅提问不执行'),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // CWD Toggle Button
              if (deviceState.selectedDeviceId != 'ask_only') ...[
                if (_showCwd)
                  Expanded(
                    child: Container(
                      height: 32,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      decoration: BoxDecoration(
                        color: AuroraColors.chip,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AuroraColors.accent),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.folder_open, size: 14, color: AuroraColors.accent),
                          const SizedBox(width: 4),
                          Expanded(
                            child: TextField(
                              controller: _cwdController,
                              style: const TextStyle(
                                fontSize: 11,
                                fontFamily: 'monospace',
                                color: AuroraColors.fg1,
                              ),
                              decoration: const InputDecoration(
                                isDense: true,
                                contentPadding: EdgeInsets.zero,
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                hintText: '工作目录路径',
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
                  )
                else
                  InkWell(
                    onTap: () => setState(() => _showCwd = true),
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      height: 32,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      decoration: BoxDecoration(
                        color: AuroraColors.chip,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AuroraColors.border),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: const [
                          Icon(Icons.folder_outlined, size: 13, color: AuroraColors.fg3),
                          SizedBox(width: 4),
                          Text('路径', style: TextStyle(fontSize: 12, color: AuroraColors.fg3)),
                        ],
                      ),
                    ),
                  ),
              ],
            ],
          ),
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
                    minLines: 1,
                    maxLines: 4,
                    style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                    decoration: const InputDecoration(
                      hintText: '向电脑下发命令或提问...',
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
