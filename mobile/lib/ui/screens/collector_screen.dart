import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import '../../collector/collector_controller.dart';
import '../../collector/models/collector_config.dart';
import '../../collector/discovery/tool_discovery_service.dart';
import '../../collector/models/tool_discovery.dart';
import '../../collector/services/autostart_service.dart';
import '../../collector/services/ws_task_client.dart';
import '../../core/services/update_service.dart';
import '../../core/theme/aurora_theme.dart';
import '../widgets/glass_card.dart';
import '../widgets/update_dialog.dart';

/// Screen for managing and monitoring the local device collector.
class CollectorScreen extends StatefulWidget {
  final CollectorController controller;

  const CollectorScreen({super.key, required this.controller});

  @override
  State<CollectorScreen> createState() => _CollectorScreenState();
}

class _CollectorScreenState extends State<CollectorScreen> {
  final ScrollController _logScrollController = ScrollController();
  bool _autoScroll = true;
  Timer? _daemonPollTimer;
  bool _isDaemon = false;
  int? _daemonPid;
  List<String> _daemonLogs = [];
  Map<String, DiscoveredTool> _daemonTools = {};
  CollectorConfig? _daemonConfig;
  bool _autostartEnabled = false;
  bool _checkingUpdate = false;

  @override
  void initState() {
    super.initState();
    _checkDaemon();
    _loadAutostartStatus();
    _daemonPollTimer = Timer.periodic(const Duration(seconds: 2), (_) => _checkDaemon());
  }

  Future<void> _loadAutostartStatus() async {
    final enabled = await AutostartService.isEnabled();
    if (mounted) {
      setState(() => _autostartEnabled = enabled);
    }
  }

