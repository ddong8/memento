import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/ask_turn.dart';

class ExecutionCard extends StatefulWidget {
  final ToolCallItem call;

  const ExecutionCard({super.key, required this.call});

  @override
  State<ExecutionCard> createState() => _ExecutionCardState();
}

class _ExecutionCardState extends State<ExecutionCard> {
  bool _expanded = true;
  bool _copied = false;

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
    final isSuccess = call.isSuccess;
    final isFailed = call.isFailed;

    final statusColor = isRunning
        ? AuroraColors.accent
        : isSuccess
            ? AuroraColors.success
            : isFailed
                ? AuroraColors.danger
                : AuroraColors.fg3;

    final statusText = isRunning
        ? '执行中...'
        : isSuccess
            ? (res?.exitCode != null ? '完成 (0)' : '成功')
            : isFailed
                ? (res?.exitCode != null ? '失败 (${res?.exitCode})' : '失败')
                : '就绪';

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: AuroraColors.surfaceSolid,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AuroraColors.borderStrong),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.2),
            blurRadius: 10,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: const BoxDecoration(
                color: AuroraColors.chip,
                borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
              ),
              child: Row(
                children: [
                  Container(
                    width: 24,
                    height: 24,
                    decoration: BoxDecoration(
                      color: statusColor.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Icon(
                      Icons.terminal,
                      size: 14,
                      color: statusColor,
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (call.deviceName != null && call.deviceName!.isNotEmpty) ...[
                    Text(
                      '🖥️ ${call.deviceName}',
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: AuroraColors.fg1,
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                  Expanded(
                    child: Text(
                      call.command.isNotEmpty ? '\$ ${call.command}' : call.name,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: AuroraColors.fg2,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // Status pill
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: statusColor.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: statusColor.withOpacity(0.3)),
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
                  Icon(
                    _expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                    size: 14,
                    color: AuroraColors.fg3,
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
                color: Color(0xFF080C14),
                borderRadius: BorderRadius.vertical(bottom: Radius.circular(14)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        call.command.isNotEmpty ? '\$ ${call.command}' : '',
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color: Color(0xFF38BDF8),
                        ),
                      ),
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
                    ],
                  ),
                  const SizedBox(height: 6),
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
                  if (res?.stdout != null && res!.stdout!.isNotEmpty)
                    SelectableText(
                      res.stdout!,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: Color(0xFFF1F5F9),
                        height: 1.45,
                      ),
                    ),
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
                ],
              ),
            ),
        ],
      ),
    );
  }
}
