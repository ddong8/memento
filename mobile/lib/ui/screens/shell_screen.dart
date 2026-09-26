import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/theme/aurora_theme.dart';
import '../../core/storage.dart';
import '../../core/api_client.dart';
import '../../state/auth_state.dart';
import '../../state/device_state.dart';
import '../../state/collector_state.dart';
import '../../state/ask_state.dart';
import '../../collector/models/collector_config.dart';
import '../../collector/services/autostart_service.dart';
import '../../core/services/windows_registry_service.dart';
import '../../state/update_state.dart';
import 'ask_screen.dart';
import 'daily_screen.dart';
import 'devices_screen.dart';
import 'collector_screen.dart';
import 'memory_screen.dart';
import '../widgets/notify_settings_sheet.dart';

class ShellScreen extends ConsumerStatefulWidget {
  const ShellScreen({super.key});

  @override
  ConsumerState<ShellScreen> createState() => _ShellScreenState();
}

class _ShellScreenState extends ConsumerState<ShellScreen> with WidgetsBindingObserver {
  int _currentIndex = 0;
  final Set<int> _loadedTabs = {0};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _autoStartCollectorIfDesktop();
      // Auto-heal autostart path if previously pointing to stale executables
      AutostartService.ensureCorrectPath();
      // Register in Windows "Installed apps" with uninstaller support
      WindowsRegistryService.register();
      // Check for app updates silently in background and download if available
      // Only desktop platforms (macOS, Windows, Linux) support in-app auto updates and hot replacement.
      if (Platform.isMacOS || Platform.isWindows || Platform.isLinux) {
        Future.delayed(const Duration(seconds: 4), () {
          if (!mounted) return;
          ref.read(appUpdateProvider.notifier).checkAndDownloadInBackground(silent: true);
        });
      }
    });
  }

  Future<void> _autoStartCollectorIfDesktop() async {
    if (!Platform.isMacOS && !Platform.isWindows && !Platform.isLinux) return;

    // If external system daemon is already running, skip in-process collector
    if (await AutostartService.isDaemonRunning()) return;

    final authToken = await AppStorage.getToken();
    final serverUrl = await AppStorage.getServerUrl();

    if (authToken != null && authToken.isNotEmpty) {
      final controller = ref.read(collectorControllerProvider);
      if (!controller.currentStatus.isRunning) {
        final baseConfig = await CollectorConfig.load();

        // Ensure we obtain a real collector_token rather than the user's JWT login token
        var collectorToken = await AppStorage.getCollectorToken();
        if (collectorToken == null || collectorToken.isEmpty) {
          try {
            final me = await ApiClient().getMe();
            final fetched = me['collector_token']?.toString();
            if (fetched != null && fetched.isNotEmpty) {
              collectorToken = fetched;
              await AppStorage.setCollectorToken(fetched);
            }
          } catch (_) {}
        }

        final effectiveToken = (collectorToken != null && collectorToken.isNotEmpty)
            ? collectorToken
            : (baseConfig.token.startsWith('ey') ? '' : baseConfig.token);

        if (effectiveToken.isNotEmpty) {
          final effectiveConfig = baseConfig.copyWith(
            serverUrl: serverUrl,
            token: effectiveToken,
          );
          await effectiveConfig.save();
          await controller.start(configOverride: effectiveConfig);
        }

        // Best effort: ensure autostart on system login
        try {
          if (!await AutostartService.isEnabled()) {
            await AutostartService.enable();
          }
        } catch (_) {}
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Auto-refresh devices when user returns to foreground
      ref.read(deviceProvider.notifier).loadDevices();
      // Silently resync active conversation if backgrounded during AI stream
      ref.read(askProvider.notifier).syncOnForegroundResumed();
    }
  }

  List<Widget> _buildPages() {
    final collectorController = ref.watch(collectorControllerProvider);
    return [
      const AskScreen(),
      _loadedTabs.contains(1) ? const MemoryScreen() : const SizedBox.shrink(),
      _loadedTabs.contains(2) ? const DevicesScreen() : const SizedBox.shrink(),
      _loadedTabs.contains(3) ? const DailyScreen() : const SizedBox.shrink(),
      _loadedTabs.contains(4) ? CollectorScreen(controller: collectorController) : const SizedBox.shrink(),
    ];
  }

  void _switchTab(int index) {
    if (_currentIndex == index && _loadedTabs.contains(index)) return;
    setState(() {
      _currentIndex = index;
      _loadedTabs.add(index);
    });
  }

  final List<Map<String, dynamic>> _navItems = const [
    {
      'label': '问 AI',
      'icon': Icons.chat_bubble_outline,
      'activeIcon': Icons.chat_bubble,
    },
    {
      'label': '记忆检索',
      'icon': Icons.search,
      'activeIcon': Icons.saved_search,
    },
    {
      'label': '在线设备',
      'icon': Icons.devices,
      'activeIcon': Icons.important_devices,
    },
    {
      'label': '工作总结',
      'icon': Icons.calendar_today_outlined,
      'activeIcon': Icons.calendar_today,
    },
    {
      'label': '本机采集',
      'icon': Icons.sensors_outlined,
      'activeIcon': Icons.sensors,
    },
  ];

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    final isDesktop = width >= 720;
    final authState = ref.watch(authProvider);

    if (isDesktop) {
      // Desktop Layout: Left Sidebar + Right Main Content
      return Scaffold(
        body: Row(
          children: [
            // Left Sidebar
            Container(
              width: 220,
              decoration: const BoxDecoration(
                color: AuroraColors.surface,
                border: Border(
                  right: BorderSide(color: AuroraColors.border, width: 1),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // App Brand Header
                  Padding(
                    padding: const EdgeInsets.only(left: 20, right: 20, top: 28, bottom: 20),
                    child: Row(
                      children: [
                        Container(
                          width: 32,
                          height: 32,
                          decoration: BoxDecoration(
                            gradient: AuroraColors.brandGradient,
                            borderRadius: BorderRadius.circular(9),
                            boxShadow: [
                              BoxShadow(
                                color: AuroraColors.accent.withOpacity(0.35),
                                blurRadius: 10,
                                offset: const Offset(0, 2),
                              ),
                            ],
                          ),
                          child: const Icon(Icons.psychology, size: 20, color: Colors.white),
                        ),
                        const SizedBox(width: 10),
                        const Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Memento',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                                color: AuroraColors.fg1,
                                letterSpacing: -0.5,
                              ),
                            ),
                            Text(
                              'Desktop / Mobile',
                              style: TextStyle(fontSize: 10, color: AuroraColors.fg3),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),

                  const Divider(color: AuroraColors.border, height: 1),
                  const SizedBox(height: 12),

                  // Nav items
                  Expanded(
                    child: ListView.separated(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      itemCount: _navItems.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 4),
                      itemBuilder: (context, index) {
                        final item = _navItems[index];
                        final isSelected = _currentIndex == index;

                        return InkWell(
                          onTap: () => _switchTab(index),
                          borderRadius: BorderRadius.circular(10),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                            decoration: BoxDecoration(
                              color: isSelected ? AuroraColors.surfaceElevated : Colors.transparent,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: isSelected ? AuroraColors.borderStrong : Colors.transparent,
                              ),
                            ),
                            child: Row(
                              children: [
                                Icon(
                                  isSelected ? item['activeIcon'] as IconData : item['icon'] as IconData,
                                  size: 18,
                                  color: isSelected ? AuroraColors.accent : AuroraColors.fg3,
                                ),
                                const SizedBox(width: 12),
                                Text(
                                  item['label'] as String,
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: isSelected ? FontWeight.w600 : FontWeight.w500,
                                    color: isSelected ? AuroraColors.fg1 : AuroraColors.fg2,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                  ),

                  // Desktop Background Update Indicator / Restart Button
                  const _DesktopUpdateWidget(),

                  // Bottom User Info & Logout
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AuroraColors.chip,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AuroraColors.border),
                      ),
                      child: Row(
                        children: [
                          const CircleAvatar(
                            radius: 13,
                            backgroundColor: AuroraColors.accentSoft,
                            child: Icon(Icons.person, size: 14, color: AuroraColors.accent),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              authState.username ?? '用户',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12, color: AuroraColors.fg1, fontWeight: FontWeight.w500),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.notifications_none_rounded, size: 16, color: AuroraColors.fg3),
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(),
                            tooltip: '手机推送',
                            onPressed: () => showNotifySettingsSheet(context),
                          ),
                          const SizedBox(width: 10),
                          IconButton(
                            icon: const Icon(Icons.logout, size: 16, color: AuroraColors.fg3),
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(),
                            tooltip: '退出登录',
                            onPressed: () => ref.read(authProvider.notifier).logout(),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            // Right Main Content
            Expanded(
              child: IndexedStack(
                index: _currentIndex,
                children: _buildPages(),
              ),
            ),
          ],
        ),
      );
    }

    // Mobile Layout: Bottom Navigation Bar
    return Scaffold(
      body: IndexedStack(
        index: _currentIndex,
        children: _buildPages(),
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: AuroraColors.surface,
          border: Border(
            top: BorderSide(color: AuroraColors.border, width: 1),
          ),
        ),
        child: BottomNavigationBar(
          currentIndex: _currentIndex,
          onTap: (idx) => _switchTab(idx),
          backgroundColor: Colors.transparent,
          elevation: 0,
          type: BottomNavigationBarType.fixed,
          selectedItemColor: AuroraColors.accent,
          unselectedItemColor: AuroraColors.fg3,
          selectedFontSize: 11,
          unselectedFontSize: 11,
          items: _navItems
              .map(
                (item) => BottomNavigationBarItem(
                  icon: Icon(item['icon'] as IconData),
                  activeIcon: Icon(item['activeIcon'] as IconData),
                  label: item['label'] as String,
                ),
              )
              .toList(),
        ),
      ),
    );
  }
}

class _DesktopUpdateWidget extends ConsumerWidget {
  const _DesktopUpdateWidget();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final updateState = ref.watch(appUpdateProvider);
    final status = updateState.status;

    // Only render if active update progress, ready to install, or an update waiting/failed
    if (status != AppUpdateStatus.downloading &&
        status != AppUpdateStatus.readyToInstall &&
        status != AppUpdateStatus.installing &&
        !(updateState.hasUpdate && (status == AppUpdateStatus.error || status == AppUpdateStatus.idle))) {
      return const SizedBox.shrink();
    }

    final version = updateState.info?.version ?? '';

    // 1. Ready to Install (Click to Restart & Update)
    if (status == AppUpdateStatus.readyToInstall) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Container(
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFF6366F1), Color(0xFF8B5CF6)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(10),
            boxShadow: [
              BoxShadow(
                color: const Color(0xFF6366F1).withOpacity(0.35),
                blurRadius: 8,
                offset: const Offset(0, 3),
              ),
            ],
          ),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => ref.read(appUpdateProvider.notifier).applyUpdateAndRestart(
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
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Row(
                  children: [
                    const Icon(Icons.bolt_rounded, color: Colors.white, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            version.isNotEmpty ? '新版本就绪 (v$version)' : '新版本已就绪',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          const Text(
                            '点击立即重启完成更新',
                            style: TextStyle(
                              color: Colors.white70,
                              fontSize: 10,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(Icons.refresh_rounded, color: Colors.white, size: 16),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }

    // 2. Installing (Replacing files & restarting)
    if (status == AppUpdateStatus.installing) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: AuroraColors.chip,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AuroraColors.accent.withOpacity(0.5)),
          ),
          child: Row(
            children: [
              const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2, color: AuroraColors.accent),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  version.isNotEmpty ? '正在重启更新至 v$version...' : '正在重启更新...',
                  style: const TextStyle(fontSize: 11, color: AuroraColors.fg1, fontWeight: FontWeight.w500),
                ),
              ),
            ],
          ),
        ),
      );
    }

    // 3. Error with update (Click to retry)
    if (status == AppUpdateStatus.error && updateState.hasUpdate) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Container(
          decoration: BoxDecoration(
            color: const Color(0xFFF59E0B).withOpacity(0.12),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFFF59E0B).withOpacity(0.4)),
          ),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => ref.read(appUpdateProvider.notifier).retry(),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded, color: Color(0xFFF59E0B), size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            version.isNotEmpty ? 'v$version 更新中断' : '更新下载中断',
                            style: const TextStyle(
                              fontSize: 11,
                              color: Color(0xFFF59E0B),
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          const Text(
                            '点击重试下载',
                            style: TextStyle(
                              fontSize: 10,
                              color: AuroraColors.fg2,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(Icons.refresh_rounded, color: Color(0xFFF59E0B), size: 16),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }

    // 4. Discovered update but idle (Click to start download)
    if (status == AppUpdateStatus.idle && updateState.hasUpdate) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Container(
          decoration: BoxDecoration(
            color: AuroraColors.chip,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AuroraColors.accent.withOpacity(0.5)),
          ),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => ref.read(appUpdateProvider.notifier).retry(),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    const Icon(Icons.system_update_alt_rounded, color: AuroraColors.accent, size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            version.isNotEmpty ? '发现新版本 v$version' : '发现新版本',
                            style: const TextStyle(
                              fontSize: 11,
                              color: AuroraColors.fg1,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          const Text(
                            '点击立即更新',
                            style: TextStyle(
                              fontSize: 10,
                              color: AuroraColors.fg2,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(Icons.arrow_forward_ios_rounded, color: AuroraColors.accent, size: 12),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }

    // 5. Downloading in background
    final percent = (updateState.progress * 100).toInt();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: AuroraColors.chip,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AuroraColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.5, color: AuroraColors.fg2),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    version.isNotEmpty ? '后台下载 v$version ($percent%)' : '正在下载更新 ($percent%)',
                    style: const TextStyle(fontSize: 11, color: AuroraColors.fg2, fontWeight: FontWeight.w500),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: LinearProgressIndicator(
                value: updateState.progress > 0 ? updateState.progress : null,
                minHeight: 3,
                backgroundColor: AuroraColors.border,
                valueColor: const AlwaysStoppedAnimation<Color>(AuroraColors.accent),
              ),
            ),
            if (updateState.sourceLabel.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                '节点: ${updateState.sourceLabel}',
                style: const TextStyle(fontSize: 9, color: AuroraColors.fg3),
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