  Future<void> _toggleAutostart(bool value) async {
    bool ok = false;
    if (value) {
      ok = await AutostartService.enable();
    } else {
      ok = await AutostartService.disable();
    }
    if (mounted) {
      setState(() => _autostartEnabled = ok ? value : !value);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(ok
              ? (value ? '已开启开机自启动 (后台静默托盘运行)' : '已关闭开机自启动')
              : '操作失败，请检查系统权限'),
          duration: const Duration(seconds: 2),
        ),
      );
    }
  }

  Future<void> _checkUpdate() async {
    if (_checkingUpdate) return;
    if (Platform.isIOS) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('当前版本为 v$kAppCurrentVersion。iOS 端请通过免费自签或 TestFlight 安装新版本。'),
          action: SnackBarAction(
            label: '发布主页',
            onPressed: () => UpdateService.openReleasePage(),
          ),
        ),
      );
      return;
    }
    if (Platform.isAndroid) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('当前版本为 v$kAppCurrentVersion。安卓端请在 GitHub 发布页下载最新 APK 安装。'),
          action: SnackBarAction(
            label: '发布主页',
            onPressed: () => UpdateService.openReleasePage(),
          ),
        ),
      );
      return;
    }
    setState(() => _checkingUpdate = true);
    try {
      final info = await UpdateService.checkUpdate();
      if (!mounted) return;
      setState(() => _checkingUpdate = false);
      if (info == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('检查更新失败，请检查网络连接')),
        );
      } else if (info.hasUpdate) {
        UpdateDialog.show(context, info);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已是最新版本 (v${info.currentVersion})')),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => _checkingUpdate = false);
        final errStr = e.toString();
        final msg = (errStr.contains('SocketException') ||
                errStr.contains('Connection refused') ||
                errStr.contains('Timeout') ||
                errStr.contains('connectionError'))
            ? '网络连接超时或不可用，请稍后重试'
            : '检查更新异常: $e';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg)),
        );
      }
    }
  }

  @override
  void dispose() {
    _daemonPollTimer?.cancel();
    _logScrollController.dispose();
    super.dispose();
  }

  Future<void> _checkDaemon() async {
    final running = await AutostartService.isDaemonRunning();
    int? pid;
    if (running) {
      try {
        final pidFile = File(p.join(CollectorConfig.homeDir, '.memento', 'collector.pid'));
        if (await pidFile.exists()) {
          pid = int.tryParse((await pidFile.readAsString()).trim());
        }
      } catch (_) {}
    }

    if (mounted) {
      setState(() {
        _isDaemon = running;
        _daemonPid = pid;
      });
    }

    if (running) {
      try {
        final config = await CollectorConfig.load();
        final logFile = File(p.join(CollectorConfig.mementoDir.path, 'collector.log'));
        List<String> logs = [];
        if (await logFile.exists()) {
          final lines = await logFile.readAsLines();
          logs = lines.length > 100 ? lines.sublist(lines.length - 100) : lines;
        }
        final tools = await ToolDiscoveryService.discoverAll();
        if (mounted) {
          setState(() {
            _daemonConfig = config;
            _daemonLogs = logs;
            _daemonTools = tools;
          });
        }
      } catch (_) {}
    }
  }

  void _scrollToBottom() {
    if (_autoScroll && _logScrollController.hasClients) {
      _logScrollController.animateTo(
        _logScrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  }

  Future<void> _toggleCollector(bool isCurrentlyRunning) async {
    if (isCurrentlyRunning) {
      if (_isDaemon) {
        if (Platform.isWindows) {
          if (_daemonPid != null) {
            await Process.run('taskkill', ['/F', '/PID', '$_daemonPid']);
          }
        } else {
          await Process.run('pkill', ['-9', '-f', 'memento-collector run']);
        }
        await _checkDaemon();
      } else {
        widget.controller.stop();
      }
    } else {
      final exe = Platform.isWindows ? 'memento-collector.exe' : '/opt/homebrew/bin/memento-collector';
      if (File(exe).existsSync()) {
        await Process.start(exe, ['run'], mode: ProcessStartMode.detached);
        await Future.delayed(const Duration(milliseconds: 800));
        await _checkDaemon();
      } else {
        await widget.controller.start();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<CollectorStatus>(
      stream: widget.controller.statusStream,
      initialData: widget.controller.currentStatus,
      builder: (context, snapshot) {
        final internalStatus = snapshot.data ?? widget.controller.currentStatus;

        final isRunning = _isDaemon || internalStatus.isRunning;
        final isOnline = _isDaemon ? true : internalStatus.isOnline;
        final deviceName = _isDaemon
            ? (_daemonConfig?.deviceName ?? internalStatus.deviceName)
            : internalStatus.deviceName;
        final serverUrl = _isDaemon
            ? (_daemonConfig?.serverUrl ?? internalStatus.serverUrl)
            : internalStatus.serverUrl;
        final tools = _isDaemon ? _daemonTools : internalStatus.tools;
        final recentLogs = _isDaemon ? _daemonLogs : internalStatus.recentLogs;

        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());

        return Scaffold(
          appBar: AppBar(
            title: const Text('本机采集器'),
            actions: [
              IconButton(
                icon: Icon(
                  isRunning ? Icons.stop_circle_outlined : Icons.play_circle_fill,
                  color: isRunning ? Colors.redAccent : AuroraColors.accent,
                ),
                tooltip: isRunning ? '停止采集器' : '启动采集器',
                onPressed: () => _toggleCollector(isRunning),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // Status Card
              GlassCard(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 12,
                          height: 12,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: isOnline
                                ? const Color(0xFF10B981)
                                : (isRunning ? Colors.amber : Colors.redAccent),
                            boxShadow: [
                              if (isOnline)
                                const BoxShadow(
                                  color: Color(0xFF10B981),
                                  blurRadius: 8,
                                  spreadRadius: 1,
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            isOnline
                                ? (_isDaemon
                                    ? '已连接服务器 (系统后台常驻 PID: ${_daemonPid ?? ""})'
                                    : '已连接服务器 (在线)')
                                : (isRunning ? '正在连接服务器...' : '采集器未运行'),
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: AuroraColors.fg1,
                            ),
                          ),
                        ),
                        ElevatedButton.icon(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: isRunning ? Colors.red.withAlpha(40) : AuroraColors.accent,
                            foregroundColor: isRunning ? Colors.redAccent : Colors.white,
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                          onPressed: () => _toggleCollector(isRunning),
                          icon: Icon(isRunning ? Icons.stop : Icons.play_arrow, size: 16),
                          label: Text(isRunning ? '停止' : '启动'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Text(
                      '设备名称: $deviceName',
                      style: const TextStyle(fontSize: 13, color: AuroraColors.fg2),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '服务器地址: ${serverUrl.isEmpty ? "未配置" : serverUrl}',
                      style: const TextStyle(fontSize: 13, color: AuroraColors.fg3),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 16),

              // System Settings Card (Autostart & Version Update)
              if (AutostartService.isSupported) ...[
                GlassCard(
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                  child: Column(
                    children: [
                      // Autostart row
                      Row(
                        children: [
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: (_autostartEnabled ? AuroraColors.accent : AuroraColors.fg4).withOpacity(0.15),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Icon(
                              Icons.power_settings_new_rounded,
                              size: 18,
                              color: _autostartEnabled ? AuroraColors.accent : AuroraColors.fg3,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  '开机自动启动',
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                    color: AuroraColors.fg1,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _autostartEnabled
                                      ? '已开启 · 登录系统时自动在后台托盘静默运行'
                                      : '未开启 · 登录系统后需手动启动客户端',
                                  style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg3),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: _autostartEnabled,
                            activeColor: AuroraColors.accent,
                            onChanged: _toggleAutostart,
                          ),
                        ],
                      ),
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 8),
                        child: Divider(height: 1, color: AuroraColors.border),
                      ),
                      // Update row
                      Row(
                        children: [
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: AuroraColors.success.withOpacity(0.15),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Icon(
                              Icons.system_update_rounded,
                              size: 18,
                              color: AuroraColors.success,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '客户端版本',
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                    color: AuroraColors.fg1,
                                  ),
                                ),
                                SizedBox(height: 2),
                                Text(
                                  '当前安装版本: v$kAppCurrentVersion',
                                  style: TextStyle(fontSize: 11.5, color: AuroraColors.fg3),
                                ),
                              ],
                            ),
                          ),
                          OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AuroraColors.fg2,
                              side: const BorderSide(color: AuroraColors.border),
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                            ),
                            onPressed: _checkingUpdate ? null : _checkUpdate,
                            icon: _checkingUpdate
                                ? const SizedBox(
                                    width: 12,
                                    height: 12,
                                    child: CircularProgressIndicator(strokeWidth: 1.5, color: AuroraColors.accent),
                                  )
                                : const Icon(Icons.refresh_rounded, size: 14),
                            label: Text(_checkingUpdate ? '检查中...' : '检查更新', style: const TextStyle(fontSize: 12)),
                          ),
                        ],
                      ),
                      if (Platform.isMacOS) ...[
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 8),
                          child: Divider(height: 1, color: AuroraColors.border),
                        ),
                        Row(
                          children: [
                            Container(
                              width: 34,
                              height: 34,
                              decoration: BoxDecoration(
                                color: AuroraColors.warn.withOpacity(0.15),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: const Icon(
                                Icons.admin_panel_settings_rounded,
                                size: 18,
                                color: AuroraColors.warn,
                              ),
                            ),
                            const SizedBox(width: 12),
                            const Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    '完全磁盘访问权限 (macOS FDA)',
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      color: AuroraColors.fg1,
                                    ),
                                  ),
                                  SizedBox(height: 2),
                                  Text(
                                    'Codex / Claude CLI 访问项目或全局配置需勾选 Memento.app',
                                    style: TextStyle(fontSize: 11.5, color: AuroraColors.fg3),
                                  ),
                                ],
                              ),
                            ),
                            OutlinedButton.icon(
                              style: OutlinedButton.styleFrom(
                                foregroundColor: AuroraColors.fg2,
                                side: const BorderSide(color: AuroraColors.border),
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                              ),
                              onPressed: () => WsTaskClient.openMacFullDiskAccessPreferences(),
                              icon: const Icon(Icons.open_in_new_rounded, size: 14),
                              label: const Text('前往授权', style: TextStyle(fontSize: 12)),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Discovered Tools
              Text(
                '已检测到的本地开发工具 (${tools.length})',
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AuroraColors.fg2),
              ),
              const SizedBox(height: 8),
              if (tools.isEmpty)
                const GlassCard(
                  padding: EdgeInsets.all(16),
                  child: Center(
                    child: Text('暂未检测到支持的工具或采集器未启动', style: TextStyle(color: AuroraColors.fg4, fontSize: 13)),
                  ),
                )
              else
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: tools.values.map((tool) {
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: AuroraColors.chip,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AuroraColors.border),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.code, size: 16, color: AuroraColors.accent),
                          const SizedBox(width: 6),
                          Text(tool.name, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AuroraColors.accent.withAlpha(30),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              '${tool.projects.length} 个项目',
                              style: const TextStyle(fontSize: 11, color: AuroraColors.accent),
                            ),
                          ),
                        ],
                      ),
                    );
                  }).toList(),
                ),

              const SizedBox(height: 20),

              // Realtime Logs
              Row(
                children: [
                  const Text(
                    '实时运行日志',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AuroraColors.fg2),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: () => setState(() => _autoScroll = !_autoScroll),
                    child: Text(
                      _autoScroll ? '自动滚动: 开启' : '自动滚动: 关闭',
                      style: TextStyle(fontSize: 11, color: _autoScroll ? AuroraColors.accent : AuroraColors.fg4),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),

              Container(
                height: 260,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF0D1117),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AuroraColors.border),
                ),
                child: recentLogs.isEmpty
                  ? const Center(child: Text('等待采集器日志输出...', style: TextStyle(color: AuroraColors.fg4, fontSize: 12)))
                  : ListView.builder(
                      controller: _logScrollController,
                      itemCount: recentLogs.length,
                      itemBuilder: (context, idx) {
                        final line = recentLogs[idx];
                        Color color = const Color(0xFF9CA3AF);
                        if (line.contains('ONLINE') || line.contains('Connected') || line.contains('verified')) {
                          color = const Color(0xFF34D399);
                        } else if (line.contains('Error') || line.contains('failed') || line.contains('rejected')) {
                          color = const Color(0xFFF87171);
                        } else if (line.contains('Watching') || line.contains('Discovered') || line.contains('Syncing')) {
                          color = const Color(0xFF60A5FA);
                        }
                        return Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(
                            line,
                            style: TextStyle(
                              fontFamily: 'Courier',
                              fontSize: 11.5,
                              color: color,
                            ),
                          ),
                        );
                      },
                    ),
              ),
            ],
          ),
        );
      },
    );
  }
}
