import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/theme/aurora_theme.dart';
import '../../state/auth_state.dart';
import '../../state/device_state.dart';
import 'ask_screen.dart';
import 'daily_screen.dart';
import 'devices_screen.dart';
import 'memory_screen.dart';

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
    }
  }

  List<Widget> _buildPages() {
    return [
      const AskScreen(),
      _loadedTabs.contains(1) ? const MemoryScreen() : const SizedBox.shrink(),
      _loadedTabs.contains(2) ? const DevicesScreen() : const SizedBox.shrink(),
      _loadedTabs.contains(3) ? const DailyScreen() : const SizedBox.shrink(),
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
