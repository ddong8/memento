import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/ask_turn.dart';
import 'app_markdown.dart';

class ExecutionCard extends StatefulWidget {
  final ToolCallItem call;
  final void Function(String? sessionId)? onSmartCompactAndRetry;

  const ExecutionCard({
    super.key,
    required this.call,
    this.onSmartCompactAndRetry,
  });

  @override
  State<ExecutionCard> createState() => _ExecutionCardState();
}

class _ExecutionCardState extends State<ExecutionCard> {
  bool _expanded = false;
  bool _copied = false;
  bool _showRawTerminal = false;
  String? _feedbackMsg;

  static final RegExp _uuidRegex = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  String? _resolveTaskId() {
    final resId = widget.call.result?.taskId;
    if (resId != null && resId.isNotEmpty && _uuidRegex.hasMatch(resId)) {
      return resId;
    }
    final argId = widget.call.args['task_id']?.toString();
    if (argId != null && argId.isNotEmpty && _uuidRegex.hasMatch(argId)) {
      return argId;
    }
    return null;
  }

  Future<void> _cancelTask() async {
    final tId = _resolveTaskId();
    if (tId == null) {
      setState(() => _feedbackMsg = '等待任务...');
      Future.delayed(const Duration(seconds: 2), () {
        if (mounted) setState(() => _feedbackMsg = null);
      });
      return;
    }

    final ok = await ApiClient().cancelTask(tId);
    if (mounted) {
      setState(() {
        _feedbackMsg = ok ? '已终止' : '终止失败';
      });
      Future.delayed(const Duration(seconds: 2), () {
        if (mounted) setState(() => _feedbackMsg = null);
      });
    }
  }

  bool _containsMarkdown(String text) {
    return text.contains('```') ||
        text.contains('# ') ||
        text.contains('## ') ||
        text.contains('**') ||
        text.contains('- ') ||
        text.contains('* ');
  }

