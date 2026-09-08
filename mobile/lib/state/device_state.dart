import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/api_client.dart';
import '../core/storage.dart';
import '../models/device.dart';

class DeviceState {
  final bool isLoading;
  final List<Device> devices;
  final String selectedDeviceId; // 'auto' | 'ask_only' | deviceId
  final String? cwd;

  DeviceState({
    this.isLoading = false,
    this.devices = const [],
    this.selectedDeviceId = 'auto',
    this.cwd,
  });

  DeviceState copyWith({
    bool? isLoading,
    List<Device>? devices,
    String? selectedDeviceId,
    String? cwd,
  }) {
    return DeviceState(
      isLoading: isLoading ?? this.isLoading,
      devices: devices ?? this.devices,
      selectedDeviceId: selectedDeviceId ?? this.selectedDeviceId,
      cwd: cwd ?? this.cwd,
    );
  }
}

class DeviceNotifier extends StateNotifier<DeviceState> {
  DeviceNotifier() : super(DeviceState()) {
    loadDevices();
  }

  Future<void> loadDevices() async {
    state = state.copyWith(isLoading: true);
    try {
      final rawList = await ApiClient().getDevices();
      final devices = rawList.map((j) => Device.fromJson(j)).toList();
      final lastId = await AppStorage.getLastDeviceId();
      state = state.copyWith(
        isLoading: false,
        devices: devices,
        selectedDeviceId: lastId ?? 'auto',
      );
    } catch (_) {
      state = state.copyWith(isLoading: false);
    }
  }

  void setSelectedDevice(String id) {
    AppStorage.setLastDeviceId(id);
    state = state.copyWith(selectedDeviceId: id);
  }

  void setCwd(String? cwd) {
    state = state.copyWith(cwd: cwd);
  }
}

final deviceProvider = StateNotifierProvider<DeviceNotifier, DeviceState>((ref) {
  return DeviceNotifier();
});
