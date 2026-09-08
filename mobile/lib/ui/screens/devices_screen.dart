import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/theme/aurora_theme.dart';
import '../../state/auth_state.dart';
import '../../state/device_state.dart';
import '../widgets/glass_card.dart';

class DevicesScreen extends ConsumerWidget {
  const DevicesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final deviceState = ref.watch(deviceProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('在线设备'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: '刷新设备列表',
            onPressed: () {
              ref.read(deviceProvider.notifier).loadDevices();
            },
          ),
          IconButton(
            icon: const Icon(Icons.logout, size: 20),
            tooltip: '退出登录',
            onPressed: () {
              ref.read(authProvider.notifier).logout();
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(deviceProvider.notifier).loadDevices(),
        color: AuroraColors.accent,
        child: deviceState.devices.isEmpty && !deviceState.isLoading
            ? ListView(
                children: const [
                  SizedBox(height: 120),
                  Center(
                    child: Text(
                      '暂无已连接的设备\n请在电脑上启动 Memento Collector 守护进程',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AuroraColors.fg3, height: 1.5),
                    ),
                  ),
                ],
              )
            : ListView.builder(
                padding: const EdgeInsets.all(16),
                itemCount: deviceState.devices.length,
                itemBuilder: (context, index) {
                  final dev = deviceState.devices[index];
                  final isOnline = dev.isOnline;

                  return Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    child: GlassCard(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Container(
                                width: 10,
                                height: 10,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: isOnline ? AuroraColors.success : AuroraColors.fg4,
                                  boxShadow: isOnline
                                      ? [
                                          BoxShadow(
                                            color: AuroraColors.success.withOpacity(0.5),
                                            blurRadius: 6,
                                            spreadRadius: 1,
                                          )
                                        ]
                                      : null,
                                ),
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  dev.name,
                                  style: const TextStyle(
                                    fontSize: 16,
                                    fontWeight: FontWeight.bold,
                                    color: AuroraColors.fg1,
                                  ),
                                ),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                decoration: BoxDecoration(
                                  color: isOnline ? AuroraColors.successSoft : AuroraColors.chip,
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: Text(
                                  isOnline ? 'ONLINE' : 'OFFLINE',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                    color: isOnline ? AuroraColors.success : AuroraColors.fg3,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              const Icon(Icons.fingerprint, size: 14, color: AuroraColors.fg3),
                              const SizedBox(width: 4),
                              Text(
                                'ID: ${dev.deviceId}',
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 12,
                                  color: AuroraColors.fg3,
                                ),
                              ),
                            ],
                          ),
                          if (dev.ip != null && dev.ip!.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Row(
                              children: [
                                const Icon(Icons.lan_outlined, size: 14, color: AuroraColors.fg3),
                                const SizedBox(width: 4),
                                Text(
                                  'IP: ${dev.ip}',
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                    color: AuroraColors.fg3,
                                  ),
                                ),
                              ],
                            ),
                          ],
                          if (dev.lastSeen != null) ...[
                            const SizedBox(height: 4),
                            Row(
                              children: [
                                const Icon(Icons.access_time, size: 14, color: AuroraColors.fg3),
                                const SizedBox(width: 4),
                                Text(
                                  '心跳: ${dev.lastSeen}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: AuroraColors.fg3,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