  void _copyOutput() {
    final res = widget.call.result;
    final buffer = StringBuffer();
    if (widget.call.command.isNotEmpty) {
      buffer.writeln('\$ ${widget.call.command}');
    }
    if (res?.stdout != null && res!.stdout!.isNotEmpty) {
      buffer.writeln(res.stdout);
    }
    if (res?.stderr != null && res!.stderr!.isNotEmpty) {
      buffer.writeln(res.stderr);
    }
    if (res?.error != null && res!.error!.isNotEmpty) {
      buffer.writeln('Error: ${res.error}');
    }

    Clipboard.setData(ClipboardData(text: buffer.toString()));
    setState(() => _copied = true);
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final call = widget.call;
    final res = call.result;
    final isRunning = call.isRunning;
    final isStillRunning = call.isStillRunning;
    final isSuccess = call.isSuccess;
    final isFailed = call.isFailed;

    final binary = call.binary;
    final cmd = call.command;
    final isClaude = binary.contains('claude') || cmd.contains('[CLAUDE]');
    final isCodex = binary.contains('codex') || cmd.contains('[CODEX]');
    final isAgy = binary.contains('agy') || binary.contains('antigravity') || cmd.contains('[ANTIGRAVITY]');

    final IconData agentIcon = isClaude
        ? Icons.auto_awesome
        : isCodex
            ? Icons.code_rounded
            : isAgy
                ? Icons.rocket_launch_rounded
                : Icons.terminal_rounded;

    final Color agentColor = isClaude
        ? const Color(0xFFE5855E)
        : isCodex
            ? const Color(0xFF10A37F)
            : isAgy
                ? const Color(0xFF9D67EF)
                : AuroraColors.accent;

    final String agentLabel = isClaude
        ? 'Claude'
        : isCodex
            ? 'Codex'
            : isAgy
                ? 'Antigravity'
                : (call.action == 'agent' ? 'Agent' : 'Shell');

    final statusColor = isRunning
        ? AuroraColors.accent
        : isStillRunning
            ? const Color(0xFFF59E0B)
            : isSuccess
                ? AuroraColors.success
                : isFailed
                    ? AuroraColors.danger
                    : AuroraColors.fg3;

    final statusText = isRunning
        ? '执行中...'
        : isStillRunning
            ? '后台运行中'
            : isSuccess
                ? '完成'
                : isFailed
                    ? (res?.exitCode != null ? '失败 · 退出码 ${res?.exitCode}' : '失败')
                    : '就绪';

    final alertCount = res?.alerts.length ?? 0;

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: AuroraColors.surfaceSolid,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AuroraColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: _expanded
                ? const BorderRadius.vertical(top: Radius.circular(12))
                : BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      color: agentColor.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(agentIcon, size: 16, color: agentColor),
                  ),
                  const SizedBox(width: 10),
                  // Title on top (what it's doing), agent and device underneath.
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          call.command.isNotEmpty
                              ? (cmd.startsWith('[') && cmd.contains('] ') ? cmd.substring(cmd.indexOf('] ') + 2) : call.command)
                              : (call.prompt.isNotEmpty ? call.prompt : call.name),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: call.action == 'shell' ? 'monospace' : null,
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: AuroraColors.fg1,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text.rich(
                          TextSpan(children: [
                            TextSpan(
                              text: agentLabel,
                              style: TextStyle(color: agentColor, fontWeight: FontWeight.w600),
                            ),
                            if (call.deviceName != null && call.deviceName!.isNotEmpty)
                              TextSpan(text: '  ·  ${call.deviceName}'),
                          ]),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 11, color: AuroraColors.fg3),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  // Risky operations stay visible while the card is collapsed.
                  if (alertCount > 0) ...[
                    Tooltip(
                      message: '期间有 $alertCount 次危险操作',
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: AuroraColors.warnSoft,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.warning_amber_rounded, size: 11, color: AuroraColors.warn),
                            const SizedBox(width: 3),
                            Text('$alertCount',
                                style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: AuroraColors.warn)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                  // Status pill
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (isRunning) ...[
                          const SizedBox(
                            width: 8,
                            height: 8,
                            child: CircularProgressIndicator(
                              strokeWidth: 1.5,
                              color: AuroraColors.accent,
                            ),
                          ),
                          const SizedBox(width: 4),
                        ],
                        Text(
                          statusText,
                          style: TextStyle(
                            fontSize: 10.5,
                            fontWeight: FontWeight.w600,
                            color: statusColor,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                  Tooltip(
                    message: _expanded ? '收起详情' : '展开查看详情',
                    child: Icon(
                      _expanded ? Icons.keyboard_arrow_up_rounded : Icons.keyboard_arrow_down_rounded,
                      size: 16,
                      color: AuroraColors.fg3,
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Console Output
          if (_expanded)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: const BoxDecoration(
                color: AuroraColors.bg,
                borderRadius: BorderRadius.vertical(bottom: Radius.circular(12)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          call.command.isNotEmpty ? '\$ ${call.command}' : '',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF38BDF8),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      if (res?.stdout != null && (isClaude || isCodex || isAgy || call.action == 'agent' || _containsMarkdown(res!.stdout!))) ...[
                        InkWell(
                          onTap: () => setState(() => _showRawTerminal = !_showRawTerminal),
                          borderRadius: BorderRadius.circular(6),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  _showRawTerminal ? Icons.article_outlined : Icons.terminal_rounded,
                                  size: 12,
                                  color: AuroraColors.fg3,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  _showRawTerminal ? '渲染' : '终端',
                                  style: const TextStyle(
                                    fontSize: 10.5,
                                    color: AuroraColors.fg3,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                      ],
                      InkWell(
                        onTap: _copyOutput,
                        borderRadius: BorderRadius.circular(6),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _copied ? Icons.check : Icons.copy,
                                size: 12,
                                color: _copied ? AuroraColors.success : AuroraColors.fg3,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                _copied ? '已复制' : '复制',
                                style: TextStyle(
                                  fontSize: 10.5,
                                  color: _copied ? AuroraColors.success : AuroraColors.fg3,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (isRunning) ...[
                        const SizedBox(width: 6),
                        InkWell(
                          onTap: _cancelTask,
                          borderRadius: BorderRadius.circular(6),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(
                                  Icons.stop_circle_outlined,
                                  size: 13,
                                  color: Color(0xFFEF4444),
                                ),
                                const SizedBox(width: 3),
                                Text(
                                  _feedbackMsg ?? '终止',
                                  style: const TextStyle(
                                    fontSize: 10.5,
                                    fontWeight: FontWeight.bold,
                                    color: Color(0xFFEF4444),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 6),
                  if (res != null && res.alerts.isNotEmpty) ...[
                    RiskAlertList(alerts: res.alerts),
                    const SizedBox(height: 6),
                  ],
                  if (isRunning &&
                      (res?.stdout == null || res!.stdout!.isEmpty) &&
                      (res?.stderr == null || res!.stderr!.isEmpty))
                    const Text(
                      '设备已接收命令，正在运行...',
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        fontStyle: FontStyle.italic,
                        color: AuroraColors.fg3,
                      ),
                    ),
                  if (res?.stdout != null && res!.stdout!.isNotEmpty) ...[
                    if ((isClaude || isCodex || isAgy || call.action == 'agent' || _containsMarkdown(res.stdout!)) && !_showRawTerminal)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: AppMarkdown(
                          data: res.stdout!,
                          baseTextStyle: const TextStyle(
                            fontSize: 13,
                            color: Color(0xFFF1F5F9),
                            height: 1.5,
                          ),
                        ),
                      )
                    else
                      SelectableText(
                        res.stdout!,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 11.5,
                          color: Color(0xFFF1F5F9),
                          height: 1.45,
                        ),
                      ),
                  ],
                  if (res?.stderr != null && res!.stderr!.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    SelectableText(
                      res.stderr!,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: Color(0xFFF87171),
                        height: 1.45,
                      ),
                    ),
                  ],
                  if (res?.error != null && res!.error!.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    SelectableText(
                      res.error!,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: Color(0xFFEF4444),
                        height: 1.45,
                      ),
                    ),
                  ],
                  if (res?.note != null && res!.note!.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0x19F59E0B),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0x40F59E0B)),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.info_outline_rounded, size: 14, color: Color(0xFFF59E0B)),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              res.note!,
                              style: const TextStyle(
                                fontSize: 11,
                                color: Color(0xFFFBBF24),
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  if ((res?.stdout?.contains('Prompt is too long') ?? false) ||
                      (res?.stderr?.contains('Prompt is too long') ?? false)) ...[
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0x1EF59E0B),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0x59F59E0B)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Row(
                            children: [
                              Icon(Icons.warning_amber_rounded, size: 16, color: Color(0xFFF59E0B)),
                              SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  '历史会话超出上下文限制 (Prompt is too long)',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.bold,
                                    color: Color(0xFFF59E0B),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          const Text(
                            '“Prompt is too long” 并非指您输入的提问过长，而是当前续接的历史会话已累计大量消息与工具记录（超出了 200,000 Token 上下文限制）。\n👉 推荐解决办法：点击下方按钮一键智能提炼前序记忆并轻装重试；或在上方切换为【➕ 新建独立会话】。',
                            style: TextStyle(
                              fontSize: 11.5,
                              color: AuroraColors.fg2,
                              height: 1.45,
                            ),
                          ),
                          if (widget.onSmartCompactAndRetry != null) ...[
                            const SizedBox(height: 10),
                            ElevatedButton.icon(
                              onPressed: () {
                                final sid = (call.args['session_id'] ?? call.args['parent_session_id'])?.toString();
                                widget.onSmartCompactAndRetry?.call(sid);
                              },
                              icon: const Icon(Icons.auto_awesome, size: 14, color: Colors.white),
                              label: const Text(
                                '⚡ 立即智能瘦身并重试 (Smart Compact & Retry)',
                                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Colors.white),
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFFD97706),
                                foregroundColor: Colors.white,
                                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}


/// Risky operations the agent performed during a task (also pushed to the phone).
class RiskAlertList extends StatelessWidget {
  final List<Map<String, dynamic>> alerts;

  const RiskAlertList({super.key, required this.alerts});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AuroraColors.warnSoft,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AuroraColors.warn.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final alert in alerts)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.warning_amber_rounded, size: 14, color: AuroraColors.warn),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text.rich(
                      TextSpan(children: [
                        TextSpan(
                          text: '${alert['label'] ?? '危险操作'}  ',
                          style: const TextStyle(fontWeight: FontWeight.w600, color: AuroraColors.warn),
                        ),
                        TextSpan(
                          text: alert['detail']?.toString() ?? '',
                          style: const TextStyle(
                            color: AuroraColors.fg2,
                            fontFamilyFallback: AuroraTheme.monospaceFontFamilyFallback,
                          ),
                        ),
                      ]),
                      style: const TextStyle(fontSize: 11.5, height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
